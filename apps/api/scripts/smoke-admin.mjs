#!/usr/bin/env node
/**
 * Admin-layer smoke test against `wrangler dev` (:8787). Seeds an owner,
 * then exercises the enterprise controls end to end:
 *
 *   owner invites employee (temp password from the API) → employee onboards
 *   → role gates (employee/support vs admin) → policy set → suspend kills
 *   live session → reactivate → reset-password revokes + re-onboards →
 *   revoke-sessions → org settings → usage read → audit trail populated.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const ownerEmail = `owner-${stamp}@wolffi.sh`
const OWNER_PW = 'owner-passphrase-1'

const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(OWNER_PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4-Flash-0731', '[]');`,
  `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
   VALUES ('usr_owner_${stamp}', '${ownerEmail}', 'The Owner', 'owner', 'active', '${hash}', '${salt}', 0);`
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
const login = async (email, password) =>
  api('/auth/login', { body: { email, password, device: { platform: 'sim' } } })

// Owner signs in
const owner = await login(ownerEmail, OWNER_PW)
check('owner login', owner.status === 200 && owner.json?.user?.role === 'owner')
const ownerTok = owner.json.access_token

// Invite an employee — temp password comes back exactly once
const empEmail = `emp-${stamp}@wolffi.sh`
const invite = await api('/admin/users', {
  token: ownerTok,
  body: { email: empEmail, name: 'Emp Loyee', role: 'employee' }
})
check('invite returns temp password', invite.status === 200 && invite.json?.temp_password)
check('duplicate invite refused', (await api('/admin/users', {
  token: ownerTok,
  body: { email: empEmail, name: 'Dup', role: 'employee' }
})).status === 409)

// Employee onboards: temp login → change → real login
const EMP_PW = 'employee-real-pw-1'
const t = await login(empEmail, invite.json.temp_password)
check('employee temp login demands change', t.json?.must_change_password === true)
const ch = await api('/auth/password', { token: t.json.change_token, body: { new_password: EMP_PW } })
check('employee sets real password', ch.status === 200)
const emp = await login(empEmail, EMP_PW)
check('employee active login', emp.status === 200 && emp.json?.user?.role === 'employee')
const empTok = emp.json.access_token
const empId = emp.json.user.id

// Role gates
check('employee blocked from admin', (await api('/admin/users', { token: empTok })).status === 403)

// Support: read yes, write no
const supInvite = await api('/admin/users', {
  token: ownerTok,
  body: { email: `sup-${stamp}@wolffi.sh`, name: 'Sup Port', role: 'support' }
})
const st = await login(`sup-${stamp}@wolffi.sh`, supInvite.json.temp_password)
await api('/auth/password', { token: st.json.change_token, body: { new_password: 'support-pw-1234' } })
const sup = await login(`sup-${stamp}@wolffi.sh`, 'support-pw-1234')
check('support can read users', (await api('/admin/users', { token: sup.json.access_token })).status === 200)
check(
  'support cannot mutate',
  (await api('/admin/users', {
    token: sup.json.access_token,
    body: { email: `x-${stamp}@wolffi.sh`, name: 'X', role: 'employee' }
  })).status === 403
)

// Policy
const pol = await api(`/admin/users/${empId}/policy`, {
  token: ownerTok,
  method: 'PUT',
  body: { allowed_models: ['deepseek-ai/DeepSeek-V4-Flash-0731'], daily_token_cap: 50000 }
})
check('policy set', pol.status === 200)
const detail = await api(`/admin/users/${empId}`, { token: ownerTok })
check('policy visible on user detail', detail.json?.policy?.daily_token_cap === 50000)

// Suspend kills the live session
const susp = await api(`/admin/users/${empId}`, {
  token: ownerTok,
  method: 'PATCH',
  body: { status: 'suspended' }
})
check('suspend ok', susp.status === 200)
check('suspended session dead', (await api('/v1/me', { token: empTok })).status === 401)
check('suspended login refused', (await login(empEmail, EMP_PW)).status === 403)

// Reactivate
await api(`/admin/users/${empId}`, { token: ownerTok, method: 'PATCH', body: { status: 'active' } })
const emp2 = await login(empEmail, EMP_PW)
check('reactivated login works', emp2.status === 200)

// Reset password: old creds die, new temp onboards again
const reset = await api(`/admin/users/${empId}/reset-password`, { token: ownerTok, body: {} })
check('reset returns temp password', reset.status === 200 && reset.json?.temp_password)
check('old password dead after reset', (await login(empEmail, EMP_PW)).status === 401)
check('reset revoked live session', (await api('/v1/me', { token: emp2.json.access_token })).status === 401)
const t2 = await login(empEmail, reset.json.temp_password)
check('reset temp demands change', t2.json?.must_change_password === true)

// Config: the admin support loop — view a user's synced blob, author a fix
// the user actually receives, reset to empty. Tier gates: support never sees
// it (it holds the user's secrets), an admin never sees an owner's.
await api('/auth/password', { token: t2.json.change_token, body: { new_password: 'emp-password-3' } })
const emp3 = await login(empEmail, 'emp-password-3')
const empTok3 = emp3.json.access_token
await api('/v1/config', {
  token: empTok3,
  method: 'PUT',
  body: { config: { theme: 'dark', variables: [{ name: 'API_KEY', value: 'sk-test', sensitive: true }] } }
})
const cfgView = await api(`/admin/users/${empId}/config`, { token: ownerTok })
check(
  'owner views user config',
  cfgView.status === 200 &&
    cfgView.json?.config?.theme === 'dark' &&
    cfgView.json?.config?.variables?.[0]?.value === 'sk-test'
)
check(
  'support cannot view config',
  (await api(`/admin/users/${empId}/config`, { token: sup.json.access_token })).status === 403
)
check(
  'config for unknown user 404',
  (await api('/admin/users/usr_nobody/config', { token: ownerTok })).status === 404
)
check(
  'admin-authored config write',
  (await api(`/admin/users/${empId}/config`, {
    token: ownerTok,
    method: 'PUT',
    body: { config: { theme: 'light' } }
  })).status === 200
)
check('user receives admin write', (await api('/v1/config', { token: empTok3 })).json?.config?.theme === 'light')
check(
  'admin config reset',
  (await api(`/admin/users/${empId}/config`, { token: ownerTok, method: 'PUT', body: { config: {} } })).status === 200
)
const afterReset = await api('/v1/config', { token: empTok3 })
check(
  'user config reset to empty',
  afterReset.status === 200 && Object.keys(afterReset.json?.config ?? {}).length === 0
)

// Admin tier can serve employees but never open an owner's secrets.
const admInvite = await api('/admin/users', {
  token: ownerTok,
  body: { email: `adm-${stamp}@wolffi.sh`, name: 'Ad Min', role: 'admin' }
})
const at = await login(`adm-${stamp}@wolffi.sh`, admInvite.json.temp_password)
await api('/auth/password', { token: at.json.change_token, body: { new_password: 'admin-pw-1234' } })
const adm = await login(`adm-${stamp}@wolffi.sh`, 'admin-pw-1234')
check(
  'admin views employee config',
  (await api(`/admin/users/${empId}/config`, { token: adm.json.access_token })).status === 200
)
check(
  'admin cannot view owner config',
  (await api(`/admin/users/${owner.json.user.id}/config`, { token: adm.json.access_token })).status === 403
)

// Self-protection & owner guard
check(
  'owner cannot self-suspend',
  (await api(`/admin/users/${owner.json.user.id}`, {
    token: ownerTok,
    method: 'PATCH',
    body: { status: 'suspended' }
  })).status === 403
)

// Org settings + usage + audit
check(
  'org patch',
  (await api('/admin/org', { token: ownerTok, method: 'PATCH', body: { name: 'Wolffish Inc' } })).status === 200
)
const org = await api('/admin/org', { token: ownerTok })
check('org read reflects patch', org.json?.org?.name === 'Wolffish Inc')
check('usage endpoint serves', (await api('/admin/usage', { token: ownerTok })).status === 200)
const aud = await api('/admin/audit', { token: ownerTok })
check(
  'audit trail populated',
  aud.status === 200 && (aud.json?.entries ?? []).some((e) => e.action === 'user.invite')
)
const audActions = (aud.json?.entries ?? []).map((e) => e.action)
check(
  'config view and write audited',
  audActions.includes('config.view') && audActions.includes('config.set')
)
check(
  'config audit detail carries no content',
  !(aud.json?.entries ?? []).some((e) => JSON.stringify(e.detail ?? '').includes('sk-test'))
)

console.log(failures === 0 ? '\nADMIN SMOKE: ALL PASS' : `\nADMIN SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
