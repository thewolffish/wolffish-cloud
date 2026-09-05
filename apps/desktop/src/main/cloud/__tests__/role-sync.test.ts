/**
 * A role change reaching a device that is already signed in.
 *
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/cloud/__tests__/role-sync.test.ts
 *
 * The bug this pins down: the stored session's copy of the user is seeded at
 * sign-in and every refresh deliberately carries the OLD user forward (the
 * refresh response has no user to read). Nothing else wrote it. So an
 * employee promoted to admin kept an app with no admin screens until they
 * signed out and back in — and a demoted admin kept being shown screens the
 * server would refuse every call from.
 *
 * `/v1/me` reads the role straight out of D1, so it is the live answer, and
 * the watchdog is the one thing that asks it on a schedule. This asserts the
 * watchdog now reconciles the role, persists it, and ANNOUNCES it — the
 * announcement is what makes the admin tab appear without a restart.
 */
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-role-'))
process.env.HOME = HOME
process.env.WFC_API_URL = 'http://api.test'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      // getVersion/getName are not optional: CloudSession.login builds the
      // device descriptor from them, and without them sign-in throws before
      // a session is ever stored.
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => HOME,
        getVersion: () => '0.0.0-test',
        getName: () => 'Wolffish'
      },
      // Encryption unavailable → the session persists as plain JSON, which
      // is also what lets this test read back what was stored.
      safeStorage: { isEncryptionAvailable: () => false }
    }
  }
  return origLoad.apply(this, args)
}

/** What /v1/me currently answers. The "admin changed something" knob. */
let liveRole = 'employee'
let liveName = 'Sam'
let meCalls = 0

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input)
  if (url.endsWith('/auth/login')) {
    return json({
      access_token: 'access-1',
      expires_in: 900,
      refresh_token: 'refresh-1',
      session_id: 'sess_1',
      device_id: 'dev_1',
      user: { id: 'usr_1', email: 'sam@wolffi.sh', name: 'Sam', role: 'employee' }
    })
  }
  if (url.endsWith('/v1/me')) {
    meCalls++
    return json({
      user: {
        id: 'usr_1',
        email: 'sam@wolffi.sh',
        name: liveName,
        role: liveRole,
        phone: '',
        position: '',
        bio: '',
        avatar_key: null,
        status: 'active',
        last_login_at: null
      },
      org: { name: 'Wolffish', default_model: 'm' },
      device: { id: 'dev_1', platform: 'desktop', name: 'Mac', pin_set: 0, pin_clear_requested: 0 },
      session_id: 'sess_1'
    })
  }
  if (url.endsWith('/v1/device/pin')) return json({ ok: true })
  if (url.includes('/profile/avatar')) return new Response(null, { status: 404 })
  return json({ ok: true })
}) as typeof fetch

// tsx emits CJS here, so no top-level await: the whole run is one async main.
async function main(): Promise<void> {
  const { cloudSession } = await import('@main/cloud/session')

  let failures = 0
  const check = (name: string, cond: unknown, extra = ''): void => {
    const ok = Boolean(cond)
    console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
    if (!ok) failures++
  }

  const announced: string[] = []
  cloudSession.onState((state) => {
    if (state.user) announced.push(state.user.role)
  })

  // Sign in, then set a PIN — the app is "ready" only past both.
  const afterLogin = await cloudSession.login('sam@wolffi.sh', 'password')
  check(
    'login established a session',
    afterLogin.status !== 'loggedOut',
    `${afterLogin.status} ${afterLogin.lastError ?? ''}`
  )
  await cloudSession.setPin('1234')
  check(
    'signed in as the role the login response carried',
    cloudSession.getState().user?.role === 'employee',
    String(cloudSession.getState().user?.role)
  )

  // The admin promotes them while the app is open.
  liveRole = 'owner'
  announced.length = 0
  await (cloudSession as unknown as { tick: () => Promise<void> }).tick()

  const promoted = cloudSession.getState()
  check(
    'the promotion reaches the signed-in device',
    promoted.user?.role === 'owner',
    String(promoted.user?.role)
  )
  check(
    'and is announced, so the UI re-gates without a restart',
    announced.includes('owner'),
    announced.join(',')
  )
  check('the email is untouched', promoted.user?.email === 'sam@wolffi.sh')

  // It has to survive a relaunch too, or the tab flickers back off at launch
  // and only returns after the first tick.
  const stored = JSON.parse(
    fs.readFileSync(path.join(HOME, '.wfc', 'runtime', 'cloud-session.json'), 'utf8')
  )
  check(
    'the new role is persisted',
    stored?.plain?.session?.user?.role === 'owner',
    JSON.stringify(stored?.plain?.session?.user)
  )

  // Nothing changed: no write, no announcement. A tick every five minutes must
  // not be five minutes of pointless re-renders.
  announced.length = 0
  await (cloudSession as unknown as { tick: () => Promise<void> }).tick()
  check('an unchanged role announces nothing', announced.length === 0, announced.join(','))

  // Demotion is the direction that actually matters for safety: the screens
  // have to go away, not merely start failing.
  liveRole = 'employee'
  await (cloudSession as unknown as { tick: () => Promise<void> }).tick()
  check(
    'a demotion takes the role away again',
    cloudSession.getState().user?.role === 'employee',
    String(cloudSession.getState().user?.role)
  )

  // A profile rename made on another device rides the same reconcile.
  liveName = 'Samir'
  await (cloudSession as unknown as { tick: () => Promise<void> }).tick()
  check(
    'a rename elsewhere lands too',
    cloudSession.getState().user?.name === 'Samir',
    String(cloudSession.getState().user?.name)
  )

  check('every check above actually asked the server', meCalls >= 5, String(meCalls))

  fs.rmSync(HOME, { recursive: true, force: true })
  console.log(failures === 0 ? '\nROLE SYNC: ALL PASS' : `\nROLE SYNC: ${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
