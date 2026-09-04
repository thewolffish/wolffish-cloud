import type { ConversationFile } from '@preload/index'

/**
 * The per-conversation action log: every tool call the agent made, in order,
 * read straight out of the persisted assistant segments — which is where an
 * agent's actions actually live, so this needs no separate audit stream.
 *
 * For a conversation that drove the browser extension this IS the list of
 * things done in the employee's browser; for any other it is the commands
 * run and the files touched.
 *
 * It lives apart from the viewer component because it is pure data work
 * (and because a module that exports both components and helpers breaks
 * fast refresh).
 */

export type ActionEntry = {
  id: string
  /** The tool the agent called — `browser_click`, `bash`, `write_file`, … */
  name: string
  timestamp: number
  /** A one-line rendering of the call's arguments, already truncated. */
  detail: string
  /** True for the browser-extension tools, so they can be told apart. */
  browser: boolean
}

const DETAIL_MAX = 160

/**
 * Every tool call in the conversation, in order — read straight out of the
 * persisted assistant segments, which is where the agent's actions actually
 * live. For a conversation that drove the browser extension this IS the
 * list of things done in the employee's browser; for any other it is the
 * commands run and files touched.
 *
 * Arguments are summarised rather than dumped: a `write_file` call carries
 * the whole file, and a log that prints it is not a log any more.
 */
export function actionLog(conv: ConversationFile): ActionEntry[] {
  const out: ActionEntry[] = []
  for (const msg of conv.messages) {
    if (msg.role !== 'assistant') continue
    const segments = (msg as { segments?: unknown }).segments
    if (!Array.isArray(segments)) continue
    for (const seg of segments) {
      const s = seg as { kind?: unknown; name?: unknown; args?: unknown; segmentId?: unknown }
      if (s.kind !== 'tool_call' || typeof s.name !== 'string') continue
      out.push({
        id: typeof s.segmentId === 'string' ? s.segmentId : `${msg.id ?? ''}-${out.length}`,
        name: s.name,
        timestamp: msg.timestamp,
        detail: summarizeArgs(s.args),
        browser: s.name.startsWith('browser_')
      })
    }
  }
  return out
}

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

/**
 * One line, bounded. Whitespace is collapsed FIRST: a `write_file` or a
 * `bash` call carries multi-line text, and a row that inherits those
 * newlines breaks the log's alignment. Clipping alone does not catch it —
 * a newline inside the first 160 characters survives untouched.
 */
const clip = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}
