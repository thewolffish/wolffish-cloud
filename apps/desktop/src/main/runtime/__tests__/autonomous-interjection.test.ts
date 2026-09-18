/**
 * Can a user steer an AUTONOMOUS run — an automation, procedure or heartbeat
 * job — while it is working?
 *
 * Until the off-lane bridge landed, no. Those runs call `agent.respond()`
 * directly instead of going through `TurnRunner.send()`, so nothing registered
 * them in `activeTurns`, `interject()` answered `no_live_turn` for every
 * message aimed at one, and `respond()` was never handed `takeInterjections`.
 * Two independent breaks. Meanwhile the window DOES read busy for these runs
 * (autonomous `emitLifecycle('started')` → chat:turnState → remoteRunning), so
 * the composer routed to the interject path that was guaranteed to refuse: the
 * pending bubble flashed and vanished, and the words sat invisible in the
 * renderer until the run ended and they went out as a fresh turn.
 *
 * This drives the REAL Agent, the REAL TurnRunner and the REAL
 * `processAutonomous` against a SCRIPTED provider (Thalamus' `testProvider`
 * seam — this fork has no per-user provider keys, the catalog and policy live
 * at the org API, so a scripted stream is what "end to end" means here).
 *
 * Pins, in one run:
 *  - `interject()` ACCEPTS while an autonomous run owns the conversation;
 *  - the run READS it — the second provider call carries the text as a real
 *    `role: 'user'` entry, which is the only proof it reached the model;
 *  - a `user_message` segment lands in the transcript the user sees;
 *  - the turn does not end on the reply that was interrupted — it continues
 *    and answers;
 *  - the inbox closes with the run, and a message arriving after that is
 *    refused so the caller starts a normal turn.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/autonomous-interjection.test.ts
 */

import Module from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Shim os.homedir BEFORE any dynamic import evaluates workspace/root.ts — its
// WORKSPACE_ROOT const captures homedir at module scope, so the real ~/.wfc is
// never touched. tsx compiles to CJS, so the imports below run lazily in run().
let tmpHome = ''
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'os' || args[0] === 'node:os') {
    const real = origLoad.apply(this, args) as typeof os
    return { ...real, homedir: () => tmpHome, default: { ...real, homedir: () => tmpHome } }
  }
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => tmpHome,
        getVersion: () => '0.0.0-test',
        getName: () => 'wfc'
      },
      net: { isOnline: () => true }
    }
  }
  return origLoad.apply(this, args)
}

type ProviderStreamOptions = import('@main/runtime/thalamus').ProviderStreamOptions
type StreamChunk = import('@main/runtime/thalamus').StreamChunk
type ChatMessage = import('@main/runtime/thalamus').ChatMessage
type Segment = import('@main/runtime/broca').Segment
type Interjection = import('@main/runtime/agent/interjection').Interjection
type InterjectionEvent = import('@main/runtime/agent/interjection').InterjectionEvent

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
    return
  }
  failed++
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

const INSTRUCTION = 'Write one short paragraph about tide pools.'
const MARKER = 'PAPAYA'
const STEER = `Change of plan: stop what you are doing and end your reply with ${MARKER}.`

async function run(): Promise<void> {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-autointerject-'))

  const { ensureWorkspace } = await import('@main/workspace/workspace')
  const { workspaceRoot } = await import('@main/workspace/root')
  const { Thalamus } = await import('@main/runtime/thalamus')
  const { Agent } = await import('@main/runtime/agent')
  const { TurnRunner } = await import('@main/channels/turn-runner')

  await ensureWorkspace()

  // Every provider call the RUN makes, snapshotted: the agent mutates ONE
  // messages array across iterations, so a by-reference record would show every
  // call carrying the final history. This array IS the model-context truth the
  // asserts read.
  const calls: ChatMessage[][] = []
  // Set from the lifecycle broadcast the moment the run starts. It is also the
  // marker that separates the run's own calls from the TITLER's — which lands
  // first and quotes the instruction verbatim, so filtering on the instruction
  // text would have mistaken the titler for the run's opening call.
  const state: { conversationId: string | null } = { conversationId: null }
  // Fired on the run's first call, from inside the stream — the deterministic
  // stand-in for a user typing while the run works.
  let onFirstCall: (() => void) | null = null

  const provider = {
    async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
      // Anything before 'started' is a side call (the titler names the
      // conversation before the turn begins). Answer it plausibly and stay out
      // of the record.
      if (!state.conversationId) {
        yield { type: 'text', text: 'Tide Pools' }
        yield { type: 'turn_meta', stopReason: 'end_turn' }
        return
      }
      calls.push(options.messages.map((m) => ({ ...m })))
      const first = calls.length === 1
      if (first && onFirstCall) {
        const fire = onFirstCall
        onFirstCall = null
        fire()
      }
      yield { type: 'active_model', provider: 'cloud', model: 'test-model' }
      yield {
        type: 'text',
        text: first ? 'Working on the original instruction.' : `All done. ${MARKER}`
      }
      // No tool calls: the turn WOULD end here, which is stop point 2 — the
      // branch that must notice a pending message and go round again instead.
      yield { type: 'turn_meta', stopReason: 'end_turn' }
    }
  }

  const thalamus = new Thalamus({ testProvider: provider })
  thalamus.setModel('test-model')

  const agent = new Agent({ thalamus, workspaceRoot: workspaceRoot() })
  await agent.init()
  const runner = new TurnRunner(agent)

  const events: InterjectionEvent[] = []
  runner.onInterjection((ev) => events.push(ev))

  // Exactly what main wires in index.ts.
  agent.setAutonomousInterjections({
    open: (conversationId) => runner.openOffLaneRun(conversationId),
    take: (conversationId, turnId) => runner.drainInterjections(conversationId, turnId),
    close: (conversationId, reason) => runner.closeOffLaneRun(conversationId, reason)
  })

  // The conversation id comes from the lifecycle broadcast, not the mirror:
  // 'started' is emitted before the run's first model call (and is exactly
  // what flips an open window to busy), whereas the first mirror tick waits
  // for the first segment — by which time the call it should have been
  // steered into has already gone out.
  agent.setAutonomousLifecycleListener((ev) => {
    if (ev.phase === 'started' && ev.conversationId) state.conversationId = ev.conversationId
  })
  const mirrored: { message: { segments?: Segment[] } | null } = { message: null }
  agent.setAutonomousMessageMirror((_cid, message) => {
    if (message) mirrored.message = message as unknown as { segments?: Segment[] }
  })

  let accepted: string | null = null
  onFirstCall = (): void => {
    const cid = state.conversationId
    if (!cid) {
      accepted = 'no conversation id at first call'
      return
    }
    const item: Interjection = {
      messageId: 'auto_m1',
      text: STEER,
      attachments: [],
      channel: 'electron',
      sentAt: 1_700_000_000_000
    }
    accepted = runner.interject(cid, item).status
  }

  const result = await agent.processAutonomous({
    instruction: INSTRUCTION,
    channel: 'heartbeat',
    jobLabel: 'autonomous-interjection-test'
  })

  ok('the run produced a conversation', state.conversationId !== null)
  ok(
    'interject ACCEPTS while an autonomous run owns the conversation',
    accepted === 'pending',
    `got ${accepted}`
  )
  ok(
    'a pending event went out',
    events.some((e) => e.messageId === 'auto_m1' && e.state === 'pending')
  )
  ok(
    'delivered, not swept back',
    events.some((e) => e.messageId === 'auto_m1' && e.state === 'delivered') &&
      !events.some((e) => e.messageId === 'auto_m1' && e.state === 'withdrawn')
  )

  // The only proof it reached the MODEL: a second call whose history carries
  // the user's words as a real user entry.
  ok('the turn continued instead of ending', calls.length >= 2, `${calls.length} provider call(s)`)
  const second = calls[1] ?? []
  ok(
    'the second call carries the message as a real user entry',
    second.some((m) => m.role === 'user' && String(m.content ?? '').includes(MARKER)),
    JSON.stringify(second.map((m) => m.role))
  )
  ok(
    'the first call did NOT carry it (it had not been sent yet)',
    !(calls[0] ?? []).some((m) => String(m.content ?? '').includes(MARKER))
  )

  // And the proof the USER sees: the segment in the transcript.
  const segments = (mirrored.message?.segments ?? []) as Segment[]
  const i = segments.findIndex((s) => s.kind === 'user_message')
  ok('a user_message segment reached the transcript', i >= 0)
  ok(
    'it carries the sender’s own id, so the pending bubble can retire',
    i >= 0 && (segments[i] as { messageId?: string }).messageId === 'auto_m1'
  )
  ok('the run answered it', result.response.includes(MARKER), result.response.slice(-160))

  // The inbox belongs to the run, and closes with it.
  ok(
    'the inbox closed with the run',
    state.conversationId !== null && !runner.hasOffLaneRun(state.conversationId)
  )
  ok(
    'a message arriving after the run is refused, so the caller starts a turn',
    state.conversationId !== null &&
      runner.interject(state.conversationId, {
        messageId: 'auto_m2',
        text: 'too late',
        attachments: [],
        channel: 'electron',
        sentAt: 1_700_000_000_001
      }).status === 'no_live_turn'
  )

  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  // Explicit: a real Agent leaves the brainstem scheduler and the disk-writer
  // queues holding the event loop open, so the process would otherwise print
  // its result and then sit there.
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
