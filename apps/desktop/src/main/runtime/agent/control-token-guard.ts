/**
 * Control-token guard — it OBSERVES a model faking silence in its user-visible
 * text and REPORTS it back to the model; it never rewrites, strips, or
 * suppresses a single character of model output.
 *
 * Three shapes of the same failure live here, because they share one cause:
 * the model decides it has nothing left to say, but cannot emit a zero-token
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
 * 3. A BRACKETED PLACEHOLDER — a short parenthesized phrase that describes the
 *    silence instead of being it, either as the whole reply or stapled onto
 *    the end of one (observed live: `(no output)` twice on 2026-09-12,
 *    `(no content)` on 2026-09-14). This is the shape that kept getting
 *    through: it carries no tokenizer marker and it is made of words, so
 *    neither of the first two checks ever saw it, and the model was never
 *    told. See `silencePlaceholder`.
 *
 * Both forms are ordinary content to the serving stack, so they stream here
 * like prose — and model output is never post-processed in this app, so
 * nothing downstream may silently delete them either. The fix lives where the
 * bug lives: in the model's own behaviour.
 *
 * The remedy is copy, never post-processing — which means the copy must not
 * print the stand-in it forbids: printing one is how the model learns it. On
 * 2026-09-12 two replies closed with a literal `(no output)` appended after
 * real prose, in a conversation whose empty turns had been nudged exactly
 * twice. The notices below therefore describe the class (a typed stand-in for
 * silence) rather than naming a member of it — except when echoing back the
 * exact characters the model itself just emitted, which tells it nothing its
 * own history above does not already show it.
 *
 * The demonstration that actually mattered was not in the copy at all: every
 * one of these nudges used to interpose a literal `(continuing)` in the
 * ASSISTANT role, one message before the model replied. That was the runtime
 * writing a parenthesized stand-in for an empty turn in the model's own voice,
 * and the leaks match its shape exactly. It is gone — see empty-turn-guard.
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
    `is nothing left to say, end the turn with an entirely empty reply instead — zero ` +
    `characters, a complete and valid ending. Write no stand-in for that silence: a ` +
    `bracketed status note, a written statement that you are staying silent, a lone "." ` +
    `and a stray token like this one are all output, and all reach the user as a message. Parentheses are for real ` +
    `asides inside a sentence you are genuinely saying, never a channel for narrating your own output. If the stray token may ` +
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
    `When everything is delivered and there is nothing left to say, end the turn with an ` +
    `entirely empty reply instead — zero characters, a complete and valid ending — and ` +
    `write no stand-in for the silence. A lone \`.\`, \`…\` or \`-\` is output, and so is any ` +
    `written note that stands in for saying nothing — a parenthesis does not make it out-of-band, ` +
    `and however well-reasoned such a note reads, writing it IS the failure it describes. ` +
    `If you wrote it deliberately as content, disregard this.`
  )
}

/**
 * Longest bracketed stand-in still read as a faked silence, measured inside
 * the brackets. Generous compared with the punctuation cap because the shape
 * itself — a bracketed group alone on its own line, whose whole content is a
 * phrase from the vocabulary below — carries the signal; the length only
 * keeps a long parenthetical aside from ever being scanned.
 */
const SILENCE_PLACEHOLDER_MAX_CHARS = 40

/**
 * A bracketed group that IS the whole reply, or that sits alone on the reply's
 * last line. Both shapes have shipped to users: the stand-in as the entire
 * message, and the stand-in appended under real prose. A group in the middle
 * of a sentence ("the command printed nothing (no output) and exited 0") is
 * never a match — an ordinary parenthetical is content, and reading it as a
 * leak would spend a tail line telling the model off for writing English.
 */
const BRACKETED_TAIL = /(?:^|\n)[ \t]*([([{<（【][^\n]{1,40}?[)\]}>）】])[ \t]*$/u

/**
 * The vocabulary of silence. Deliberately an allowlist of phrases that mean
 * "this message is the absence of a message" and nothing else: `(none)`,
 * `(n/a)` and `(end)` are OFF it, because each has an ordinary use as real
 * content ("Blockers: (none)"). A missed leak costs one stray line the model
 * is told about the next time it does it; a false positive spends a tail line
 * arguing with a model that was writing normally.
 */
const SILENCE_PHRASE =
  /^(?:no\s+(?:content|output|reply|response|text|message|further\s+(?:content|output|reply|response|text|message|comment))|nothing(?:\s+(?:to\s+add|to\s+say|further|more|else))?|empty(?:\s+(?:reply|response|message))?|silence|silent|staying\s+silent|end\s+of\s+(?:turn|reply|response|message))[\s.!…]*$/iu

/** A faked silence typed as a bracketed placeholder, and where it sat. */
export type SilencePlaceholder = { text: string; trailing: boolean }

/**
 * The bracketed stand-in for silence in `text`, or null when the reply carries
 * none.
 *
 * This is the third shape of the one failure this file exists for, and the one
 * that kept getting through: a model that means "nothing to add" but cannot
 * emit a zero-token content channel types a short bracketed phrase instead.
 * Observed live as `(no output)` on 2026-09-12 (appended under real prose,
 * twice in one conversation) and `(no content)` on 2026-09-14. Neither the
 * control-token list (these carry no tokenizer marker) nor the punctuation
 * check (these are words) saw either one, so nothing ever told the model.
 *
 * Brackets are REQUIRED. An unbracketed "Nothing to add." as an entire reply
 * is a legitimate answer to a question, and this guard must never second-guess
 * a model that answered one.
 */
export function silencePlaceholder(text: string): SilencePlaceholder | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const match = BRACKETED_TAIL.exec(trimmed)
  if (!match) return null
  const group = match[1]
  const inner = group.slice(1, -1).trim()
  if (inner.length === 0 || inner.length > SILENCE_PLACEHOLDER_MAX_CHARS) return null
  if (!SILENCE_PHRASE.test(inner)) return null
  return { text: group, trailing: group !== trimmed }
}

/**
 * The runtime-tail notice for a bracketed stand-in. Echoes the exact group
 * back, the way the control-token notice echoes its token: the model wrote it
 * one call ago and it is still sitting in its own history above, so quoting it
 * here teaches nothing it has not already demonstrated to itself — while
 * naming it is the only way the model can tell which characters are meant.
 *
 * The two positions get different copy because they are different mistakes. A
 * placeholder ALONE is a reply sent in place of silence; a placeholder after
 * prose is a marker stapled onto a reply that had already finished.
 */
export function silencePlaceholderNotice(placeholder: SilencePlaceholder): string {
  const where = placeholder.trailing
    ? `you closed your previous reply with \`${placeholder.text}\` on its own line, after prose that had already ` +
      `said everything — so the user got a real answer with a stray marker stapled to the end of it. A substantive ` +
      `reply ends at its last real character; nothing is appended to close it.`
    : `your entire previous reply was \`${placeholder.text}\` — a written stand-in for saying nothing, delivered ` +
      `to the user as a message of its own. To them it reads as a glitch, not as silence.`
  return (
    `SILENCE-PLACEHOLDER SIGNAL: ${where} ` +
    `Nothing is ever structurally required in your reply. When everything is delivered and there is nothing left ` +
    `to say, end the turn with an entirely empty reply — zero characters, a complete and valid ending — and write ` +
    `no stand-in for it: a bracketed status note, a written statement that you are staying silent, a lone ` +
    `punctuation mark and a stray control token are all output, and all reach the user. Parentheses do not make ` +
    `a note out-of-band — they are for real asides inside a sentence you are genuinely saying — and however ` +
    `well-reasoned the note is, writing it IS the failure it describes. ` +
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

/**
 * Arm the silence-placeholder notice. Shares the same slot as the other two,
 * for the same reason: one line rides the tail per call, all three say "you
 * faked silence, here is the real exit", and no reply is two of these at once
 * (a control token and a bracketed phrase are different characters, and
 * neither is punctuation-only).
 */
export function armSilencePlaceholderNotice(
  conversationId: string | null,
  placeholder: SilencePlaceholder
): void {
  if (!conversationId) return
  pending.set(conversationId, silencePlaceholderNotice(placeholder))
}

/** Drain (return and clear) the pending notice, or undefined when none. */
export function drainControlTokenNotice(conversationId: string | null): string | undefined {
  if (!conversationId) return undefined
  const notice = pending.get(conversationId)
  if (notice !== undefined) pending.delete(conversationId)
  return notice
}
