#!/usr/bin/env node
/**
 * Mock Brave Search upstream for local search-lane tests (:9091).
 *
 * Speaks GET /web/search the way api.search.brave.com does — the
 * X-Subscription-Token check, a JSON body with web.results, and the
 * per-plan rate-limit headers (X-RateLimit-Limit / Policy / Remaining /
 * Reset in their two-window "per second, per month" shape) — and ENFORCES
 * a one-second sliding window like the real plan: more than MOCK_BRAVE_QPS
 * requests in any second answer 429. That is what lets the smoke prove the
 * gate: a burst through the Worker must reach here with zero 429s.
 *
 * A query containing MOCK_MONTH_EXHAUSTED (or MOCK_EXHAUST_TOKEN, so a pool
 * test can spend one instance and not the other) answers 429 with a zero
 * monthly remainder and a 2-second reset, so the gate's fail-fast and
 * fail-over paths are provable without waiting a month. A query containing MOCK_NO_MONTH answers 200
 * with the headers a pay-as-you-go plan really sends (monthly limit and
 * remainder both 0, a month-long reset — seen live 2026-09-02): the gate
 * must NOT read that as an exhausted month. GET /stats reports what
 * arrived; POST /reset clears it.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9091)
const KEY = process.env.MOCK_BRAVE_KEY ?? 'mock-brave-key'
const QPS = Number(process.env.MOCK_BRAVE_QPS ?? 5)
// The query token that makes THIS instance answer "month exhausted" — per
// instance, so a pool test can spend one plan while the other keeps serving.
const EXHAUST_TOKEN = process.env.MOCK_EXHAUST_TOKEN ?? 'MOCK_MONTH_EXHAUSTED'
const MONTH = 15_000

let sent = []
const stats = { calls: 0, ok: 0, rateLimited: 0, unauthorized: 0, byQuery: {} }
const reset = () => {
  sent = []
  stats.calls = 0
  stats.ok = 0
  stats.rateLimited = 0
  stats.unauthorized = 0
  stats.byQuery = {}
}

const headers = (remainingSec, remainingMonth, resetMonthSec = 2_592_000) => ({
  'content-type': 'application/json',
  'x-ratelimit-limit': `${QPS}, ${MONTH}`,
  'x-ratelimit-policy': `${QPS};w=1, ${MONTH};w=2592000`,
  'x-ratelimit-remaining': `${remainingSec}, ${remainingMonth}`,
  'x-ratelimit-reset': `1, ${resetMonthSec}`
})

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(stats))
    return
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    reset()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (req.method !== 'GET' || url.pathname !== '/web/search') {
    res.writeHead(404).end()
    return
  }

  stats.calls++
  const q = url.searchParams.get('q') ?? ''
  stats.byQuery[q] = (stats.byQuery[q] ?? 0) + 1

  if (req.headers['x-subscription-token'] !== KEY) {
    stats.unauthorized++
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'ErrorResponse', error: { status: 401, code: 'SUBSCRIPTION_TOKEN_INVALID' } }))
    return
  }

  if (q.includes(EXHAUST_TOKEN)) {
    stats.rateLimited++
    res.writeHead(429, headers(0, 0, 2))
    res.end(JSON.stringify({ type: 'ErrorResponse', error: { status: 429, code: 'RATE_LIMITED' } }))
    return
  }

  const now = Date.now()
  sent = sent.filter((t) => now - t < 1000)
  if (sent.length >= QPS) {
    stats.rateLimited++
    res.writeHead(429, headers(0, MONTH - stats.ok))
    res.end(JSON.stringify({ type: 'ErrorResponse', error: { status: 429, code: 'RATE_LIMITED' } }))
    return
  }
  sent.push(now)
  stats.ok++

  const count = Math.min(20, Math.max(1, Number(url.searchParams.get('count') ?? 5) || 5))
  const results = Array.from({ length: count }, (_, i) => ({
    title: `${q} — result ${i + 1}`,
    url: `https://example.com/${encodeURIComponent(q)}/${i + 1}`,
    description: `Mock snippet ${i + 1} for "${q}"`
  }))
  if (q.includes('MOCK_NO_MONTH')) {
    res.writeHead(200, {
      ...headers(QPS - sent.length, 0, 2_500_000),
      'x-ratelimit-limit': `${QPS}, 0`,
      'x-ratelimit-policy': `${QPS};w=1, 0;w=2592000`
    })
    res.end(JSON.stringify({ type: 'search', query: { original: q }, web: { type: 'search', results } }))
    return
  }
  res.writeHead(200, headers(QPS - sent.length, MONTH - stats.ok))
  res.end(JSON.stringify({ type: 'search', query: { original: q }, web: { type: 'search', results } }))
}).listen(PORT, () => {
  console.log(`mock brave listening on :${PORT} (qps ${QPS}, key ${KEY})`)
})
