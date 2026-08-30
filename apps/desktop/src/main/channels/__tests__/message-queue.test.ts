/**
 * Channel mid-turn message QUEUE — replaces the old "hold on, I'm busy"
 * decline on Telegram/WhatsApp with the in-app composer's queue semantics.
 *
 * Two layers under test:
 *  - ChannelMessageQueue + its copy helpers (pure unit).
 *  - The REAL TelegramChannel driven against a REAL TurnRunner, with only
 *    agent.respond / thalamus.title and the grammY bot api stubbed. That is
 *    where the bugs actually live: the flush rides the same end-of-turn
 *    cleanup that releases the per-chat slot, and it has to survive the
 *    microtask window where the slot is free but the runner lane is not.
 *
 * Covers: park + ack depth, FIFO drain order, media surviving the queue onto
 * the persisted user message (what the in-app feed renders and the model
 * reads), /cancel, queue-survives-/stop, and queue-cleared-on-/new.
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/message-queue.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-mqueue-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, label: string, tries = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`waitFor timed out: ${label}`)
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r as () => void
  })
  return { promise, resolve }
}

const CHAT_ID = 4242
const USER_ID = 7

async function run(): Promise<void> {
  // ── Layer 1: the queue container + copy ────────────────────────────────
  {
    const {
      ChannelMessageQueue,
      queuedAckText,
      queueClearedText,
      queueEmptyText,
      queuePendingNote
    } = await import('@main/channels/message-queue')

    type Item = { id: string; text: string; attachments: [] }
    const q = new ChannelMessageQueue<number, Item>()
    const mk = (t: string): Item => ({ id: t, text: t, attachments: [] })

    ok('queue: empty size 0', q.size(1) === 0)
    ok('queue: enqueue returns depth 1', q.enqueue(1, mk('a')) === 1)
    ok('queue: enqueue returns depth 2', q.enqueue(1, mk('b')) === 2)
    ok('queue: other key isolated', q.size(2) === 0)
    ok('queue: FIFO head is a', q.shift(1)?.text === 'a')
    q.requeue(1, mk('a'))
    ok('queue: requeue restores head', q.shift(1)?.text === 'a', 'requeue must unshift, not push')
    ok('queue: b still queued', q.size(1) === 1)
    ok('queue: clear reports count', q.clear(1) === 1)
    ok('queue: clear empties', q.size(1) === 0)
    ok('queue: shift on empty is undefined', q.shift(1) === undefined)
    q.enqueue(9, mk('z'))
    q.clearAll()
    ok('queue: clearAll wipes every key', q.size(9) === 0)

    ok('copy: depth 1 no files', queuedAckText(1, 0).includes("It's next in line."))
    ok('copy: depth 3 counts', queuedAckText(3, 0).includes('3 messages are now waiting'))
    ok('copy: 1 file singular', queuedAckText(1, 1).includes('with 1 file.'))
    ok('copy: 2 files plural', queuedAckText(1, 2).includes('with 2 files'))
    ok('copy: ack names /cancel', queuedAckText(1, 0).includes('/cancel'))
    ok('copy: cleared singular', queueClearedText(1).includes('1 queued message.'))
    ok('copy: cleared plural', queueClearedText(4).includes('4 queued messages.'))
    ok('copy: empty + running points at /stop', queueEmptyText(true).includes('/stop'))
    ok('copy: empty + idle stays terse', queueEmptyText(false) === 'Nothing queued.')
    ok('copy: no pending note at 0', queuePendingNote(0) === '')
    ok('copy: pending note at 2', queuePendingNote(2).includes('2 queued messages will run next'))
  }

  // ── Layer 2: real TelegramChannel + real TurnRunner ────────────────────
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { TelegramChannel } = await import('@main/channels/telegram/channel')
  const { loadConversation } = await import('@main/conversations')
  const { getConversationIdForChat } = await import('@main/channels/telegram/conversations')

  /** Prompt text → gate that holds that turn open until we release it. */
  const gates = new Map<string, ReturnType<typeof deferred>>()
  /** Prompt text, in the order respond() actually saw it. */
  const responded: string[] = []
  const startedGate = new Map<string, ReturnType<typeof deferred>>()

  const corpus = new Corpus({ devLog: false })
  const agent = {
    corpus,
    thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Queue Test' }) },
    motor: { stopTask: async (): Promise<void> => undefined },
    respond: async (turn: {
      turnId: string
      onSegment: (s: Record<string, unknown>) => void
      history: Array<{ content: string }>
      signal?: AbortSignal
    }): Promise<{ stopReason: string; toolCalls: number }> => {
      const last = String(turn.history[turn.history.length - 1]?.content ?? '')
      // The dispatched content is the composed attachment context, so match on
      // the prompt PREFIX rather than equality.
      const tag = last.split('\n')[0].trim()
      responded.push(tag)
      turn.onSegment({ kind: 'text', turnId: turn.turnId, segmentId: 's1', delta: `ok:${tag}` })
      startedGate.get(tag)?.resolve()
      const gate = gates.get(tag)
      if (gate) await gate.promise
      turn.onSegment({
        kind: 'turn_end',
        turnId: turn.turnId,
        segmentId: 's2',
        stopReason: turn.signal?.aborted ? 'canceled' : 'end_turn',
        iterationCount: 1
      })
      return { stopReason: turn.signal?.aborted ? 'canceled' : 'end_turn', toolCalls: 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  const localProvider = { isReady: false }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = new TelegramChannel(agent as any, runner, localProvider as any)

  /** Everything the bot sent to the chat, in order. */
  const outbox: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ch = channel as any
  let messageId = 1000
  const api = {
    sendMessage: async (_chatId: number, text: string) => {
      outbox.push(text)
      return { message_id: ++messageId }
    },
    sendChatAction: async (): Promise<boolean> => true
  }
  ch.bot = { api }
  ch.allowedUserIds = new Set([USER_ID])

  const ctx = {
    from: { id: USER_ID },
    chat: { id: CHAT_ID },
    message: { text: '', message_id: 1 },
    api
  }
  const send = (text: string): Promise<void> =>
    ch.handleTextMessage({ ...ctx, message: { text, message_id: ++messageId } })

  const acks = (): string[] => outbox.filter((t) => t.includes('Queued'))
  const convMessages = async (): Promise<
    Array<{ role: string; content: string; attachments?: unknown[] }>
  > => {
    const id = await getConversationIdForChat(CHAT_ID)
    if (!id) return []
    const conv = await loadConversation(id)
    return (conv?.messages ?? []) as Array<{
      role: string
      content: string
      attachments?: unknown[]
    }>
  }

  // ── 1. Two messages sent mid-turn are parked, acked, and drained in order ──
  {
    gates.set('first', deferred())
    startedGate.set('first', deferred())
    void send('first')
    await startedGate.get('first')!.promise

    await send('second')
    await send('third')

    ok('park: two acks emitted', acks().length === 2, JSON.stringify(acks()))
    ok('park: first ack says next in line', acks()[0]?.includes("It's next in line."), acks()[0])
    ok(
      'park: second ack reports depth 2',
      acks()[1]?.includes('2 messages are now waiting'),
      acks()[1]
    )
    ok('park: neither ran yet', responded.length === 1, JSON.stringify(responded))
    ok('park: no busy decline sent', !outbox.some((t) => t.includes('Hold on')))

    gates.get('first')!.resolve()
    await waitFor(() => responded.length === 3, 'queue drained')
    ok(
      'drain: FIFO order preserved',
      responded.join(',') === 'first,second,third',
      responded.join(',')
    )
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle')
    await tick()

    const msgs = await convMessages()
    const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content)
    ok(
      'drain: all three persisted in order',
      userTexts.join(',') === 'first,second,third',
      userTexts.join(',')
    )
  }

  // ── 2. Media survives the queue onto the persisted user message ────────
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()
    gates.set('busy2', deferred())
    startedGate.set('busy2', deferred())
    void send('busy2')
    await startedGate.get('busy2')!.promise

    // Stands in for a downloaded photo: the media handlers save the blob and
    // hand the resulting attachment to enqueueMessage exactly like this.
    const attachment = {
      id: 'att_1',
      type: 'image',
      filePath: '/tmp/queued-photo.png',
      originalName: 'queued-photo.png',
      mimeType: 'image/png',
      sizeBytes: 1234
    }
    await ch.enqueueMessage(CHAT_ID, {
      id: 'q_media',
      userId: USER_ID,
      ctx,
      text: 'look at this',
      attachments: [attachment]
    })
    ok('media: ack counts the file', acks()[0]?.includes('with 1 file'), acks()[0])

    gates.get('busy2')!.resolve()
    await waitFor(() => responded.includes('look at this'), 'media turn ran')
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after media')
    await tick()

    const msgs = await convMessages()
    const mediaMsg = msgs.find((m) => m.role === 'user' && m.content === 'look at this')
    ok('media: user message persisted', !!mediaMsg)
    ok(
      'media: attachment rides the persisted message',
      mediaMsg?.attachments?.length === 1,
      JSON.stringify(mediaMsg?.attachments)
    )
    ok(
      'media: model saw the attachment context',
      responded.includes('look at this'),
      JSON.stringify(responded)
    )
  }

  // ── 3. /cancel drops the queue and leaves the running turn alone ───────
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()
    gates.set('busy3', deferred())
    startedGate.set('busy3', deferred())
    void send('busy3')
    await startedGate.get('busy3')!.promise

    await send('drop-me-1')
    await send('drop-me-2')
    ok('cancel: two parked', ch.queue.size(CHAT_ID) === 2, String(ch.queue.size(CHAT_ID)))

    await send('/cancel')
    ok('cancel: queue emptied', ch.queue.size(CHAT_ID) === 0)
    ok(
      'cancel: reports how many dropped',
      outbox.some((t) => t.includes('Dropped 2 queued messages')),
      JSON.stringify(outbox.slice(-2))
    )
    ok('cancel: running turn untouched', runner.activeTurnCount() === 1)

    gates.get('busy3')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after cancel')
    await tick()
    ok(
      'cancel: dropped messages never ran',
      !responded.includes('drop-me-1') && !responded.includes('drop-me-2'),
      JSON.stringify(responded)
    )

    await send('/cancel')
    ok(
      'cancel: empty queue says so',
      outbox.some((t) => t.includes('Nothing queued')),
      JSON.stringify(outbox.slice(-1))
    )
  }

  // ── 4. /stop keeps the queue (it advances, like the in-app one) ─────────
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()
    gates.set('busy4', deferred())
    startedGate.set('busy4', deferred())
    void send('busy4')
    await startedGate.get('busy4')!.promise

    await send('after-stop')
    ok('stop: one parked', ch.queue.size(CHAT_ID) === 1)

    const stopped = send('/stop')
    // The gate keeps respond() parked until the abort is observed; release it
    // so the aborted turn can unwind exactly as a real cancel does.
    gates.get('busy4')!.resolve()
    await stopped
    ok(
      'stop: reply flags the pending queue',
      outbox.some((t) => t.includes('queued message will run next')),
      JSON.stringify(outbox.filter((t) => t.includes('Stop')))
    )
    await waitFor(() => responded.includes('after-stop'), 'queue advanced past stop')
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after stop')
    ok('stop: queue drained, not dropped', ch.queue.size(CHAT_ID) === 0)
  }

  // ── 5. /new clears the queue — it must not flush into a NEW conversation ──
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()
    const before = await getConversationIdForChat(CHAT_ID)

    // No turn running: park directly, the way a lost race would.
    ch.queue.enqueue(CHAT_ID, {
      id: 'q1',
      userId: USER_ID,
      ctx,
      text: 'stale-1',
      attachments: []
    })
    ch.queue.enqueue(CHAT_ID, {
      id: 'q2',
      userId: USER_ID,
      ctx,
      text: 'stale-2',
      attachments: []
    })

    await send('/new')
    const after = await getConversationIdForChat(CHAT_ID)
    ok('new: rotated to a fresh conversation', !!after && after !== before, `${before} -> ${after}`)
    ok('new: queue cleared', ch.queue.size(CHAT_ID) === 0)
    ok(
      'new: reply says the queue was dropped',
      outbox.some((t) => t.includes('queued messages were dropped')),
      JSON.stringify(outbox.slice(0, 2))
    )
    await tick()
    ok(
      'new: stale messages never ran',
      !responded.includes('stale-1') && !responded.includes('stale-2'),
      JSON.stringify(responded)
    )
  }

  // ── 6. A LONG turn must not produce a "still busy" warning ─────────────
  // The regression: enqueueMessage fired a flush whose wait polls the very
  // map that admitted the message (activeByChat), so on any turn outliving
  // the wait budget it could only expire — and an expiry was counted as a
  // failed dispatch. Three of those warned the user their message hadn't run
  // and pointed them at /stop, on a turn that was healthy and about to
  // answer. Unreachable in this suite before: every simulated turn resolves
  // in milliseconds and the budget is 30s, hence setQueueFlushWait.
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()
    // 3 attempts × (60ms wait + 50ms backoff) ⇒ the old code warns by ~330ms.
    channel.setQueueFlushWait(60)

    gates.set('long-turn', deferred())
    startedGate.set('long-turn', deferred())
    void send('long-turn')
    await startedGate.get('long-turn')!.promise

    await send('queued-behind-a-long-turn')
    ok('long: parked', ch.queue.size(CHAT_ID) === 1, String(ch.queue.size(CHAT_ID)))
    ok(
      'long: no flush loop spins behind our own turn',
      !ch.flushingByChat.has(CHAT_ID),
      'enqueue must not start a wait on the map that just admitted the message'
    )

    // Outlive the old budget several times over.
    await sleep(600)
    ok(
      'long: no "still busy" warning while the turn is healthy',
      !outbox.some((t) => t.includes('Still busy')),
      JSON.stringify(outbox)
    )
    ok('long: still parked, not dropped', ch.queue.size(CHAT_ID) === 1)
    ok('long: did not run early', !responded.includes('queued-behind-a-long-turn'))
    ok('long: the ack is still the only thing said', acks().length === 1, JSON.stringify(outbox))

    gates.get('long-turn')!.resolve()
    await waitFor(() => responded.includes('queued-behind-a-long-turn'), 'long turn queue drained')
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after long turn')
    ok(
      'long: end-of-turn cleanup dispatched it, still no warning',
      !outbox.some((t) => t.includes('Still busy')),
      JSON.stringify(outbox)
    )

    // The other direction: the gate must not swallow the race-closer. With no
    // turn of ours running there is no cleanup coming, so enqueue MUST flush.
    outbox.length = 0
    responded.length = 0
    await ch.enqueueMessage(CHAT_ID, {
      id: 'q_no_turn',
      userId: USER_ID,
      ctx,
      text: 'nobody-is-running',
      attachments: []
    })
    await waitFor(() => responded.includes('nobody-is-running'), 'idle-chat enqueue self-flushed')
    ok('idle: enqueue on a free chat still flushes itself', true)
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after self-flush')

    channel.setQueueFlushWait(30_000)
  }

  // ── 7. A REJECTED render chain still releases the chat and drains ──────
  // The gate in section 6 rests on "a running turn's cleanup always flushes".
  // That cleanup hangs off the render chain, so a rejected chain used to skip
  // it entirely: activeByChat leaked, the chat read as busy forever, and every
  // later message parked behind a turn that was already over.
  {
    outbox.length = 0
    responded.length = 0
    gates.clear()
    startedGate.clear()

    gates.set('doomed-chain', deferred())
    startedGate.set('doomed-chain', deferred())
    void send('doomed-chain')
    await startedGate.get('doomed-chain')!.promise

    // Poison this turn's render chain the way a throwing renderSegment /
    // scheduleMirror link would. The extra .catch only marks the rejection
    // handled for Node — `rejected` itself stays rejected, which is the point.
    const rejected = Promise.reject(new Error('render link blew up'))
    rejected.catch(() => undefined)
    ch.activeByChat.get(CHAT_ID).renderChain = rejected

    await send('after-a-broken-chain')
    ok('broken chain: parked', ch.queue.size(CHAT_ID) === 1)

    gates.get('doomed-chain')!.resolve()
    await waitFor(() => !ch.activeByChat.has(CHAT_ID), 'per-chat slot released despite rejection')
    ok('broken chain: slot released, chat not wedged', !ch.activeByChat.has(CHAT_ID))
    await waitFor(
      () => responded.includes('after-a-broken-chain'),
      'queue drained despite rejection'
    )
    ok('broken chain: queued message still ran', responded.includes('after-a-broken-chain'))
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after broken chain')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

run()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  })
