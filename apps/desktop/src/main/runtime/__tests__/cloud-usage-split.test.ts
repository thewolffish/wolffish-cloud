/**
 * How the cloud provider splits a prompt into fresh vs cached tokens.
 *
 * The org API is OpenAI-shaped, and OpenAI-shaped hosts report
 * `prompt_tokens` INCLUSIVE of the cached prefix, with
 * `prompt_tokens_details.cached_tokens` naming the subset that hit the
 * cache. Everything downstream of this provider assumes the Anthropic
 * convention instead — `inputTokens` is the FRESH tokens only, cache reads
 * counted beside it — which is what the context meter adds up
 * (`fresh + cacheRead + cacheWrite`), what `calculateCost` bills (full rate
 * on input, 0.1x on cache reads), and what the on-disk ledger records.
 *
 * Passing the inclusive number through counted the cached prefix twice. On a
 * warm turn (94-98% cache-hit is the norm against this host) the meter read
 * roughly double the real window occupancy and the local cost estimate was
 * several times the real one. The API's own cost model does the same
 * subtraction (`apps/api/src/lib/models.ts` — `fresh = tokensIn - cached`),
 * so these assertions pin the desktop to the server's reading of the wire.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/cloud-usage-split.test.ts
 */

import { createServer, type Server } from 'node:http'
import { CloudProvider, connectCloudProvider } from '../providers/cloud'
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

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number }

/** Serve one SSE turn whose terminal frame carries `usage` verbatim. */
async function serve(usage: unknown): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          ...(usage === undefined ? {} : { usage })
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

/** Run one turn against a stub reporting `usage`; answer its turn_meta usage. */
async function usageFor(usage: unknown): Promise<Usage | undefined> {
  const { server, port } = await serve(usage)
  connectCloudProvider({ apiBase: `http://127.0.0.1:${port}`, getToken: async () => 'tok' })
  const chunks: StreamChunk[] = []
  for await (const c of new CloudProvider().stream({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731'
  })) {
    chunks.push(c)
  }
  server.close()
  const meta = chunks.find((c) => c.type === 'turn_meta') as { usage?: Usage } | undefined
  return meta?.usage
}

async function run(): Promise<void> {
  // The shape of a real warm turn: a 108,224-token prompt of which 103,168
  // were served from cache (measured live 2026-09-04, 95.3% hit).
  const warm = await usageFor({
    prompt_tokens: 108_224,
    completion_tokens: 1_130,
    prompt_tokens_details: { cached_tokens: 103_168 }
  })
  check('a warm turn reports only the FRESH prompt as input', warm?.inputTokens, 5_056)
  check('... and the cached prefix as a cache read', warm?.cacheReadTokens, 103_168)
  check('... output is untouched', warm?.outputTokens, 1_130)
  check(
    'fresh + cacheRead reconstructs the real window occupancy (the meter numerator)',
    (warm?.inputTokens ?? 0) + (warm?.cacheReadTokens ?? 0),
    108_224
  )

  // A cold turn has no cached prefix — the whole prompt is fresh, and the
  // meter reads the same number it always did.
  const cold = await usageFor({ prompt_tokens: 4_020, completion_tokens: 1_581 })
  check('a cold turn is all fresh', cold?.inputTokens, 4_020)
  check('... with no cache read', cold?.cacheReadTokens, 0)

  // Explicit zero details behaves like the absent block.
  const zeroCached = await usageFor({
    prompt_tokens: 900,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0 }
  })
  check('cached_tokens: 0 is a cold turn', zeroCached?.inputTokens, 900)

  // A host that ever reported more cached than prompt would drive the
  // numerator NEGATIVE and paint an impossible meter. Clamp, never subtract
  // past zero.
  const bogus = await usageFor({
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 500 }
  })
  check('cached > prompt cannot make input negative', bogus?.inputTokens, 0)
  check('... the cache read is clamped to the prompt', bogus?.cacheReadTokens, 100)

  // A stream that died before its terminal usage frame reports zeros — the
  // signal the meter reads as "usage unavailable, keep the last reading"
  // rather than wiping itself to 0%.
  const missing = await usageFor(undefined)
  check('a usage-less stream reports zeros, not NaN', missing, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0
  })
}

void run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})
