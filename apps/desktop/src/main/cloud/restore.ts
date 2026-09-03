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
 * apps/mobile/src/lib/sync/sync.ts applies the same rules to the same pages;
 * change them together.
 */

import type { ConversationFile, ConversationMessage } from '@main/conversations'

export type WireRecord = {
  id: string
  seq: number
  kind: string
  content: unknown
  created_at: string
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
  const id = typeof raw.id === 'string' && raw.id ? raw.id : rec.id.replace(/\.[0-9a-f]{8}$/, '')
  return { ...raw, id, role, content, timestamp } as ConversationMessage
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
      const base = rec.id.replace(/\.[0-9a-f]{8}$/, '')
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
