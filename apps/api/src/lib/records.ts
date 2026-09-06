/**
 * One conversation's records, paged — shared by the user's own read
 * (routes/sync.ts) and the admin's read of someone else's (routes/admin.ts).
 *
 * It lives here because the paging is not obvious: an archived conversation
 * has its records in a gzipped R2 blob AND, usually, a few live D1 rows that
 * arrived after the archive ran, and the client walks both through ONE
 * monotonic cursor. Two copies of that arithmetic would drift, and the way
 * they would drift is silent — a page boundary that skips a message, which
 * nobody notices until a transcript is missing a turn.
 *
 * Cursor space: archived record i (1-based, blob order) has cursor value i;
 * a live row with rowid r has cursor value N + r, where N is the blob's
 * record count. N is stable for the life of the blob (a skipped archived
 * record is skipped, not removed), so indices never shift under a restore
 * in progress.
 *
 * Live wins: a live row carrying an archived record's id is the newer write
 * (a re-sent message, or an envelope re-sent since archiving), so the
 * archived copy is skipped — the same rule the archive merge applies, so
 * this read agrees with the next merge.
 */
import { readArchive, type ArchiveBlob, type ArchivedRecord } from '@/lib/archive'
import type { Env } from '@/index'

export const RECORDS_PAGE_MAX = 200

export type ConversationLocation = {
  archive_key: string | null
  archived_at: string | null
}

export type WireRecord = {
  id: string
  seq: number
  kind: string
  content: unknown
  created_at: string
  /**
   * Which message this is a version of, and which version — the two facts
   * the id used to encode as one string. Served as fields so no client has
   * to parse it (see migration 0017). Null on snapshot rows, and on message
   * rows written before the columns existed that the backfill could not
   * shape; a client falls back to the id itself, which is what the old
   * regex produced for exactly those rows anyway.
   */
  base_id: string | null
  version_hash: string | null
}

type Row = {
  id: string
  seq: number
  kind: string
  content: string
  created_at: string
  base_id?: string | null
  version_hash?: string | null
}

const wire = (r: Row | ArchivedRecord): WireRecord => ({
  id: r.id,
  seq: r.seq,
  kind: r.kind,
  content: typeof r.content === 'string' ? JSON.parse(r.content) : r.content,
  created_at: r.created_at,
  base_id: r.base_id ?? null,
  version_hash: r.version_hash ?? null
})

/**
 * Parsed archive blobs, per isolate: a restore pages one conversation 200
 * records at a time, and re-reading and inflating the same blob for every
 * page would multiply R2 traffic by the page count. Small and short-lived.
 */
const archiveCache = new Map<string, { at: number; blob: ArchiveBlob }>()
const ARCHIVE_CACHE_TTL_MS = 120_000
const ARCHIVE_CACHE_MAX = 16

/** Keyed by blob AND archive time, so a re-merged blob is never served stale. */
export async function cachedArchive(
  env: Env,
  key: string,
  archivedAt: string
): Promise<ArchiveBlob | null> {
  const cacheKey = `${key}@${archivedAt}`
  const hit = archiveCache.get(cacheKey)
  if (hit && Date.now() - hit.at < ARCHIVE_CACHE_TTL_MS) return hit.blob
  const blob = await readArchive(env, key)
  if (!blob) return null
  if (archiveCache.size >= ARCHIVE_CACHE_MAX) {
    const oldest = [...archiveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) archiveCache.delete(oldest[0])
  }
  archiveCache.set(cacheKey, { at: Date.now(), blob })
  return blob
}

/**
 * One page. `next_after: null` means this was the last page — the explicit
 * terminator is the contract (not "a short page"), so a client stays correct
 * even if the server's max page size ever shrinks below what was requested.
 */
export async function readRecordsPage(
  env: Env,
  conversationId: string,
  where: ConversationLocation,
  opts: { after: number; limit: number }
): Promise<{ records: WireRecord[]; next_after: number | null }> {
  const cursor = Number.isFinite(opts.after) && opts.after > 0 ? opts.after : 0
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit : RECORDS_PAGE_MAX, 1), RECORDS_PAGE_MAX)

  const page: WireRecord[] = []
  let nextAfter: number | null = null
  let n = 0

  const blob =
    where.archive_key && where.archived_at
      ? await cachedArchive(env, where.archive_key, where.archived_at)
      : null
  if (blob) {
    const archived: ArchivedRecord[] = blob.records
    n = archived.length
    if (cursor < n) {
      const live = await env.DB.prepare(
        `SELECT id, seq, kind FROM conversation_records WHERE conversation_id = ?1`
      )
        .bind(conversationId)
        .all<{ id: string; seq: number; kind: string }>()
      const liveIds = new Set((live.results ?? []).map((r) => r.id))
      // The client must see exactly one envelope: a live snapshot supersedes
      // an archived one of lower or equal seq.
      const liveSnapshotSeq = Math.max(
        -1,
        ...(live.results ?? []).filter((r) => r.kind === 'snapshot').map((r) => r.seq)
      )
      for (let i = cursor; i < n && page.length < limit; i++) {
        const r = archived[i]!
        nextAfter = i + 1
        if (liveIds.has(r.id)) continue
        if (r.kind === 'snapshot' && liveSnapshotSeq >= 0 && r.seq <= liveSnapshotSeq) continue
        page.push(wire(r))
      }
      if (page.length === limit) {
        // More archived records, or live rows, may follow: never a false terminator.
        return { records: page, next_after: nextAfter }
      }
    }
  }

  // Live rows after the cursor (translated out of the offset space), refilled
  // until the page is full or the rows are exhausted.
  let liveCursor = cursor > n ? cursor - n : 0
  let exhausted = false
  while (page.length < limit && !exhausted) {
    const want = limit - page.length
    const rows = await env.DB.prepare(
      `SELECT rowid AS rid, id, seq, kind, content, created_at, base_id, version_hash
       FROM conversation_records
       WHERE conversation_id = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3`
    )
      .bind(conversationId, liveCursor, want + 1)
      .all<Row & { rid: number }>()
    const results = rows.results ?? []
    exhausted = results.length <= want
    for (const r of results.slice(0, want)) {
      liveCursor = r.rid
      nextAfter = n + r.rid
      page.push(wire(r))
    }
    if (results.length === 0) break
  }
  return { records: page, next_after: exhausted ? null : nextAfter }
}
