/**
 * What a phone-driven turn LEAVES BEHIND for the desktop's context-meter card.
 *
 * The card is built entirely from the conversation's persisted `stats` — the
 * meter reading, the last turn's roll-up, the lifetime totals. The in-app
 * chat builds them in the renderer; the autonomous runs build them with a
 * TurnStatsCollector; every OTHER channel was supposed to do the same from
 * the relayed corpus events. This one never did: its sink dropped
 * `onTurnEvent` on the floor, so a conversation run from the phone saved no
 * stats at all and opened in the app with a blank gauge — however much work
 * the agent had actually done in it (2026-09-04: a 41-tool-call browser
 * session over three turns, 1.2M ingested tokens, meter empty).
 *
 * So the assertions are about the persisted file: that a mobile turn writes
 * a meter reading, that the reading is the LAST brain call's prompt (what is
 * resident in the window) rather than a sum over the turn, that side-spend
 * never lands in the meter but still counts toward lifetime totals, that a
 * second turn accumulates, and that a turn which errors before producing a
 * single segment still records what it burned.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-turn-stats.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-stats-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
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
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
type SinkLike = {
  onSegment: (segment: unknown) => void
  onTurnEvent: (type: string, payload: unknown) => void
  onDone: () => void
  onError: (error: string) => void
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A brain call: 20k of prompt, 16k of it cached, 500 out. */
const brainCall = (fresh: number, cacheRead: number, out: number): Record<string, unknown> => ({
  provider: 'cloud',
  model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  role: 'brain',
  inputTokens: fresh,
  outputTokens: out,
  cacheCreationTokens: 0,
  cacheReadTokens: cacheRead,
  durationMs: 1_000
})

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { Rpc } = await import('@main/cloud/bridge-protocol')
  const { loadConversation } = await import('@main/conversations')

  const handlers = new Map<string, RpcHandler>()
  const fakeTunnel = {
    onRpc: (method: string, handler: RpcHandler) => handlers.set(method, handler),
    emit: () => undefined
  }

  // The runner hands the channel's own sink back to the test so a turn can be
  // driven event by event, exactly as TurnRunner's corpus relay would.
  const sinks: SinkLike[] = []
  let turnSeq = 0
  const channel = new MobileChannel({
    agent: {},
    runner: {
      send: ({
        makeSink
      }: {
        makeSink: (a: { turnId: string; conversationId: string | null }) => SinkLike
      }) => {
        const turnId = `turn_${++turnSeq}`
        sinks.push(makeSink({ turnId, conversationId: null }))
        return { turnId, controller: new AbortController() }
      }
    },
    serializeCapabilities: async () => []
  } as never)
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(fakeTunnel)
  ;(channel as unknown as { bridge: unknown }).bridge = fakeTunnel

  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler registered for ${method}`)
    return Promise.resolve(handler(params))
  }

  // ══════════════════════════════════════════════ turn one: a real work turn
  const sent = (await call(Rpc.sendMessage, {
    conversationId: null,
    text: 'screenshot hacker news'
  })) as { conversationId: string }
  await settle(60)
  const convId = sent.conversationId

  const turn1 = sinks[0]
  if (!turn1) {
    ok('the runner received a sink', false)
    return
  }

  turn1.onTurnEvent('context.built', { tokenBudget: 1_048_576, compactionAt: 737_280 })
  // Two brain iterations. The meter must read the LAST one's prompt — what is
  // resident in the window now — not the sum of both.
  turn1.onTurnEvent('llm.response', brainCall(4_000, 16_000, 500))
  turn1.onTurnEvent('tool.called', { tool: 'ext_screenshot' })
  turn1.onTurnEvent('llm.response', brainCall(1_000, 30_000, 300))
  // Side-spend: a workflow worker and a summarization call. Neither is
  // conversation context; both are real money.
  turn1.onTurnEvent('llm.response', { ...brainCall(900, 0, 100), role: 'worker' })
  turn1.onTurnEvent('llm.response', { ...brainCall(200, 0, 50), role: 'summary', cost: 0.000_02 })
  turn1.onTurnEvent('turn.usage', {
    provider: 'cloud',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    role: 'brain',
    toolCalls: 1,
    cost: 0.004
  })
  turn1.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's1', delta: 'Here it is.' })
  turn1.onDone()
  await settle()

  const after1 = await loadConversation(convId)
  const stats1 = after1?.stats
  ok('a mobile turn persists stats at all', stats1 != null, JSON.stringify(stats1))
  if (!stats1) {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }

  eq('the meter reads the LAST brain call, not the turn total', stats1.meter?.contextTokens, 31_000)
  eq('the budget comes from context.built', stats1.meter?.contextBudget, 1_048_576)
  eq('the compaction tick rides along', stats1.meter?.compactionAt, 737_280)
  eq(
    'the reading is stamped with the model it was measured under',
    stats1.meter?.model,
    'deepseek-ai/DeepSeek-V4-Flash-0731'
  )

  eq('last turn: brain input only', stats1.lastTurn?.inputTokens, 5_000)
  eq('last turn: brain output only', stats1.lastTurn?.outputTokens, 800)
  eq('last turn: cache reads', stats1.lastTurn?.cacheReadTokens, 46_000)
  eq('last turn: brain api calls', stats1.lastTurn?.apiCalls, 2)
  eq('last turn: the authoritative brain tool count', stats1.lastTurn?.toolCalls, 1)
  eq('last turn: cost is brain + side-spend', stats1.lastTurn?.cost, 0.004_02)
  eq('last turn: the provider that answered', stats1.lastTurn?.provider, 'cloud')

  eq('all-time: one turn so far', stats1.allTime.turns, 1)
  eq('all-time: side-spend calls count too', stats1.allTime.apiCalls, 4)
  eq('all-time: side-spend tokens count too', stats1.allTime.inputTokens, 6_100)
  ok('all-time: elapsed is recorded', stats1.allTime.processingMs >= 0)

  // ═══════════════════════════════════════════════ turn two: it accumulates
  await call(Rpc.sendMessage, { conversationId: convId, text: 'now resize it' })
  await settle(60)
  const turn2 = sinks[1]
  if (!turn2) {
    ok('a follow-up send makes a second sink', false)
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  turn2.onTurnEvent('context.built', { tokenBudget: 1_048_576, compactionAt: 737_280 })
  turn2.onTurnEvent('llm.response', brainCall(2_000, 48_000, 200))
  turn2.onTurnEvent('turn.usage', {
    provider: 'cloud',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    role: 'brain',
    toolCalls: 0,
    cost: 0.002
  })
  turn2.onSegment({ kind: 'text', turnId: 'turn_2', segmentId: 's1', delta: 'Resized.' })
  turn2.onDone()
  await settle()

  const stats2 = (await loadConversation(convId))?.stats
  eq('the meter moves to the newest reading', stats2?.meter?.contextTokens, 50_000)
  eq('all-time turns accumulate', stats2?.allTime.turns, 2)
  eq('all-time input accumulates', stats2?.allTime.inputTokens, 8_100)
  eq('all-time cost accumulates', stats2?.allTime.cost, 0.006_02)
  eq('the last turn is the newest one, not a sum', stats2?.lastTurn?.inputTokens, 2_000)

  // ═════════════════════════════════ a turn that dies before it says anything
  // No segment ever streams, so there is no assistant message to append — the
  // old early-return skipped the whole write. The spend still happened.
  await call(Rpc.sendMessage, { conversationId: convId, text: 'and again' })
  await settle(60)
  const turn3 = sinks[2]
  if (!turn3) {
    ok('a third send makes a third sink', false)
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  turn3.onTurnEvent('context.built', { tokenBudget: 1_048_576, compactionAt: 737_280 })
  turn3.onTurnEvent('llm.response', brainCall(700, 60_000, 0))
  turn3.onError('provider is temporarily unavailable')
  await settle()

  const stats3 = (await loadConversation(convId))?.stats
  eq('an errored turn still records its spend', stats3?.allTime.turns, 3)
  eq('... and its tokens', stats3?.allTime.inputTokens, 8_800)
  eq('... and moves the meter to what it measured', stats3?.meter?.contextTokens, 60_700)

  // ═════════════════════════ a turn that never reaches the model keeps the meter
  // A no-provider turn measured nothing. Blanking the gauge would be a lie
  // about the conversation; the last real reading stands.
  await call(Rpc.sendMessage, { conversationId: convId, text: 'once more' })
  await settle(60)
  const turn4 = sinks[3]
  if (!turn4) {
    ok('a fourth send makes a fourth sink', false)
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }
  turn4.onTurnEvent('context.built', { tokenBudget: 1_048_576, compactionAt: 737_280 })
  turn4.onError('offline')
  await settle()

  const stats4 = (await loadConversation(convId))?.stats
  eq('a turn that never measured keeps the last reading', stats4?.meter?.contextTokens, 60_700)
  eq('... and does not stamp an empty turn on the totals', stats4?.allTime.turns, 3)

  await throughTheRealRelay()
}

/**
 * The same fix, but end-to-end through the REAL TurnRunner.
 *
 * Everything above drives `sink.onTurnEvent` by hand, which pins the
 * collector and the persist but takes the relay on faith — and the relay is
 * where this could still be dead: TurnRunner only forwards the corpus events
 * named in TURN_RELAYED_EVENTS, and only those emitted inside THIS turn's
 * scope. If any of the four the meter needs were missing from that list, the
 * card would come up blank again with every assertion above still green.
 *
 * So: a real Corpus, a real TurnRunner, the real Mobile sink, and a fake
 * Agent whose respond() emits the way the runtime does.
 */
async function throughTheRealRelay(): Promise<void> {
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { Rpc } = await import('@main/cloud/bridge-protocol')
  const { loadConversation } = await import('@main/conversations')

  const corpus = new Corpus({ devLog: false })
  const agent = {
    corpus,
    // Titling runs before respond; stub it so the turn is deterministic.
    thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Relay Test' }) },
    motor: { stopTask: async (): Promise<void> => undefined },
    respond: async (): Promise<unknown> => {
      corpus.emit('context.built', {
        tokenCount: 10_000,
        tokenBudget: 1_048_576,
        compactionAt: 737_280,
        sectionsIncluded: []
      })
      corpus.emit('llm.response', {
        provider: 'cloud',
        model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        role: 'brain',
        inputTokens: 2_500,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 71_500,
        durationMs: 1_200
      })
      corpus.emit('tool.called', { taskId: 'task_1', tool: 'ext_screenshot', args: {} })
      corpus.emit('turn.usage', {
        provider: 'cloud',
        model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        role: 'brain',
        iterations: 1,
        toolCalls: 1,
        inputTokens: 2_500,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 71_500,
        cacheHitRate: 0.97,
        cost: 0.0031
      })
      return { stopReason: 'end_turn' }
    }
  }

  const runner = new TurnRunner(agent as never)
  const handlers = new Map<string, RpcHandler>()
  const tunnel = { onRpc: (m: string, h: RpcHandler) => handlers.set(m, h), emit: () => undefined }
  const channel = new MobileChannel({
    agent,
    runner,
    serializeCapabilities: async () => []
  } as never)
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(tunnel)
  ;(channel as unknown as { bridge: unknown }).bridge = tunnel

  const send = handlers.get(Rpc.sendMessage)
  if (!send) {
    ok('the relay scenario registered a send handler', false)
    return
  }
  const sent = (await send({ conversationId: null, text: 'screenshot it' })) as {
    conversationId: string
  }

  // The turn runs through the real runner; poll for its end-of-turn write.
  type Stats = NonNullable<Awaited<ReturnType<typeof loadConversation>>>['stats']
  let stats: Stats | null | undefined
  for (let i = 0; i < 100 && !stats; i++) {
    await settle(50)
    stats = (await loadConversation(sent.conversationId))?.stats
  }

  ok('the real relay reaches the collector', stats != null, JSON.stringify(stats))
  eq('the meter reading survives the real relay', stats?.meter?.contextTokens, 74_000)
  eq('the budget survives the real relay', stats?.meter?.contextBudget, 1_048_576)
  eq('the compaction tick survives the real relay', stats?.meter?.compactionAt, 737_280)
  eq('the tool count survives the real relay', stats?.lastTurn?.toolCalls, 1)
  eq('the cost survives the real relay', stats?.lastTurn?.cost, 0.0031)
  eq('the lifetime roll-up is written', stats?.allTime.turns, 1)
}

void run().then(
  () => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
