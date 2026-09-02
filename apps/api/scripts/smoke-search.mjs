#!/usr/bin/env node
/**
 * Search-lane smoke test against `wrangler dev` (:8787) with the mock Brave
 * upstream (:9091 — .dev.vars sets BRAVE_API_KEY=mock-brave-key,
 * BRAVE_BASE_URL=http://localhost:9091 and BRAVE_QPS=5, a deliberately
 * tiny plan so the gate has something to protect). Walks:
 *
 *   status (the managed panel's payload) → validation → one search answers
 *   from Brave in the plugin's shape → metered as kind=search at the plan
 *   price (admin + self usage) → per-user daily cap trips 429 → org
 *   switch 403 → org monthly cap 429 → a 24-wide burst reaches the mock
 *   with ZERO upstream 429s (the gate's whole point) → identical concurrent
 *   queries coalesce into one upstream call → the gate learned the plan's
 *   per-second limit from the headers → an exhausted monthly window fails
 *   fast without calling upstream, then reopens.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const MOCK = process.env.MOCK_BRAVE_BASE ?? 'http://localhost:9091'
const stamp = Date.now().toString(36)
const ownerEmail = `searchowner-${stamp}@wolffi.sh`
const PW = 'search-owner-pass-1'
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'

const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', '${MODEL}', '[]');`,
  `UPDATE org SET search_enabled = 1, user_daily_search_cap = 200, org_monthly_search_cap = 100000 WHERE id = 1;`,
  `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
   VALUES ('usr_search_${stamp}', '${ownerEmail}', 'Search Owner', 'owner', 'active', '${hash}', '${salt}', 0);`
].join(' ')
execSync(`npx wrangler d1 execute wfc-master --local --command "${sql.replace(/"/g, '\\"')}"`, {
  stdio: 'pipe'
})

let failures = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (path, { token, body, method } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text, headers: res.headers }
}
const mockStats = async () => (await fetch(`${MOCK}/stats`)).json()
await fetch(`${MOCK}/reset`, { method: 'POST' })

const owner = await api('/auth/login', { body: { email: ownerEmail, password: PW } })
check('login', owner.status === 200)
const tok = owner.json.access_token
const uid = owner.json.user.id
const search = (body, token = tok) => api('/v1/search', { token, body })

// ── the managed panel's payload ──────────────────────────────────────────
check('status requires auth', (await api('/v1/search/status')).status === 401)
check('search requires auth', (await api('/v1/search', { body: { query: 'x' } })).status === 401)
const st0 = await api('/v1/search/status', { token: tok })
check(
  'status: brave lane configured + enabled + ready',
  st0.status === 200 &&
    st0.json?.provider === 'brave' &&
    st0.json?.configured === true &&
    st0.json?.enabled === true &&
    st0.json?.ready === true,
  JSON.stringify(st0.json)
)
check(
  'status: caps, price and standing on the wire',
  st0.json?.daily_cap === 200 &&
    st0.json?.org_monthly_cap === 100000 &&
    st0.json?.price_per_query_microusd === 5000 &&
    st0.json?.used_today === 0
)

// ── validation ───────────────────────────────────────────────────────────
check('missing query 400', (await search({})).status === 400)
check('count above 20 → 400', (await search({ query: 'x', count: 99 })).status === 400)
check('bad country 400', (await search({ query: 'x', country: 'USA' })).status === 400)
check('bad freshness 400', (await search({ query: 'x', freshness: 'yesterday' })).status === 400)

// ── one search, the plugin's shape ───────────────────────────────────────
const s1 = await search({ query: 'wolffish cloud', count: 3 })
check(
  'search answers from brave in the plugin shape',
  s1.status === 200 &&
    s1.json?.provider === 'brave' &&
    s1.json?.results?.length === 3 &&
    /^https?:/.test(s1.json.results[0].url) &&
    s1.json.results[0].title.includes('wolffish cloud') &&
    typeof s1.json.results[0].snippet === 'string',
  JSON.stringify(s1.json)
)
check(
  'meta reports standing and latency',
  s1.json?.meta?.used_today === 1 &&
    s1.json?.meta?.daily_cap === 200 &&
    s1.json?.meta?.coalesced === false &&
    Number.isInteger(s1.json?.meta?.latency_ms)
)
await sleep(400) // let waitUntil metering land
check('status counts the search', (await api('/v1/search/status', { token: tok })).json?.used_today === 1)

// ── metered ──────────────────────────────────────────────────────────────
const usage = await api(`/admin/usage?user_id=${uid}`, { token: tok })
const row = (usage.json?.recent ?? []).find((r) => r.kind === 'search')
check(
  'admin usage row: kind=search, plan price, no tokens',
  row?.model === 'brave/web-search' &&
    row?.cost_microusd === 5000 &&
    row?.decision === 'allowed' &&
    row?.tokens_in === 0 &&
    row?.latency_ms >= 0,
  JSON.stringify(row)
)
check('admin totals count searches', usage.json?.totals?.[0]?.searches === 1, JSON.stringify(usage.json?.totals))
const selfUsage = await api('/v1/usage?after=0', { token: tok })
check(
  'self usage read carries kind',
  (selfUsage.json?.rows ?? []).some((r) => r.kind === 'search' && r.cost_microusd === 5000)
)

// ── per-user daily cap ───────────────────────────────────────────────────
await api(`/admin/users/${uid}/policy`, { token: tok, method: 'PUT', body: { daily_search_cap: 1 } })
const capped = await search({ query: 'capped' })
check(
  'per-user cap trips 429',
  capped.status === 429 && capped.json?.error === 'search_quota_exceeded' && capped.json?.scope === 'user_daily',
  JSON.stringify(capped.json)
)
await sleep(300)
const denied = (await api(`/admin/usage?user_id=${uid}`, { token: tok })).json?.recent ?? []
check('denial metered as denied_quota at zero cost', denied.some((r) => r.kind === 'search' && r.decision === 'denied_quota' && r.cost_microusd === 0))
await api(`/admin/users/${uid}/policy`, { token: tok, method: 'PUT', body: { daily_search_cap: 0 } })
check('cap 0 = unlimited', (await search({ query: 'unlimited' })).status === 200)
await api(`/admin/users/${uid}/policy`, { token: tok, method: 'PUT', body: { daily_search_cap: null } })
check('status reflects org default again', (await api('/v1/search/status', { token: tok })).json?.daily_cap === 200)

// ── the org switch ───────────────────────────────────────────────────────
await api('/admin/org', { token: tok, method: 'PATCH', body: { search_enabled: false } })
const off = await search({ query: 'off' })
check('org switch off → 403 search_disabled', off.status === 403 && off.json?.error === 'search_disabled')
const stOff = await api('/v1/search/status', { token: tok })
check('status reports the switch', stOff.json?.enabled === false && stOff.json?.ready === false)
await api('/admin/org', { token: tok, method: 'PATCH', body: { search_enabled: true } })
check('org switch on → 200', (await search({ query: 'on' })).status === 200)

// ── the org monthly cap ──────────────────────────────────────────────────
await api('/admin/org', { token: tok, method: 'PATCH', body: { org_monthly_search_cap: 1 } })
const orgCapped = await search({ query: 'org capped' })
check(
  'org monthly cap trips 429',
  orgCapped.status === 429 && orgCapped.json?.scope === 'org_monthly',
  JSON.stringify(orgCapped.json)
)
await api('/admin/org', { token: tok, method: 'PATCH', body: { org_monthly_search_cap: 100000 } })
check('org cap restored', (await search({ query: 'org restored' })).status === 200)

// ── the burst: the gate's whole point ────────────────────────────────────
// 24 distinct queries at once against a 5-query-per-second plan (gate
// admits 4/s). Every one must succeed and NOT ONE may reach the mock as a
// 429 — the queue, not the employee, absorbs the plan limit.
const before = await mockStats()
const t0 = Date.now()
const burst = await Promise.all(
  Array.from({ length: 24 }, (_, i) => search({ query: `burst ${stamp} ${i}`, count: 1 }))
)
const burstMs = Date.now() - t0
const after = await mockStats()
check(
  'burst of 24 concurrent searches all served',
  burst.every((r) => r.status === 200),
  burst.map((r) => r.status).join(',')
)
check(
  'zero upstream 429s during the burst',
  after.rateLimited === before.rateLimited,
  `mock saw ${after.rateLimited - before.rateLimited} rate-limited calls`
)
check('burst was paced by the window (not fired at once)', burstMs >= 4_000, `${burstMs}ms`)
check('burst waited inside the gate', burst.some((r) => (r.json?.meta?.waited_ms ?? 0) > 500))

// ── coalescing ───────────────────────────────────────────────────────────
const sameQuery = `same ${stamp}`
const same = await Promise.all(Array.from({ length: 8 }, () => search({ query: sameQuery, count: 2 })))
const statsSame = await mockStats()
check('identical concurrent queries all served', same.every((r) => r.status === 200))
check('…from ONE upstream call', statsSame.byQuery[sameQuery] === 1, `${statsSame.byQuery[sameQuery]} calls`)
check('…and flagged as coalesced', same.filter((r) => r.json?.meta?.coalesced === true).length === 7)

// ── the gate learned the plan ────────────────────────────────────────────
const stGate = await api('/v1/search/status', { token: tok })
check(
  'gate learned the plan qps from the headers (5 → admits 4/s)',
  stGate.json?.plan_qps === 5 && stGate.json?.gate?.limitPerSec === 4,
  JSON.stringify(stGate.json?.gate)
)

// ── a plan with no monthly window must never read as exhausted ───────────
// Live Brave (pay-as-you-go) answers 200 with "limit: 50, 0 / remaining: n, 0"
// and a month-long reset. The first deploy closed the lane for 29 days on
// exactly that; this is the regression guard.
check('no-monthly-window plan headers: search succeeds', (await search({ query: 'MOCK_NO_MONTH plan' })).status === 200)
check('…and the next search still flows (lane not closed)', (await search({ query: 'after no-month' })).status === 200)
check(
  '…status shows the lane open',
  (await api('/v1/search/status', { token: tok })).json?.gate?.monthExhaustedForMs === 0
)

// ── an exhausted monthly window fails fast, then reopens ─────────────────
const exhausted = await search({ query: 'MOCK_MONTH_EXHAUSTED' })
check(
  'upstream month exhausted → 429 plan_monthly',
  exhausted.status === 429 && exhausted.json?.error === 'search_quota_exhausted' && exhausted.json?.scope === 'plan_monthly',
  JSON.stringify(exhausted.json)
)
const callsBefore = (await mockStats()).calls
const failFast = await search({ query: 'during exhaustion' })
check('while exhausted: fails fast without calling upstream', failFast.status === 429 && (await mockStats()).calls === callsBefore)
await sleep(2_600)
check('window reset reopens the lane', (await search({ query: 'after reset' })).status === 200)

console.log(failures === 0 ? '\nSEARCH SMOKE: ALL PASS' : `\nSEARCH SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
