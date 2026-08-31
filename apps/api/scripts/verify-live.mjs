#!/usr/bin/env node
/**
 * The live release gate: every scenario, against the deployed edge, pure
 * API — no direct database writes, no test-mode bypass anywhere.
 *
 *   WFC_DEMO_PASSWORD=... node scripts/verify-live.mjs
 *   (API_BASE overrides https://api.wolffi.sh)
 *
 * Uses the seeded org: the owner drives admin scenarios, one seeded demo
 * employee provides the cross-user perspective, and a fresh throwaway
 * "verify" employee is invited through the real flow, exercised, and left
 * suspended with all sessions revoked at the end.
 *
 * Real model calls are capped at max_tokens 30 — the whole suite costs
 * fractions of a cent.
 */
const BASE = process.env.API_BASE ?? 'https://api.wolffi.sh'
const PASSWORD = process.env.WFC_DEMO_PASSWORD
if (!PASSWORD) {
  console.error('WFC_DEMO_PASSWORD required')
  process.exit(1)
}
import { createHash } from 'node:crypto'

const stamp = Date.now().toString(36)
let failures = 0
let n = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  n++
  console.log(`${ok ? '✅' : '❌'} ${String(n).padStart(2, '0')} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
const api = async (path, { token, body, method, raw } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined && raw === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {}
  return { status: res.status, json, buf, headers: res.headers }
}

const V31 = 'deepseek-ai/DeepSeek-V3.1'
const R1 = 'deepseek-ai/DeepSeek-R1-0528'
const tinyChat = (token, model, stream = false) =>
  stream
    ? fetch(`${BASE}/ai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: 30,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
        })
      })
    : api('/ai/v1/chat/completions', {
        token,
        body: { model, max_tokens: 30, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }
      })

// ── 0 · health ───────────────────────────────────────────────────────────
const health = await api('/health')
check('health', health.status === 200 && health.json?.ok === true)

// ── 1 · owner + seeded employee sign in ─────────────────────────────────
const owner = await api('/auth/login', {
  body: { email: 'younes@wolffi.sh', password: PASSWORD, device: { platform: 'desktop', name: 'verify' } }
})
check('owner login', owner.status === 200 && owner.json?.user?.role === 'owner')
const O = owner.json.access_token

const roster = await api('/admin/users', { token: O })
const demoEmp = (roster.json?.users ?? []).find(
  (u) => u.role === 'employee' && u.status === 'active' && !u.must_change_password
)
check('seeded roster present', (roster.json?.users ?? []).length >= 50 && Boolean(demoEmp))
const empLogin = await api('/auth/login', {
  body: { email: demoEmp.email, password: PASSWORD, device: { platform: 'sim', name: 'verify-emp' } }
})
check('seeded employee login', empLogin.status === 200)
const E = empLogin.json.access_token

// ── 2 · invite flow, end to end ──────────────────────────────────────────
const vEmail = `verify-${stamp}@demo.wolffi.sh`
const invite = await api('/admin/users', {
  token: O,
  body: { email: vEmail, name: 'Verify User', role: 'employee' }
})
check('invite issues temp password', invite.status === 200 && invite.json?.temp_password)
check(
  'duplicate invite 409',
  (await api('/admin/users', { token: O, body: { email: vEmail, name: 'Dup', role: 'employee' } })).status === 409
)
const t = await api('/auth/login', { body: { email: vEmail, password: invite.json.temp_password } })
check('temp login demands change, no session', t.json?.must_change_password === true && !t.json?.access_token)
check(
  'weak password refused',
  (await api('/auth/password', { token: t.json.change_token, body: { new_password: 'short' } })).status === 400
)
const V_PW = `verify-pass-${stamp}`
check(
  'password change ok',
  (await api('/auth/password', { token: t.json.change_token, body: { new_password: V_PW } })).status === 200
)
check('temp password dead', (await api('/auth/login', { body: { email: vEmail, password: invite.json.temp_password } })).status === 401)
const v = await api('/auth/login', {
  body: { email: vEmail, password: V_PW, device: { platform: 'desktop', name: 'verify-dev' } }
})
check('verify user login', v.status === 200)
let VT = v.json.access_token
const vId = v.json.user.id
const me1 = await api('/v1/me', { token: VT })
check('/v1/me identity + device', me1.json?.user?.email === vEmail && me1.json?.device?.id === v.json.device_id)

// ── 3 · security gates ───────────────────────────────────────────────────
check('wrong password 401', (await api('/auth/login', { body: { email: vEmail, password: 'nope-nope-nope' } })).status === 401)
check('garbage token 401', (await api('/v1/me', { token: 'not.a.token' })).status === 401)
check('unauthenticated router 401', (await api('/ai/v1/chat/completions', { body: { model: V31 } })).status === 401)
check('employee blocked from admin', (await api('/admin/users', { token: VT })).status === 403)

// ── 4 · the router, on real DeepSeek ─────────────────────────────────────
const chat1 = await tinyChat(VT, V31)
check('V3.1 completes (JSON)', chat1.status === 200 && chat1.json?.usage?.completion_tokens > 0, JSON.stringify(chat1.json).slice(0, 200))
const chat2 = await tinyChat(VT, R1, true)
const sse = await chat2.text()
check(
  'R1 streams (SSE + [DONE])',
  chat2.status === 200 && chat2.headers.get('content-type')?.includes('event-stream') && sse.includes('[DONE]'),
  sse.slice(0, 120)
)
check(
  'unknown model 403 with allowed list',
  (await api('/ai/v1/chat/completions', {
    token: VT,
    body: { model: 'not-a-real/model', messages: [{ role: 'user', content: 'x' }] }
  })).status === 403
)

// ── 5 · governance: allowlist + quota, live edits ────────────────────────
const models0 = await api('/v1/models', { token: VT })
check('catalog serves org defaults', (models0.json?.models ?? []).length === 2)
check(
  'narrow allowlist',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [V31] } })).status === 200
)
await new Promise((r) => setTimeout(r, 1500)) // KV cache invalidation
const models1 = await api('/v1/models', { token: VT })
check('catalog reflects narrowing', (models1.json?.models ?? []).length === 1 && models1.json.models[0].id === V31)
const deniedR1 = await api('/ai/v1/chat/completions', {
  token: VT,
  body: { model: R1, messages: [{ role: 'user', content: 'x' }] }
})
check('narrowed model denied', deniedR1.status === 403 && deniedR1.json?.error === 'model_not_allowed')

check(
  'tiny quota set',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [V31], daily_token_cap: 10 } })).status === 200
)
await new Promise((r) => setTimeout(r, 1500))
const quotaDenied = await tinyChat(VT, V31)
check('quota trips 429', quotaDenied.status === 429 && quotaDenied.json?.error === 'quota_exceeded', JSON.stringify(quotaDenied.json))
check(
  'quota restored',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [V31], daily_token_cap: null } })).status === 200
)
await new Promise((r) => setTimeout(r, 1500))
check('service restored after cap lift', (await tinyChat(VT, V31)).status === 200)

// ── 6 · sync: the folder-is-a-cache proof ────────────────────────────────
check(
  'config put',
  (await api('/v1/config', { token: VT, method: 'PUT', body: { config: { theme: 'dark', pinned: true } } })).status === 200
)
check('config get round-trips', (await api('/v1/config', { token: VT })).json?.config?.theme === 'dark')
const now = new Date().toISOString()
const convId = `cnv_verify_${stamp}`
const items = [
  { type: 'conversation', id: convId, title: 'Verify chat', created_at: now, updated_at: now },
  { type: 'record', id: `rec_verify_${stamp}_0`, conversation_id: convId, seq: 0, content: { role: 'user', text: 'hello' }, created_at: now },
  { type: 'record', id: `rec_verify_${stamp}_1`, conversation_id: convId, seq: 1, content: { role: 'assistant', text: 'hi' }, created_at: now },
  { type: 'episode', id: `epi_verify_${stamp}`, content: { note: 'verified' }, occurred_at: now }
]
const b1 = await api('/v1/sync/batch', { token: VT, body: { items } })
check('outbox batch accepted', b1.json?.accepted === 4 && b1.json?.rejected === 0, JSON.stringify(b1.json))
const b2 = await api('/v1/sync/batch', { token: VT, body: { items } })
check('replay is a no-op', b2.json?.accepted === 0 && b2.json?.ignored === 4)
const page = await api(`/v1/conversations/${convId}/records`, { token: VT })
check('records page back', page.json?.records?.length === 2 && page.json.records[1].content.text === 'hi')
check('other employee cannot read them', (await api(`/v1/conversations/${convId}/records`, { token: E })).status === 404)

const blob = Buffer.from(`verify blob ${stamp}`)
const sha = createHash('sha256').update(blob).digest('hex')
const up = await api(`/v1/files/upload?sha256=${sha}&name=verify.txt&mime=text/plain`, { token: VT, raw: blob })
check('file upload to R2', up.status === 200 && up.json?.deduped === false)
check('re-upload dedupes', (await api(`/v1/files/upload?sha256=${sha}&name=copy.txt&mime=text/plain`, { token: VT, raw: blob })).json?.deduped === true)
check(
  'hash mismatch rejected',
  (await api(`/v1/files/upload?sha256=${'0'.repeat(64)}&name=x&mime=text/plain`, { token: VT, raw: blob })).status === 400
)
const dl = await api(`/v1/files/${sha}`, { token: VT })
check('blob round-trips from R2', dl.status === 200 && dl.buf.equals(blob))
check('other employee cannot fetch blob', (await api(`/v1/files/${sha}`, { token: E })).status === 404)
const boot = await api('/v1/sync/bootstrap', { token: VT })
check(
  'bootstrap rehydrates fresh install',
  boot.json?.config?.theme === 'dark' && boot.json?.conversations?.length === 1 && boot.json?.files?.length === 2
)

// ── 7 · sessions: refresh, reuse, PIN, revoke, reset, suspend ────────────
const r1 = await api('/auth/refresh', { body: { refresh_token: v.json.refresh_token } })
check('refresh rotates', r1.status === 200 && r1.json?.refresh_token !== v.json.refresh_token)
check('old refresh reuse kills session', (await api('/auth/refresh', { body: { refresh_token: v.json.refresh_token } })).json?.error === 'refresh_reuse_detected')
const v2 = await api('/auth/login', { body: { email: vEmail, password: V_PW, device: { id: v.json.device_id, platform: 'desktop' } } })
check('re-login reuses device row', v2.json?.device_id === v.json.device_id)
VT = v2.json.access_token

check('device reports PIN set', (await api('/v1/device/pin', { token: VT, body: { pin_set: true } })).status === 200)
check('admin requests PIN clear', (await api(`/admin/users/${vId}/clear-pin`, { token: O, body: {} })).status === 200)
const mePin = await api('/v1/me', { token: VT })
check('client sees pin_clear_requested', mePin.json?.device?.pin_clear_requested === 1)
await api('/v1/device/pin', { token: VT, body: { pin_set: false } })
const mePin2 = await api('/v1/me', { token: VT })
check('PIN clear acknowledged', mePin2.json?.device?.pin_clear_requested === 0 && mePin2.json?.device?.pin_set === 0)

check('admin revoke-sessions', (await api(`/admin/users/${vId}/revoke-sessions`, { token: O, body: {} })).json?.revoked >= 1)
await new Promise((r) => setTimeout(r, 1500))
check('revoked token dead at edge', (await api('/v1/me', { token: VT })).status === 401)

const reset = await api(`/admin/users/${vId}/reset-password`, { token: O, body: {} })
check('admin reset issues temp', reset.status === 200 && reset.json?.temp_password)
check('old password dead after reset', (await api('/auth/login', { body: { email: vEmail, password: V_PW } })).status === 401)
check(
  'reset temp demands change',
  (await api('/auth/login', { body: { email: vEmail, password: reset.json.temp_password } })).json?.must_change_password === true
)

check('suspend verify user', (await api(`/admin/users/${vId}`, { token: O, method: 'PATCH', body: { status: 'suspended' } })).status === 200)
check('suspended login 403', (await api('/auth/login', { body: { email: vEmail, password: reset.json.temp_password } })).status === 403)

// ── 8 · observability ────────────────────────────────────────────────────
const usage = await api(`/admin/usage?user_id=${vId}`, { token: O })
const decisions = new Set((usage.json?.recent ?? []).map((r) => r.decision))
check('usage rows for verify user', (usage.json?.recent ?? []).length >= 5)
check('all decision kinds metered', decisions.has('allowed') && decisions.has('denied_model') && decisions.has('denied_quota'), [...decisions].join(','))
const costed = (usage.json?.recent ?? []).find((r) => r.decision === 'allowed' && r.cost_microusd > 0)
check('upstream cost metered', Boolean(costed))
const audit = await api('/admin/audit?limit=50', { token: O })
const actions = new Set((audit.json?.entries ?? []).map((e) => e.action))
check(
  'audit trail complete',
  ['user.invite', 'policy.set', 'user.revoke_sessions', 'user.reset_password', 'user.update', 'device.clear_pin'].every((a) => actions.has(a)),
  [...actions].join(',')
)

// owner signs out
check('owner logout', (await api('/v1/logout', { token: O, body: {} })).status === 200)

console.log(
  failures === 0
    ? `\nLIVE VERIFICATION: ALL ${n} CHECKS PASS against ${BASE}`
    : `\nLIVE VERIFICATION: ${failures}/${n} FAILURES against ${BASE}`
)
process.exit(failures === 0 ? 0 : 1)
