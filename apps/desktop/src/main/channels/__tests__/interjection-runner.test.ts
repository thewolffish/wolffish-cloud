/**
 * Mid-turn messages at the TurnRunner: the per-conversation inbox that lets
 * a user message reach a RUNNING turn instead of waiting in a surface-side
 * queue until the turn ends (see runtime/agent/interjection.ts).
 *
 * Pins the contract every surface leans on:
 *  - interject() on an idle conversation says no_live_turn (the caller sends
 *    normally); on a live one it parks the message and broadcasts pending;
 *  - the agent's pull (takeInterjections) drains the inbox and broadcasts
 *    delivered — the loop pushes the message into history at that moment;
 *  - withdraw takes an unread message back (user reason) and refuses once
 *    it has been read;
 *  - a Stop returns unread messages to their sender with reason canceled;
 *  - a natural finish returns the sliver-race leftovers with turn_ended;
 *  - a turn queued behind its predecessor on the lane INHERITS the unread
 *    messages instead of bouncing them.
 *
 * Exercises the REAL TurnRunner with a stubbed agent (same hermetic setup as
 * active-runs.test.ts). Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/interjection-runner.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-interject-'))
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
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error('waitFor timed out')
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function run(): Promise<void> {
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  type InterjectionEvent = import('@main/runtime/agent/interjection').InterjectionEvent
  type Interjection = import('@main/runtime/agent/interjection').Interjection

  const corpus = new Corpus({ devLog: false })

  // The stub agent parks on a gate; the test pokes `drain` to play the
  // loop's stop point (it calls the pull the runner threaded in).
  let drain: (() => Interjection[]) | null = null
  let gate = deferred<void>()
  let started = deferred<void>()
  const agent = {
    corpus,
    respond: async (turn: {
      turnId: string
      conversationId: string | null
      signal?: AbortSignal
      takeInterjections?: () => Interjection[]
    }): Promise<unknown> => {
      drain = turn.takeInterjections ?? null
      started.resolve()
      turn.signal?.addEventListener('abort', () => gate.resolve())
      await gate.promise
      return turn.signal?.aborted
        ? { stopReason: 'canceled' as const, toolCalls: 0 }
        : { stopReason: 'end_turn' as const, toolCalls: 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  const events: InterjectionEvent[] = []
  runner.onInterjection((ev) => events.push(ev))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeSink = (ctx: { turnId: string; conversationId: string | null }): any => ({
    ...ctx,
    channelId: 'electron',
    onSegment: () => {},
    onTurnEvent: () => {},
    onApprovalRequest: async () => 'denied' as const,
    onDone: () => {},
    onError: () => {},
    onCredentialBlocked: () => {}
  })

  const send = (conversationId: string, content: string): { done: Promise<void> } =>
    runner.send({
      history: [{ role: 'user', content }],
      conversationId,
      conversationTitle: 'Live Run',
      makeSink
    })

  const item = (id: string, text: string): Interjection => ({
    messageId: id,
    text,
    attachments: [],
    channel: 'electron',
    sentAt: Date.now()
  })

  // ── 1. Idle conversation: nothing to interject into ─────────────────────
  ok('idle: no_live_turn', runner.interject('conv_a', item('m0', 'hi')).status === 'no_live_turn')
  ok('idle: no event broadcast', events.length === 0)

  // ── 2. Live turn: parked + pending, delivered on the agent's pull ────────
  const first = send('conv_a', 'start')
  await started.promise
  ok('live: pending', runner.interject('conv_a', item('m1', 'skip tests')).status === 'pending')
  ok('live: pending event', events.at(-1)?.state === 'pending' && events.at(-1)?.messageId === 'm1')
  ok('live: snapshot lists it', runner.pendingInterjections('conv_a').length === 1)

  const taken = drain!()
  ok('pull: drains the inbox in order', taken.length === 1 && taken[0].messageId === 'm1')
  ok('pull: delivered event', events.at(-1)?.state === 'delivered')
  ok('pull: inbox now empty', runner.pendingInterjections('conv_a').length === 0)
  ok('pull: second pull is empty', drain!().length === 0)

  // ── 3. Withdraw: only while unread ──────────────────────────────────────
  runner.interject('conv_a', item('m2', 'never mind'))
  ok('withdraw: unread message comes back', runner.withdrawInterjection('conv_a', 'm2'))
  ok(
    'withdraw: event carries reason user',
    events.at(-1)?.state === 'withdrawn' && events.at(-1)?.reason === 'user'
  )
  ok('withdraw: read message refuses', runner.withdrawInterjection('conv_a', 'm1') === false)

  // ── 4. Stop with an unread message: returned with reason canceled ───────
  runner.interject('conv_a', item('m3', 'also do X'))
  runner.cancelConversation('conv_a')
  await first.done.catch(() => undefined)
  await tick()
  const canceled = events.filter((e) => e.messageId === 'm3').at(-1)
  ok(
    'stop: unread returned as withdrawn/canceled',
    canceled?.state === 'withdrawn' && canceled.reason === 'canceled',
    JSON.stringify(canceled)
  )
  ok('stop: inbox empty after the lane closes', runner.pendingInterjections('conv_a').length === 0)
  ok('stop: conversation idle again', !runner.isConversationActive('conv_a'))

  // ── 5. Natural finish with a sliver-race leftover: turn_ended ──────────
  gate = deferred<void>()
  started = deferred<void>()
  const second = send('conv_b', 'go')
  await started.promise
  runner.interject('conv_b', item('m4', 'late one'))
  gate.resolve() // the loop ended without pulling — the sliver race
  await second.done
  await tick()
  const late = events.filter((e) => e.messageId === 'm4').at(-1)
  ok(
    'finish: leftover returned as withdrawn/turn_ended',
    late?.state === 'withdrawn' && late.reason === 'turn_ended',
    JSON.stringify(late)
  )

  // ── 6. A successor queued on the lane inherits the unread messages ──────
  gate = deferred<void>()
  started = deferred<void>()
  const third = send('conv_c', 'one')
  await started.promise
  const firstGate = gate
  gate = deferred<void>()
  started = deferred<void>()
  const fourth = send('conv_c', 'two') // queued behind `third` on the lane
  await tick()
  runner.interject('conv_c', item('m5', 'for whoever runs next'))
  firstGate.resolve() // `third` ends without pulling
  await third.done
  await started.promise // `fourth` is now running
  ok(
    'lane: not bounced while a successor is queued',
    !events.some((e) => e.messageId === 'm5' && e.state === 'withdrawn')
  )
  const inherited = drain!()
  ok('lane: successor pulls it', inherited.length === 1 && inherited[0].messageId === 'm5')
  gate.resolve()
  await fourth.done
  await waitFor(() => !runner.isConversationActive('conv_c'))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
