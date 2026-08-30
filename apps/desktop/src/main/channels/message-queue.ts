import type { MessageAttachment } from '@main/conversations'

/**
 * A user message parked while that chat's turn was still running.
 *
 * This is the channel-side twin of the in-app composer's `queuedPrompts`
 * (Chat.tsx): a message that arrives mid-turn is ACCEPTED and held in order,
 * then dispatched as its own turn the moment the chat frees up — replacing the
 * old "hold on, I'm busy" decline that made the user resend by hand.
 *
 * Media is already DOWNLOADED and saved into the conversation's uploads folder
 * before it lands here. Channel file handles are short-lived (Telegram's
 * `file_path` expires; WhatsApp's media keys live on the inbound message we no
 * longer hold at flush time), so deferring the fetch would leave a queued
 * photo undeliverable minutes later. `attachments` therefore always carry real
 * on-disk paths, and a flushed message goes through the SAME
 * dispatch → composeAttachmentContext → processHistoryAttachments pipeline an
 * unqueued one does — the model cannot tell the two apart, and the in-app feed
 * renders the user bubble with its file chips the moment the turn starts.
 */
export type QueuedMessageBase = {
  /** Stable id for the entry. Diagnostics only — never shown to the user. */
  id: string
  text: string
  attachments: MessageAttachment[]
  /**
   * Voice notes carry the same two flags the unqueued path hands dispatchTurn:
   * the transcript is the prompt and the audio stays out of the LLM history.
   */
  voicePrompt?: boolean
  voiceLang?: string
}

/**
 * Per-chat FIFO of parked messages. Deliberately dumb — ordering and storage
 * only. Every policy decision (when a chat counts as busy, when to drain, what
 * to tell the user) lives in the channel that owns the queue, because those
 * rules differ: Telegram gates on `activeByChat`, WhatsApp on `activeByJid`
 * plus its synchronous `dispatchingByJid` claim.
 *
 * In-memory only. A queue does not survive an app restart or a channel
 * stop/start — same trade the in-app queue makes, and the messages themselves
 * are still sitting in the user's phone chat if they want to resend.
 */
export class ChannelMessageQueue<K, T extends QueuedMessageBase> {
  private readonly byKey = new Map<K, T[]>()

  /** Append and return the resulting depth (what the ack reports). */
  enqueue(key: K, item: T): number {
    const list = this.byKey.get(key)
    if (list) {
      list.push(item)
      return list.length
    }
    this.byKey.set(key, [item])
    return 1
  }

  /**
   * Put an item back at the FRONT. Used only when a flush attempt could not
   * start a turn after all (the chat re-armed under us), so the message keeps
   * its place in line instead of being re-appended behind later arrivals.
   */
  requeue(key: K, item: T): void {
    const list = this.byKey.get(key)
    if (list) list.unshift(item)
    else this.byKey.set(key, [item])
  }

  /** Pop the head, dropping the bucket once empty so the map stays small. */
  shift(key: K): T | undefined {
    const list = this.byKey.get(key)
    if (!list || list.length === 0) return undefined
    const next = list.shift()
    if (list.length === 0) this.byKey.delete(key)
    return next
  }

  size(key: K): number {
    return this.byKey.get(key)?.length ?? 0
  }

  /** Drop everything queued for one chat and report how many were dropped. */
  clear(key: K): number {
    const count = this.byKey.get(key)?.length ?? 0
    this.byKey.delete(key)
    return count
  }

  /** Channel teardown — a stopped bot must not resurrect a stale queue. */
  clearAll(): void {
    this.byKey.clear()
  }
}

/**
 * What the user is told the instant their mid-turn message is accepted.
 *
 * Plain conversational text with no Markdown: it is delivered verbatim to a
 * phone chat, and WhatsApp renders none of it. Reports the file count and the
 * resulting queue depth so the user can see, without asking, that nothing was
 * dropped and how much is stacked up.
 */
export function queuedAckText(depth: number, attachmentCount: number): string {
  const files =
    attachmentCount === 0
      ? ''
      : attachmentCount === 1
        ? ' with 1 file'
        : ` with ${attachmentCount} files`
  const waiting = depth <= 1 ? "It's next in line." : `${depth} messages are now waiting in order.`
  return `📥 Queued${files}. ${waiting} I'll get to it as soon as the current task finishes. Send /cancel to drop everything queued.`
}

/** Reply to /cancel. Depth is what was actually dropped. */
export function queueClearedText(dropped: number): string {
  return dropped === 1 ? '🗑 Dropped 1 queued message.' : `🗑 Dropped ${dropped} queued messages.`
}

/**
 * Reply to /cancel when nothing was queued. `running` points a user who meant
 * "abort what you're doing" at the command that actually does that — /cancel
 * used to be a /stop alias on Telegram, so the habit exists.
 */
export function queueEmptyText(running: boolean): string {
  return running
    ? 'Nothing queued. The task still running is stopped with /stop.'
    : 'Nothing queued.'
}

/** Trailing note appended to /stop so a pending queue is never a surprise. */
export function queuePendingNote(depth: number): string {
  if (depth <= 0) return ''
  return depth === 1
    ? '\n\n1 queued message will run next — /cancel drops it.'
    : `\n\n${depth} queued messages will run next — /cancel drops them.`
}
