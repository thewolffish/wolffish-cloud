/**
 * The account, as the terminal reads it.
 *
 * The daemon owns the session and every token; the client only ever sees the
 * redacted AuthState the window sees, and drives the same handlers the
 * window's sign-in screens call, in the same order:
 *
 *   email + password
 *     → temporary password?  set a new one (10+ characters)
 *     → first sign-in here?  create a 4-digit PIN (the quick lock)
 *     → ready
 *
 * A locked session asks for the PIN; five misses sign the account out and
 * clear this machine's cache — exactly what the window does. Forgotten
 * password: an emailed 6-digit code buys a new one. Invited account: the
 * code from the invitation email buys the first password ("activate").
 *
 * This module is the pure half — the copy, the state machine, the checks —
 * shared by the classic verbs (commands/auth.mjs) and the TUI flows
 * (tui/dialogs/auth.tsx), so both surfaces say the same thing at the same
 * moment. English only, like the rest of the terminal.
 */

/** The window's auth.errors copy, verbatim. */
export const AUTH_ERRORS = {
  invalid_credentials: 'Wrong email or password.',
  rate_limited: 'Too many attempts — try again soon.',
  account_disabled: 'Your access has been disabled by an admin.',
  temp_password_expired: 'Temp password expired — ask your admin.',
  weak_password: 'Password too weak — use at least 10 characters.',
  network: 'Can’t reach Wolffish Cloud.',
  pin_wrong: 'Wrong PIN.',
  pin_format: 'PIN must be 4 digits.',
  pin_lockout: 'Too many wrong PINs — signed out.',
  session_expired: 'Session ended. Sign in again.',
  session_revoked: 'Session ended by your organization.',
  generic: 'Something went wrong. Try again.',
  email_not_found: 'No account with that email.',
  wrong_password: 'Wrong password.',
  invalid_code: 'Wrong code — check the email and try again.',
  code_expired: 'That code expired or was used up. Request a new one.',
  email_send_failed: "Couldn't send the email. Try again.",
  email_not_configured: 'Email is not configured on the server yet.',
  already_active: 'This account is already active — sign in, or reset your password.',
  not_signed_in: 'Not signed in.',
  no_pending_change: 'That sign-in expired — start again.'
}

export const PASSWORD_MIN_LENGTH = 10
const PIN_RE = /^\d{4}$/
const CODE_RE = /^\d{6}$/

/** Errors after which asking again is pointless — the next try fails the same way. */
export const FATAL_ERRORS = new Set([
  'rate_limited',
  'account_disabled',
  'temp_password_expired',
  'network',
  'email_not_configured',
  'pin_lockout'
])

export function authErrorText(code, detail) {
  const text = AUTH_ERRORS[code] ?? AUTH_ERRORS.generic
  return detail && typeof detail === 'string' && !text.includes(detail)
    ? `${text} (${detail})`
    : text
}

/**
 * What the account needs next, from the redacted state. This is the whole
 * state machine: every flow loops on it until it answers 'ready'.
 */
export function nextStep(state) {
  switch (state?.status) {
    case 'ready':
      return 'ready'
    case 'locked':
      return 'unlock'
    case 'needsPin':
      return 'setPin'
    case 'mustChangePassword':
      return 'changePassword'
    case 'initializing':
      return 'initializing'
    default:
      return 'signIn'
  }
}

/**
 * Two shapes arrive here: the daemon's AuthState (`user: {email, name, role}`,
 * `orgName`) and the TUI store's flattened copy (`email`, `name`, `org`).
 */
function who(state) {
  const user = state?.user ?? state ?? {}
  return {
    name: user.name || null,
    email: user.email || null,
    org: state?.orgName ?? state?.org ?? null
  }
}

/** A session exists on this machine (it may be locked or half signed-in). */
export function isSignedIn(state) {
  return (
    Boolean(who(state).email) && state.status !== 'loggedOut' && state.status !== 'initializing'
  )
}

/**
 * Why a turn cannot start right now, naming the command that fixes it — or
 * null when the account is ready. `run` renders a verb for the surface:
 * `wfc login` in a shell, `/login` inside the session.
 */
export function authGate(state, run = (verb) => `wfc ${verb}`) {
  switch (nextStep(state)) {
    case 'ready':
      return null
    case 'unlock':
      return `locked — unlock with your PIN: ${run('unlock')}`
    case 'setPin':
      return `finish signing in (create your PIN): ${run('login')}`
    case 'changePassword':
      return `finish signing in (set a new password): ${run('login')}`
    case 'initializing':
      return 'the session is still starting — try again in a moment'
    default:
      return `not signed in: ${run('login')}`
  }
}

/** One line for status screens: who, where, and whether the door is open. */
export function describeAccount(state) {
  const w = who(state)
  const name = w.name || w.email || 'someone'
  const org = w.org ? ` · ${w.org}` : ''
  switch (state?.status) {
    case 'ready':
      return `signed in as ${name}${org}`
    case 'locked':
      return `${name}${org} — locked (PIN)`
    case 'needsPin':
      return `${name}${org} — PIN not set yet`
    case 'mustChangePassword':
      return 'temporary password must be replaced'
    case 'initializing':
      return 'starting…'
    default:
      return 'not signed in'
  }
}

export function validatePassword(password, confirm) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH)
    return `At least ${PASSWORD_MIN_LENGTH} characters.`
  if (confirm !== undefined && confirm !== password) return 'Passwords don’t match.'
  return null
}

export function validatePin(pin, confirm) {
  if (!PIN_RE.test(String(pin ?? ''))) return 'PIN must be 4 digits.'
  if (confirm !== undefined && confirm !== pin) return 'PINs didn’t match — start over.'
  return null
}

export function validateCode(code) {
  return CODE_RE.test(String(code ?? '').trim()) ? null : 'The code is 6 digits.'
}
