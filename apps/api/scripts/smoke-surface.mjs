#!/usr/bin/env node
/**
 * Surface attribution + token plans, against `wrangler dev` (:8787).
 *
 * The claim under test is the one the admin screen is built on: a client
 * says which SURFACE a call came from, and that survives all the way to
 * what an admin reads. So this walks the whole path rather than any one
 * hop — header -> usage row -> usage_daily rollup -> /admin/users/:id/overview
 * -> /admin/roster — and separately checks the plan counters the ceilings
 * are actually enforced against, which live in the gate rather than in D1.
 *
 * Also asserts the failure mode on purpose: an unrecognised surface is
 * METERED AS UNATTRIBUTED, never refused. Attribution is reporting, and a
 * router that rejected a call over a label would be trading a working
 * product for a tidy database.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = 'http://localhost:8787'
const stamp = Date.now().toString(36)
const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync('surface-pw-1', Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const email = `surface-${stamp}@wolffi.sh`
execSync(
  `npx wrangler d1 execute wfc-master --local --command "INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password) VALUES ('usr_surface_${stamp}', '${email}', 'Surface', 'owner', 'active', '${hash}', '${salt}', 0);"`,
  { stdio: 'pipe' }
)

const api = async (path, { token, body, method, headers } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

let failures = 0
const check = (n, c, extra = '') => {
  console.log(`${c ? '✅' : '❌'} ${n}${c || !extra ? '' : ` — ${extra}`}`)
  if (!c) failures++
}

const login = await api('/auth/login', { body: { email, password: 'surface-pw-1', device: { platform: 'sim' } } })
const tok = login.json.access_token
const org = (await api('/admin/org', { token: tok })).json.org
const model = org.default_model

// One call per surface the desktop can declare, plus a bogus one.
const surfaces = ['inapp', 'mobile', 'heartbeat', 'procedure']
for (const surface of surfaces) {
  const r = await api('/ai/v1/chat/completions', {
    token: tok,
    headers: { 'x-wfc-surface': surface },
    body: { model, messages: [{ role: 'user', content: `hello from ${surface}` }] }
  })
  check(`${surface}: call accepted`, r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`)
}
const bogus = await api('/ai/v1/chat/completions', {
  token: tok,
  headers: { 'x-wfc-surface': 'definitely-not-a-surface' },
  body: { model, messages: [{ role: 'user', content: 'hello' }] }
})
check('an unknown surface is metered, not refused', bogus.status === 200, `HTTP ${bogus.status}`)

await new Promise((r) => setTimeout(r, 1500))

const rows = JSON.parse(
  execSync(
    `npx wrangler d1 execute wfc-master --local --json --command "SELECT surface, COUNT(*) n FROM usage WHERE user_id = 'usr_surface_${stamp}' GROUP BY surface ORDER BY surface;"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
)[0].results
const bySurface = Object.fromEntries(rows.map((r) => [r.surface, r.n]))
for (const s of surfaces) check(`usage row records surface=${s}`, bySurface[s] >= 1, JSON.stringify(bySurface))
check("an unknown surface records as ''", (bySurface[''] ?? 0) >= 1, JSON.stringify(bySurface))

const daily = JSON.parse(
  execSync(
    `npx wrangler d1 execute wfc-master --local --json --command "SELECT surface, SUM(requests) r FROM usage_daily WHERE user_id = 'usr_surface_${stamp}' GROUP BY surface ORDER BY surface;"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
)[0].results
check(
  `rollup splits by surface (${daily.length} buckets)`,
  daily.length === surfaces.length + 1,
  JSON.stringify(daily)
)

const ov = await api(`/admin/users/usr_surface_${stamp}/overview`, { token: tok })
const seen = new Set((ov.json?.surfaces ?? []).map((s) => s.surface))
check('overview reports each surface', surfaces.every((s) => seen.has(s)), [...seen].join(','))

// The plan ceiling is what the roster's meter reads; prove it is live.
const roster = await api('/admin/roster', { token: tok })
const me = (roster.json?.people ?? []).find((p) => p.id === `usr_surface_${stamp}`)
check('roster shows month-to-date input for this person', (me?.month_tokens_in ?? 0) > 0, JSON.stringify(me?.month_tokens_in))
check('roster ceilings are the standard plan', me?.ceilings?.monthlyIn === 100_000_000)

// The plan ceilings are enforced against the GATE's durable counters, not
// the D1 rollup — so the thing to prove live is that those counters move.
// (The comparison itself is exercised by smoke-ai's `quota trips 429`,
// which runs through the same admit path.)
const gates = await api(`/admin/gates?user_id=usr_surface_${stamp}`, { token: tok })
const tokens = gates.json?.standing?.tokens
check('gate reports this user\'s month-to-date input', (tokens?.userMonthIn ?? 0) > 0, JSON.stringify(tokens))
check('gate reports this user\'s month-to-date output', (tokens?.userMonthOut ?? 0) > 0, JSON.stringify(tokens))
check(
  'gate input and output are counted separately',
  tokens?.userMonthIn !== tokens?.userMonthOut,
  JSON.stringify(tokens)
)

// A plan change must reach the router, not just the row: the policy cache
// is versioned and invalidated on write, and this is the assertion that
// would fail if that invalidation were dropped.
await api(`/admin/users/usr_surface_${stamp}/plan`, { token: tok, method: 'PUT', body: { token_plan: 'high' } })
const after = await api(`/admin/users/usr_surface_${stamp}/overview`, { token: tok })
check('plan change is visible immediately', after.json?.policy?.ceilings?.monthlyIn === 300_000_000,
  JSON.stringify(after.json?.policy?.ceilings))

console.log(failures === 0 ? '\nSURFACE: ALL PASS' : `\nSURFACE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
