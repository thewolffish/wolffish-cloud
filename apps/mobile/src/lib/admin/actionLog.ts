import type { ConversationMessage } from '@/lib/conversations/types'

/**
 * The per-conversation action log: every tool call the agent made, in order,
 * read straight out of the persisted assistant segments — which is where an
 * agent's actions actually live, so this needs no separate audit stream.
 *
 * For a conversation that drove the browser extension this IS the list of
 * things done in that person's browser; for any other it is the commands run
 * and the files touched.
 *
 * It lives apart from the screen because it is pure data work — a component
 * module drags the whole chat renderer (and AsyncStorage) in behind it, which
 * makes it untestable and breaks fast refresh.
 *
 * apps/desktop/src/renderer/src/pages/settings/admin/actionLog.ts is the same
 * contract for the desktop; change them together.
 */

export type ActionEntry = {
  id: string
  name: string
  detail: string
  /** True for the browser-extension tools, so they can be told apart. */
  browser: boolean
}

/** Two lines on a phone, so a little longer than the desktop's one line. */
const DETAIL_MAX = 200

/**
 * Every tool call in the conversation, in order — read straight out of the
 * persisted assistant segments, which is where an agent's actions actually
 * live, so this needs no separate audit stream.
 */
export function actionLog(messages: ConversationMessage[]): ActionEntry[] {
  const out: ActionEntry[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const seg of message.segments ?? []) {
      const s = seg as { kind?: unknown; name?: unknown; args?: unknown; segmentId?: unknown }
      if (s.kind !== 'tool_call' || typeof s.name !== 'string') continue
      out.push({
        id: typeof s.segmentId === 'string' ? s.segmentId : `${message.id ?? ''}-${out.length}`,
        name: s.name,
        detail: summarizeArgs(s.args),
        browser: s.name.startsWith('browser_')
      })
    }
  }
  return out
}

/**
 * Arguments as one short line. A `write_file` or `bash` call carries a whole
 * file, so whitespace is collapsed FIRST — clipping alone leaves any newline
 * inside the limit intact, and one of those breaks the row's layout.
 */
function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return clip(args)
  if (typeof args !== 'object') return clip(String(args))
  const parts: string[] = []
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const rendered =
      typeof v === 'string'
        ? v
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : Array.isArray(v)
            ? `[${v.length}]`
            : v === null
              ? 'null'
              : '{…}'
    parts.push(`${k}: ${rendered}`)
    if (parts.join(' · ').length > DETAIL_MAX) break
  }
  return clip(parts.join(' · '))
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}
