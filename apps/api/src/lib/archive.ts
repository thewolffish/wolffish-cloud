/**
 * The bounded hot window — what keeps D1 under its 10 GB ceiling.
 *
 * Conversation records are the bulk of the database: every message of every
 * conversation, tool results included, up to 300 KB each, kept forever
 * because a fresh install restores from them. At hundreds of daily agentic
 * users that is hundreds of megabytes a day. So D1 holds a HOT WINDOW: a
 * conversation nobody has touched for ARCHIVE_IDLE_DAYS has its records
 * moved, nightly, into one gzipped JSON blob in R2 (`archive/<user>/<conv>
 * .json.gz`) and its rows deleted. The records read merges the blob with any
 * rows that arrived since, under the same cursor contract, so no client
 * changes. A conversation that comes back to life simply accumulates new
 * rows in D1 again; the next idle pass merges them into the blob.
 *
 * Raw usage rows get the same treatment past USAGE_RAW_RETENTION_DAYS —
 * exported to R2 as gzipped JSON, then deleted. The `usage_daily` rollup
 * (kept by the meter, in the same batch as every raw row) is what admin
 * totals read, so the totals never depend on raw rows surviving.
 *
 * Every job here is bounded by a deadline and a row budget; the nightly run
 * drains a backlog over successive nights rather than ever overrunning the
 * cron's wall-clock allowance.
 */
import type { Env } from '@/index'

export const ARCHIVE_IDLE_DAYS = 14
export const USAGE_RAW_RETENTION_DAYS = 180
const DAY_MS = 86_400_000
const CONVERSATIONS_PER_RUN = 400
const RECORD_PAGE = 500
/** D1 caps bound parameters per statement at 100. */
const SQL_IN_CHUNK = 90
const USAGE_EXPORT_PAGE = 2_000

export type ArchivedRecord = {
  /** The row's D1 rowid at archive time; orders the blob and keys the read cursor. */
  rid: number
  id: string
  seq: number
  kind: string
  /** The JSON payload exactly as stored (a string in D1). */
  content: string
  created_at: string
  /** Record identity as columns (migration 0017); absent in older blobs. */
  base_id?: string | null
  version_hash?: string | null
}

export type ArchiveBlob = {
  version: 1
  conversation_id: string
  user_id: string
  archived_at: string
  records: ArchivedRecord[]
}

export const archiveKey = (userId: string, conversationId: string) =>
  `archive/${userId}/${conversationId}.json.gz`

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

async function gunzip(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text()
}

export async function readArchive(env: Env, key: string): Promise<ArchiveBlob | null> {
  const obj = await env.BLOBS.get(key)
  if (!obj) return null
  try {
    const parsed = JSON.parse(await gunzip(obj.body)) as ArchiveBlob
    return parsed && parsed.version === 1 && Array.isArray(parsed.records) ? parsed : null
  } catch (err) {
    console.error('archive unreadable', { key, message: (err as Error).message })
    return null
  }
}

/**
 * Merge two record sets by id (live wins over archived for an equal id —
 * it is the newer write), keep exactly one snapshot (the newest seq), and
 * order by rid so cursors stay monotonic.
 */
export function mergeRecords(archived: ArchivedRecord[], live: ArchivedRecord[]): ArchivedRecord[] {
  const byId = new Map<string, ArchivedRecord>()
  for (const r of archived) byId.set(r.id, r)
  for (const r of live) byId.set(r.id, r)
  let snapshot: ArchivedRecord | null = null
  const out: ArchivedRecord[] = []
  for (const r of byId.values()) {
    if (r.kind === 'snapshot') {
      if (!snapshot || r.seq >= snapshot.seq) snapshot = r
      continue
    }
    out.push(r)
  }
  if (snapshot) out.push(snapshot)
  out.sort((a, b) => a.rid - b.rid)
  return out
}

async function readAllRecords(env: Env, conversationId: string): Promise<ArchivedRecord[]> {
  const out: ArchivedRecord[] = []
  let cursor = 0
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT rowid AS rid, id, seq, kind, content, created_at, base_id, version_hash
       FROM conversation_records
       WHERE conversation_id = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3`
    )
      .bind(conversationId, cursor, RECORD_PAGE)
      .all<ArchivedRecord>()
    const page = rows.results ?? []
    out.push(...page)
    if (page.length < RECORD_PAGE) break
    cursor = page[page.length - 1]!.rid
  }
  return out
}

async function deleteRecordsById(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
    const chunk = ids.slice(i, i + SQL_IN_CHUNK)
    await env.DB.prepare(
      `DELETE FROM conversation_records WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
    )
      .bind(...chunk)
      .run()
  }
}

/**
 * Move the records of idle conversations into R2. Safe to interrupt at any
 * point: the blob is written before the rows are deleted, the read path
 * dedupes by id, and a conversation is marked archived only after its rows
 * are gone.
 */
export async function archiveIdleConversations(
  env: Env,
  now: number,
  deadline: number
): Promise<{ archived: number; records: number }> {
  const idleBefore = new Date(now - ARCHIVE_IDLE_DAYS * DAY_MS).toISOString()
  let archived = 0
  let records = 0
  // LOOPS under the deadline, like retireUsageRows beside it. This used to
  // take ONE page of CONVERSATIONS_PER_RUN and stop, called once by a daily
  // cron — so the ceiling was that many conversations a DAY, org-wide. Above
  // that arrival rate the backlog only ever grew, and this job is the entire
  // reason D1 stays under its hard 10 GB limit: the mechanism that bounds the
  // database was itself bounded below the rate it had to keep up with.
  // The page size stays (one query is still bounded work); the deadline
  // decides when to stop, not an arbitrary count.
  while (Date.now() < deadline) {
    const candidates = await env.DB.prepare(
      `SELECT c.id, c.user_id, c.archive_key FROM conversations c
       WHERE c.deleted_at IS NULL AND c.updated_at < ?1
         AND EXISTS (SELECT 1 FROM conversation_records r
                     WHERE r.conversation_id = c.id AND r.kind != 'snapshot')
       ORDER BY c.updated_at LIMIT ?2`
    )
      .bind(idleBefore, CONVERSATIONS_PER_RUN)
      .all<{ id: string; user_id: string; archive_key: string | null }>()
    const page = candidates.results ?? []
    if (page.length === 0) break

    for (const row of page) {
      if (Date.now() > deadline) break
      const live = await readAllRecords(env, row.id)
      // The envelope stays a live row: the phone's conversation index reads
      // model/icon/project/stats straight off it (one JOIN per page), and an
      // archived conversation must keep answering there. The blob carries a
      // copy too, and the read path prefers the live one.
      const movable = live.filter((r) => r.kind !== 'snapshot')
      if (movable.length === 0) continue
      const previous = row.archive_key ? await readArchive(env, row.archive_key) : null
      const key = archiveKey(row.user_id, row.id)
      const blob: ArchiveBlob = {
        version: 1,
        conversation_id: row.id,
        user_id: row.user_id,
        archived_at: new Date().toISOString(),
        records: mergeRecords(previous?.records ?? [], live)
      }
      await env.BLOBS.put(key, await gzip(JSON.stringify(blob)))
      await deleteRecordsById(
        env,
        movable.map((r) => r.id)
      )
      await env.DB.prepare(
        'UPDATE conversations SET archived_at = ?1, archive_key = ?2 WHERE id = ?3'
      )
        .bind(blob.archived_at, key, row.id)
        .run()
      archived++
      records += movable.length
    }
    // A short page means the backlog is drained. Otherwise the next query
    // picks up where this one stopped: the rows just archived no longer
    // match, so the window slides forward on its own.
    if (page.length < CONVERSATIONS_PER_RUN) break
  }
  return { archived, records }
}

/**
 * Raw usage rows past the retention window: exported to R2 in gzipped
 * pages (`usage-archive/<day>/<firstId>-<lastId>.json.gz`), then deleted.
 * The rollup already holds their totals.
 */
export async function retireUsageRows(
  env: Env,
  now: number,
  deadline: number
): Promise<{ exported: number }> {
  const cutoff = new Date(now - USAGE_RAW_RETENTION_DAYS * DAY_MS).toISOString()
  const day = new Date(now).toISOString().slice(0, 10)
  let exported = 0
  while (Date.now() < deadline) {
    const rows = await env.DB.prepare(
      'SELECT * FROM usage WHERE created_at < ?1 ORDER BY id LIMIT ?2'
    )
      .bind(cutoff, USAGE_EXPORT_PAGE)
      .all<{ id: number } & Record<string, unknown>>()
    const page = rows.results ?? []
    if (page.length === 0) break
    const first = page[0]!.id
    const last = page[page.length - 1]!.id
    await env.BLOBS.put(
      `usage-archive/${day}/${first}-${last}.json.gz`,
      await gzip(page.map((r) => JSON.stringify(r)).join('\n'))
    )
    const ids = page.map((r) => r.id)
    for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
      const chunk = ids.slice(i, i + SQL_IN_CHUNK)
      await env.DB.prepare(
        `DELETE FROM usage WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
      )
        .bind(...chunk)
        .run()
    }
    exported += page.length
    if (page.length < USAGE_EXPORT_PAGE) break
  }
  return { exported }
}
