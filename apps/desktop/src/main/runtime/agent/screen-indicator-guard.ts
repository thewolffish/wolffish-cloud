import type { ChatMessage } from '@main/runtime/thalamus'
import type { ParsedResponse } from '@main/runtime/wernicke'

/**
 * The computer-use screen indicator — the blue edge glow plus the centered
 * "Wolffish is capturing your screen" pill — is raised and lowered by the
 * model alone: `computer_glow_on` before the first capture,
 * `computer_glow_off` as the last action of the session. Nothing shows it
 * for the model and nothing hides it while a session is alive.
 *
 * That lifecycle is deliberate, but one half of it is a claim made on the
 * user's own screen rather than a piece of agent state: while the indicator
 * is up, the user is being told they are being watched. The moment the turn
 * ends, that claim is simply false — and it stays on screen forever, because
 * there is no idle timer. Observed live: a computer-use task finished
 * cleanly, the model wrote its summary, and the pill stayed up.
 *
 * So the indicator gets three layers, weakest first, each one only firing
 * where the previous could not:
 *
 *   1. NOTICE   While the indicator is up, SCREEN_INDICATOR_NOTICE rides the
 *               runtime tail on every iteration — the same observe-and-notify
 *               vehicle as the phone/voice reminders, after every cache
 *               breakpoint. Prevention: the rule is restated at the request's
 *               most salient position, where a turn that went well cannot
 *               lose it to a 25k-token prompt.
 *   2. NUDGE    A turn may not END with an indicator it raised. When the
 *               model stops calling tools while the glow is up,
 *               screenIndicatorNudge injects a system aside and the loop runs
 *               again, so the model closes it itself — model-led, just later
 *               than it should have been. Bounded by
 *               MAX_SCREEN_INDICATOR_NUDGES so it can never spin.
 *   3. FAILSAFE The Agent's finally clears it when the turn is over for real
 *               and no model step can happen any more (cancel, error, or a
 *               spent nudge budget). Not an idle timer and never mid-session:
 *               it is the harness refusing to leave a false statement on a
 *               user's screen after the agent that made it has stopped
 *               running.
 *
 * The counterpart on the other end lives in the plugin: the capture and input
 * tools refuse to run until the indicator is up (or has proved unavailable),
 * so "watched without the signal" is impossible rather than merely forbidden.
 */

/** Raises the indicator. Model-called; also the plugin's gate opener. */
export const SCREEN_INDICATOR_ON_TOOL = 'computer_glow_on'

/** Lowers it. Model-called, and the Agent's terminal failsafe. */
export const SCREEN_INDICATOR_OFF_TOOL = 'computer_glow_off'

/**
 * How many times the loop will send the turn back for a forgotten
 * `computer_glow_off` before letting it end and clearing the indicator
 * itself. Two, for the same reason as MAX_EMPTY_TURN_NUDGES: enough to
 * recover a model that simply forgot, not enough to argue with one that
 * won't — and the failsafe makes the user-visible outcome identical either
 * way, so spending more calls here buys nothing.
 */
export const MAX_SCREEN_INDICATOR_NUDGES = 2

/**
 * Runtime-tail line, present on every iteration while the indicator is up.
 * Names what the user is actually seeing (not "the glow", which means
 * nothing to a model reading its own telemetry) and states the one exit,
 * including the two cases the model is most likely to treat as exceptions:
 * giving up, and handing back mid-task.
 */
export const SCREEN_INDICATOR_NOTICE =
  'SCREEN INDICATOR: ON — the user currently sees a blue glow around their display and a notice reading "Wolffish is capturing your screen". ' +
  'Only computer_glow_off takes it down; nothing clears it for you, and there is no timer. ' +
  'Call it the moment you stop looking at or touching their screen — as the LAST action of this turn, whether you finished the task, gave up on it, or are handing back so the user can do something. ' +
  'A turn that ends with it still up tells them they are being watched when they are not.'

/**
 * The nudge, injected when the model ends its turn with the indicator up.
 *
 * Written for a model that believes it is already done: the reply is gone,
 * so the only thing left is the tool call, and the fastest honest way out is
 * to make it. It offers the genuine alternative too (keep working) so the
 * nudge can never talk a model out of an unfinished task, and it closes the
 * empty-reply exit explicitly — the turn has nothing left to say, and
 * without permission to be silent a model will manufacture a second closing
 * message the user did not need. The stand-in warning is the same lesson
 * empty-turn-guard paid for twice: describe the class, never print a member
 * of it, or the model learns the literal and types it.
 */
const SCREEN_INDICATOR_NUDGE_TEXT =
  '[System: You are ending your turn, but the screen indicator is still ON — the user is still being shown ' +
  '"Wolffish is capturing your screen" even though you have stopped. Only computer_glow_off clears it; nothing ' +
  'else will, ever. Call computer_glow_off now. (If you are in fact not finished with their screen, carry on with ' +
  'the task instead — but no turn may end with the indicator up.) Your reply has already been delivered to the ' +
  'user, so once the indicator is off there is nothing further to say: end with an entirely empty response — zero ' +
  'characters, and no written stand-in for the silence — not even a parenthesised note saying there is nothing ' +
  'further, since anything you write is delivered to them verbatim.]'

/**
 * Fold one completed tool call into the "is the indicator up?" flag.
 *
 * Turn-local by design. A global "is the glow window alive" probe would be
 * wrong twice over: with concurrent conversations one turn would see — and
 * the failsafe would then clear — an indicator another conversation is
 * actively using, and a glow raised by an earlier turn is not this turn's to
 * answer for. Tracking only what THIS run raised keeps every layer scoped to
 * the session that owns it.
 *
 * Only successful calls move the flag: a `computer_glow_on` that failed put
 * nothing on screen, and a `computer_glow_off` that failed took nothing down.
 */
export function trackScreenIndicator(on: boolean, toolName: string, ok: boolean): boolean {
  if (!ok) return on
  if (toolName === SCREEN_INDICATOR_ON_TOOL) return true
  if (toolName === SCREEN_INDICATOR_OFF_TOOL) return false
  return on
}

/**
 * Returns the messages to inject before looping again when the model ends its
 * turn with the indicator still up, or `null` when the turn should end
 * normally (indicator already down, the model is still calling tools, this
 * wasn't an end_turn, or the nudge budget is spent).
 *
 * Shape follows empty-turn-guard: the aside is a `role: 'user'` message, and
 * an assistant turn is interposed ONLY when the model actually produced text.
 * Echoing a real reply back is right — it already streamed to the user, and
 * leaving it out of the history would make the model think it never said it.
 * Inventing one when the reply was empty is not: a literal `(continuing)`
 * placeholder used to stand in there, and a parenthesized stand-in for an
 * empty turn written in the model's own voice is exactly the thing that keeps
 * leaking back out as user-visible text. Nothing on this fork's wire needs the
 * filler either — see empty-turn-guard.
 */
export function screenIndicatorNudge(
  indicatorOn: boolean,
  parsed: Pick<ParsedResponse, 'stopReason' | 'text' | 'toolCalls' | 'thinking'>,
  nudgeCount: number,
  maxNudges: number = MAX_SCREEN_INDICATOR_NUDGES
): ChatMessage[] | null {
  if (!indicatorOn || nudgeCount >= maxNudges) return null
  if (parsed.stopReason !== 'end_turn' || parsed.toolCalls.length > 0) return null

  const user: ChatMessage = { role: 'user', content: SCREEN_INDICATOR_NUDGE_TEXT }
  const delivered = parsed.text.trim()
  if (!delivered) return [user]

  const assistant: ChatMessage = { role: 'assistant', content: delivered }
  if (parsed.thinking) assistant.reasoningContent = parsed.thinking
  return [assistant, user]
}
