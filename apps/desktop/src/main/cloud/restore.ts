/**
 * Records → one transcript: the pure half of restore, shared by nothing but
 * kept apart from sync.ts so it can be exercised without Electron.
 *
 * `records` is in the server's insert order (sync pages on its `after`
 * cursor and concatenates), and that order — not seq — decides which version
 * of a message survives: the desktop pushes its current truth every time, so
 * the last version the org received is the one it holds now. Seq is the
 * message's timestamp, which a writer may have re-stamped between two pushes
 * (a live conversation has been seen pushing a user message 1.5 s "younger"
 * than its own reply, then the corrected copy); preferring the highest seq
 * resurrected the stale copy and sorted the reply above the prompt. Ordering
 * is still by seq, with insert order breaking ties so a prompt and its reply
 * stamped in the same millisecond keep their places.
 *
 * apps/mobile/src/lib/sync/rebuild.ts applies the same rules to the same
 * pages — version selection, segment coercion, overflow hydration (which
 * fetches only the surviving version's body); change them together.
 */

import type { ConversationFile, ConversationMessage } from '@main/conversations'

export type WireRecord = {
  id: string
  seq: number
  kind: string
  content: unknown
  created_at: string
  /** Record identity as fields (api migration 0017). Null on snapshots, and
   *  on message rows older than the columns — hence baseIdOf's fallback. */
  base_id?: string | null
  version_hash?: string | null
}

/**
 * Which message a record is a version of.
 *
 * The org serves this as a column now; the regex survives only for a record
 * that predates it (an archive blob written before migration 0017, or a
 * server not yet carrying the field). It is the last id-parsing in this
 * client and it should be deleted once no such rows can be served —
 * apps/api/src/routes/sync.ts holds the matching one.
 */
export function baseIdOf(rec: WireRecord): string {
  return rec.base_id ?? rec.id.replace(/\.[0-9a-f]{8}$/, '')
}

export type WireConversationMeta = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/**
 * A record's content is owned by whoever wrote it — this app, an older build,
 * the org's simulator — so the restored message is coerced onto the desktop's
 * contract instead of trusted: a string `content` (`text` accepted as the
 * legacy name), a finite `timestamp` (the record's seq when it looks like
 * one, else its created_at), a role, and an id (the record's base id when
 * the message carries none). Every extra field rides along untouched.
 */
export function normalizeRestoredMessage(rec: WireRecord): ConversationMessage {
  const raw = (
    rec.content && typeof rec.content === 'object' && !Array.isArray(rec.content) ? rec.content : {}
  ) as Record<string, unknown>
  const rawTs = raw.timestamp
  const timestamp =
    typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0
      ? rawTs
      : Number.isFinite(rec.seq) && rec.seq > 1_000_000_000_000
        ? rec.seq
        : Date.parse(rec.created_at) || Date.now()
  const content =
    typeof raw.content === 'string' ? raw.content : typeof raw.text === 'string' ? raw.text : ''
  const role: ConversationMessage['role'] = raw.role === 'assistant' ? 'assistant' : 'user'
  const id = typeof raw.id === 'string' && raw.id ? raw.id : baseIdOf(rec)
  const segments = Array.isArray(raw.segments) ? raw.segments.map(normalizeSegment) : undefined
  return {
    ...raw,
    ...(segments ? { segments } : {}),
    id,
    role,
    content,
    timestamp
  } as ConversationMessage
}

/**
 * A streamed segment's text lives in `delta` (broca's contract, and what
 * every renderer concatenates). A record written by another author may
 * carry it as `text` instead — the overflow placeholder this engine itself
 * wrote before 2026-09-08 did, and those rows are versions: they stay on the
 * server as written. A text segment with no string `delta` rendered as the
 * literal word "undefined", which is what an admin saw in place of every
 * spilled message. Coerced here, once, for every reader of a record.
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

/** Where a spilled message's body lives (see wireMessage in sync.ts). */
export type OverflowRef = { sha256?: unknown; bytes?: unknown; name?: unknown }

export type OverflowBodyFetch = (sha: string) => Promise<string>

/**
 * Put spilled message bodies back.
 *
 * A record whose content carries `syncOverflow` holds only a readable
 * prefix and a placeholder segment; the real message is a blob. The fetch
 * is injected because the two readers reach the blob differently — the
 * owner through GET /v1/files/<sha>, an admin through the conversation's
 * admin route — and so this stays runnable without Electron. A blob that
 * cannot be fetched leaves the prefix in place: a shorter message beats a
 * failed restore, the placeholder still renders as prose, and the next pull
 * tries again. `onMiss` is that report; there is no logger in this file.
 *
 * Only the SURVIVING version of a message is fetched — the one
 * rebuildConversation keeps, the last the org received. Every version of a
 * message uploads its body under the same blob name (wireMessage), so the
 * older shas are gone from the store once the newer one exists: fetching
 * them was a 404 and a warning per superseded version, about a body nothing
 * was going to render.
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
  const concurrency = Math.max(1, opts.concurrency ?? 4)
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

export function rebuildConversation(
  meta: WireConversationMeta,
  records: WireRecord[]
): ConversationFile {
  let envelope: Record<string, unknown> = {}
  const byMessage = new Map<string, WireRecord>()
  for (const rec of records) {
    if (rec.kind === 'snapshot') {
      envelope = (rec.content as Record<string, unknown>) ?? {}
    } else if (rec.kind === 'message') {
      const base = baseIdOf(rec)
      // Re-set on every version so a message's place in the map is where
      // it was FIRST seen; the value is the version seen LAST.
      byMessage.set(base, rec)
    }
  }
  const messages = [...byMessage.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => normalizeRestoredMessage(r))
  return {
    ...(envelope as Partial<ConversationFile>),
    id: meta.id,
    title: (envelope.title as string) || meta.title || '',
    model: (envelope.model as string | null) ?? null,
    messages,
    createdAt: Date.parse(meta.created_at) || Date.now(),
    updatedAt: Date.parse(meta.updated_at) || Date.now()
  }
}

/**
 * The one segment a spilled record carries, in broca's text-segment shape
 * (`delta`, not `text`): every renderer concatenates `delta`, so a
 * placeholder written any other way showed the literal word "undefined" to
 * a reader that never fetched the body — which is every reader the owner's
 * own client is not. (Records already on the server keep the old shape;
 * restore.ts coerces those on the way in.)
 */
export const placeholderSegment = (
  delta: string
): { kind: 'text'; turnId: string; segmentId: string; delta: string } => ({
  kind: 'text',
  turnId: '',
  segmentId: 'sync-overflow',
  delta
})

/**
 * The segments a spilled record keeps: the placeholder, plus every
 * `user_message` segment the message carried.
 *
 * Those are mid-turn messages the USER sent — typed into the phone while a run
 * was working, read by the agent at its next stop point, and recorded inside
 * the assistant's message at the point they were read (see
 * runtime/agent/interjection.ts). Everything else in a spilled record is the
 * agent's own output, and losing some of it costs a detail that is one blob
 * fetch away. These are different in kind:
 *
 *  - on the phone they have NO other copy. The pending bubble that stood in for
 *    the message comes down the moment it is delivered, and the phone's
 *    transcript is rebuilt from these records — so a record without them is a
 *    conversation where the user's own words are simply missing;
 *  - the truncated path (`truncatedMessage`) has no blob at all, so anything
 *    dropped there is gone from the org's copy for good;
 *  - even on the normal spill path, hydration can miss or lag, and until it
 *    lands the placeholder is the whole transcript for that turn.
 *
 * They are also tiny — a sentence or two each — so carrying them on a record
 * that is already over the ceiling costs nothing that matters. The full body in
 * the blob still holds everything; this is only about what survives WITHOUT it.
 */
export function spilledSegments(msg: ConversationMessage, note: string): unknown[] {
  const kept = (msg.segments ?? []).filter(
    (seg) => seg && typeof seg === 'object' && (seg as { kind?: unknown }).kind === 'user_message'
  )
  return [placeholderSegment(note), ...kept]
}
