/**
 * Full account support in the terminal — the one contract that must hold on
 * every surface: a turn cannot start unless the session is `ready`, and every
 * refusal names the command that fixes it. Plus the wiring: the daemon
 * exposes the redacted state, the classic verbs and the TUI commands exist,
 * and the client's copy of the state machine agrees with the daemon's gate.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/cli-auth-gate.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { authGateMessage } from '../cli/auth-gate'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(DESKTOP, rel), 'utf8')

let n = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    n++
    console.log(`✅ ${name}`)
  } catch (err) {
    n++
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

check('ready opens the door; every other status names its fix', () => {
  assert.equal(authGateMessage('ready'), null)
  assert.match(authGateMessage('loggedOut') ?? '', /wfc login/)
  assert.match(authGateMessage('locked') ?? '', /wfc unlock/)
  assert.match(authGateMessage('needsPin') ?? '', /wfc login/)
  assert.match(authGateMessage('mustChangePassword') ?? '', /wfc login/)
  assert.ok(authGateMessage('initializing'), 'a starting session is not "ready" either')
})

check('the daemon gates cli:send and reports the account in cli:status', () => {
  const ipc = read('src/main/channels/cli/ipc.ts')
  assert.ok(ipc.includes('authGateMessage(deps.auth().status)'), 'cli:send must consult the gate')
  assert.ok(
    ipc.includes('auth: deps.auth ? deps.auth() : null'),
    'cli:status must carry the account'
  )
  const main = read('src/main/index.ts')
  assert.ok(main.includes('auth: () => cloudSession.getState()'), 'index.ts must supply the state')
})

check('the client state machine agrees with the daemon gate, verb for verb', () => {
  const client = read('src/cli/lib/auth.mjs')
  for (const verb of ['login', 'unlock']) assert.ok(client.includes(`run('${verb}')`), verb)
  assert.ok(client.includes("case 'needsPin':") && client.includes("case 'mustChangePassword':"))
  // The window's PIN and password rules, restated once for both surfaces.
  assert.ok(client.includes('PASSWORD_MIN_LENGTH = 10'))
  assert.ok(client.includes('/^\\d{4}$/'), '4-digit PIN')
  assert.ok(client.includes('/^\\d{6}$/'), '6-digit emailed code')
})

check('the classic verbs and the session commands both exist', () => {
  const verbs = read('src/cli/wfc.mjs')
  for (const v of [
    "case 'login':",
    "case 'logout':",
    "case 'unlock':",
    "case 'lock':",
    "case 'account':",
    "case 'reset-password':",
    "case 'activate':",
    "case 'change-password':",
    "case 'change-pin':"
  ])
    assert.ok(verbs.includes(v), v)
  const tui = read('src/cli/tui/register.ts')
  for (const slash of [
    "slash: 'login'",
    "slash: 'logout'",
    "slash: 'unlock'",
    "slash: 'lock'",
    "slash: 'account'",
    "slash: 'reset-password'",
    "slash: 'activate'",
    "slash: 'change-password'",
    "slash: 'change-pin'"
  ])
    assert.ok(tui.includes(slash), slash)
})

check('the auth handlers are reachable over the socket (none is GUI-only)', () => {
  const server = read('src/main/channels/cli/server.ts')
  assert.ok(!/'auth:/.test(server), 'an auth:* handler is refused by name')
})

console.log(`\n${n} checks`)
