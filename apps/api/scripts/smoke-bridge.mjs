#!/usr/bin/env node
/**
 * Pairing + bridge smoke — the phone's whole way in, against a running
 * Worker (wrangler dev by default; API_BASE for the edge).
 *
 *   node scripts/smoke-bridge.mjs
 *
 * Owner signs in as the "desktop", offers a pairing; a "phone" claims it
 * with the typed code (and a second offer with the QR token), receives a
 * session, reads presence, opens both bridge sockets, round-trips an RPC
 * through the desktop, receives an event, registers for push, and is cut
 * off the moment the desktop unpairs it. Also covers the phone-facing sync
 * additions: the `since` index with envelope fields and tombstones, the
 * blob-by-path lookup, and the per-day usage fold.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787'
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish'
const OWNER = process.env.WFC_OWNER_EMAIL ?? 'gate.keeper.50@demo.wolffi.sh'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
let n = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  n++
  console.log(
    `${ok ? '✅' : '❌'} ${String(n).padStart(2, '0')} ${name}${ok || !extra ? '' : ` — ${extra}`}`
  )
  if (!ok) failures++
}
const api = async (path, { token, body, method, raw, headers } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined && raw === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {})
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A JSON WebSocket with an inbox the test can await frames from. */
function socket(url) {
  const ws = new WebSocket(url)
  const inbox = []
  const waiters = []
  ws.onmessage = (e) => {
    let frame
    try {
      frame = JSON.parse(String(e.data))
    } catch {
      return
    }
    const w = waiters.findIndex((x) => x.pred(frame))
    if (w >= 0) waiters.splice(w, 1)[0].resolve(frame)
    else inbox.push(frame)
  }
  const closed = new Promise((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })
  })
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('socket error'))
  })
  const next = (pred, timeoutMs = 5000) => {
    const i = inbox.findIndex(pred)
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error('timed out waiting for frame'))
      }, timeoutMs)
      waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        }
      })
    })
  }
  return { ws, opened, closed, next, send: (f) => ws.send(JSON.stringify(f)) }
}

// ── 1 · desktop signs in, offers a pairing ────────────────────────────────
const login = await api('/auth/login', {
  body: {
    email: OWNER,
    password: PASSWORD,
    device: {
      platform: 'desktop',
      name: 'smoke-desktop',
      app_version: 'smoke'
    }
  }
})
check('desktop login', login.status === 200 && login.json?.access_token, JSON.stringify(login.json))
const D = login.json.access_token
const desktopDeviceId = login.json.device_id

const offer = await api('/v1/pair/offer', { token: D, body: {} })
check(
  'offer minted',
  offer.status === 200 && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(offer.json?.code ?? ''),
  JSON.stringify(offer.json)
)
check(
  'offer carries a QR payload',
  typeof offer.json?.qr === 'string' && offer.json.qr.startsWith('wolffish-pair:v2:')
)
const pending = await api(`/v1/pair/offer/${offer.json.id}`, { token: D })
check('offer pending before a claim', pending.json?.status === 'pending')

// ── 2 · phone claims with the typed code (any spelling) ───────────────────
const sloppy = offer.json.code.toLowerCase().replace('-', ' ').replace(/0/g, 'o')
check(
  'wrong code refused',
  (await api('/auth/pair/claim', { body: { code: 'ZZZZ-ZZZ9' } })).status === 404
)
const claim = await api('/auth/pair/claim', {
  body: {
    code: sloppy,
    device: { name: 'smoke-phone', app_version: '1.0.48' }
  }
})
check(
  'claim mints a phone session',
  claim.status === 200 && claim.json?.access_token && claim.json?.device_id,
  JSON.stringify(claim.json)
)
check('claim names the desktop', claim.json?.desktop?.id === desktopDeviceId)
check(
  'claim answers the api base',
  typeof claim.json?.api === 'string' && /^https?:\/\//.test(claim.json.api),
  claim.json?.api
)
const P = claim.json.access_token
const phoneDeviceId = claim.json.device_id
check(
  'offer single-use',
  (await api('/auth/pair/claim', { body: { code: offer.json.code } })).status === 404
)
const claimed = await api(`/v1/pair/offer/${offer.json.id}`, { token: D })
check(
  'offer reads claimed with the phone',
  claimed.json?.status === 'claimed' && claimed.json?.device?.id === phoneDeviceId
)

const me = await api('/v1/me', { token: P })
check(
  'phone session is the same user',
  me.json?.user?.email === OWNER && me.json?.device?.platform === 'mobile'
)
const refreshed = await api('/auth/refresh', {
  body: { refresh_token: claim.json.refresh_token }
})
check('phone refresh rotates', refreshed.status === 200 && refreshed.json?.access_token)
const P2 = refreshed.json.access_token

// ── 3 · the QR token route ───────────────────────────────────────────────
const offer2 = await api('/v1/pair/offer', { token: D, body: {} })
const payload = JSON.parse(
  Buffer.from(offer2.json.qr.slice('wolffish-pair:v2:'.length), 'base64url').toString('utf8')
)
check(
  'QR payload carries api + token',
  payload.v === 2 && typeof payload.api === 'string' && typeof payload.token === 'string'
)
const claim2 = await api('/auth/pair/claim', {
  body: { token: payload.token, device: { name: 'smoke-phone-2' } }
})
check('token claim mints a session', claim2.status === 200 && claim2.json?.device_id)
const phone2 = claim2.json

// ── 4 · devices ──────────────────────────────────────────────────────────
const devices = await api('/v1/devices', { token: D })
const mobiles = (devices.json?.devices ?? []).filter((d) => d.platform === 'mobile' && d.paired)
check(
  'desktop lists both paired phones',
  mobiles.some((d) => d.id === phoneDeviceId) && mobiles.some((d) => d.id === phone2.device_id),
  JSON.stringify(devices.json)
)
check(
  'own device refuses self-revoke',
  (await api(`/v1/devices/${desktopDeviceId}`, { token: D, method: 'DELETE' })).status === 400
)

// ── 5 · the bridge ───────────────────────────────────────────────────────
const status0 = await api('/v1/bridge/status', { token: P2 })
check('presence before anyone connects', status0.status === 200 && status0.json?.desktop === null)
check('bridge door is websocket-only', (await api('/v1/bridge/ws?role=phone')).status === 426)
const anon = socket(`${WS_BASE}/v1/bridge/ws?role=phone`)
check(
  'bridge upgrade needs a session',
  await anon.opened.then(
    () => false,
    () => true
  )
)

const desk = socket(
  `${WS_BASE}/v1/bridge/ws?role=desktop&access_token=${D}&name=Smoke%20Desktop&platform=darwin`
)
await desk.opened
const p0 = await desk.next((f) => f.t === 'presence')
check(
  'desktop gets presence on connect',
  p0.desktop?.deviceId === desktopDeviceId && p0.phones.length === 0
)

const status1 = await api('/v1/bridge/status', { token: P2 })
check(
  'phone sees the desktop up via REST',
  status1.json?.desktop?.deviceId === desktopDeviceId &&
    status1.json.desktop.name === 'Smoke Desktop'
)

const phone = socket(
  `${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P2}&name=iPhone&platform=ios&version=1.0.48`
)
await phone.opened
const p1 = await phone.next((f) => f.t === 'presence')
check('phone gets presence with the desktop', p1.desktop?.deviceId === desktopDeviceId)
const p2 = await desk.next((f) => f.t === 'presence' && f.phones.length === 1)
check(
  'desktop learns the phone arrived',
  p2.phones[0]?.deviceId === phoneDeviceId && p2.phones[0]?.name === 'iPhone'
)

// RPC round trip: phone → bridge → desktop → bridge → phone.
phone.send({
  t: 'rpc',
  id: 7,
  method: 'desktop.hello',
  params: { who: 'phone' }
})
const req = await desk.next((f) => f.t === 'rpc')
check(
  'desktop receives the rpc with the phone identity',
  req.method === 'desktop.hello' &&
    req.params?.who === 'phone' &&
    req.phone?.deviceId === phoneDeviceId
)
desk.send({ t: 'res', id: req.id, result: { ok: true, echo: req.params.who } })
const res = await phone.next((f) => f.t === 'res')
check('phone receives the answer under its own id', res.id === 7 && res.result?.echo === 'phone')

desk.send({ t: 'ev', topic: 'conversation.upserted', payload: { id: 'c1' } })
const ev = await phone.next((f) => f.t === 'ev')
check(
  'desktop events fan out to the phone',
  ev.topic === 'conversation.upserted' && ev.payload?.id === 'c1'
)

// Push registration + a notify with no ack → falls to push (no real token
// here, so the bridge reports dropped with a reason rather than lying).
phone.send({
  t: 'push',
  frame: { v: 1, type: 'register_push', expoPushToken: null, platform: 'ios' }
})
await sleep(150)
desk.send({
  t: 'notify',
  frame: {
    v: 1,
    type: 'notify',
    notificationId: 'n1',
    runId: 'r',
    phase: 'info',
    title: 'hi',
    body: 'there',
    urgency: 'normal',
    deeplink: null,
    ttl: 60,
    ts: Date.now()
  }
})
const delivered = await phone.next((f) => f.t === 'notification')
check('notification reaches the connected phone in-band', delivered.frame?.notificationId === 'n1')
phone.send({
  t: 'push',
  frame: { v: 1, type: 'notification_ack', notificationId: 'n1' }
})
const nr = await desk.next((f) => f.t === 'notify_result')
check('desktop hears the in-band route', nr.frame?.route === 'inband', JSON.stringify(nr))

// A second socket for the same phone replaces the first.
const phoneB = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P2}&name=iPhone`)
await phoneB.opened
const replaced = await phone.closed
check('a reconnect replaces the older phone socket', replaced.code === 4000)

// No desktop → rpc answered offline.
desk.ws.close(1000, 'bye')
await desk.closed
const gone = await phoneB.next((f) => f.t === 'presence' && f.desktop === null)
check('phone learns the desktop went away', gone.desktop === null)
phoneB.send({ t: 'rpc', id: 8, method: 'desktop.hello', params: {} })
const offline = await phoneB.next((f) => f.t === 'res')
check(
  'rpc without a desktop answers desktop_offline',
  offline.id === 8 && offline.error?.code === 'desktop_offline'
)

// Unpair from the desktop: sessions revoked, socket closed, token dead.
const revoke = await api(`/v1/devices/${phoneDeviceId}`, {
  token: D,
  method: 'DELETE'
})
check(
  'desktop unpairs the phone',
  revoke.status === 200 && revoke.json?.revoked >= 1,
  JSON.stringify(revoke.json)
)
const cut = await phoneB.closed
check('phone socket closed as revoked', cut.code === 4001)
check('phone token dead after unpair', (await api('/v1/me', { token: P2 })).status === 401)
check(
  'phone refresh dead after unpair',
  (
    await api('/auth/refresh', {
      body: { refresh_token: refreshed.json.refresh_token }
    })
  ).status === 401
)

// Logout from the phone side closes its own socket.
const phone2ws = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${phone2.access_token}`)
await phone2ws.opened
await phone2ws.next((f) => f.t === 'presence')
check(
  'phone logout ok',
  (await api('/v1/logout', { token: phone2.access_token, body: {} })).status === 200
)
const bye = await phone2ws.closed
check('logout closes the bridge socket', bye.code === 4001)

// ── 6 · the phone-facing sync reads ──────────────────────────────────────
const stamp = Date.now().toString(36)
const convId = `smoke-${stamp}`
const t0 = new Date().toISOString()
await sleep(20)
const batch = await api('/v1/sync/batch', {
  token: D,
  body: {
    items: [
      {
        type: 'conversation',
        id: convId,
        title: 'Bridge smoke',
        created_at: t0,
        updated_at: t0
      },
      {
        type: 'record',
        id: `snap.${convId}`,
        conversation_id: convId,
        seq: 5,
        kind: 'snapshot',
        content: {
          id: convId,
          title: 'Bridge smoke',
          model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
          channel: 'mobile',
          icon: '🐟',
          projectId: 'p1',
          stats: { allTime: { turns: 1 } },
          summary: 'a smoke',
          messageCount: 2
        },
        created_at: t0
      },
      {
        type: 'record',
        id: `m_1.aaaaaaaa`,
        conversation_id: convId,
        seq: 1,
        kind: 'message',
        content: { id: 'm_1', role: 'user', content: 'hi', timestamp: 1 },
        created_at: t0
      },
      {
        type: 'record',
        id: `m_2.bbbbbbbb`,
        conversation_id: convId,
        seq: 2,
        kind: 'message',
        content: {
          id: 'm_2',
          role: 'assistant',
          content: 'hello',
          timestamp: 2
        },
        created_at: t0
      }
    ]
  }
})
// Against a persistent org (verify-live, a rerun) the fixture rows already
// exist and come back `ignored` — a dedupe, not a refusal. Only a rejection
// is a failure.
check(
  'batch accepted',
  (batch.json?.accepted ?? 0) + (batch.json?.ignored ?? 0) === 4 && batch.json?.rejected === 0,
  JSON.stringify(batch.json)
)
const since = await api(`/v1/conversations?since=${encodeURIComponent(t0)}&include=meta`, {
  token: D
})
const row = (since.json?.conversations ?? []).find((c) => c.id === convId)
check(
  'since index carries envelope fields',
  row &&
    row.model === 'deepseek-ai/DeepSeek-V4-Flash-0731' &&
    row.icon === '🐟' &&
    row.project_id === 'p1' &&
    row.summary === 'a smoke',
  JSON.stringify(row)
)
check(
  'since index carries stats + count',
  row?.stats?.allTime?.turns === 1 && row?.message_count === 2,
  JSON.stringify(row)
)
check(
  'since answers a cursor',
  typeof since.json?.cursor === 'string' && since.json.cursor.includes('~~')
)
const del = await api(`/v1/conversations/${convId}`, {
  token: D,
  method: 'DELETE'
})
check('delete tombstones', del.json?.deleted === true)
const after = await api(`/v1/conversations?since=${encodeURIComponent(since.json.cursor)}`, {
  token: D
})
const tomb = (after.json?.conversations ?? []).find((c) => c.id === convId)
check('tombstone reaches the since cursor', tomb && tomb.deleted_at, JSON.stringify(after.json))

const blob = Buffer.from(`bridge-smoke-${stamp}`)
const sha = (await import('node:crypto')).createHash('sha256').update(blob).digest('hex')
const path = `files/smoke-${stamp}.txt`
check(
  'upload by path',
  (
    await api(`/v1/files/upload?sha256=${sha}&name=${encodeURIComponent(path)}&mime=text/plain`, {
      token: D,
      raw: blob
    })
  ).status === 200
)
const head = await api(`/v1/files/path?name=${encodeURIComponent(path)}`, {
  token: D,
  method: 'HEAD'
})
check('HEAD by path answers the sha', head.status === 200 && head.headers.get('etag') === sha)
const byPath = await api(`/v1/files/path?name=${encodeURIComponent(path)}`, {
  token: D
})
check('GET by path streams the blob', byPath.status === 200 && byPath.buf.equals(blob))
check(
  'unknown path is 404',
  (await api('/v1/files/path?name=nope/nothing.txt', { token: D })).status === 404
)

const days = await api('/v1/usage/days?tz=180', { token: D })
check(
  'usage days fold',
  days.status === 200 && Array.isArray(days.json?.days) && days.json.tz === 180
)

console.log(`\n${failures === 0 ? '🎉' : '💥'} ${n - failures}/${n} checks passed`)
process.exit(failures === 0 ? 0 : 1)
