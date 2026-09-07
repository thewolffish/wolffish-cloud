/**
 * Control-token guard — it OBSERVES a model faking silence in its user-visible
 * text and REPORTS it back to the model; it never rewrites, strips, or
 * suppresses a single character of model output.
 *
 * Two shapes of the same failure live here, because they share one cause: the
 * model decides it has nothing left to say, but cannot emit a zero-token
 * content channel, so it types the smallest stand-in it can find.
 *
 * 1. A tokenizer CONTROL TOKEN as plain text (observed live: grok-4.6 closing
 *    a telemetry acknowledgement with a literal `<|eos|>`, rendered verbatim
 *    in the chat feed — and once titling a conversation `…Arabic PDF<|eos|>`).
 * 2. A CONTENT-FREE reply — punctuation and nothing else (observed live
 *    2026-09-06: deepseek-v4, told by the runtime tail not to reply to
 *    telemetry and by the phone notice not to re-notify, reasoned "so I end
 *    silently with zero characters" and then sent a lone `.`, which reached
 *    the user as its own message bubble).
 *
 * Both forms are ordinary content to the serving stack, so they stream here
 * like prose — and model output is never post-processed in this app, so
 * nothing downstream may silently delete them either. The fix lives where the
 * bug lives: in the model's own behaviour.
 *
 * So the leak is surfaced the way the no-progress guard surfaces repetition —
 * one line in the volatile runtime tail (cache-safe, after every cache
 * breakpoint), addressed to the model that wrote it. The model reads it and
 * DECIDES: end silently next time, clear the stray character up with the user,
 * or — if it was deliberate content — ignore the signal.
 *
 * Nudging is deliberately NOT the lever here. By the time a reply is parsed it
 * has already streamed to the renderer, so re-prompting cannot unsend the
 * stray character; it only risks appending filler after it, and (when the
 * model then correctly ends empty) burns the empty-turn nudge budget arguing
 * with a model that just got it right. Telling it, once, on its next call is
 * the only move that improves anything.
 *
 * The leak typically happens on a turn's FINAL call (there is no next
 * iteration to tell), so an armed notice survives the turn: it is keyed by
 * conversation and drained by that conversation's next model call, whichever
 * turn that is. In-memory only, like the channels' pending format notices —
 * a restart forgets an undelivered notice, which costs nothing (advisory).
 */

/**
 * Well-known control tokens, exact strings, checked only at the very END of a
 * reply (both observed leaks were trailing). Conservative on purpose: a
 * mid-prose mention (the user discussing tokenizers) never trips it, and
 * `</s>` stays OFF the list — a reply legitimately ending in closing-tag
 * markup (`…</s>`) would false-positive.
 */
const CONTROL_TOKENS = [
  '<|eos|>', // grok — the observed leak
  '<|endoftext|>', // GPT family
  '<|im_end|>', // ChatML (qwen, kimi, minimax, …)
  '<|eot_id|>', // llama 3 chat
  '<|end_of_text|>', // llama 3 base
  '<|end▁of▁sentence|>' // deepseek (U+2581 separators)
]

/** The trailing control token of `text`, or null when it ends clean. */
export function trailingControlToken(text: string): string | null {
  const t = text.trimEnd()
  for (const token of CONTROL_TOKENS) if (t.endsWith(token)) return token
  return null
}

/**
 * The runtime-tail notice. Echoing the token verbatim back to the model is
 * safe: it is only ever a string this same model just emitted as plain content
 * through this same stack, so the stack demonstrably treats it as text, not as
 * a live special token.
 */
export function controlTokenNotice(token: string): string {
  return (
    `CONTROL-TOKEN SIGNAL: your previous reply ended with the literal text \`${token}\` — ` +
    `a tokenizer control token, and it was delivered to the user exactly as written. ` +
    `To the user it is meaningless clutter; they cannot be expected to know what it is. ` +
    `Never write control tokens as visible text. When everything is delivered and there ` +
    `is nothing left to say, end with no output at all instead — a completely empty ` +
    `reply, zero characters, never a typed placeholder such as "(no output)". If the stray token may ` +
    `have confused the user, clear it up briefly in your next reply; if you wrote it ` +
    `deliberately as content (for example, quoting a token to explain it), disregard this.`
  )
}

/**
 * Longest punctuation-only reply still treated as a faked silence. Above this
 * the run of punctuation is long enough to plausibly BE the content the user
 * asked for (a divider, a rule, ASCII art), and the guard defers rather than
 * guess. Conservative in the same spirit as the control-token list: a missed
 * leak costs one stray character, a false positive costs a wasted line of
 * advice the model is explicitly told it may ignore.
 */
const CONTENT_FREE_MAX_CHARS = 8

/** Whitespace plus invisible format chars (ZWSP, ZWJ, BOM) — none of it visible content. */
const INVISIBLE = /[\s\p{Cf}]/gu

/**
 * Every remaining char is Unicode punctuation. `\p{P}` deliberately excludes
 * symbols (`\p{S}`), so an emoji-only reply — `👍`, `✅` — is content and never
 * trips, as are letters and digits in any script.
 */
const PUNCTUATION_ONLY = /^\p{P}+$/u

/**
 * The punctuation-only reply text, or null when the reply carries content.
 *
 * Truly-empty text returns null on purpose: an empty content channel is the
 * empty-turn guard's business (it can still nudge, because nothing has been
 * shown to the user yet), not a leak to report after the fact.
 */
export function contentFreeReply(text: string): string | null {
  const visible = text.replace(INVISIBLE, '')
  if (visible === '' || visible.length > CONTENT_FREE_MAX_CHARS) return null
  return PUNCTUATION_ONLY.test(visible) ? visible : null
}

/**
 * The runtime-tail notice for a content-free reply. Echoes the exact
 * characters back so the model can see what the user saw, names the correct
 * exit, and — like every notice in this file — defers to the model when the
 * punctuation was deliberate content.
 */
export function contentFreeReplyNotice(reply: string): string {
  return (
    `CONTENT-FREE REPLY SIGNAL: your previous reply was \`${reply}\` and nothing else — ` +
    `punctuation with no content, delivered to the user as a message of its own. ` +
    `To them it reads as a stray keystroke, not as silence. ` +
    `When everything is delivered and there is nothing left to say, end with no output ` +
    `at all instead — a completely empty reply, zero characters. A lone \`.\`, \`…\` or \`-\` ` +
    `is output, exactly as much as "(no output)" is. ` +
    `If you wrote it deliberately as content, disregard this.`
  )
}

/** Pending notice per conversation — armed at the leak, drained by the next model call. */
const pending = new Map<string, string>()

/** Arm the notice for `conversationId`'s next model call (latest leak wins). */
export function armControlTokenNotice(conversationId: string | null, token: string): void {
  if (!conversationId) return
  pending.set(conversationId, controlTokenNotice(token))
}

/**
 * Arm the content-free-reply notice. Shares the control token's slot on
 * purpose: both notices say "you faked silence, here is the real exit", only
 * one line can ride the tail per call, and the two shapes never co-occur in a
 * single reply (a control token contains letters, so it is never punctuation-
 * only). Latest leak wins, as above.
 */
export function armContentFreeReplyNotice(conversationId: string | null, reply: string): void {
  if (!conversationId) return
  pending.set(conversationId, contentFreeReplyNotice(reply))
}

/** Drain (return and clear) the pending notice, or undefined when none. */
export function drainControlTokenNotice(conversationId: string | null): string | undefined {
  if (!conversationId) return undefined
  const notice = pending.get(conversationId)
  if (notice !== undefined) pending.delete(conversationId)
  return notice
}
