#!/usr/bin/env node
/**
 * Router smoke test against `wrangler dev` (:8787) with the mock upstream
 * (:9090, set via DEEPINFRA_BASE_URL in .dev.vars). Walks:
 *
 *   /v1/models reflects policy → allowed model completes (JSON) →
 *   streaming completes with SSE passthrough → disallowed model 403 +
 *   metered → tiny quota trips 429 + metered → usage rows visible via
 *   /admin/usage → quota denial clears when the cap is raised.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const ownerEmail = `aiowner-${stamp}@wolffi.sh`
const PW = 'ai-owner-pass-1'
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const OTHER = 'deepseek-ai/DeepSeek-V4-Pro-0813'

const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', '${MODEL}', '[]');`,
  `UPDATE org SET default_model = '${MODEL}', default_allowed_models = '[]' WHERE id = 1;`,
  `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
   VALUES ('usr_ai_${stamp}', '${ownerEmail}', 'AI Owner', 'owner', 'active', '${hash}', '${salt}', 0);`
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
  return { status: res.status, json, text }
}

const owner = await api('/auth/login', { body: { email: ownerEmail, password: PW } })
check('login', owner.status === 200)
const tok = owner.json.access_token
const uid = owner.json.user.id

// Catalog: no explicit policy → default model only
const models0 = await api('/v1/models', { token: tok })
check(
  'catalog defaults to org default model',
  models0.json?.models?.length === 1 && models0.json.models[0].id === MODEL
)

// Unauthenticated router call rejected
check('router requires auth', (await api('/ai/v1/chat/completions', { body: { model: MODEL } })).status === 401)

// Allowed model, JSON completion
const chat = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] }
})
check(
  'allowed model completes',
  chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.includes('mock'),
  JSON.stringify(chat.json)
)

// Streaming passthrough
const streamRes = await fetch(`${BASE}/ai/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true })
})
const streamText = await streamRes.text()
check(
  'streaming passthrough works',
  streamRes.status === 200 &&
    streamRes.headers.get('content-type')?.includes('event-stream') &&
    streamText.includes('Hello ') &&
    streamText.includes('[DONE]')
)

// Thinking modes: the router forwards reasoning_effort verbatim and the
// upstream's reasoning_content comes back untouched, in both wire shapes.
const thinkOn = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: MODEL, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] }
})
check(
  'reasoning_effort=high returns reasoning_content (JSON)',
  thinkOn.status === 200 && thinkOn.json?.choices?.[0]?.message?.reasoning_content?.length > 0,
  JSON.stringify(thinkOn.json)
)
const thinkOff = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: MODEL, reasoning_effort: 'none', messages: [{ role: 'user', content: 'hi' }] }
})
check(
  'reasoning_effort=none returns no reasoning_content',
  thinkOff.status === 200 && thinkOff.json?.choices?.[0]?.message?.reasoning_content === undefined
)
const thinkStream = await fetch(`${BASE}/ai/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  body: JSON.stringify({
    model: MODEL,
    reasoning_effort: 'max',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  })
})
check(
  'streamed reasoning_content passes through',
  thinkStream.status === 200 && (await thinkStream.text()).includes('"reasoning_content"')
)
check(
  'invalid reasoning_effort surfaces as upstream_error',
  (await api('/ai/v1/chat/completions', {
    token: tok,
    body: { model: MODEL, reasoning_effort: 'banana', messages: [{ role: 'user', content: 'hi' }] }
  })).status === 502
)

// Disallowed model refused with the allowed list attached
const denied = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: OTHER, messages: [{ role: 'user', content: 'hi' }] }
})
check(
  'disallowed model refused',
  denied.status === 403 && denied.json?.error === 'model_not_allowed' && denied.json?.default_model === MODEL
)

// Widen policy → catalog grows → model now allowed
await api(`/admin/users/${uid}/policy`, {
  token: tok,
  method: 'PUT',
  body: { allowed_models: [MODEL, OTHER] }
})
const models1 = await api('/v1/models', { token: tok })
check('catalog reflects widened policy', models1.json?.models?.length === 2)
const nowAllowed = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: OTHER, messages: [{ role: 'user', content: 'hi' }] }
})
check('policy change takes effect', nowAllowed.status === 200)

// Tiny quota trips: 12 tokens already used ≥ cap 10
await api(`/admin/users/${uid}/policy`, {
  token: tok,
  method: 'PUT',
  body: { allowed_models: [MODEL], daily_token_cap: 10 }
})
await new Promise((r) => setTimeout(r, 400)) // let waitUntil metering land
const quotaDenied = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] }
})
check(
  'quota trips 429',
  quotaDenied.status === 429 && quotaDenied.json?.error === 'quota_exceeded',
  JSON.stringify(quotaDenied.json)
)

// Raise the cap → requests flow again
await api(`/admin/users/${uid}/policy`, {
  token: tok,
  method: 'PUT',
  body: { allowed_models: [MODEL], daily_token_cap: 1000000 }
})
const flowing = await api('/ai/v1/chat/completions', {
  token: tok,
  body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] }
})
check('raised cap restores service', flowing.status === 200)

// Usage rows: allowed + denied_model + denied_quota all metered
await new Promise((r) => setTimeout(r, 400))
const usage = await api(`/admin/usage?user_id=${uid}`, { token: tok })
const decisions = new Set((usage.json?.recent ?? []).map((r) => r.decision))
check('usage rows written', (usage.json?.recent ?? []).length >= 4)
check(
  'denials metered too',
  decisions.has('allowed') && decisions.has('denied_model') && decisions.has('denied_quota'),
  [...decisions].join(',')
)
const allowedRow = (usage.json?.recent ?? []).find((r) => r.decision === 'allowed')
check('token counts metered', allowedRow?.tokens_in === 7 && allowedRow?.tokens_out === 5)
check('cost computed', (allowedRow?.cost_microusd ?? 0) > 0)

console.log(failures === 0 ? '\nAI SMOKE: ALL PASS' : `\nAI SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
