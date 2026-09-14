import type { TodoItem } from '@main/runtime/broca'
import type { ChatMessage } from '@main/runtime/thalamus'
import type { ParsedResponse } from '@main/runtime/wernicke'

/**
 * The model's task list (`todo_write`) is rendered as a checklist card on
 * every surface — the app, the phone, the terminal — and the user reads it as
 * the progress bar for the work. It is model-maintained by design: only a
 * `todo_write` moves an item, nothing infers completion from a tool result or
 * from the turn ending.
 *
 * That leaves one failure the doctrine alone did not prevent, observed live:
 * the model writes the list once at the start, does all the work, writes a
 * wrap-up that says "done" — and the card under it still says
 * `in_progress`. Every surface then shows a finished task as unfinished,
 * forever, because no later turn owns that list.
 *
 * Same three-layer shape as screen-indicator-guard, weakest first:
 *
 *   1. NOTICE   From the first `todo_write` of the turn until the list has
 *               no open item, TASK-LIST notice rides the runtime tail on
 *               every iteration: what the card currently shows, and the one
 *               rule (write completions as they land, close the list before
 *               the final reply). Prevention, at the request's most salient
 *               position.
 *   2. NUDGE    A turn may not END with a list it wrote this turn still
 *               showing open items. When the model stops calling tools while
 *               items are open, todoCloseoutNudge injects a system aside and
 *               the loop runs once more, so the model writes the true final
 *               state itself — completed, cancelled, or (genuinely blocked)
 *               in_progress with a follow-up. Bounded by MAX_TODO_NUDGES.
 *
 * There is deliberately no failsafe: the runtime cannot know whether an item
 * finished, and guessing would put a lie on the card. A list a nudged model
 * still leaves open is the model's statement that the work is not done.
 *
 * Lists inherited from an earlier turn are a different case (see
 * openTodoNotice in Agent.ts): the runtime tells the model about them, but a
 * turn doing unrelated work is free to leave them alone.
 */

/** One nudge: enough to recover a model that forgot, not enough to argue. */
export const MAX_TODO_NUDGES = 1

export function openTodoItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((i) => i.status === 'pending' || i.status === 'in_progress')
}

function describeOpen(items: readonly TodoItem[]): string {
  const open = openTodoItems(items)
  const shown = open
    .slice(0, 6)
    .map((i) => `"${i.content}" (${i.status})`)
    .join(', ')
  const more = open.length > 6 ? ` and ${open.length - 6} more` : ''
  return `${open.length} of ${items.length} items unfinished: ${shown}${more}`
}

/**
 * Runtime-tail line, present on every iteration while the list this turn
 * wrote still has an open item.
 */
export function openTaskListNotice(items: readonly TodoItem[]): string | undefined {
  if (openTodoItems(items).length === 0) return undefined
  return (
    `TASK LIST: OPEN — the checklist card the user is watching shows ${describeOpen(items)}. ` +
    'Rewrite it with todo_write the moment a step actually finishes, before starting the next one — never batched, never on intent. ' +
    'Before your final reply, write the true final state: finished items completed, dropped ones cancelled, and only a genuinely blocked item left in_progress, with a follow-up naming the blocker. ' +
    'A wrap-up that says done above a card that says in progress is a broken promise on every surface.'
  )
}

/**
 * Returns the messages to inject before looping again when the model ends
 * its turn with a list it wrote this turn still open, or `null` when the
 * turn should end normally (no list this turn, nothing open, the model is
 * still calling tools, this wasn't an end_turn, or the nudge is spent).
 *
 * Shape, exactly as the other guards: the aside is a `role: 'user'` message,
 * preceded by an assistant message echoing the reply that already streamed —
 * and by nothing at all when the reply was empty. See screen-indicator-guard
 * for why no placeholder is invented in that case.
 */
export function todoCloseoutNudge(
  items: readonly TodoItem[] | null,
  parsed: Pick<ParsedResponse, 'stopReason' | 'text' | 'toolCalls' | 'thinking'>,
  nudgeCount: number,
  maxNudges: number = MAX_TODO_NUDGES
): ChatMessage[] | null {
  if (!items || nudgeCount >= maxNudges) return null
  if (openTodoItems(items).length === 0) return null
  if (parsed.stopReason !== 'end_turn' || parsed.toolCalls.length > 0) return null

  const user: ChatMessage = {
    role: 'user',
    content:
      `[System: You are ending your turn, but your task list still shows ${describeOpen(items)} — ` +
      'that is the checklist card the user is looking at right now. If that work is done, call todo_write ' +
      'now with every item in its true final state (completed, or cancelled if dropped), then end with an ' +
      'entirely empty response — zero characters, and no written stand-in for the silence, since anything ' +
      'you write is delivered to the user verbatim. If the work is genuinely not done, continue it now; if ' +
      'you are blocked, call todo_write leaving that item in_progress with a follow-up item naming the blocker, ' +
      'then end empty. Your reply has already been delivered — nothing further needs saying.]'
  }

  const delivered = parsed.text.trim()
  if (!delivered) return [user]

  const assistant: ChatMessage = { role: 'assistant', content: delivered }
  if (parsed.thinking) assistant.reasoningContent = parsed.thinking
  return [assistant, user]
}
