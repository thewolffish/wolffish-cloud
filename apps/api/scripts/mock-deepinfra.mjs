#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible mock upstream for local router tests (:9090).
 * Speaks /chat/completions in both JSON and SSE (with usage in the final
 * chunk, as DeepInfra does when stream_options.include_usage is set).
 *
 * Mirrors DeepInfra's verified reasoning behaviour (live, 2026-09-01):
 * `reasoning_effort` is validated against the real enum, and any value
 * except 'none' yields a `reasoning_content` trace next to the content —
 * so the smokes can prove the router forwards the knob both ways.
 *
 * Defaults reproduce the historical mock exactly (7 prompt / 5 completion
 * tokens, three instant chunks) so every existing smoke keeps passing. The
 * load simulation turns the knobs below to make it behave like a real host:
 *
 *   MOCK_CONCURRENCY    max requests in flight; above it → 429 "Rate limited"
 *                       exactly as DeepInfra answers (default 0 = unlimited)
 *   MOCK_STREAM_CHUNKS  content chunks per streamed reply (default 2)
 *   MOCK_CHUNK_DELAY_MS pause between chunks — what holds a slot (default 0)
 *   MOCK_TTFB_MS        pause before the first byte (default 0)
 *   MOCK_REALISTIC=1    prompt_tokens from the body size, cached_tokens for a
 *                       repeated prompt_cache_key, an estimated_cost — the
 *                       fields the meter reads on the real host
 *
 * GET /stats reports what arrived (in-flight high-water mark, 429s served,
 * per-cache-key hits); POST /reset clears it.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9090)
const CONCURRENCY = Number(process.env.MOCK_CONCURRENCY ?? 0)
const STREAM_CHUNKS = Math.max(1, Number(process.env.MOCK_STREAM_CHUNKS ?? 2))
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.MOCK_CHUNK_DELAY_MS ?? 0))
const TTFB_MS = Math.max(0, Number(process.env.MOCK_TTFB_MS ?? 0))
const REALISTIC = process.env.MOCK_REALISTIC === '1'
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

let inflight = 0
const stats = { calls: 0, ok: 0, rateLimited: 0, inflightMax: 0, cancelled: 0, cacheHits: 0 }
const seenCacheKeys = new Map()
const reset = () => {
  stats.calls = 0
  stats.ok = 0
  stats.rateLimited = 0
  stats.inflightMax = 0
  stats.cancelled = 0
  stats.cacheHits = 0
  seenCacheKeys.clear()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...stats, inflight }))
    return
  }
  if (req.method === 'POST' && req.url === '/reset') {
    reset()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  stats.calls++

  if (CONCURRENCY > 0 && inflight >= CONCURRENCY) {
    stats.rateLimited++
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
    res.end(JSON.stringify({ detail: { error: 'Rate limited' } }))
    return
  }

  if (body.reasoning_effort !== undefined && !EFFORTS.has(body.reasoning_effort)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message: "Input should be 'none', 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max'",
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: null
        }
      })
    )
    return
  }
  const reasons = body.reasoning_effort !== undefined && body.reasoning_effort !== 'none'

  // Usage: the historical constants, or a body-derived estimate with the
  // cache split a real host reports for a repeated prompt_cache_key.
  let usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }
  if (REALISTIC) {
    const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body.messages ?? []).length / 4))
    const key = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : null
    let cached = 0
    if (key) {
      const prev = seenCacheKeys.get(key) ?? 0
      cached = Math.floor(Math.min(prev, promptTokens) * 0.9)
      seenCacheKeys.set(key, promptTokens)
      if (cached > 0) stats.cacheHits++
    }
    const completion = STREAM_CHUNKS * 3 + (reasons ? 4 : 0)
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completion,
      total_tokens: promptTokens + completion,
      prompt_tokens_details: { cached_tokens: cached },
      estimated_cost: ((promptTokens - cached) * 0.08 + cached * 0.016 + completion * 0.18) / 1_000_000
    }
  }

  inflight++
  stats.inflightMax = Math.max(stats.inflightMax, inflight)
  let gone = false
  req.on('close', () => {
    if (!res.writableEnded) {
      gone = true
      stats.cancelled++
    }
  })
  try {
    if (TTFB_MS) await sleep(TTFB_MS)
    if (gone) return

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, extra = {}) =>
        `data: ${JSON.stringify({
          id: 'mock-1',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }],
          ...extra
        })}\n\n`
      if (reasons) res.write(chunk({ role: 'assistant', reasoning_content: 'mock thinking. ' }))
      res.write(chunk(reasons ? { content: 'Hello ' } : { role: 'assistant', content: 'Hello ' }))
      for (let i = 1; i < STREAM_CHUNKS; i++) {
        if (CHUNK_DELAY_MS) await sleep(CHUNK_DELAY_MS)
        if (gone) return
        res.write(chunk({ content: i === STREAM_CHUNKS - 1 ? 'from mock.' : `chunk ${i} ` }))
      }
      if (STREAM_CHUNKS === 1) res.write(chunk({ content: 'from mock.' }))
      res.write(`data: ${JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [],
        usage
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      stats.ok++
      return
    }

    if (CHUNK_DELAY_MS) await sleep(CHUNK_DELAY_MS * (STREAM_CHUNKS - 1))
    if (gone) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello from mock.',
              ...(reasons ? { reasoning_content: 'mock thinking.' } : {})
            },
            finish_reason: 'stop'
          }
        ],
        usage
      })
    )
    stats.ok++
  } finally {
    inflight--
  }
}).listen(PORT, () =>
  console.log(
    `mock deepinfra on :${PORT} (concurrency ${CONCURRENCY || 'unlimited'}, chunks ${STREAM_CHUNKS}, delay ${CHUNK_DELAY_MS}ms, realistic ${REALISTIC})`
  )
)
