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
 * Real model calls are capped at max_tokens 30 — except the thinking-mode
 * matrix, which needs room for a reasoning trace (max_tokens 500) — so the
 * whole suite still costs fractions of a cent.
 */
const BASE = process.env.API_BASE ?? 'https://api.wolffi.sh'
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish'
import { createHash } from 'node:crypto'
import { buildZip } from './lib/zip.mjs'

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

/**
 * Policy edits propagate through eventually-consistent KV (cache deletes
 * usually land instantly, worst case ~60s). Poll until the expected status
 * appears, like a real client would, instead of trusting one fixed sleep.
 */
const untilStatus = async (fn, wantStatus, tries = 20, delayMs = 3000) => {
  let last
  for (let i = 0; i < tries; i++) {
    last = await fn()
    if (last.status === wantStatus) return last
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return last
}

const FLASH = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const PRO = 'deepseek-ai/DeepSeek-V4-Pro-0813'
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
  body: { email: 'gate.keeper.50@demo.wolffi.sh', password: PASSWORD, device: { platform: 'desktop', name: 'verify' } }
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
let V_PW = `verify-pass-${stamp}`
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
check('unauthenticated router 401', (await api('/ai/v1/chat/completions', { body: { model: FLASH } })).status === 401)
check('employee blocked from admin', (await api('/admin/users', { token: VT })).status === 403)

// ── 3.5 · the validation boundary rejects loudly ─────────────────────────
const negCap = await api('/admin/org', { token: O, method: 'PATCH', body: { user_daily_token_cap: -5 } })
check(
  'negative org cap 400 with issue path',
  negCap.status === 400 && negCap.json?.issues?.[0]?.path === 'user_daily_token_cap'
)
check(
  'org default outside allowlist 400 (semantic)',
  (await api('/admin/org', {
    token: O,
    method: 'PATCH',
    body: { default_model: 'not/in-list', default_allowed_models: [FLASH] }
  })).status === 400
)
check(
  'wrong-typed policy 400',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: 'x' } })).status === 400
)
check(
  'config array 400',
  (await api('/v1/config', { token: VT, method: 'PUT', body: { config: [1, 2] } })).status === 400
)
check(
  // The config ceiling is 512 KB (ConfigPutSchema); a 70 KB blob is a real
  // config with MCP OAuth state and must be accepted.
  'oversized config 400',
  (await api('/v1/config', { token: VT, method: 'PUT', body: { config: { blob: 'x'.repeat(600_000) } } })).status === 400 &&
    (await api('/v1/config', { token: VT, method: 'PUT', body: { config: { blob: 'x'.repeat(70_000) } } })).status === 200
)
const mixedBatch = await api('/v1/sync/batch', {
  token: VT,
  body: {
    items: [
      { type: 'conversation', id: `cnv_vx_${stamp}`, title: 'ok', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { type: 'record', id: 'bad', conversation_id: `cnv_vx_${stamp}`, seq: 'not-a-number', content: {}, created_at: 'nope' }
    ]
  }
})
check(
  'mixed batch: good lands, bad rejected with issues',
  mixedBatch.json?.accepted === 1 && mixedBatch.json?.rejected === 1 && mixedBatch.json?.issues?.[0]?.path?.startsWith('items.1'),
  JSON.stringify(mixedBatch.json)
)
check('wrong-typed login 400', (await api('/auth/login', { body: { email: 123, password: true } })).status === 400)
check('non-boolean pin 400', (await api('/v1/device/pin', { token: VT, body: { pin_set: 'yes' } })).status === 400)

// ── 4 · the router, on real DeepSeek ─────────────────────────────────────
const chat1 = await tinyChat(VT, FLASH)
check('V4 Flash completes (JSON)', chat1.status === 200 && chat1.json?.usage?.completion_tokens > 0, JSON.stringify(chat1.json).slice(0, 200))
const chat2 = await tinyChat(VT, PRO, true)
const sse = await chat2.text()
check(
  'V4 Pro streams (SSE + [DONE])',
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

// ── 4.5 · thinking modes: every mode on every supported model ────────────
// The desktop maps its brain button off/high/max → reasoning_effort
// none/high/max (providers/cloud.ts). Prove each rung end-to-end on each
// model: 'none' must complete with NO reasoning trace, 'high' and 'max'
// must produce message.reasoning_content alongside the answer.
const effortChat = (model, effort, maxTokens) =>
  api('/ai/v1/chat/completions', {
    token: VT,
    body: {
      model,
      max_tokens: maxTokens,
      reasoning_effort: effort,
      messages: [{ role: 'user', content: 'What is 17 * 23? Reply with just the number.' }]
    }
  })
for (const model of [FLASH, PRO]) {
  const short = model.split('/')[1]
  const off = await effortChat(model, 'none', 60)
  const offMsg = off.json?.choices?.[0]?.message
  check(
    `${short} effort=none: answers with no reasoning`,
    off.status === 200 && (offMsg?.content?.length ?? 0) > 0 && offMsg?.reasoning_content == null,
    JSON.stringify(off.json).slice(0, 200)
  )
  for (const effort of ['high', 'max']) {
    const on = await effortChat(model, effort, 500)
    const onMsg = on.json?.choices?.[0]?.message
    check(
      `${short} effort=${effort}: reasoning_content present`,
      on.status === 200 && (onMsg?.reasoning_content?.length ?? 0) > 0,
      JSON.stringify(on.json).slice(0, 200)
    )
  }
}
// Streamed thinking: reasoning arrives as delta.reasoning_content — the
// exact field the desktop's SSE parser renders.
{
  const res = await fetch(`${BASE}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${VT}` },
    body: JSON.stringify({
      model: FLASH,
      stream: true,
      max_tokens: 500,
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'What is 19 * 21? Reply with just the number.' }]
    })
  })
  const text = await res.text()
  let reasoningChars = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      reasoningChars += JSON.parse(line.slice(5))?.choices?.[0]?.delta?.reasoning_content?.length ?? 0
    } catch {}
  }
  check(
    'streamed thinking lands in delta.reasoning_content',
    res.status === 200 && reasoningChars > 0 && text.includes('[DONE]'),
    text.slice(0, 120)
  )
}
// The effort enum is genuinely validated upstream and the router passes
// the rejection through as 502 — a typo'd mode fails loudly, not silently.
check(
  'invalid reasoning_effort rejected end-to-end',
  (await effortChat(FLASH, 'banana', 60)).status === 502
)
// Both V4 models are text-only on DeepInfra (verified: image parts are
// rejected upstream) — the catalog's vision:false must stay honest.
check(
  'image input rejected (text-only lane stays true)',
  (await api('/ai/v1/chat/completions', {
    token: VT,
    body: {
      model: FLASH,
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What color?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }
          ]
        }
      ]
    }
  })).status === 502
)

// ── 5 · governance: allowlist + quota, live edits ────────────────────────
const models0 = await api('/v1/models', { token: VT })
check(
  'catalog serves the frontier pair',
  (models0.json?.models ?? []).length === 2 &&
    models0.json?.default_model === FLASH &&
    (models0.json?.models ?? []).every((m) => m.reasoning === true && m.vision === false && m.context_window === 1_048_576),
  JSON.stringify(models0.json).slice(0, 300)
)
check(
  'narrow allowlist',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [PRO] } })).status === 200
)
const deniedFlash = await untilStatus(
  () => api('/ai/v1/chat/completions', { token: VT, body: { model: FLASH, messages: [{ role: 'user', content: 'x' }] } }),
  403
)
check('narrowed model denied', deniedFlash.status === 403 && deniedFlash.json?.error === 'model_not_allowed')
const models1 = await api('/v1/models', { token: VT })
check('catalog reflects narrowing', (models1.json?.models ?? []).length === 1 && models1.json.models[0].id === PRO)

check(
  'tiny quota set',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [PRO], daily_token_cap: 10 } })).status === 200
)
const quotaDenied = await untilStatus(() => tinyChat(VT, PRO), 429)
check('quota trips 429', quotaDenied.status === 429 && quotaDenied.json?.error === 'quota_exceeded', JSON.stringify(quotaDenied.json))
check(
  'quota restored',
  (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [PRO], daily_token_cap: null } })).status === 200
)
const restored = await untilStatus(() => tinyChat(VT, PRO), 200)
check('service restored after cap lift', restored.status === 200, JSON.stringify(restored.json))

// ── 6 · sync: the folder-is-a-cache proof ────────────────────────────────
check(
  'config put',
  (await api('/v1/config', { token: VT, method: 'PUT', body: { config: { theme: 'dark', pinned: true } } })).status === 200
)
check('config get round-trips', (await api('/v1/config', { token: VT })).json?.config?.theme === 'dark')
check(
  'admin views user config',
  (await api(`/admin/users/${vId}/config`, { token: O })).json?.config?.theme === 'dark'
)
const now = new Date().toISOString()
const convId = `cnv_verify_${stamp}`
const items = [
  { type: 'conversation', id: convId, title: 'Verify chat', created_at: now, updated_at: now },
  // The desktop's message shape (id, role, content, timestamp; seq = timestamp).
  { type: 'record', id: `rec_verify_${stamp}_0`, conversation_id: convId, seq: Date.parse(now), content: { id: `m_${stamp}_0`, role: 'user', content: 'hello', timestamp: Date.parse(now) }, created_at: now },
  { type: 'record', id: `rec_verify_${stamp}_1`, conversation_id: convId, seq: Date.parse(now) + 1, content: { id: `m_${stamp}_1`, role: 'assistant', content: 'hi', timestamp: Date.parse(now) + 1 }, created_at: now }
]
const b1 = await api('/v1/sync/batch', { token: VT, body: { items } })
check('outbox batch accepted', b1.json?.accepted === 3 && b1.json?.rejected === 0, JSON.stringify(b1.json))
const b2 = await api('/v1/sync/batch', { token: VT, body: { items } })
check('replay is a no-op', b2.json?.accepted === 0 && b2.json?.ignored === 3)
const badId = `rec_verify_${stamp}_bad`
const b3 = await api('/v1/sync/batch', { token: VT, body: { items: [{ type: 'record', id: badId, conversation_id: convId, seq: null, content: { role: 'user', content: 'x', timestamp: 1 }, created_at: now }] } })
check('malformed record refused by id', b3.json?.rejected === 1 && b3.json?.rejected_ids?.[0] === badId, JSON.stringify(b3.json))
const page = await api(`/v1/conversations/${convId}/records`, { token: VT })
check('records page back', page.json?.records?.length === 2 && page.json.records[1].content.content === 'hi')
check('other employee cannot read them', (await api(`/v1/conversations/${convId}/records`, { token: E })).status === 404)
check('records page terminates with an explicit null cursor', page.json?.next_after === null)
const convIdx = await api('/v1/conversations?after=0', { token: VT })
check('conversation index carries its keyset cursor', convIdx.status === 200 && convIdx.json !== null && 'next' in convIdx.json)
// One envelope per conversation: the stable snapshot id upserts, older rows retire.
const snapItem = (seq, title) => ({ type: 'record', id: `snap.${convId}`, conversation_id: convId, seq, kind: 'snapshot', content: { title }, created_at: now })
await api('/v1/sync/batch', { token: VT, body: { items: [snapItem(1000, 'v1')] } })
const snapNewer = await api('/v1/sync/batch', { token: VT, body: { items: [snapItem(2000, 'v2')] } })
check('newer envelope accepted', snapNewer.json?.accepted === 1, JSON.stringify(snapNewer.json))
const snapStale = await api('/v1/sync/batch', { token: VT, body: { items: [snapItem(500, 'stale')] } })
check('stale envelope ignored', snapStale.json?.ignored === 1, JSON.stringify(snapStale.json))
const snaps = ((await api(`/v1/conversations/${convId}/records`, { token: VT })).json?.records ?? []).filter((r) => r.kind === 'snapshot')
check('exactly one snapshot row, the newest', snaps.length === 1 && snaps[0].content.title === 'v2', JSON.stringify(snaps))

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
// Superseding: newer content at a path retires the older row (one live row per path).
const blob2 = Buffer.from(`verify blob v2 ${stamp}`)
const sha2 = createHash('sha256').update(blob2).digest('hex')
await api(`/v1/files/upload?sha256=${sha2}&name=verify.txt&mime=text/plain`, { token: VT, raw: blob2 })
const man = await api('/v1/files/manifest', { token: VT })
check('manifest carries its keyset cursor', man.json !== null && 'next' in man.json)
const verifyRows = (man.json?.files ?? []).filter((f) => f.name === 'verify.txt')
check('newer content supersedes the older row for a path', verifyRows.length === 1 && verifyRows[0].sha256 === sha2, JSON.stringify(verifyRows))
check('superseded blob still served while copy.txt references it', (await api(`/v1/files/${sha}`, { token: VT })).status === 200)
const fdel = await api('/v1/files/delete', { token: VT, body: { names: ['copy.txt'] } })
check('file tombstone by path', fdel.status === 200 && fdel.json?.deleted === 1, JSON.stringify(fdel.json))
check('tombstoned path gone from manifest', !((await api('/v1/files/manifest', { token: VT })).json?.files ?? []).some((f) => f.name === 'copy.txt'))
const boot = await api('/v1/sync/bootstrap', { token: VT })
check(
  'bootstrap rehydrates fresh install',
  // Two conversations by this point: the sync section's plus the
  // validation section's mixed-batch survivor. One live file: verify.txt
  // at its newest content (copy.txt tombstoned, the v1 row superseded).
  boot.json?.config?.theme === 'dark' && boot.json?.conversations?.length === 2 && boot.json?.files?.length === 1
)
check('bootstrap carries pagination cursors', boot.json !== null && 'conversations_next' in boot.json && 'files_next' in boot.json)
// Admin-authored config: the support loop's write half, proven live — the
// fix an admin authors is exactly what the user's client then reads.
check(
  'admin-authored config write',
  (await api(`/admin/users/${vId}/config`, {
    token: O,
    method: 'PUT',
    body: { config: { theme: 'admin-fixed' } }
  })).status === 200
)
check(
  'user reads admin-authored config',
  (await api('/v1/config', { token: VT })).json?.config?.theme === 'admin-fixed'
)
// The org's usage table, per user — what a purged install rebuilds its ledger from.
const usageSelf = await api('/v1/usage?after=0', { token: VT })
const usageRows = usageSelf.json?.rows ?? []
check(
  'self usage read: this user\'s rows, cached-token split present',
  usageSelf.status === 200 && usageRows.length >= 2 && usageRows.every((r) => 'tokens_cached' in r && 'device_id' in r) && usageSelf.json?.next === null,
  JSON.stringify(usageSelf.json).slice(0, 200)
)
check(
  'self usage read is keyset-paged',
  (await api(`/v1/usage?after=${usageRows[usageRows.length - 1]?.id ?? 0}`, { token: VT })).json?.rows?.length === 0
)
// Wipe: the factory-reset half — this user's whole record, and only theirs.
const wipe = await api('/v1/sync/wipe', { token: VT, method: 'POST', body: {} })
check('wipe tombstones the whole record', wipe.status === 200 && wipe.json?.conversations === 2 && wipe.json?.files === 1, JSON.stringify(wipe.json))
check('bootstrap empty after wipe', (await api('/v1/sync/bootstrap', { token: VT })).json?.conversations?.length === 0)
check('other employee untouched by wipe', (await api('/v1/sync/bootstrap', { token: E })).status === 200)

// ── 6.5 · self-service profile + voluntary password change ──────────────
const prof = await api('/v1/profile', {
  token: VT,
  method: 'PATCH',
  body: {
    name: 'Verify User Jr',
    phone: '+966 50 000 0000',
    position: 'QA Engineer',
    bio: 'Breaks the release gate for a living.'
  }
})
check('profile patch ok', prof.status === 200 && prof.json?.user?.phone === '+966 50 000 0000')
const meProf = await api('/v1/me', { token: VT })
check(
  'me carries profile edits',
  meProf.json?.user?.name === 'Verify User Jr' &&
    meProf.json?.user?.phone === '+966 50 000 0000' &&
    meProf.json?.user?.position === 'QA Engineer' &&
    meProf.json?.user?.bio === 'Breaks the release gate for a living.'
)
check(
  'oversize bio rejected',
  (await api('/v1/profile', { token: VT, method: 'PATCH', body: { bio: 'x'.repeat(600) } })).status === 400
)
check(
  'bad phone rejected',
  (await api('/v1/profile', { token: VT, method: 'PATCH', body: { phone: 'call-me-maybe' } })).status === 400
)
// conversation tombstone: deleted conversations leave every listing
{
  const delId = `cnv_verify_del_${stamp}`
  await api('/v1/sync/batch', { token: VT, body: { items: [{ type: 'conversation', id: delId, title: 'to delete', created_at: new Date(1).toISOString(), updated_at: new Date(2).toISOString() }] } })
  check(
    'conversation delete tombstones',
    (await api(`/v1/conversations/${delId}`, { token: VT, method: 'DELETE' })).json?.deleted === true
  )
  const listed = await api('/v1/conversations', { token: VT })
  check(
    'deleted conversation gone from listing',
    !(listed.json?.conversations ?? []).some((c) => c.id === delId)
  )
}

// ── 6.55 · password reset: emailed code via Resend, then a new password ──
// Recipient is Resend's own safe test inbox (delivered+label@resend.dev),
// invited fresh each run; the code is read back through the admin peek.
const rEmail = `delivered+wfc-reset-${stamp}@resend.dev`
const rInvite = await api('/admin/users', {
  token: O,
  body: { email: rEmail, name: 'Reset Probe', role: 'employee' }
})
check('reset probe invited', rInvite.status === 200)
const rId = rInvite.json?.user_id
check(
  'reset request for unknown email 401',
  (await api('/auth/reset/request', { body: { email: `ghost-${stamp}@resend.dev` } })).json?.error === 'email_not_found'
)
const rReq = await api('/auth/reset/request', { body: { email: rEmail } })
check('reset request sends email', rReq.status === 200, JSON.stringify(rReq.json))
const rPeek = await api(`/admin/users/${rId}/reset-code`, { token: O })
check('admin reads pending code', rPeek.status === 200 && /^[0-9]{6}$/.test(rPeek.json?.code ?? ''))
const R_CODE = rPeek.json.code
const R_PW = `reset-pass-${stamp}`
check(
  'wrong code rejected',
  (await api('/auth/reset/confirm', {
    body: { email: rEmail, code: R_CODE === '000000' ? '000001' : '000000', new_password: R_PW }
  })).json?.error === 'invalid_code'
)
check(
  'short password rejected',
  (await api('/auth/reset/confirm', { body: { email: rEmail, code: R_CODE, new_password: 'short' } })).status === 400
)
check(
  'reset confirm ok',
  (await api('/auth/reset/confirm', { body: { email: rEmail, code: R_CODE, new_password: R_PW } })).status === 200
)
check(
  'code dead after use',
  (await api('/auth/reset/confirm', { body: { email: rEmail, code: R_CODE, new_password: R_PW } })).json?.error === 'code_expired'
)
const rLogin = await api('/auth/login', {
  body: { email: rEmail, password: R_PW, device: { platform: 'desktop', name: 'reset-probe' } }
})
check('login with reset password (invited→active)', rLogin.status === 200 && rLogin.json?.access_token)
check(
  'reset probe suspended (cleanup)',
  (await api(`/admin/users/${rId}`, { token: O, method: 'PATCH', body: { status: 'suspended' } })).status === 200
)

// ── 6.6 · profile photo: R2 content-addressed, byte-faithful ─────────────
const AV_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const avAuth = { authorization: `Bearer ${VT}` }
const avPut = await fetch(`${BASE}/v1/profile/avatar`, {
  method: 'PUT',
  headers: { ...avAuth, 'content-type': 'image/png' },
  body: AV_PNG
})
check('avatar upload ok', avPut.status === 200)
const avGet = await fetch(`${BASE}/v1/profile/avatar`, { headers: avAuth })
const avBytes = Buffer.from(await avGet.arrayBuffer())
check(
  'avatar roundtrip byte-identical',
  avGet.status === 200 && avGet.headers.get('content-type') === 'image/png' && avBytes.equals(AV_PNG)
)
check('me flags avatar', (await api('/v1/me', { token: VT })).json?.user?.avatar_key?.length === 64)
// Conditional GET: the etag is the content hash; a match must answer 304
// with no body, a stale validator must answer 200 with the full image.
const avEtag = avGet.headers.get('etag')
const av304 = await fetch(`${BASE}/v1/profile/avatar`, {
  headers: { ...avAuth, 'if-none-match': avEtag ?? '' }
})
check(
  'avatar conditional GET → 304, empty body',
  avEtag?.length === 64 && av304.status === 304 && (await av304.arrayBuffer()).byteLength === 0
)
const avStale = await fetch(`${BASE}/v1/profile/avatar`, {
  headers: { ...avAuth, 'if-none-match': '"deadbeef"' }
})
check(
  'avatar stale etag → 200 full body',
  avStale.status === 200 && Buffer.from(await avStale.arrayBuffer()).equals(AV_PNG)
)
check(
  'non-image avatar rejected',
  (await fetch(`${BASE}/v1/profile/avatar`, {
    method: 'PUT',
    headers: { ...avAuth, 'content-type': 'text/plain' },
    body: 'not-an-image'
  })).status === 400
)
check(
  'avatar remove ok',
  (await fetch(`${BASE}/v1/profile/avatar`, { method: 'DELETE', headers: avAuth })).status === 200
)
check(
  'avatar gone after remove',
  (await fetch(`${BASE}/v1/profile/avatar`, { headers: avAuth })).status === 404
)

check(
  'voluntary change needs current password',
  (await api('/auth/password', { token: VT, body: { new_password: `changed-${stamp}-pw` } })).status === 401
)
check(
  'wrong current password rejected',
  (await api('/auth/password', { token: VT, body: { current_password: 'nope-nope-nope', new_password: `changed-${stamp}-pw` } })).status === 401
)
check(
  'voluntary change with current ok',
  (await api('/auth/password', { token: VT, body: { current_password: V_PW, new_password: `changed-${stamp}-pw` } })).status === 200
)
check('old password dead after voluntary change', (await api('/auth/login', { body: { email: vEmail, password: V_PW } })).status === 401)
V_PW = `changed-${stamp}-pw`
check('new password works', (await api('/auth/login', { body: { email: vEmail, password: V_PW } })).status === 200)

// ── 6.7 · capabilities: the cloud-first registry ─────────────────────────
// Org scope: admin adds/updates/removes, every client mirrors. User scope:
// each member's own imports, invisible to everyone else. Packages are zips
// gated on sha256 + structure (root SKILL.md).
{
  const capZip = (body) =>
    buildZip([{ name: 'SKILL.md', data: Buffer.from(`---\nname: vcap-${stamp}\ndescription: verify capability\n---\n${body}\n`) }])
  const shaOf = (buf) => createHash('sha256').update(buf).digest('hex')
  const capPut = (route, token, zip, extra = '') =>
    api(`${route}?sha256=${shaOf(zip)}&name=vcap&description=verify${extra}`, { token, method: 'PUT', raw: zip })

  const man0 = await api('/v1/capabilities/manifest', { token: VT })
  check(
    'manifest serves the seeded org set',
    (man0.json?.org ?? []).length >= 39 &&
      man0.json.org.every((e) => /^[0-9a-f]{64}$/.test(e.sha256) && e.version >= 1) &&
      man0.json.org.some((e) => e.slug === 'shell')
  )
  check('unauthenticated manifest 401', (await api('/v1/capabilities/manifest')).status === 401)

  const orgSlug = `vcap-${stamp}`
  const z1 = capZip('v one')
  const put1 = await capPut(`/admin/capabilities/${orgSlug}`, O, z1)
  check('admin adds org capability', put1.status === 200 && put1.json?.version === 1, JSON.stringify(put1.json))
  check(
    'employee blocked from admin capability PUT',
    (await capPut(`/admin/capabilities/blocked-${stamp}`, VT, z1)).status === 403
  )
  check('bad slug rejected', (await capPut('/admin/capabilities/Bad_Slug!', O, z1)).status === 400)
  check(
    'hash mismatch rejected',
    (await api(`/admin/capabilities/${orgSlug}?sha256=${'0'.repeat(64)}`, { token: O, method: 'PUT', raw: z1 })).status === 400
  )
  const noSkill = buildZip([{ name: 'other.txt', data: Buffer.from('x') }])
  const rejNoSkill = await capPut(`/admin/capabilities/${orgSlug}`, O, noSkill)
  check('package without SKILL.md rejected', rejNoSkill.status === 400 && rejNoSkill.json?.error === 'invalid_package')
  const garbage = Buffer.from(`not a zip ${stamp}`)
  check('non-zip package rejected', (await capPut(`/admin/capabilities/${orgSlug}`, O, garbage)).status === 400)

  const man1 = await api('/v1/capabilities/manifest', { token: VT })
  const seen1 = (man1.json?.org ?? []).find((e) => e.slug === orgSlug)
  check('employee sees new org capability', seen1?.version === 1 && seen1?.sha256 === shaOf(z1))
  const dl1 = await api(`/v1/capabilities/org/${orgSlug}/package`, { token: VT })
  check(
    'org package downloads byte-identical',
    dl1.status === 200 && dl1.buf.equals(z1) && dl1.headers.get('etag') === shaOf(z1) && dl1.headers.get('x-capability-version') === '1'
  )

  const z2 = capZip('v two — updated')
  const put2 = await capPut(`/admin/capabilities/${orgSlug}`, O, z2)
  check('admin update bumps version', put2.status === 200 && put2.json?.version === 2)
  const man2 = await api('/v1/capabilities/manifest', { token: VT })
  const seen2 = (man2.json?.org ?? []).find((e) => e.slug === orgSlug)
  check('manifest reflects the update', seen2?.version === 2 && seen2?.sha256 === shaOf(z2))

  const userSlug = `vusr-${stamp}`
  const uz = buildZip([{ name: 'SKILL.md', data: Buffer.from(`---\nname: ${userSlug}\n---\nmy own skill\n`) }])
  const uput = await capPut(`/v1/capabilities/user/${userSlug}`, VT, uz)
  check('user uploads own capability', uput.status === 200 && uput.json?.version === 1)
  const manU = await api('/v1/capabilities/manifest', { token: VT })
  check('own manifest lists user capability', (manU.json?.user ?? []).some((e) => e.slug === userSlug))
  const manE = await api('/v1/capabilities/manifest', { token: E })
  check('other user does NOT see it', !(manE.json?.user ?? []).some((e) => e.slug === userSlug))
  check(
    'other user cannot download it',
    (await api(`/v1/capabilities/user/${userSlug}/package`, { token: E })).status === 404
  )
  const udl = await api(`/v1/capabilities/user/${userSlug}/package`, { token: VT })
  check('owner downloads own package', udl.status === 200 && udl.buf.equals(uz))
  check('user deletes own capability', (await api(`/v1/capabilities/user/${userSlug}`, { token: VT, method: 'DELETE' })).status === 200)
  check(
    'deleted user capability gone from manifest',
    !((await api('/v1/capabilities/manifest', { token: VT })).json?.user ?? []).some((e) => e.slug === userSlug)
  )

  check('admin removes org capability', (await api(`/admin/capabilities/${orgSlug}`, { token: O, method: 'DELETE' })).status === 200)
  const man3 = await api('/v1/capabilities/manifest', { token: VT })
  check('removed capability gone org-wide', !(man3.json?.org ?? []).some((e) => e.slug === orgSlug))
  check('removed package 404s', (await api(`/v1/capabilities/org/${orgSlug}/package`, { token: VT })).status === 404)
  const put3 = await capPut(`/admin/capabilities/${orgSlug}`, O, z1)
  check('re-add after remove keeps version history (v3)', put3.status === 200 && put3.json?.version === 3)
  const adminList = await api('/admin/capabilities', { token: O })
  check(
    'admin listing carries registry state',
    (adminList.json?.capabilities ?? []).some((e) => e.slug === orgSlug && e.version === 3 && !e.deleted_at)
  )
  await api(`/admin/capabilities/${orgSlug}`, { token: O, method: 'DELETE' }) // leave the registry clean
}

// ── 6.8 · the web-search lane: org key behind the door, fair gate in front ─
// The org's Brave key exists only at the edge; the desktop's web-search
// plugin calls POST /v1/search with its session token, and the Brave
// settings panel renders GET /v1/search/status. The live searches run only
// once BRAVE_API_KEY is set on the Worker — until then the unconfigured
// contract is what gets proven. Each live search costs $0.005.
{
  check('search status requires auth', (await api('/v1/search/status')).status === 401)
  check('search requires auth', (await api('/v1/search', { body: { query: 'x' } })).status === 401)
  const st = await api('/v1/search/status', { token: VT })
  check(
    'search status: brave lane, caps and plan price on the wire',
    st.status === 200 &&
      st.json?.provider === 'brave' &&
      typeof st.json?.configured === 'boolean' &&
      typeof st.json?.enabled === 'boolean' &&
      Number.isInteger(st.json?.daily_cap) &&
      Number.isInteger(st.json?.org_monthly_cap) &&
      Number.isInteger(st.json?.used_today) &&
      st.json?.price_per_query_microusd === 5000,
    JSON.stringify(st.json)
  )
  check('search validation: missing query 400', (await api('/v1/search', { token: VT, body: {} })).status === 400)
  check(
    'search validation: count 99 → 400',
    (await api('/v1/search', { token: VT, body: { query: 'x', count: 99 } })).status === 400
  )
  const liveSearch = (query, count = 1) => api('/v1/search', { token: VT, body: { query, count } })
  if (!st.json?.configured) {
    const nc = await liveSearch('wolffish')
    check(
      'unconfigured lane answers 503 search_not_configured (set BRAVE_API_KEY to run the live searches)',
      nc.status === 503 && nc.json?.error === 'search_not_configured',
      JSON.stringify(nc.json)
    )
  } else {
    const s1 = await liveSearch('Brave Search API pricing', 3)
    check(
      'live search answers from Brave in the plugin shape',
      s1.status === 200 &&
        s1.json?.provider === 'brave' &&
        (s1.json?.results ?? []).length >= 1 &&
        /^https?:/.test(s1.json.results[0].url) &&
        typeof s1.json.results[0].snippet === 'string',
      JSON.stringify(s1.json).slice(0, 300)
    )
    // Metered after the response (waitUntil): poll the user's own usage read.
    let metered = null
    for (let i = 0; i < 10 && !metered; i++) {
      const rows = (await api('/v1/usage?after=0', { token: VT })).json?.rows ?? []
      metered = rows.find((r) => r.kind === 'search') ?? null
      if (!metered) await new Promise((r) => setTimeout(r, 1000))
    }
    check(
      'search metered as kind=search at the plan price, no tokens',
      metered?.model === 'brave/web-search' && metered?.cost_microusd === 5000 && metered?.tokens_in === 0,
      JSON.stringify(metered)
    )
    check(
      'admin usage totals count searches',
      ((await api(`/admin/usage?user_id=${vId}`, { token: O })).json?.totals?.[0]?.searches ?? 0) >= 1
    )
    // Per-user daily cap, live edit → 429 → lift → flows again.
    check(
      'search cap set',
      (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [PRO], daily_search_cap: 1 } })).status === 200
    )
    // KV-cached policy: poll the full propagation window, like the model lane.
    const capped = await untilStatus(() => liveSearch(`wolffish cap ${stamp}`), 429)
    check(
      'search cap trips 429',
      capped.status === 429 && capped.json?.error === 'search_quota_exceeded' && capped.json?.scope === 'user_daily',
      JSON.stringify(capped.json)
    )
    check(
      'search cap lifted',
      (await api(`/admin/users/${vId}/policy`, { token: O, method: 'PUT', body: { allowed_models: [PRO] } })).status === 200
    )
    const flowing = await untilStatus(() => liveSearch(`wolffish flow ${stamp}`), 200)
    check('search flows after cap lift', flowing.status === 200, JSON.stringify(flowing.json))
    // The gate: ten at once from one employee, all served, none rate-limited.
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => liveSearch(`wolffish burst ${stamp} ${i}`))
    )
    check(
      'burst of 10 concurrent searches all served through the gate',
      burst.every((r) => r.status === 200),
      burst.map((r) => r.status).join(',')
    )
    check('gate reports the plan limit it runs at', (st.json?.gate?.limitPerSec ?? 0) >= 1, JSON.stringify(st.json?.gate))
    // The org switch, live — restored immediately, even on failure.
    try {
      check(
        'org search switch off',
        (await api('/admin/org', { token: O, method: 'PATCH', body: { search_enabled: false } })).status === 200
      )
      const off = await untilStatus(() => liveSearch(`wolffish off ${stamp}`), 403)
      check('search refused while the org switch is off', off.status === 403 && off.json?.error === 'search_disabled')
    } finally {
      check(
        'org search switch restored',
        (await api('/admin/org', { token: O, method: 'PATCH', body: { search_enabled: true } })).status === 200
      )
    }
    const back = await untilStatus(() => liveSearch(`wolffish back ${stamp}`), 200)
    check('search flows after the switch is restored', back.status === 200)
  }
}

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
  ['user.invite', 'policy.set', 'user.revoke_sessions', 'user.reset_password', 'user.update', 'device.clear_pin', 'capability.put', 'capability.delete'].every((a) => actions.has(a)),
  [...actions].join(',')
)

// ── 9 · pairing + the desktop↔phone bridge ───────────────────────────────
// The phone's whole way in, as one gate: the smoke script IS the contract
// (scripts/smoke-bridge.mjs), so it runs here verbatim against the edge
// rather than being paraphrased into a second copy that could drift.
{
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const run = spawnSync(process.execPath, [join(here, 'smoke-bridge.mjs')], {
    env: { ...process.env, API_BASE: BASE, WFC_DEMO_PASSWORD: PASSWORD },
    encoding: 'utf8'
  })
  const lines = (run.stdout ?? '').trim().split('\n')
  for (const line of lines) console.log(`   ${line}`)
  if (run.stderr) console.log(run.stderr.trim().split('\n').map((l) => `   ${l}`).join('\n'))
  const summary = lines[lines.length - 1] ?? ''
  check('pairing + bridge smoke passes end to end', run.status === 0, summary)
}

// owner signs out
check('owner logout', (await api('/v1/logout', { token: O, body: {} })).status === 200)

console.log(
  failures === 0
    ? `\nLIVE VERIFICATION: ALL ${n} CHECKS PASS against ${BASE}`
    : `\nLIVE VERIFICATION: ${failures}/${n} FAILURES against ${BASE}`
)
process.exit(failures === 0 ? 0 : 1)
