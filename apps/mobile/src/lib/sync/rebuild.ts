import type { WireRecord } from '@/lib/cloud/api'
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
 * contract; change them together.
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
      const base = rec.id.replace(/\.[0-9a-f]{8}$/, '')
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
      const id = typeof rawId === 'string' && rawId ? rawId : rec.id.replace(/\.[0-9a-f]{8}$/, '')
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
