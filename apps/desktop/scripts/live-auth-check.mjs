#!/usr/bin/env node
/**
 * Live check of the desktop auth journey against the real org API — the
 * same wire calls src/main/cloud/api.ts makes, in the same order the app
 * makes them. Uses the owner account to mint a throwaway employee, walks
 * that employee through the entire first-login story, then suspends them.
 *
 *   WFC_DEMO_PASSWORD=... node scripts/live-auth-check.mjs
 *   (API_BASE overrides https://api.wolffi.sh)
 */
import os from 'node:os'

const BASE = process.env.API_BASE ?? 'https://api.wolffi.sh'
const OWNER_PW = process.env.WFC_DEMO_PASSWORD ?? 'wolffish123'

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

const device = { platform: 'desktop', name: os.hostname(), app_version: '0.1.0-check' }
const stamp = Date.now().toString(36)

// Owner mints the throwaway employee (the admin side of the invite flow).
const owner = await api('/auth/login', {
  body: { email: 'gate.keeper.50@demo.wolffi.sh', password: OWNER_PW, device }
})
check('owner login', owner.status === 200)
const O = owner.json.access_token
const invite = await api('/admin/users', {
  token: O,
  body: { email: `authcheck-${stamp}@demo.wolffi.sh`, name: 'Auth Check', role: 'employee' }
})
check('invite minted', invite.status === 200 && invite.json?.temp_password)
const email = `authcheck-${stamp}@demo.wolffi.sh`

// 1 — the app's first sign-in: temp password → must_change_password
const t1 = await api('/auth/login', { body: { email, password: invite.json.temp_password, device } })
check('temp login demands change', t1.status === 200 && t1.json?.must_change_password === true)

// 2 — forced change with the scoped token, then the real login (the exact
//     completePasswordChange() sequence)
const NEW_PW = `authcheck-pass-${stamp}`
const ch = await api('/auth/password', {
  token: t1.json.change_token,
  body: { new_password: NEW_PW }
})
check('password change accepted', ch.status === 200)
const login = await api('/auth/login', { body: { email, password: NEW_PW, device } })
check(
  'real login returns full session',
  login.status === 200 && login.json?.access_token && login.json?.refresh_token && login.json?.device_id
)

// 3 — device id reuse: logging in again with the id must keep the same row
const again = await api('/auth/login', {
  body: { email, password: NEW_PW, device: { ...device, id: login.json.device_id } }
})
check('device id reused on re-login', again.json?.device_id === login.json.device_id)

// 4 — refresh rotation (the getAccessToken() path)
const r1 = await api('/auth/refresh', { body: { refresh_token: again.json.refresh_token } })
check('refresh rotates', r1.status === 200 && r1.json?.refresh_token !== again.json.refresh_token)
const ACCESS = r1.json.access_token

// 5 — /v1/me (the watchdog tick)
const me1 = await api('/v1/me', { token: ACCESS })
check('me resolves user + device', me1.json?.user?.email === email && me1.json?.device?.id)

// 6 — PIN lifecycle: report set → admin clears → me shows request → ack
check('pin_set reported', (await api('/v1/device/pin', { token: ACCESS, body: { pin_set: true } })).status === 200)
const userId = me1.json.user.id
check('admin requests clear', (await api(`/admin/users/${userId}/clear-pin`, { token: O, body: {} })).status === 200)
const me2 = await api('/v1/me', { token: ACCESS })
check('clear request visible to device', me2.json?.device?.pin_clear_requested === 1)
check('device acks clear', (await api('/v1/device/pin', { token: ACCESS, body: { pin_set: false } })).status === 200)
const me3 = await api('/v1/me', { token: ACCESS })
check('clear acked', me3.json?.device?.pin_clear_requested === 0 && me3.json?.device?.pin_set === 0)

// 7 — logout kills the token (the signOut() path)
check('logout ok', (await api('/v1/logout', { token: ACCESS, body: {} })).status === 200)
check('token dead after logout', (await api('/v1/me', { token: ACCESS })).status === 401)

// 8 — precise failure codes the sign-in screen maps
const bad = await api('/auth/login', { body: { email, password: 'wrong-wrong-wrong', device } })
check('wrong_password code', bad.status === 401 && bad.json?.error === 'wrong_password')
const ghost = await api('/auth/login', {
  body: { email: 'nobody-here@demo.wolffi.sh', password: 'whatever-at-all', device }
})
check('email_not_found code', ghost.status === 401 && ghost.json?.error === 'email_not_found')

// cleanup: suspend the throwaway
check(
  'cleanup: throwaway suspended',
  (await api(`/admin/users/${userId}`, { token: O, method: 'PATCH', body: { status: 'suspended' } })).status === 200
)
check('owner logout', (await api('/v1/logout', { token: O, body: {} })).status === 200)

console.log(failures === 0 ? '\nLIVE AUTH CHECK: ALL PASS' : `\nLIVE AUTH CHECK: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
