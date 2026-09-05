import {
  updateConversation,
  type ConversationChannel,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'

/**
 * Mid-turn durability for in-app turns — the reason a machine that reboots
 * mid-run comes back with the run instead of with the prompt alone.
 *
 * An in-app turn used to reach disk EXACTLY ONCE, at the fold: the renderer
 * owns the transcript and only calls conversation:save on chat:done /
 * chat:error. Everything before that lived in two volatile places — the
 * renderer's React state and this process's AssistantAccumulator — so a turn
 * that ran forty minutes and twenty tool calls had written nothing. The one
 * artifact on disk was the titler shell (title + the FIRST user message), and
 * a crash, a kill, or a Windows restart left exactly that: the user's prompt,
 * no answer, no timeline. Worse on a second turn, where the titler early-
 * returns on the already-titled file and not even the prompt is written.
 *
 * The checkpoint closes that window. The main process already builds the whole
 * assistant message segment by segment (the phone mirror's accumulator); this
 * writes that same message — plus the turn's user message — to the same file
 * the renderer will save, under the SAME message ids, so the two are one
 * message under the id-keyed merge and the fold replaces the checkpoint rather
 * than duplicating it.
 *
 * Cloud-first, on TWO cadences. Every tick writes to disk (cheap, local, and
 * what a relaunch on this machine reads back). Only some ticks arm the cloud
 * push: a server record id embeds the message's content hash, so pushing every
 * version of a message that is rewritten dozens of times over one long turn
 * would land dozens of rows where the turn deserves one or two. The push
 * cadence is minutes; the final flush and the shutdown flush always push. A
 * device that never comes back therefore hands the org the run as of at most
 * CLOUD_PUSH_FLOOR_MS ago, while this machine's own disk has all of it.
 *
 * Cadence is split by what the segment costs to lose:
 *  - STRUCTURAL (tool call, tool result, task/workflow snapshot, turn_end) —
 *    the slow, expensive, unrepeatable parts of a run. Sub-second floor.
 *  - TEXT (prose and reasoning deltas) — cheap to lose a sentence of, and
 *    arriving per token. A multi-second floor keeps a fast stream from
 *    thrashing the disk with whole-file rewrites.
 * Both are throttled trailing-edge and skip when nothing changed since the
 * last write, so the long waits inside a tool call cost nothing at all.
 */
const STRUCTURAL_FLOOR_MS = 750
const TEXT_FLOOR_MS = 4_000
/**
 * Min gap between checkpoint writes that arm a cloud push. Far longer than the
 * disk floors above: the disk pays a file rewrite, the org pays a permanent
 * record row per distinct version of the message.
 */
const CLOUD_PUSH_FLOOR_MS = 120_000

export type CheckpointKind = 'structural' | 'text'

/**
 * Upsert messages into a conversation BY ID, inside the file's write queue.
 *
 * Not a whole-file save: this writer owns only the messages it names, and only
 * for as long as nobody better has written them. Everything else in the file —
 * title, summary, stats, project binding, the other messages — is left exactly
 * as found, which is what lets this run concurrently with the titler, the
 * summarizer and the renderer's own save without any of them having to know
 * about it.
 *
 * Two rules keep a late checkpoint from ever degrading a finished message:
 *
 *  - a USER message is written once and never rewritten. The prompt is
 *    immutable, and this writer's copy is reconstructed from the wire history
 *    (undressed of the `<attachments>` / `<voice_note>` scaffolding), so
 *    whatever the renderer or the titler shell already wrote is at least as
 *    good.
 *  - an ASSISTANT message is replaced only while the copy on disk is still
 *    marked `interrupted` — i.e. only ever a checkpoint replacing its own
 *    earlier checkpoint. Once the fold has landed (the renderer never writes
 *    the mark), this writer stands down for good. That matters because the
 *    renderer's copy is genuinely richer: it carries the approval cards, the
 *    per-tool timings, and the subagent `worker` segments the main-side
 *    accumulator deliberately never collects. The alternative — preserving
 *    those fields one by one — is a list that silently rots every time a new
 *    field is added to a message.
 *
 * Returns without writing when nothing changed, so a turn parked in a long
 * tool call doesn't churn `updatedAt` — or schedule a sync push — per tick.
 */
export async function checkpointConversationMessages(
  id: string,
  messages: ConversationMessage[],
  seed?: {
    channel?: ConversationChannel
    projectId?: string | null
    model?: string | null
    title?: string
    /** Arm this conversation's cloud push (see CLOUD_PUSH_FLOOR_MS). */
    notifySync?: boolean
  }
): Promise<void> {
  const incoming = messages.filter((m): m is ConversationMessage => !!m && !!m.id)
  if (incoming.length === 0) return

  await updateConversation(
    id,
    (disk) => {
      const now = Date.now()
      // No file yet — the first turn of a conversation, checkpointing before the
      // titler's shell landed. Seed a minimal one; the titler's own update takes
      // the `disk exists` branch afterwards and names it, and the renderer's fold
      // fills in model/stats/working folders.
      const current: ConversationFile = disk ?? {
        id,
        title: seed?.title ?? 'Untitled',
        model: seed?.model ?? null,
        messages: [],
        createdAt: now,
        updatedAt: now,
        ...(seed?.channel ? { channel: seed.channel } : {}),
        ...(seed?.projectId ? { projectId: seed.projectId } : {})
      }

      let changed = disk === null
      const next = [...current.messages]
      for (const message of incoming) {
        const at = next.findIndex((m) => m.id === message.id)
        if (at < 0) {
          next.push(message)
          changed = true
          continue
        }
        // Already on disk. Only a checkpoint's own earlier copy may be replaced
        // — see the two rules above.
        if (message.role !== 'assistant' || !next[at].interrupted) continue
        if (JSON.stringify(next[at]) === JSON.stringify(message)) continue
        next[at] = message
        changed = true
      }
      // Nothing to change — but a caller that is arming the cloud push needs a
      // write to hang it on (the hook fires on writes only), so an unchanged
      // state the org has not seen is re-written rather than skipped. Between
      // push ticks this is the pure no-op that keeps a parked turn free.
      if (!changed && seed?.notifySync !== true) return null

      current.messages = next
      current.updatedAt = now
      // A checkpoint is, by definition, a turn that has not ended. A sealed
      // conversation being written into again is a live conversation.
      if (current.sealed) current.sealed = false
      return current
    },
    { notifySync: seed?.notifySync !== false }
  )
}

/**
 * One turn's checkpointer. Owns the throttle timers for that turn and nothing
 * else; the caller supplies the current assistant message on every tick (the
 * accumulator is the caller's) and disposes this when the turn is released.
 */
export class TurnCheckpoint {
  private timer: NodeJS.Timeout | null = null
  private timerKind: CheckpointKind | null = null
  private lastWriteAt = 0
  /** When a write last armed the cloud push — zero so the first one always does. */
  private lastPushAt = 0
  /** The last state actually handed to the sync scheduler — see write(). */
  private lastPushed: string | null = null
  private writing: Promise<void> = Promise.resolve()
  private disposed = false
  /** Serialized copy of what the last write carried — the no-op guard. */
  private lastWritten: string | null = null

  constructor(
    private readonly conversationId: string,
    private readonly seed: {
      channel?: ConversationChannel
      projectId?: string | null
      model?: string | null
    },
    /** The turn's user message, re-sent on every tick so it lands even if the
     *  first write raced the titler shell that would otherwise carry it. */
    private readonly userMessage: ConversationMessage | null,
    /** The assistant message as it stands right now, or null before there is one. */
    private readonly assistantMessage: () => ConversationMessage | null,
    /** False once the turn is released — a trailing tick must never write over
     *  the renderer's fold with this process's poorer copy. */
    private readonly isLive: () => boolean
  ) {}

  /** Write the user message now, ahead of the first token. */
  promptNow(): void {
    void this.write(false)
  }

  /** Note a segment; write now or on this kind's floor, whichever is later. */
  touch(kind: CheckpointKind): void {
    if (this.disposed) return
    const floor = kind === 'structural' ? STRUCTURAL_FLOOR_MS : TEXT_FLOOR_MS
    const since = Date.now() - this.lastWriteAt
    if (since >= floor) {
      this.clearTimer()
      void this.write(false)
      return
    }
    // A structural tick supersedes a pending text tick — it must not wait out
    // the slower floor.
    if (this.timer && !(kind === 'structural' && this.timerKind === 'text')) return
    this.clearTimer()
    this.timerKind = kind
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerKind = null
      void this.write(false)
    }, floor - since)
    this.timer.unref?.()
  }

  /**
   * Write the turn as it stands, now, and resolve once it is on disk.
   *
   * `final` drops the interrupted mark — the turn ENDED and the message is
   * whole (onDone / onError, so a turn whose renderer never folds is still
   * saved). `push` arms the cloud push regardless of its cadence — the
   * shutdown flush, where there is no later tick to carry it.
   */
  async flush(opts: { final?: boolean; push?: boolean } = {}): Promise<void> {
    this.clearTimer()
    await this.write(opts.final === true, opts.push === true)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.timerKind = null
  }

  private write(final: boolean, push = false): Promise<void> {
    // A final flush is allowed to land after release — that IS the release
    // path. Everything else stops at the fold.
    if (!final && (this.disposed || !this.isLive())) return this.writing
    const assistant = this.assistantMessage()
    const messages: ConversationMessage[] = []
    if (this.userMessage) messages.push(this.userMessage)
    if (assistant) {
      messages.push(final ? assistant : { ...assistant, interrupted: true })
    }
    if (messages.length === 0) return this.writing

    const fingerprint = JSON.stringify(messages)
    const now = Date.now()
    // The org hears about the turn on its own, much slower cadence — and
    // always when the turn ends or the app is going down.
    const notifySync = final || push || now - this.lastPushAt >= CLOUD_PUSH_FLOOR_MS
    const unchanged = fingerprint === this.lastWritten
    // Nothing new to write AND nothing owed to the org. The second half is
    // what makes a shutdown flush of an unmoved turn still reach the server:
    // the push rides an actual write, so a state the org has not seen has to
    // be re-written to be sent, even though the bytes are identical.
    if (unchanged && !(notifySync && fingerprint !== this.lastPushed)) return this.writing
    this.lastWritten = fingerprint
    this.lastWriteAt = now
    if (notifySync) {
      this.lastPushAt = now
      this.lastPushed = fingerprint
    }
    // Serialize this turn's own writes so a burst can't queue a pile of
    // whole-file rewrites behind each other.
    this.writing = this.writing
      .catch(() => undefined)
      .then(() =>
        checkpointConversationMessages(this.conversationId, messages, {
          ...this.seed,
          notifySync
        }).catch(() => undefined)
      )
    return this.writing
  }
}
