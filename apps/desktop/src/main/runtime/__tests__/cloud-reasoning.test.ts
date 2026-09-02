/**
 * Cloud thinking-mode tests — the registry's `cloud` case (the frontier
 * DeepSeek V4 pair via api.wolffi.sh → DeepInfra) and the provider-side
 * mapping of the canonical brain-button scale onto DeepInfra's
 * `reasoning_effort` enum. Registry behaviour was pinned against the live
 * API 2026-09-01: 'none' zeroes reasoning, high/max stream
 * reasoning_content, unknown models must not receive the parameter.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/cloud-reasoning.test.ts
 */

import { createServer } from 'node:http'
import { normalizeReasoningMode, reasoningModesFor } from '../reasoning'
import { CloudProvider, connectCloudProvider, reasoningEffortFor } from '../providers/cloud'
import type { StreamChunk } from '../thalamus'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}: expected ${e}, got ${a}`)
}

const FLASH = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const PRO = 'deepseek-ai/DeepSeek-V4-Pro-0813'

// ---------------------------------------------------------------------------
// reasoningModesFor('cloud', …) — what the brain button offers
// ---------------------------------------------------------------------------

check('Flash gets the full effort ladder', reasoningModesFor('cloud', FLASH), [
  'off',
  'high',
  'max'
])
check('Pro gets the full effort ladder', reasoningModesFor('cloud', PRO), ['off', 'high', 'max'])
check(
  'future dated v4 snapshots inherit the ladder',
  reasoningModesFor('cloud', 'deepseek-ai/DeepSeek-V4-Flash-0931'),
  ['off', 'high', 'max']
)
check(
  'unknown org models stay unsupported until verified',
  reasoningModesFor('cloud', 'some-org/other-model'),
  []
)
check(
  'non-v4 deepseek ids stay unsupported on this lane',
  reasoningModesFor('cloud', 'deepseek-ai/DeepSeek-V3.1'),
  []
)

// ---------------------------------------------------------------------------
// normalizeReasoningMode against the cloud ladder — persisted-value clamping
// ---------------------------------------------------------------------------

const MODES = reasoningModesFor('cloud', FLASH)
check(
  'nothing persisted defaults to thinking on (high)',
  normalizeReasoningMode(undefined, MODES),
  'high'
)
check('off persists as off', normalizeReasoningMode('off', MODES), 'off')
check('max persists as max', normalizeReasoningMode('max', MODES), 'max')
check("legacy 'basic' lands on high", normalizeReasoningMode('basic', MODES), 'high')
check("legacy 'none' lands on off", normalizeReasoningMode('none', MODES), 'off')
check("legacy 'extended' lands on high", normalizeReasoningMode('extended', MODES), 'high')

// ---------------------------------------------------------------------------
// reasoningEffortFor — the wire value the provider actually sends
// ---------------------------------------------------------------------------

check('off maps to an explicit none', reasoningEffortFor(FLASH, 'off'), 'none')
check('high maps to high', reasoningEffortFor(FLASH, 'high'), 'high')
check('max maps to max', reasoningEffortFor(FLASH, 'max'), 'max')
check('undefined keeps the default-on posture', reasoningEffortFor(FLASH, undefined), 'high')
check("plain 'on' rides as high", reasoningEffortFor(FLASH, 'on'), 'high')
check('Pro maps identically', reasoningEffortFor(PRO, 'max'), 'max')
check(
  'unknown model sends no parameter at all',
  reasoningEffortFor('some-org/other-model', 'high'),
  null
)

// ---------------------------------------------------------------------------
// The wire itself — CloudProvider.stream() must place reasoning_effort in
// the request body and surface reasoning_content deltas as reasoning chunks.
// A local stub stands in for the org API; the SSE shape mirrors what the
// live router streamed back during verification (2026-09-01).
// ---------------------------------------------------------------------------

async function wireTest(): Promise<void> {
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      res.write(chunk({ role: 'assistant', reasoning_content: 'thinking…' }))
      res.write(chunk({ content: 'answer' }))
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  connectCloudProvider({ apiBase: `http://127.0.0.1:${port}`, getToken: async () => 'tok' })

  const run = async (model: string, thinkingMode?: string): Promise<StreamChunk[]> => {
    const provider = new CloudProvider()
    const chunks: StreamChunk[] = []
    for await (const c of provider.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      model,
      thinkingMode: thinkingMode as never
    })) {
      chunks.push(c)
    }
    return chunks
  }

  const maxChunks = await run(FLASH, 'max')
  check('wire: max rides as reasoning_effort=max', bodies[0]?.reasoning_effort, 'max')
  check(
    'wire: reasoning_content deltas surface as reasoning chunks',
    maxChunks.filter((c) => c.type === 'reasoning').map((c) => (c as { text: string }).text),
    ['thinking…']
  )
  check(
    'wire: content still flows alongside the trace',
    maxChunks.some((c) => c.type === 'text' && (c as { text: string }).text === 'answer'),
    true
  )

  await run(FLASH, 'off')
  check('wire: off rides as an explicit reasoning_effort=none', bodies[1]?.reasoning_effort, 'none')

  await run(PRO, 'high')
  check('wire: Pro high rides as reasoning_effort=high', bodies[2]?.reasoning_effort, 'high')

  await run('some-org/other-model', 'high')
  check(
    'wire: unknown model carries no reasoning_effort key',
    'reasoning_effort' in (bodies[3] ?? {}),
    false
  )

  server.close()
}

void wireTest().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})
