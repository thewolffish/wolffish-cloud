/**
 * Control-token guard — it OBSERVES a tokenizer control token leaking into the
 * model's user-visible text and REPORTS it back to the model; it never
 * rewrites, strips, or suppresses a single character of model output.
 *
 * Some models "say nothing" by writing their end-of-sequence marker as plain
 * text instead of ending with empty content (observed live: grok-4.6 closing a
 * telemetry acknowledgement with a literal `<|eos|>`, rendered verbatim in the
 * chat feed — and once titling a conversation `…Arabic PDF<|eos|>`). The
 * plain-text form is ordinary content to the serving stack, so it streams here
 * like prose — and model output is never post-processed in this app, so
 * nothing downstream may silently delete it either. The fix lives where the
 * bug lives: in the model's own behaviour.
 *
 * So the leak is surfaced the way the no-progress guard surfaces repetition —
 * one line in the volatile runtime tail (cache-safe, after every cache
 * breakpoint), addressed to the model that wrote it. The model reads it and
 * DECIDES: end silently next time, clear the stray token up with the user, or
 * — if the token was deliberate quoted content — ignore the signal.
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

/** Pending notice per conversation — armed at the leak, drained by the next model call. */
const pending = new Map<string, string>()

/** Arm the notice for `conversationId`'s next model call (latest leak wins). */
export function armControlTokenNotice(conversationId: string | null, token: string): void {
  if (!conversationId) return
  pending.set(conversationId, controlTokenNotice(token))
}

/** Drain (return and clear) the pending notice, or undefined when none. */
export function drainControlTokenNotice(conversationId: string | null): string | undefined {
  if (!conversationId) return undefined
  const notice = pending.get(conversationId)
  if (notice !== undefined) pending.delete(conversationId)
  return notice
}
