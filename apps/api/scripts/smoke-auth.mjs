#!/usr/bin/env node
/**
 * Auth lifecycle smoke test against a running `wrangler dev` (:8787).
 * Seeds its own throwaway user via the local D1, then walks:
 *
 *   temp login → forced password change → real login → /v1/me →
 *   refresh rotation → old-refresh reuse detection → logout → me 401
 *
 * Exits non-zero on the first failed expectation.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const email = `smoke-${stamp}@wolffi.sh`
const TEMP = 'wf-temp-pass1'
const REAL = 'correct-horse-battery'

const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(TEMP, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')

const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V3.1', '[]');`,
  `INSERT INTO users (id, email, name, role, status, password_hash, password_salt,
     must_change_password, temp_password_expires_at)
   VALUES ('usr_smoke_${stamp}', '${email}', 'Smoke Test', 'employee', 'invited',
     '${hash}', '${salt}', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'));`
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
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json }
}

// 1 — temp login must demand a password change, not issue a session
const step1 = await api('/auth/login', { body: { email, password: TEMP } })
check('temp login demands change', step1.status === 200 && step1.json?.must_change_password === true)
check('temp login issues no session', !step1.json?.access_token)

// 2 — weak new password is refused
const weak = await api('/auth/password', {
  token: step1.json.change_token,
  body: { new_password: 'short' }
})
check('weak password refused', weak.status === 400)

// 3 — real password set
const change = await api('/auth/password', {
  token: step1.json.change_token,
  body: { new_password: REAL }
})
check('password change ok', change.status === 200 && change.json?.ok === true)

// 4 — old temp password no longer works
const oldLogin = await api('/auth/login', { body: { email, password: TEMP } })
check('temp password dead after change', oldLogin.status === 401)

// 5 — real login issues a session and a device
const login = await api('/auth/login', {
  body: { email, password: REAL, device: { platform: 'sim', name: 'smoke' } }
})
check(
  'real login issues session',
  login.status === 200 && login.json?.access_token && login.json?.refresh_token,
  JSON.stringify(login.json)
)
check('login reports user + device', login.json?.user?.email === email && login.json?.device_id)

// 6 — /v1/me works with the access token
const meRes = await api('/v1/me', { token: login.json.access_token })
check('/v1/me resolves identity', meRes.status === 200 && meRes.json?.user?.email === email)
check('/v1/me carries org', meRes.json?.org?.name === 'Wolffish')

// 7 — wrong password rejected
const bad = await api('/auth/login', { body: { email, password: 'wrong-password-x' } })
check('wrong password rejected', bad.status === 401)

// 8 — refresh rotates
const r1 = await api('/auth/refresh', { body: { refresh_token: login.json.refresh_token } })
check('refresh rotates', r1.status === 200 && r1.json?.refresh_token !== login.json.refresh_token)

// 9 — reusing the rotated-out refresh token kills the session
const reuse = await api('/auth/refresh', { body: { refresh_token: login.json.refresh_token } })
check('refresh reuse detected', reuse.status === 401 && reuse.json?.error === 'refresh_reuse_detected')
const afterReuse = await api('/auth/refresh', { body: { refresh_token: r1.json.refresh_token } })
check('session dead after reuse', afterReuse.status === 401)

// 10 — fresh login, then logout kills the access token via the kill marker
const login2 = await api('/auth/login', { body: { email, password: REAL } })
check('second login ok', login2.status === 200 && login2.json?.access_token)
const out = await api('/v1/logout', { token: login2.json.access_token, body: {} })
check('logout ok', out.status === 200)
const meAfter = await api('/v1/me', { token: login2.json.access_token })
check('access token dead after logout', meAfter.status === 401)

// 11 — garbage tokens rejected
const garbage = await api('/v1/me', { token: 'not.a.token' })
check('garbage token rejected', garbage.status === 401)

console.log(failures === 0 ? '\nAUTH SMOKE: ALL PASS' : `\nAUTH SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
