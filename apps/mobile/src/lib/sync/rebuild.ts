import type { WireRecord } from '@/lib/cloud/api'

/**
 * Which message a record is a version of. The org serves this as a column
 * (api migration 0017); the regex survives only for records that predate it,
 * and is the last id-parsing on the phone — apps/desktop/src/main/cloud/
 * restore.ts and apps/api/src/routes/sync.ts hold the matching two.
 *
 * It lives HERE rather than beside the wire type in cloud/api.ts because it
 * is record shaping, not a request: api.ts is mocked wholesale by the sync
 * tests, and a pure helper hiding inside a mocked HTTP module disappears
 * exactly when the code under test needs it.
 */
export function baseIdOf(rec: WireRecord): string {
  return rec.base_id ?? rec.id.replace(/\.[0-9a-f]{8}$/, '')
}
import type { ConversationMessage } from '@/lib/conversations/types'

/**
 * Records -> one conversation. Extracted from sync.ts so the ADMIN
 * transcript viewer can rebuild another person's conversation with the very
 * same rules this phone applies to its own — an admin reading a transcript
 * must see what its owner sees, and two copies of these rules would drift
 * one message shape at a time, silently, showing a transcript that looks
 * complete while dropping a version of a message.
 *
 * apps/desktop/src/main/cloud/restore.ts holds the third copy of the same
 * contract — version selection, segment coercion, overflow hydration —
 * change them together.
 */

export type RebuiltConversation = {
  updatedAt: number | null
  messages: Array<{
    id: string
    role: string
    content: string
    timestamp: number
    payload?: Record<string, unknown>
  }>
}

/**
 * The org's record pages → one conversation. The same rules the desktop
 * applies when it rebuilds a transcript after a purge: message versions
 * share a base id (the record id carries a content hash suffix) and the
 * version the org received LAST wins — `records` is in the server's insert
 * order, and the desktop pushes its current truth every time. Not the
 * highest seq: seq is the message's timestamp, and a writer re-stamping a
 * message between pushes leaves a stale copy with the younger seq (seen
 * live: a prompt 1.5 s "younger" than its own reply, rendered under it).
 * The last snapshot is the envelope; messages sort by seq, insert order
 * breaking ties so a prompt and its reply stamped in the same millisecond
 * keep their places.
 */
export function rebuildConversation(records: WireRecord[]): RebuiltConversation {
  let envelope: Record<string, unknown> = {}
  const byMessage = new Map<string, WireRecord>()
  for (const rec of records) {
    if (rec.kind === 'snapshot') {
      envelope = (rec.content as Record<string, unknown>) ?? {}
    } else if (rec.kind === 'message') {
      const base = baseIdOf(rec)
      // A message keeps the map slot of its first version; the value is the
      // version seen last.
      byMessage.set(base, rec)
    }
  }
  const messages = [...byMessage.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((rec) => {
      const raw = (
        rec.content && typeof rec.content === 'object' && !Array.isArray(rec.content)
          ? rec.content
          : {}
      ) as Record<string, unknown>
      const rawTs = raw.timestamp
      const timestamp =
        typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0
          ? rawTs
          : Number.isFinite(rec.seq) && rec.seq > 1_000_000_000_000
            ? rec.seq
            : Date.parse(rec.created_at) || Date.now()
      const { id: rawId, role: rawRole, content: rawContent, text, timestamp: _ts, ...rest } = raw
      const id = typeof rawId === 'string' && rawId ? rawId : baseIdOf(rec)
      if (Array.isArray(rest.segments)) rest.segments = rest.segments.map(normalizeSegment)
      return {
        id,
        role: rawRole === 'assistant' ? 'assistant' : 'user',
        content: typeof rawContent === 'string' ? rawContent : typeof text === 'string' ? text : '',
        timestamp,
        payload: Object.keys(rest).length ? rest : undefined
      }
    })
  const updatedAt =
    typeof envelope.updatedAt === 'number' && Number.isFinite(envelope.updatedAt)
      ? envelope.updatedAt
      : null
  return { updatedAt, messages }
}

/**
 * A streamed segment's text lives in `delta` (the desktop's broca contract,
 * and what buildRenderBlocks concatenates). A record written by another
 * author may carry it as `text` instead — the overflow placeholder the
 * desktop wrote before 2026-09-08 did, and those rows are versions: they
 * stay on the server as written. A text segment with no string `delta`
 * rendered as the literal word "undefined" in place of every spilled
 * message. Coerced here, once, for every reader of a record — the owner's
 * catch-up and the admin transcript alike.
 */
function normalizeSegment(seg: unknown): unknown {
  if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return seg
  const s = seg as Record<string, unknown>
  if (s.kind !== 'text' && s.kind !== 'reasoning') return seg
  if (typeof s.delta === 'string') return seg
  const delta = typeof s.text === 'string' ? s.text : typeof s.content === 'string' ? s.content : ''
  return {
    ...s,
    delta,
    turnId: typeof s.turnId === 'string' ? s.turnId : '',
    segmentId: typeof s.segmentId === 'string' ? s.segmentId : `seg_${delta.length}`
  }
}

/** Where a spilled message's body lives (desktop sync.ts wireMessage). */
export type OverflowRef = { sha256?: unknown; bytes?: unknown; name?: unknown }

export type OverflowBodyFetch = (sha: string) => Promise<string>

/**
 * Put spilled message bodies back.
 *
 * A record whose content carries `syncOverflow` holds only a readable
 * prefix and a placeholder segment; the real message is a blob under the
 * owner's files. The fetch is injected so this stays a pure transform (and
 * so an admin reader can reach the blob its own way). A blob that cannot be
 * fetched leaves the prefix in place: a shorter message beats a failed
 * catch-up, the placeholder renders as prose, and the next pull tries
 * again. `onMiss` is that report.
 *
 * Only the SURVIVING version of a message is fetched — the one
 * rebuildConversation keeps, the last the org received. Every version of
 * a message uploads its body under the same blob name, so the older shas
 * are gone from the store by the time the newer one exists: fetching them
 * is a 404 per superseded version, and on a phone each one is a round trip
 * and a warning about a body nobody was going to render.
 */
export async function hydrateOverflow(
  records: WireRecord[],
  fetchBody: OverflowBodyFetch,
  opts: { concurrency?: number; onMiss?: (sha: string, err: unknown) => void } = {}
): Promise<WireRecord[]> {
  const surviving = new Map<string, WireRecord>()
  for (const rec of records) if (rec.kind === 'message') surviving.set(baseIdOf(rec), rec)
  const spilled = [...surviving.values()].filter((r) => {
    const c = r.content as { syncOverflow?: OverflowRef } | null
    return typeof c?.syncOverflow?.sha256 === 'string'
  })
  if (spilled.length === 0) return records
  const concurrency = Math.max(1, opts.concurrency ?? 2)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < spilled.length) {
      const rec = spilled[next++]!
      const sha = String((rec.content as { syncOverflow: OverflowRef }).syncOverflow.sha256)
      try {
        const parsed = JSON.parse(await fetchBody(sha)) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rec.content = parsed
      } catch (err) {
        opts.onMiss?.(sha, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, spilled.length) }, worker))
  return records
}

/**
 * The rebuilt rows as the shape the message renderers take. The payload
 * carries everything that is not a core field (segments, approvals, tool
 * timings, attachments), exactly as `rowToMessage` spreads it back out of
 * SQLite — so an admin-rendered message and a locally stored one are the
 * same object, and every card the owner saw renders for the admin too.
 *
 * Kept beside rebuildConversation rather than in the repo: this path never
 * touches the database, which is the whole point of it existing.
 */
export function rebuiltToMessages(rebuilt: RebuiltConversation): ConversationMessage[] {
  return rebuilt.messages.map((m) => ({
    ...(m.payload ?? {}),
    id: m.id,
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.content,
    timestamp: m.timestamp
  }))
}
