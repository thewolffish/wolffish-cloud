/**
 * What every surface believes about channel connectivity.
 *
 * One function feeds three readers: `wolffish status` in the terminal, and the
 * agent's own `channel_status` and `wolffish_status` tools. That last one is
 * why the shape matters more than a settings row would — the agent decides
 * whether it can REACH the user from this, and relays the reconnect line
 * verbatim when it cannot.
 *
 * The bug this guards: mobile was absent from the list entirely, so a paired,
 * connected phone was invisible to all three. A channel missing here does not
 * look broken; it looks like it does not exist.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/channel-status.test.ts
 */
import assert from 'node:assert/strict'
import { collectChannelStatus } from '@main/channels/status'

let passed = 0
let failed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

const phone = (connected: boolean, extra: Record<string, unknown> = {}): unknown => ({
  id: 'dev_phone',
  name: 'iPhone',
  platform: 'ios',
  model: 'iPhone 16 Pro',
  osVersion: '26.6',
  appVersion: '1.0.48',
  pairedAt: Date.now(),
  lastSeenAt: null,
  connected,
  ...extra
})

const bridge = (status: string, extra: Record<string, unknown> = {}): unknown => ({
  status,
  phones: [],
  connectedAt: status === 'connected' ? Date.now() : null,
  lastError: null,
  reconnects: 0,
  framesSent: 0,
  framesReceived: 0,
  bytesSent: 0,
  bytesReceived: 0,
  ...extra
})

const unpaired = { paired: false, phones: [], bridge: null }

const snapshot = (mobile: unknown): ReturnType<typeof collectChannelStatus> =>
  collectChannelStatus({
    mobile: () => mobile
  } as never)

const mobileRow = (mobile: unknown): ReturnType<typeof collectChannelStatus>[number] => {
  const row = snapshot(mobile).find((entry) => entry.id === 'mobile')
  assert.ok(row, 'mobile is missing from the channel list')
  return row
}

check('every channel is listed, mobile and the terminal among them', () => {
  const ids = snapshot(unpaired).map((entry) => entry.id)
  assert.deepEqual(ids, ['mobile', 'cli', 'electron'])
})

check('the terminal reads connected only while a terminal is attached', () => {
  const rows = (cli: { clients: number; listening: boolean } | undefined): unknown =>
    collectChannelStatus({
      mobile: () => unpaired,
      cli: cli ? () => cli : undefined
    } as never).find((entry) => entry.id === 'cli')

  assert.equal((rows({ clients: 1, listening: true }) as { connected: boolean }).connected, true)
  // Listening is not the same as reachable: with nobody attached there is
  // nowhere for a message to land.
  assert.equal((rows({ clients: 0, listening: true }) as { connected: boolean }).connected, false)
  assert.equal((rows({ clients: 0, listening: false }) as { connected: boolean }).connected, false)
  assert.equal((rows(undefined) as { connected: boolean }).connected, false)
})

check('in-app chat is not claimed as available on a headless box', () => {
  const row = (headless: boolean): { connected: boolean; detail: string } =>
    collectChannelStatus({
      mobile: () => unpaired,
      headless: () => headless
    } as never).find((entry) => entry.id === 'electron') as never

  assert.equal(row(false).connected, true)
  assert.equal(row(true).connected, false)
  assert.match(row(true).detail, /headless/)
})

check('a paired phone with a live tunnel reads connected, by name', () => {
  const row = mobileRow({ paired: true, phones: [phone(true)], bridge: bridge('connected') })
  assert.equal(row.connected, true)
  assert.equal(row.state, 'connected')
  assert.match(row.detail, /iPhone/)
  assert.equal(row.reconnect, '', 'a connected channel must not carry reconnect steps')
})

/**
 * The distinction the row exists for. A pairing is durable; the tunnel only
 * carries traffic while the app is on screen. Reporting "connected" off the
 * pairing alone would tell the agent it can reach a phone in someone's pocket.
 */
check('paired but the app is closed is NOT connected — and says it is still paired', () => {
  const row = mobileRow({ paired: true, phones: [phone(false)], bridge: bridge('connected') })
  assert.equal(row.connected, false)
  assert.match(row.detail, /paired/, 'down must not read as gone')
  assert.match(row.detail, /not open/)
  assert.ok(row.reconnect.length > 0, 'a disconnected channel owes the user a way back')
})

check('reconnecting and connecting are named, not lumped into "closed"', () => {
  assert.match(
    mobileRow({ paired: true, phones: [phone(false)], bridge: bridge('reconnecting') }).detail,
    /reconnecting/
  )
  assert.match(
    mobileRow({ paired: true, phones: [phone(false)], bridge: bridge('connecting') }).detail,
    /connecting/
  )
})

check('a tunnel error surfaces the error itself', () => {
  const row = mobileRow({
    paired: true,
    phones: [phone(false)],
    bridge: bridge('error', { lastError: 'bridge refused' })
  })
  assert.equal(row.connected, false)
  assert.match(row.detail, /bridge refused/)
})

check('no phone paired says so, and points at pairing rather than at waking one', () => {
  const row = mobileRow(unpaired)
  assert.equal(row.connected, false)
  assert.equal(row.state, 'unpaired')
  assert.match(row.detail, /no phone paired/)
  assert.match(row.reconnect, /pair/i)
})

check('a phone that never named itself still gets a row', () => {
  const row = mobileRow({
    paired: true,
    phones: [phone(true, { name: '', model: null })],
    bridge: bridge('connected')
  })
  assert.equal(row.connected, true)
  assert.match(row.detail, /phone/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
