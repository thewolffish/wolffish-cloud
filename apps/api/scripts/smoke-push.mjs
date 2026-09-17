#!/usr/bin/env node
/**
 * The push fallback, end to end — the path a phone that is NOT on screen
 * takes, against scripts/mock-expo.mjs standing in for exp.host.
 *
 *   node scripts/mock-expo.mjs &            # :9094
 *   EXPO_PUSH_BASE=http://127.0.0.1:9094 \
 *   EXPO_ACCESS_TOKEN=mock-expo-token npx wrangler dev
 *   node scripts/smoke-push.mjs
 *
 * (smoke-all.mjs does all of that for you.)
 *
 * Everything here is about the half of push that HTTP 200 hides. Expo answers
 * 200 and reports per-message failure inside the body, so the questions worth
 * asking a live Worker are: does a dead token actually prune its registration
 * (rather than being reported as delivered forever), does a phone that never
 * registered get an honest `dropped` instead of a hopeful `push`, and does
 * the payload the handset depends on — channel id, priority, badge,
 * conversationId — survive the trip.
 *
 * The receipt sweep is a Durable Object alarm — fifteen minutes in production,
 * two seconds here via PUSH_SWEEP_DELAY_MS — and IS exercised, because it is
 * the half of delivery nothing else can see.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787'
const MOCK = process.env.MOCK_EXPO_BASE ?? 'http://127.0.0.1:9094'
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish123'
const OWNER = process.env.WFC_OWNER_EMAIL ?? 'nasser.alowais@wolffi.sh'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs)
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

const mock = async (path, method = 'GET') => (await fetch(`${MOCK}${path}`, { method })).json()

const deviceRow = async (token, id) =>
  ((await api('/v1/devices', { token })).json?.devices ?? []).find((d) => d.id === id)

/** The bridge pushes in waitUntil, so the row lands a beat after the answer. */
const waitForPush = async (token, id, want, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const row = await deviceRow(token, id)
    if (row?.push?.state === want) return row
    await sleep(100)
  }
  return deviceRow(token, id)
}

// ── 0 · the mock is up and the Worker is pointed at it ────────────────────
const stats0 = await mock('/reset', 'POST').catch(() => null)
check('mock expo reachable', stats0?.ok === true, `start: node scripts/mock-expo.mjs (${MOCK})`)

// ── 1 · pair a phone ──────────────────────────────────────────────────────
const login = await api('/auth/login', {
  body: {
    email: OWNER,
    password: PASSWORD,
    device: { platform: 'desktop', name: 'smoke-push', app_version: 'smoke' }
  }
})
check('desktop login', login.status === 200 && login.json?.access_token, JSON.stringify(login.json))
const D = login.json.access_token

const offer = await api('/v1/pair/offer', { token: D, body: {} })
const claim = await api('/auth/pair/claim', {
  body: {
    code: offer.json.code,
    device: {
      name: 'iPhone',
      app_version: '1.0.49',
      model: 'iPhone 17 Pro',
      os: 'ios',
      os_version: '27.0'
    }
  }
})
check('phone paired', claim.status === 200 && claim.json?.device_id, JSON.stringify(claim.json))
const P = claim.json.access_token
const phoneId = claim.json.device_id

const desk = socket(`${WS_BASE}/v1/bridge/ws?role=desktop&access_token=${D}&name=smoke-push`)
await desk.opened
await desk.next((f) => f.t === 'presence')

/**
 * Notification ids are UNIQUE PER RUN, and that is load-bearing rather than
 * tidy: the bridge remembers every notificationId for a day and replays its
 * original outcome instead of delivering again. Fixed ids made a second run
 * of this file assert against the first run's answers — green, and testing
 * nothing. The desktop mints ULIDs for the same reason.
 */
const RUN = Date.now().toString(36)
const notify = (id, extra = {}) =>
  desk.send({
    t: 'notify',
    frame: {
      v: 1,
      type: 'notify',
      notificationId: `${RUN}-${id}`,
      runId: 'run_smoke',
      phase: 'completed',
      title: 'Migration finished',
      body: 'All 214 rows converted cleanly.',
      urgency: 'normal',
      deeplink: null,
      conversationId: '2026-09-17_11-02-33',
      ttl: 3600,
      ts: Date.now(),
      ...extra
    }
  })

// ── 2 · no registration at all → dropped, and it says which seam ──────────
notify('p0')
const none = await desk.next((f) => f.t === 'notify_result')
check(
  'a phone that never registered is dropped, not "pushed"',
  none.frame?.route === 'dropped' && /no phone has registered/.test(none.frame?.reason ?? ''),
  JSON.stringify(none.frame)
)

// ── 3 · a live token, phone off screen → push, with the payload intact ────
const phone = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P}&name=iPhone`)
await phone.opened
await phone.next((f) => f.t === 'presence')
phone.send({
  t: 'push',
  frame: {
    v: 1,
    type: 'register_push',
    expoPushToken: 'ExponentPushToken[mock-ok]',
    platform: 'android',
    appVersion: '1.0.49'
  }
})
await sleep(200)
phone.ws.close(1000, 'backgrounded')
await phone.closed
await sleep(200)

notify('p1')
const pushed = await desk.next((f) => f.t === 'notify_result')
check(
  'an off-screen phone with a token routes to push',
  pushed.frame?.route === 'push',
  JSON.stringify(pushed.frame)
)
await sleep(600)
const sent = await mock('/stats')
const message = sent.lastBatch?.[0]
check('the push reached the Expo endpoint', sent.sends === 1, JSON.stringify(sent))
check(
  'the message carries the android channel the phone created',
  message?.channelId === 'agent-runs',
  JSON.stringify(message)
)
// FCM `normal` is a QUEUE, not a quieter delivery: a phone in Doze holds it
// for minutes or hours, which is the exact case push exists for. Android is
// therefore always sent high, whatever urgency the model chose ('normal'
// here).
check('android is sent at high priority regardless of urgency', message?.priority === 'high')
check(
  'the raising conversation and the send time ride in data',
  message?.data?.conversationId === '2026-09-17_11-02-33' && typeof message?.data?.ts === 'number',
  JSON.stringify(message?.data)
)
check('the badge the OS paints is counted', message?.badge === 1, String(message?.badge))
const liveRow = await waitForPush(D, phoneId, 'live')
check(
  'a delivered send records when it was sent',
  liveRow?.push?.state === 'live' && typeof liveRow?.push?.sent_at === 'string',
  JSON.stringify(liveRow?.push)
)

// ── 4 · a dead token: 200 OK, error inside — the registration must go ─────
const phone2 = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P}&name=iPhone`)
await phone2.opened
await phone2.next((f) => f.t === 'presence')
phone2.send({
  t: 'push',
  frame: {
    v: 1,
    type: 'register_push',
    expoPushToken: 'ExponentPushToken[mock-dead]',
    platform: 'ios'
  }
})
await sleep(200)
phone2.ws.close(1000, 'backgrounded')
await phone2.closed
await sleep(200)

notify('p2')
await desk.next((f) => f.t === 'notify_result')
const deadRow = await waitForPush(D, phoneId, 'dead')
check(
  'a DeviceNotRegistered ticket marks the device dead',
  deadRow?.push?.state === 'dead' && deadRow?.push?.error === 'DeviceNotRegistered',
  JSON.stringify(deadRow?.push)
)

// …and the registration is GONE, so the next notify is honest rather than
// hopeful. This is the assertion that would have caught the original bug:
// before tickets were read, this notify answered `push` forever.
notify('p3')
const afterDeath = await desk.next((f) => f.t === 'notify_result')
check(
  'the next notify drops instead of pushing at a dead token',
  afterDeath.frame?.route === 'dropped',
  JSON.stringify(afterDeath.frame)
)

// ── 5 · the receipt sweep: the only thing that proves a delivery ──────────
// A ticket means Expo took the message. This is the half that says whether
// APNs or FCM ever did — a Durable Object alarm fifteen minutes later in
// production, two seconds here (PUSH_SWEEP_DELAY_MS). The mock answers an
// InvalidCredentials receipt for the `mock-badcreds` token, which is the one
// failure that is about the ORG's Expo project rather than the handset, and
// the only place it is ever visible.
const phone3 = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P}&name=iPhone`)
await phone3.opened
await phone3.next((f) => f.t === 'presence')
phone3.send({
  t: 'push',
  frame: {
    v: 1,
    type: 'register_push',
    expoPushToken: 'ExponentPushToken[mock-badcreds]',
    platform: 'ios'
  }
})
await sleep(200)
phone3.ws.close(1000, 'backgrounded')
await phone3.closed
await sleep(200)

notify('p4')
const queued = await desk.next((f) => f.t === 'notify_result')
check(
  'a re-registered phone is pushable again',
  queued.frame?.route === 'push',
  JSON.stringify(queued.frame)
)

// The alarm has to fire on its own — nothing below pokes it. Poll for the
// OUTCOME, not for the call: the first sweep carries the EARLIER push's
// receipt, an ok one that clears the error field, and this ticket's sweep is
// the one after it. Asserting on the first getReceipts call read the row
// half way through and saw the clean state the next sweep was about to spoil.
let creds = null
for (let i = 0; i < 80; i += 1) {
  await sleep(250)
  const row = await deviceRow(D, phoneId)
  if (row?.push?.error === 'InvalidCredentials') {
    creds = row
    break
  }
}
const sweeps = await mock('/stats')
check('the receipt sweep runs by itself', sweeps.receiptCalls > 0, JSON.stringify(sweeps))
check(
  'an InvalidCredentials receipt lands on the device row',
  creds?.push?.error === 'InvalidCredentials',
  JSON.stringify((await deviceRow(D, phoneId))?.push)
)
// The handset is fine — the org's Expo credentials are not — so its token
// must NOT be pruned the way a dead one is.
check(
  'a credentials failure does not condemn the handset',
  creds?.push?.state === 'live',
  JSON.stringify(creds?.push)
)

// ── 5.5 · an acked in-band notification must NOT also push ───────────────
// The fallback is armed on every in-band send and disarmed by the phone's
// ack, which arrives on the same object while that wait is in progress. If
// the ack ever stopped resolving the waiter, every notification delivered to
// a phone that is ON SCREEN would quietly be sent a second time through Expo
// — invisible to the user, who is deduped by notificationId, and visible only
// as a doubled push bill and a badge that counts twice.
const before = (await mock('/stats')).sends
const phone4 = socket(`${WS_BASE}/v1/bridge/ws?role=phone&access_token=${P}&name=iPhone`)
await phone4.opened
await phone4.next((f) => f.t === 'presence')
notify('p5')
const inband = await phone4.next((f) => f.t === 'notification')
phone4.send({
  t: 'push',
  frame: { v: 1, type: 'notification_ack', notificationId: inband.frame.notificationId }
})
const route = await desk.next((f) => f.t === 'notify_result')
check(
  'a phone on screen is answered inband',
  route.frame?.route === 'inband',
  JSON.stringify(route.frame)
)
// Longer than the 2 s ack window, so a fallback that was going to fire has.
await sleep(3000)
check(
  'an acked in-band notification sends no push',
  (await mock('/stats')).sends === before,
  `sends went ${before} → ${(await mock('/stats')).sends}`
)
phone4.ws.close(1000, 'bye')
await phone4.closed

// ── 6 · the admin lane reports the fleet ──────────────────────────────────
const gates = await api('/admin/gates', { token: D })
check(
  'admin gates report the push lane as configured',
  gates.json?.push?.configured === true,
  JSON.stringify(gates.json?.push)
)
check(
  'admin gates surface the fleet and name the org-wide failure',
  Object.keys(gates.json?.push?.devices ?? {}).length > 0 &&
    gates.json?.push?.last_error?.error === 'InvalidCredentials',
  JSON.stringify(gates.json?.push)
)

// ── 7 · leave nothing paired behind ───────────────────────────────────────
await api(`/v1/devices/${phoneId}`, { token: D, method: 'DELETE' })
desk.ws.close(1000, 'bye')

console.log(
  failures === 0 ? `\n🎉 ${n}/${n} checks passed` : `\n💥 ${failures} of ${n} checks failed`
)
process.exit(failures === 0 ? 0 : 1)
