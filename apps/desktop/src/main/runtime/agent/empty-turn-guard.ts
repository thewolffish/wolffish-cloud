import type { ChatMessage } from '@main/runtime/thalamus'
import type { ParsedResponse } from '@main/runtime/wernicke'

/**
 * How many consecutive silent empty end_turns the tool loop will nudge past
 * before giving up and ending the turn. Small on purpose: the nudge exists to
 * recover a glitched turn, not to argue with a model that genuinely has
 * nothing more to do. Two attempts is enough to unstick the reasoning-only
 * dropout without letting a truly-finished turn spin.
 */
export const MAX_EMPTY_TURN_NUDGES = 2

/**
 * The nudge shown to the model when it ends its turn on nothing. Phrased as a
 * system aside so it reads as a runtime correction, not user speech, and gives
 * the model all three exits: wrap up if done, continue if not — or stay silent
 * if silence is genuinely right. The third exit is load-bearing: a turn whose
 * closing message already went out (telemetry acknowledgements, a post-tool
 * continuation with nothing to add) has no honest way to end EXCEPT empty, and
 * a nudge that only offers "summarize or continue" pressures the model into
 * filler — or into faking emptiness by typing its end-of-sequence control
 * token as text (observed: grok-4.6 emitting a literal `<|eos|>` to the user).
 * Naming silence as valid keeps the choice with the model; the nudge budget
 * above still bounds a genuinely glitched dropout.
 *
 * The silent exit must spell out that "empty" means ZERO characters. An
 * earlier wording ("end with no output again") was taken literally: a model
 * closed the turn by typing the text `(no output)`, which was delivered to
 * the user as a reply (observed live, 2026-08-30). Placeholder text that
 * DESCRIBES silence is still output.
 */
const EMPTY_TURN_NUDGE_TEXT =
  '[System: You ended your turn without any output or tool call. If the task is ' +
  'complete, reply with a brief summary of what was done. If your closing message ' +
  'was already delivered earlier this turn and there is genuinely nothing left to ' +
  'say, end with an entirely empty response again — zero characters — and the ' +
  'turn will close cleanly. Do NOT type a placeholder that describes the silence, ' +
  'such as "(no output)" or "(nothing to add)", and no control tokens: anything ' +
  'you write is delivered to the user verbatim as a reply. Otherwise, continue the ' +
  'next step now — either call the appropriate tool(s) or give your final answer.]'

/**
 * A "silent empty turn" is one where the model ended its turn (`end_turn`) with
 * no tool calls AND no visible text. It happens when a reasoning model emits a
 * reasoning block but an empty content channel — the run then ends mid-plan with
 * no closing message to the user and the task left unfinished. (Observed in the
 * wild: a Notion doc-build whose final reasoning literally said "let me continue…
 * add the remaining sections", then stopped on empty.)
 *
 * When that happens, returns the messages to inject before looping again so the
 * model gets a chance to finish or wrap up; returns `null` when the turn should
 * end normally (it produced text, produced tool calls, wasn't an `end_turn`, or
 * the nudge budget is spent).
 *
 * The injected pair is deliberate and provider-safe:
 * - A **non-empty** assistant placeholder is required. Anthropic rejects empty
 *   text blocks and enforces strict user/assistant alternation, so a bare user
 *   message right after tool results would 400. Interposing a non-empty
 *   assistant turn keeps the sequence valid on Anthropic and is fine on
 *   OpenAI/DeepSeek (1:1 mapping). `parsed.text` is empty by definition here, so
 *   we use a literal placeholder rather than reusing it.
 * - No `toolUses` are attached — an unmatched tool call would break every
 *   adapter.
 * - `reasoningContent` is carried through only when present, matching how the
 *   loop's max_tokens continuation preserves reasoning.
 */
export function emptyTurnNudge(
  parsed: Pick<ParsedResponse, 'stopReason' | 'text' | 'toolCalls' | 'thinking'>,
  nudgeCount: number,
  maxNudges: number = MAX_EMPTY_TURN_NUDGES
): ChatMessage[] | null {
  const isSilentEmptyTurn =
    parsed.stopReason === 'end_turn' && parsed.toolCalls.length === 0 && parsed.text.trim() === ''
  if (!isSilentEmptyTurn || nudgeCount >= maxNudges) return null

  const assistant: ChatMessage = { role: 'assistant', content: '(continuing)' }
  if (parsed.thinking) assistant.reasoningContent = parsed.thinking
  const user: ChatMessage = { role: 'user', content: EMPTY_TURN_NUDGE_TEXT }
  return [assistant, user]
}
