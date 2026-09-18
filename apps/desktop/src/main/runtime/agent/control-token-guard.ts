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
 * iteration to tell), so an armed notice survives the turn and is drained by
 * the next model call — ANY next model call, in any conversation. One global
 * slot, not one per conversation.
 *
 * That is deliberate, and it is the whole reason this guard does anything at
 * all for autonomous work. A heartbeat, procedure or automation run mints a
 * FRESH sealed conversation per run (see `processAutonomous`) and ends after a
 * single turn, so a notice keyed by conversation was armed into a conversation
 * that would never make another model call and was silently dropped — the
 * guard detected every scheduled-run leak and told nobody. Observed live
 * 2026-09-17: deepseek-flash closed a heartbeat run with a literal
 * `[Empty response]`, the placeholder check matched it, and the notice died
 * with the conversation. The model is one model across conversations; the
 * lesson travels with it even when the conversation does not.
 *
 * Delivery into a DIFFERENT conversation carries one extra clause, because the
 * quoted reply is not in the history the model is looking at and the user
 * there never saw it: carry the rule forward, raise nothing here. Without that
 * clause a cross-conversation notice invites an apology to the wrong person
 * for a message they cannot see.
 *
 * Draining is gated to the same roles that arm — worker text never reaches the
 * user, so a worker must not consume the one notice the master is owed.
 *
 * In-memory only, like the channels' pending format notices — a restart
 * forgets an undelivered notice, which costs nothing (advisory).
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

/**
 * The same vocabulary in the script the models actually think in.
 *
 * The lane is not all English-lab: DeepSeek is the seeded default, and the
 * router forwards to whatever OpenAI-compatible hosts a deployment wires in —
 * so a model reaching for the smallest stand-in it can find reaches for the
 * one in its own language, not the English one. Observed live 2026-09-18:
 * deepseek-flash closed a heartbeat run with a bare `空空如也` ("utterly
 * empty"), four characters and four output tokens, the entire final reply of
 * the run — the English-only check below saw nothing, so the model was never
 * told and the user got Chinese at the end of an English conversation. The
 * runtime had just ORDERED that silence, too; see todo-guard for that half of
 * the fix.
 *
 * Brackets are deliberately NOT required here, unlike the English path. The
 * asymmetry is not an oversight: an unbracketed "Nothing to add." is a
 * legitimate English answer to a question and must never be second-guessed,
 * whereas these are set phrases whose entire job is to stand in for an absent
 * message, and a reply that is nothing but one of them — in a conversation
 * conducted in another language — has never been anything else.
 *
 * Simplified and traditional forms both appear because the labs differ on
 * which they emit. Single characters (`空`, `无`) stay OFF the list for the same
 * reason `(none)` is off the English one: each has an ordinary use as real
 * content, and a false positive spends a tail line arguing with a model that
 * was writing normally.
 */
const CJK_SILENCE_PHRASES = [
  '空空如也', // "utterly empty" — the observed leak
  '空无一物',
  '空無一物',
  '无内容',
  '無內容',
  '无输出',
  '無輸出',
  '无回复',
  '無回覆',
  '无响应',
  '無響應',
  '没有内容',
  '沒有內容',
  '没有输出',
  '沒有輸出',
  '无更多内容',
  '無更多內容',
  '无话可说',
  '無話可說',
  '没什么可说的',
  '沒什麼可說的',
  '无需回复',
  '無需回覆',
  '空回复',
  '空回覆',
  '保持沉默',
  '沉默'
]

/** Bracket pairs the models reach for, ASCII and full-width/CJK alike. */
const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['（', '）'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['〔', '〕']
]

/** Trailing sentence punctuation, both widths — a stand-in often wears one. */
const TRAILING_PUNCTUATION = /[\s.。!！?？…、,，:：;；~～-]+$/u

/** `text` with one matched bracket pair peeled off, or `text` unchanged. */
function unwrapBrackets(text: string): string {
  for (const [open, close] of BRACKET_PAIRS) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, -close.length).trim()
    }
  }
  return text
}

/**
 * The CJK stand-in in `text`, or null. Matches the whole reply or a line that
 * sits alone at its end — the same two positions as the English check, since
 * both shapes have shipped: the phrase as the entire message, and the phrase
 * stapled under real prose. A phrase inside a sentence is content and never
 * matches.
 */
function cjkSilencePlaceholder(text: string): SilencePlaceholder | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
  if (lastLine === '') return null
  const bare = unwrapBrackets(lastLine).replace(TRAILING_PUNCTUATION, '').trim()
  if (!CJK_SILENCE_PHRASES.includes(bare)) return null
  return { text: lastLine, trailing: lastLine !== trimmed }
}

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
 * Brackets are REQUIRED for the English vocabulary. An unbracketed "Nothing to
 * add." as an entire reply is a legitimate answer to a question, and this guard
 * must never second-guess a model that answered one. The CJK set phrases
 * checked first carry no such ambiguity, so they match bare — see
 * CJK_SILENCE_PHRASES for why the asymmetry is deliberate.
 */
export function silencePlaceholder(text: string): SilencePlaceholder | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const cjk = cjkSilencePlaceholder(trimmed)
  if (cjk) return cjk
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

/**
 * The clause appended when the notice is delivered in a different conversation
 * from the one the leak happened in. It has to override, not soften, the base
 * notice's "clear it up with the user" advice: here there is no stray
 * character on screen and no user who saw one.
 */
const ELSEWHERE_CLAUSE =
  'That reply was in a DIFFERENT conversation from this one — it is not in the history above, ' +
  'and the user you are talking to now never saw it. Do not mention it, apologise for it or ' +
  'try to clear it up here; there is nothing here to clear up. Carry the rule forward, nothing else.'

/** The one pending notice — armed at the leak, drained by the next model call anywhere. */
let pending: { conversationId: string | null; notice: string } | null = null

/**
 * Arm the notice for the next model call (latest leak wins).
 *
 * A single slot, deliberately global: see the header. The conversation id is
 * remembered only to decide which wording the drain hands back, never to
 * decide whether the notice is delivered at all.
 */
export function armControlTokenNotice(conversationId: string | null, token: string): void {
  pending = { conversationId, notice: controlTokenNotice(token) }
}

/**
 * Arm the content-free-reply notice. Shares the control token's slot on
 * purpose: both notices say "you faked silence, here is the real exit", only
 * one line can ride the tail per call, and the two shapes never co-occur in a
 * single reply (a control token contains letters, so it is never punctuation-
 * only). Latest leak wins, as above.
 */
export function armContentFreeReplyNotice(conversationId: string | null, reply: string): void {
  pending = { conversationId, notice: contentFreeReplyNotice(reply) }
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
  pending = { conversationId, notice: silencePlaceholderNotice(placeholder) }
}

/**
 * Drain (return and clear) the pending notice, or undefined when none.
 *
 * Delivers wherever the next model call happens — the leak is the model's, not
 * the conversation's. `conversationId` only selects the wording: the same
 * conversation gets the notice as written (the stray characters are in the
 * history above, and the user there did see them), any other gets it plus the
 * clause that says so.
 */
export function drainControlTokenNotice(conversationId: string | null): string | undefined {
  const leak = pending
  if (!leak) return undefined
  pending = null
  const sameConversation =
    leak.conversationId !== null &&
    conversationId !== null &&
    leak.conversationId === conversationId
  return sameConversation ? leak.notice : `${leak.notice} ${ELSEWHERE_CLAUSE}`
}
