#!/usr/bin/env node
/**
 * Admin-layer smoke test against `wrangler dev` (:8787). Seeds an owner,
 * then exercises the enterprise controls end to end:
 *
 *   owner invites employee (emailed activation code) → employee activates
 *   → role gates (employee/support vs admin) → policy set → suspend kills
 *   live session → reactivate → reset-password revokes + re-onboards →
 *   revoke-sessions → org settings → usage read → audit trail populated.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
// One transport-only retry: a wrangler CLI call mid-run closes the dev
// server's keep-alive socket, and the NEXT fetch gets ECONNRESET.
const fetchRetry = async (url, init) => {
  try {
    return await fetch(url, init)
  } catch {
    return fetch(url, init)
  }
}
const api = async (path, { token, body, method } = {}) => {
  const res = await fetchRetry(`${BASE}${path}`, {
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

// Invite an employee — an activation code is mailed, not a password.
// `wrangler dev` has no RESEND_API_KEY, so the API reports email_sent:false
// and hands the code back (see routes/admin.ts) — the only way a local run
// can drive the real flow.
const empEmail = `deema.alsalem+${stamp}@wolffi.sh`
const invite = await api('/admin/users', {
  token: ownerTok,
  body: { email: empEmail, name: 'Deema Alsalem', role: 'employee' }
})
check('invite issues an activation code', invite.status === 200 && /^[0-9]{6}$/.test(invite.json?.activation_code ?? ''))
check('invite hands back no password', !invite.json?.temp_password)
check('duplicate invite refused', (await api('/admin/users', {
  token: ownerTok,
  body: { email: empEmail, name: 'Deema Alsalem', role: 'employee' }
})).status === 409)

/** Invite → activate → sign in, the whole onboarding as one step. */
const onboard = async (email, name, role, password) => {
  const inv = await api('/admin/users', { token: ownerTok, body: { email, name, role } })
  await api('/auth/activate/confirm', {
    body: { email, code: inv.json.activation_code, new_password: password }
  })
  return login(email, password)
}

// Employee activates: wrong code, then the real one, then sign in.
const EMP_PW = 'employee-real-pw-1'
check(
  'invited account cannot sign in',
  (await login(empEmail, EMP_PW)).status === 401
)
const A_CODE = invite.json.activation_code
check(
  'wrong activation code rejected',
  (await api('/auth/activate/confirm', {
    body: { email: empEmail, code: A_CODE === '000000' ? '000001' : '000000', new_password: EMP_PW }
  })).json?.error === 'invalid_code'
)
check(
  'short password rejected',
  (await api('/auth/activate/confirm', { body: { email: empEmail, code: A_CODE, new_password: 'short' } })).status === 400
)
const act = await api('/auth/activate/confirm', { body: { email: empEmail, code: A_CODE, new_password: EMP_PW } })
check('activation ok', act.status === 200)
check(
  'code dead after use',
  (await api('/auth/activate/confirm', { body: { email: empEmail, code: A_CODE, new_password: EMP_PW } })).json?.error === 'already_active'
)
const emp = await login(empEmail, EMP_PW)
check('employee active login', emp.status === 200 && emp.json?.user?.role === 'employee')
const empTok = emp.json.access_token
const empId = emp.json.user.id

// Role gates
check('employee blocked from admin', (await api('/admin/users', { token: empTok })).status === 403)

// Support: read yes, write no
const sup = await onboard(`sup-${stamp}@wolffi.sh`, 'Sup Port', 'support', 'support-pw-1234')
check('support can read users', (await api('/admin/users', { token: sup.json.access_token })).status === 200)
check(
  'support cannot mutate',
  (await api('/admin/users', {
    token: sup.json.access_token,
    body: { email: `ammar.alsuhaimi+${stamp}@wolffi.sh`, name: 'Ammar Alsuhaimi', role: 'employee' }
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
const adm = await onboard(`adm-${stamp}@wolffi.sh`, 'Ad Min', 'admin', 'admin-pw-1234')
check(
  'admin views employee config',
  (await api(`/admin/users/${empId}/config`, { token: adm.json.access_token })).status === 200
)
check(
  'admin cannot view owner config',
  (await api(`/admin/users/${owner.json.user.id}/config`, { token: adm.json.access_token })).status === 403
)

// Re-sending an invite: a new code, the old one dead, and only while the
// account is still waiting to be used.
const rsEmail = `ibtisam.alrumaih+${stamp}@wolffi.sh`
const rsInvite = await api('/admin/users', {
  token: ownerTok,
  body: { email: rsEmail, name: 'Ibtisam Alrumaih', role: 'employee' }
})
const rsId = rsInvite.json.user_id
const rsAgain = await api(`/admin/users/${rsId}/activation`, { token: ownerTok, body: {} })
check('resend issues a fresh code', rsAgain.status === 200 && /^[0-9]{6}$/.test(rsAgain.json?.activation_code ?? ''))
check('resend supersedes the old code', rsAgain.json.activation_code !== rsInvite.json.activation_code)
check(
  'superseded code refused',
  (await api('/auth/activate/confirm', {
    body: { email: rsEmail, code: rsInvite.json.activation_code, new_password: 'resend-pw-12345' }
  })).json?.error === 'invalid_code'
)
check(
  'fresh code activates',
  (await api('/auth/activate/confirm', {
    body: { email: rsEmail, code: rsAgain.json.activation_code, new_password: 'resend-pw-12345' }
  })).status === 200
)
check(
  'resend refused once active',
  (await api(`/admin/users/${rsId}/activation`, { token: ownerTok, body: {} })).status === 409
)
check(
  'self-serve resend refused once active',
  (await api('/auth/activate/request', { body: { email: rsEmail } })).status === 409
)
check(
  'support cannot resend an invite',
  (await api(`/admin/users/${empId}/activation`, { token: sup.json.access_token, body: {} })).status === 403
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



// ── The admin layer: plans, the roster, and reading someone's work ───────
//
// Everything below is what the admin PAGE renders. The roster is one call
// for the whole company (the card grid), the overview is one call for one
// person, and the conversation reads are the same records the employee's own
// client receives — proven here by pushing a conversation as the employee
// and reading it back as the owner.

// Plans: default is standard, and it is a real answer even with no policy row.
const plans = await api('/admin/plans', { token: ownerTok })
check(
  'plan catalogue serves ceilings',
  plans.status === 200 &&
    plans.json?.ceilings?.standard?.monthlyIn === 100_000_000 &&
    plans.json?.ceilings?.high?.monthlyOut === 25_000_000 &&
    plans.json?.ceilings?.unmetered?.monthlyIn === 0
)
const empDetail = await api(`/admin/users/${empId}`, { token: ownerTok })
check('employee defaults to standard plan', empDetail.json?.token_plan === 'standard')
check(
  'standard ceilings on user detail',
  empDetail.json?.ceilings?.monthlyIn === 100_000_000 && empDetail.json?.ceilings?.monthlyOut === 8_000_000
)

check(
  'plan set to high',
  (await api(`/admin/users/${empId}/plan`, { token: ownerTok, method: 'PUT', body: { token_plan: 'high' } }))
    .json?.ceilings?.monthlyIn === 300_000_000
)
check(
  'bogus plan refused',
  (await api(`/admin/users/${empId}/plan`, { token: ownerTok, method: 'PUT', body: { token_plan: 'infinite' } }))
    .status === 400
)
// A policy edit that does not mention the plan must not reset it — the one
// interaction between the two controls that could silently downgrade someone.
await api(`/admin/users/${empId}/policy`, {
  token: ownerTok,
  method: 'PUT',
  body: { daily_search_cap: 25 }
})
check(
  'policy edit preserves plan',
  (await api(`/admin/users/${empId}`, { token: ownerTok })).json?.token_plan === 'high'
)
check(
  'policy edit can set the plan too',
  (await api(`/admin/users/${empId}/policy`, {
    token: ownerTok,
    method: 'PUT',
    body: { daily_search_cap: 25, token_plan: 'unmetered' }
  })).status === 200 &&
    (await api(`/admin/users/${empId}`, { token: ownerTok })).json?.ceilings?.monthlyIn === 0
)
await api(`/admin/users/${empId}/plan`, { token: ownerTok, method: 'PUT', body: { token_plan: 'standard' } })

// The employee does some work: one conversation with a snapshot envelope
// (the provenance the admin list reads) and two messages — then a re-push
// (second snapshot) and one message that spilled to a blob.
const convId = `conv_smoke_${stamp}`
const spilledBody = {
  id: `m_${stamp}_3`,
  role: 'assistant',
  content: 'Here is the itinerary in full',
  timestamp: 1_700_000_000_003,
  segments: [{ kind: 'text', turnId: 't', segmentId: 's', delta: 'Here is the itinerary in full' }]
}
const spilledBytes = Buffer.from(JSON.stringify(spilledBody), 'utf8')
const spilledSha = createHash('sha256').update(spilledBytes).digest('hex')
const spilledName = `.records/conv-${convId}/m_${stamp}_3.json`
const upload = await fetch(
  `${BASE}/v1/files/upload?sha256=${spilledSha}&name=${encodeURIComponent(spilledName)}&mime=application/json`,
  { method: 'POST', headers: { authorization: `Bearer ${empTok3}` }, body: spilledBytes }
)
check('employee uploaded a spilled message body', upload.status === 200)
const batch = await api('/v1/sync/batch', {
  token: empTok3,
  body: {
    items: [
      {
        type: 'conversation',
        id: convId,
        title: 'Booking the flights',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        type: 'record',
        id: `${convId}.snapshot`,
        conversation_id: convId,
        seq: Date.now(),
        kind: 'snapshot',
        content: {
          id: convId,
          title: 'Booking the flights',
          channel: 'mobile',
          model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
          messageCount: 2,
          stats: { allTime: { toolCalls: 3, turns: 1, cost: 0.02 } }
        },
        created_at: new Date().toISOString()
      },
      {
        type: 'record',
        id: `m_${stamp}_1.aaaaaaaa`,
        conversation_id: convId,
        seq: 1_700_000_000_001,
        kind: 'message',
        content: { id: `m_${stamp}_1`, role: 'user', content: 'book me a flight', timestamp: 1_700_000_000_001 },
        created_at: new Date().toISOString()
      },
      {
        type: 'record',
        id: `m_${stamp}_2.bbbbbbbb`,
        conversation_id: convId,
        seq: 1_700_000_000_002,
        kind: 'message',
        content: { id: `m_${stamp}_2`, role: 'assistant', content: 'Booked.', timestamp: 1_700_000_000_002 },
        created_at: new Date().toISOString()
      },
      // A message too big for its record: preview + pointer to the blob
      // uploaded below (the desktop's wireMessage shape).
      {
        type: 'record',
        id: `m_${stamp}_3.cccccccc`,
        conversation_id: convId,
        seq: 1_700_000_000_003,
        kind: 'message',
        content: {
          id: `m_${stamp}_3`,
          role: 'assistant',
          content: 'Here is the itinerary\n\n[… 300,000 characters; the full message is synced alongside this record]',
          timestamp: 1_700_000_000_003,
          segments: [{ kind: 'text', turnId: '', segmentId: 'sync-overflow', delta: '[full segment detail in the message body blob]' }],
          syncOverflow: { sha256: spilledSha, bytes: spilledBytes.byteLength, name: spilledName }
        },
        created_at: new Date().toISOString()
      }
    ]
  }
})
check('employee pushed a conversation', batch.status === 200 && batch.json?.accepted === 5, JSON.stringify(batch.json))

// A legacy snapshot row — the hash-id kind every push wrote before the
// batch route kept one per conversation. Nothing retires it until the next
// push, so a conversation last synced before that rule carries several. It
// goes straight into D1 because the API no longer produces one; its
// figures are wrong on purpose, so a list that reads it is caught.
const legacySql = `INSERT INTO conversation_records (id, conversation_id, user_id, seq, kind, content, created_at)
  VALUES ('snap.legacy${stamp}', '${convId}', '${empId}', 1600000000000, 'snapshot',
    '{"id":"${convId}","title":"Booking the flights","channel":"cli","messageCount":9,"stats":{"allTime":{"toolCalls":1}}}',
    '${new Date().toISOString()}');`
execSync(`npx wrangler d1 execute wfc-master --local --command "${legacySql.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })

// Roster: one call, every employee, with the glance numbers on the card.
const roster = await api('/admin/roster', { token: ownerTok })
const me = (roster.json?.people ?? []).find((p) => p.id === empId)
check('roster serves', roster.status === 200 && Array.isArray(roster.json?.people))
check('roster carries the whole company', (roster.json?.people ?? []).length >= 4)
check('roster row has plan + ceilings', me?.token_plan === 'standard' && me?.ceilings?.monthlyIn === 100_000_000)
check(
  'roster row has the glance numbers',
  me !== undefined &&
    typeof me.days_active === 'number' &&
    typeof me.cost_microusd === 'number' &&
    typeof me.month_tokens_in === 'number' &&
    typeof me.searches === 'number'
)
check('roster counts conversations', me?.conversations === 1)
check('roster reports devices', me?.devices >= 1)

// Overview: one call, one person, everything the detail screen shows.
const ov = await api(`/admin/users/${empId}/overview`, { token: ownerTok })
check('overview serves', ov.status === 200 && ov.json?.user?.id === empId)
check('overview carries the plan', ov.json?.policy?.token_plan === 'standard')
check(
  'overview shapes present',
  Array.isArray(ov.json?.lanes) &&
    Array.isArray(ov.json?.surfaces) &&
    Array.isArray(ov.json?.daily) &&
    Array.isArray(ov.json?.devices) &&
    Array.isArray(ov.json?.sessions) &&
    Array.isArray(ov.json?.recent)
)
check('overview counts the work', ov.json?.counts?.conversations === 1)
check('overview 404s for a stranger', (await api('/admin/users/usr_nobody/overview', { token: ownerTok })).status === 404)

// The conversation list: provenance without opening anything.
const convs = await api(`/admin/users/${empId}/conversations`, { token: ownerTok })
const row = (convs.json?.conversations ?? []).find((x) => x.id === convId)
check('admin lists a user conversation', convs.status === 200 && row !== undefined)
check(
  'a conversation pushed twice is listed once',
  (convs.json?.conversations ?? []).filter((x) => x.id === convId).length === 1,
  JSON.stringify((convs.json?.conversations ?? []).map((x) => x.id))
)
check('conversation list carries surface provenance', row?.channel === 'mobile')
check('conversation list reads the LATEST snapshot: message count', row?.message_count === 2)
check('conversation list reads the LATEST snapshot: tool-call stats', row?.stats?.allTime?.toolCalls === 3)
// The owner's own list (the phone's) joins the same table and had the same
// duplicate.
const ownList = await api('/v1/conversations?since=&include=meta', { token: empTok3 })
const ownRows = (ownList.json?.conversations ?? []).filter((x) => x.id === convId)
check('the employee\'s own list shows the conversation once', ownList.status === 200 && ownRows.length === 1, JSON.stringify(ownList.json).slice(0, 300))
check('the employee\'s own list reads the latest snapshot', ownRows[0]?.stats?.allTime?.toolCalls === 3 && ownRows[0]?.channel === 'mobile', JSON.stringify(ownRows[0]))

// The transcript itself — the same records the employee's own client gets.
const recs = await api(`/admin/conversations/${convId}/records`, { token: ownerTok })
const kinds = (recs.json?.records ?? []).map((r) => r.kind)
check('admin reads the transcript', recs.status === 200 && recs.json?.records?.length === 5, JSON.stringify((recs.json?.records ?? []).map((r) => [r.id, r.kind])))
check('transcript has the envelopes and the messages', kinds.filter((k) => k === 'snapshot').length === 2 && kinds.filter((k) => k === 'message').length === 3)
check('transcript names its owner', recs.json?.conversation?.user_id === empId)
const mine = await api(`/v1/conversations/${convId}/records`, { token: empTok3 })
check(
  'admin transcript matches the user\'s own',
  JSON.stringify((mine.json?.records ?? []).map((r) => r.id)) ===
    JSON.stringify((recs.json?.records ?? []).map((r) => r.id))
)

// Reading someone's work is the most sensitive read here, and it is gated
// exactly like the config read: support never, admin never an owner's.
check(
  'support cannot list conversations',
  (await api(`/admin/users/${empId}/conversations`, { token: sup.json.access_token })).status === 403
)
check(
  'support cannot read a transcript',
  (await api(`/admin/conversations/${convId}/records`, { token: sup.json.access_token })).status === 403
)
check(
  'admin can read an employee transcript',
  (await api(`/admin/conversations/${convId}/records`, { token: adm.json.access_token })).status === 200
)
check(
  'admin cannot list an owner\'s conversations',
  (await api(`/admin/users/${owner.json.user.id}/conversations`, { token: adm.json.access_token })).status === 403
)
// The spilled body: the admin fetches it through the conversation, gated
// like the transcript; anyone else's blob, or a blob the owner never had,
// is not there.
const blob = await fetch(`${BASE}/admin/conversations/${convId}/files/${spilledSha}`, {
  headers: { authorization: `Bearer ${ownerTok}` }
})
check(
  'owner reads a spilled message body through the conversation',
  blob.status === 200 && (await blob.text()) === spilledBytes.toString('utf8')
)
check(
  'admin reads the spilled body too',
  (await api(`/admin/conversations/${convId}/files/${spilledSha}`, { token: adm.json.access_token })).status === 200
)
check(
  'support cannot read the spilled body',
  (await api(`/admin/conversations/${convId}/files/${spilledSha}`, { token: sup.json.access_token })).status === 403
)
check(
  'a blob the owner never uploaded is not served through their conversation',
  (await api(`/admin/conversations/${convId}/files/${'f'.repeat(64)}`, { token: ownerTok })).status === 404
)
check(
  'a malformed sha is refused',
  (await api(`/admin/conversations/${convId}/files/nope`, { token: ownerTok })).status === 400
)
check(
  'unknown conversation 404s',
  (await api('/admin/conversations/conv_nope/records', { token: ownerTok })).status === 404
)

// Per-user audit: what was done to this person, and by them.
const userAudit = await api(`/admin/users/${empId}/audit`, { token: ownerTok })
const userActions = (userAudit.json?.entries ?? []).map((e) => e.action)
check('per-user audit serves', userAudit.status === 200 && userActions.length > 0)
check('per-user audit records the plan change', userActions.includes('plan.set'))
check('per-user audit names the actor', (userAudit.json?.entries ?? [])[0]?.actor_email !== undefined)

const aud2 = await api('/admin/audit', { token: ownerTok })
check(
  'opening a transcript is audited',
  (aud2.json?.entries ?? []).some((e) => e.action === 'conversation.view' && e.target === convId)
)

// Usage now splits by surface as well as by lane.
const usage = await api('/admin/usage', { token: ownerTok })
check('usage exposes the surface split', usage.status === 200 && Array.isArray(usage.json?.surfaces))

console.log(failures === 0 ? '\nADMIN SMOKE: ALL PASS' : `\nADMIN SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
