/**
 * The account, in a shell: `wfc login`, `logout`, `unlock`, `lock`,
 * `account`, `reset-password`, `activate`, `change-password`, `change-pin`.
 *
 * Every verb is a thin driver over the daemon's `auth:*` handlers — the same
 * ones the window's sign-in screens call — so the rules (temporary password
 * → new password, first sign-in → PIN, five wrong PINs → signed out) live in
 * ONE place and the terminal cannot drift from the app. Secrets are always
 * prompted, hidden, never taken from argv: a password on a command line lands
 * in shell history.
 */
import { c, confirm, err, heading, icon, keyValue, out, question } from '../lib/ui.mjs'
import {
  FATAL_ERRORS,
  authErrorText,
  describeAccount,
  isSignedIn,
  nextStep,
  validateCode,
  validatePassword,
  validatePin
} from '../lib/auth.mjs'

const MAX_TRIES = 5
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const getState = (client) => client.invoke('auth:getState')

function fail(state) {
  err(`  ${icon.fail()} ${c.red(authErrorText(state?.lastError, state?.lastErrorDetail))}`)
}

function printAccount(state) {
  heading('Account')
  const rows = [['status', describeAccount(state)]]
  if (state?.user) {
    rows.push(['email', c.gray(state.user.email ?? '')])
    if (state.user.name) rows.push(['name', state.user.name])
    if (state.user.role) rows.push(['role', c.gray(state.user.role)])
  }
  if (state?.orgName) rows.push(['organization', state.orgName])
  keyValue(rows)
  const hint = {
    loggedOut: 'sign in: wfc login',
    locked: 'unlock: wfc unlock',
    needsPin: 'finish signing in: wfc login',
    mustChangePassword: 'finish signing in: wfc login',
    ready: 'sign out: wfc logout · lock: wfc lock · password: wfc change-password'
  }[state?.status]
  if (hint) out(c.gray(`    ${hint}`))
}

/** `wfc account` — who is signed in on this machine. */
export async function account(client, { json = false } = {}) {
  const state = await getState(client)
  if (json) {
    out(JSON.stringify(state, null, 2))
    return 0
  }
  printAccount(state)
  return 0
}

/** Ask for a new password twice, until the pair passes the window's policy. */
async function askNewPassword(label = 'new password') {
  for (;;) {
    const first = await question(`  ${label}: `, { hidden: true })
    const second = await question(`  confirm ${label}: `, { hidden: true })
    const problem = validatePassword(first, second)
    if (!problem) return first
    err(`  ${icon.warn()} ${c.yellow(problem)}`)
  }
}

async function askNewPin(label = 'PIN') {
  for (;;) {
    const first = await question(`  ${label} (4 digits): `, { hidden: true })
    const second = await question(`  confirm ${label}: `, { hidden: true })
    const problem = validatePin(first, second)
    if (!problem) return first
    err(`  ${icon.warn()} ${c.yellow(problem)}`)
  }
}

/**
 * Drive the account from wherever it is to `ready`. Shared by login,
 * reset-password and activate — each of those merely gets the session to
 * the first step and hands over.
 */
async function continueToReady(client, state, { email = null } = {}) {
  let tries = 0
  for (;;) {
    switch (nextStep(state)) {
      case 'ready':
        out(`${icon.ok()} ${describeAccount(state)}`)
        return 0

      case 'initializing':
        await sleep(400)
        state = await getState(client)
        continue

      case 'signIn': {
        if (!email) email = (await question('  email: ')).trim()
        if (!email) {
          err(`  ${icon.fail()} ${c.red('an email is required')}`)
          return 2
        }
        const password = await question('  password: ', { hidden: true })
        state = await client.invoke('auth:login', email, password)
        if (state.status === 'loggedOut') {
          fail(state)
          if (FATAL_ERRORS.has(state.lastError) || ++tries >= MAX_TRIES) return 1
          if (state.lastError === 'email_not_found') email = null
          out(c.gray('    forgot it? wfc reset-password'))
        }
        continue
      }

      case 'changePassword': {
        out(c.gray('  Your temporary password must be replaced. At least 10 characters.'))
        const next = await askNewPassword()
        state = await client.invoke('auth:changePassword', next)
        if (state.lastError) {
          fail(state)
          if (state.status === 'loggedOut' || FATAL_ERRORS.has(state.lastError)) return 1
        }
        continue
      }

      case 'setPin': {
        out(c.gray('  Create a 4-digit PIN — a quick lock for this machine, local to it.'))
        const pin = await askNewPin()
        state = await client.invoke('auth:setPin', pin)
        if (state.lastError) {
          fail(state)
          if (state.status === 'loggedOut') return 1
        }
        continue
      }

      case 'unlock':
        return unlock(client)
    }
  }
}

/** `wfc login [email]` — email + password, then whatever the account still needs. */
export async function login(client, args = []) {
  const state = await getState(client)
  if (state.status === 'ready') {
    out(`${icon.ok()} already ${describeAccount(state)}`)
    out(c.gray('    switch accounts: wfc logout, then wfc login'))
    return 0
  }
  if (state.status === 'locked') return unlock(client)
  heading('Sign in')
  return continueToReady(client, state, { email: args[0] ?? null })
}

/** `wfc unlock` — the PIN door. Five misses sign the account out. */
export async function unlock(client) {
  let state = await getState(client)
  if (state.status !== 'locked') {
    if (state.status === 'ready') out(`${icon.ok()} not locked — ${describeAccount(state)}`)
    else out(c.gray(`  nothing to unlock — ${describeAccount(state)}`))
    return 0
  }
  const who = state.user?.name || state.user?.email || ''
  out(c.gray(`  Welcome back${who ? `, ${who}` : ''}.`))
  for (;;) {
    const pin = await question('  PIN: ', { hidden: true })
    state = await client.invoke('auth:unlock', pin)
    if (state.status === 'ready') {
      out(`${icon.ok()} unlocked`)
      return 0
    }
    if (state.status !== 'locked') {
      fail(state)
      return 1
    }
    const left = state.pinAttemptsLeft
    err(
      `  ${icon.fail()} ${c.red(`Wrong PIN${typeof left === 'number' ? ` — ${left} left before sign-out` : ''}.`)}`
    )
    out(c.gray('    forgot it? wfc logout, then sign in with your password'))
  }
}

/** `wfc lock` — re-lock behind the PIN, now. */
export async function lock(client) {
  const state = await client.invoke('auth:lock')
  if (state.status === 'locked') {
    out(`${icon.ok()} locked — unlock with: wfc unlock`)
    return 0
  }
  out(c.gray(`  nothing to lock — ${describeAccount(state)}`))
  return 1
}

/** `wfc logout` — revoke the session and clear this machine's cache. */
export async function logout(client, { yes = false } = {}) {
  const state = await getState(client)
  if (!isSignedIn(state)) {
    out(c.gray('  not signed in'))
    return 0
  }
  if (!yes) {
    const ok = await confirm(
      `  Sign out ${state.user?.email ?? ''}? This machine's cache is cleared; nothing is lost — it comes back on the next sign-in.`,
      false
    )
    if (!ok) return 1
  }
  const next = await client.invoke('auth:signOut')
  if (next.status === 'loggedOut') {
    out(`${icon.ok()} signed out`)
    return 0
  }
  fail(next)
  return 1
}

/**
 * `wfc reset-password [email]` — a 6-digit code by email, then a new
 * password, then straight into sign-in with it.
 */
export async function resetPassword(client, args = []) {
  const state = await getState(client)
  if (isSignedIn(state)) {
    out(c.gray(`  ${describeAccount(state)} — change it with: wfc change-password`))
    return 1
  }
  heading('Reset your password')
  const email = (args[0] ?? (await question('  email: '))).trim()
  if (!email) {
    err(`  ${icon.fail()} ${c.red('an email is required')}`)
    return 2
  }
  const sent = await client.invoke('auth:resetRequest', email)
  if (!sent.ok) {
    err(`  ${icon.fail()} ${c.red(authErrorText(sent.code, sent.detail))}`)
    return 1
  }
  out(`${icon.ok()} a 6-digit code is on its way to ${c.bold(email)}`)
  out(c.gray('    leave the code empty to send a new one'))
  for (;;) {
    const code = (await question('  code: ')).trim()
    if (!code) {
      const again = await client.invoke('auth:resetRequest', email)
      if (again.ok) out(`${icon.ok()} a new code is on its way`)
      else err(`  ${icon.fail()} ${c.red(authErrorText(again.code, again.detail))}`)
      continue
    }
    const problem = validateCode(code)
    if (problem) {
      err(`  ${icon.warn()} ${c.yellow(problem)}`)
      continue
    }
    const password = await askNewPassword()
    const done = await client.invoke('auth:resetConfirm', email, code, password)
    if (!done.ok) {
      err(`  ${icon.fail()} ${c.red(authErrorText(done.code, done.detail))}`)
      if (done.code === 'invalid_code' || done.code === 'code_expired') continue
      return 1
    }
    out(`${icon.ok()} password reset — signing you in`)
    const next = await client.invoke('auth:login', email, password)
    return continueToReady(client, next, { email })
  }
}

/**
 * `wfc activate [email]` — an invited account's first password, bought with
 * the code from the invitation email. No session comes back; signing in with
 * the new password is the first honest test that it took.
 */
export async function activate(client, args = []) {
  const state = await getState(client)
  if (isSignedIn(state)) {
    out(c.gray(`  already ${describeAccount(state)}`))
    return 1
  }
  heading('Activate your account')
  const email = (args[0] ?? (await question('  email: '))).trim()
  if (!email) {
    err(`  ${icon.fail()} ${c.red('an email is required')}`)
    return 2
  }
  out(
    c.gray('    enter the code from your invitation email — or leave it empty to be sent a new one')
  )
  for (;;) {
    const code = (await question('  code: ')).trim()
    if (!code) {
      const again = await client.invoke('auth:activateRequest', email)
      if (again.ok) out(`${icon.ok()} a new code is on its way to ${c.bold(email)}`)
      else err(`  ${icon.fail()} ${c.red(authErrorText(again.code, again.detail))}`)
      continue
    }
    const problem = validateCode(code)
    if (problem) {
      err(`  ${icon.warn()} ${c.yellow(problem)}`)
      continue
    }
    const password = await askNewPassword('password')
    const done = await client.invoke('auth:activateConfirm', email, code, password)
    if (!done.ok) {
      err(`  ${icon.fail()} ${c.red(authErrorText(done.code, done.detail))}`)
      if (done.code === 'invalid_code' || done.code === 'code_expired') continue
      return 1
    }
    out(`${icon.ok()} account activated — signing you in`)
    const next = await client.invoke('auth:login', email, password)
    return continueToReady(client, next, { email })
  }
}

/** `wfc change-password` — prove the current one, set a new one. */
export async function changePassword(client) {
  const state = await getState(client)
  if (state.status !== 'ready') {
    out(c.gray(`  ${describeAccount(state)} — sign in first`))
    return 1
  }
  heading('Change your password')
  const current = await question('  current password: ', { hidden: true })
  const next = await askNewPassword()
  const result = await client.invoke('auth:passwordChangeSelf', current, next)
  if (result.lastError) {
    fail(result)
    return 1
  }
  out(`${icon.ok()} password changed`)
  return 0
}

/** `wfc change-pin` — prove the current PIN, set a new one. */
export async function changePin(client) {
  const state = await getState(client)
  if (state.status !== 'ready') {
    out(c.gray(`  ${describeAccount(state)} — sign in first`))
    return 1
  }
  heading('Change your PIN')
  const current = await question('  current PIN: ', { hidden: true })
  const next = await askNewPin('new PIN')
  const result = await client.invoke('auth:changePin', current, next)
  if (result.lastError) {
    fail(result)
    return 1
  }
  out(`${icon.ok()} PIN changed`)
  return 0
}
