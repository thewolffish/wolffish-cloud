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
 * closed the turn by typing `(no output)` as its content, which was delivered
 * to the user as a reply (observed live, 2026-08-30). Text that DESCRIBES
 * silence is still output.
 *
 * Naming that literal in order to forbid it made the leak worse, which is why
 * this text no longer prints a stand-in at all — printing one is how the model
 * learns it. On 2026-09-12 a mobile-channel conversation was nudged twice and
 * closed twice with the same literal appended AFTER real prose, the marker
 * count matching the nudge budget exactly, and the model's reasoning both
 * times was "I need to produce some output structurally in this format". So
 * the wording now describes the class (a typed stand-in for silence) without
 * quoting a member of it, denies the structural-requirement premise outright,
 * and covers the appended shape as well as the reply-for-silence shape.
 *
 * Naming punctuation was needed for the same reason: on 2026-09-06 deepseek-v4
 * reasoned "so I end silently with zero characters" and then sent a lone `.`,
 * which reached the user as its own message bubble. A bare punctuation mark
 * does not read as a "placeholder that describes the silence", so it has to
 * be named outright. The stray character itself is caught after the fact by
 * the content-free half of the control-token guard — a nudge cannot help
 * there, because the text has already streamed to the user by then.
 */
const EMPTY_TURN_NUDGE_TEXT =
  '[System: You ended your turn with an empty response and no tool call. If the task is ' +
  'complete, reply with a brief summary of what was done. If your closing message ' +
  'was already delivered earlier this turn and there is genuinely nothing left to ' +
  'say, end with an entirely empty response again — zero characters — and the ' +
  'turn will close cleanly. Nothing is ever structurally required in your reply. ' +
  'Do NOT write a stand-in for the silence: no bracketed status note, no written ' +
  'statement that you are staying silent, no lone "." or "…", no control token, ' +
  'and never a trailing marker on the end of a reply that has content — anything ' +
  'you write is delivered to the user verbatim as a reply. Otherwise, continue the ' +
  'next step now — either call the appropriate tool(s) or give your final answer.]'

/**
 * A "silent empty turn" is one where the model ended its turn (`end_turn`) with
 * no tool calls AND no visible text. It happens when a reasoning model emits a
 * reasoning block but an empty content channel — the run then ends mid-plan with
 * no closing message to the user and the task left unfinished. (Observed in the
 * wild: a document build whose final reasoning literally said "let me continue…
 * add the remaining sections", then stopped on empty.)
 *
 * When that happens, returns the messages to inject before looping again so the
 * model gets a chance to finish or wrap up; returns `null` when the turn should
 * end normally (it produced text, produced tool calls, wasn't an `end_turn`, or
 * the nudge budget is spent).
 *
 * What is injected is a SINGLE `role: 'user'` aside — no assistant turn is
 * interposed. There used to be one: a literal `(continuing)` placeholder,
 * carried over from the direct-provider build, where a bare user message
 * right after tool results would 400 on Anthropic's strict alternation. This
 * fork has no Anthropic wire. Every call leaves through providers/cloud.ts as
 * OpenAI-shaped messages to the router, which forwards to OpenAI-compatible
 * upstreams: a user message after tool results is ordinary there, and
 * `toOpenAIMessages` coalesces two user messages in a row into one, so the
 * first-call case needs no filler either.
 *
 * Dropping it is not a cleanup, it is the fix. This file's own rule is
 * "describe the class, never print a member of it", and the placeholder broke
 * that rule in the worst position available: a parenthesized lowercase phrase
 * standing in for an empty turn, written into the MODEL'S OWN MOUTH in the
 * message immediately before the one asking it to reply. The literals that
 * reached users are that shape exactly — `(no output)` on 2026-09-12,
 * `(no content)` on 2026-09-14 — the leak count matched the nudge count, and
 * the model's reasoning said it was producing output "in this format". Two
 * rounds of copy fixes never touched the one place the runtime was
 * demonstrating the format.
 *
 * The turn's `reasoningContent` goes with it: what is dropped is the thinking
 * of a call that produced nothing, with no tool call left to keep it paired
 * with.
 */
export function emptyTurnNudge(
  parsed: Pick<ParsedResponse, 'stopReason' | 'text' | 'toolCalls' | 'thinking'>,
  nudgeCount: number,
  maxNudges: number = MAX_EMPTY_TURN_NUDGES
): ChatMessage[] | null {
  const isSilentEmptyTurn =
    parsed.stopReason === 'end_turn' && parsed.toolCalls.length === 0 && parsed.text.trim() === ''
  if (!isSilentEmptyTurn || nudgeCount >= maxNudges) return null

  return [{ role: 'user', content: EMPTY_TURN_NUDGE_TEXT }]
}
