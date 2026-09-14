/**
 * The account state machine and its copy — shared by `wfc login` and
 * /login, so one test covers both surfaces.
 */
import { describe, expect, test } from 'bun:test'
import {
  authErrorText,
  authGate,
  describeAccount,
  isSignedIn,
  nextStep,
  validateCode,
  validatePassword,
  validatePin
} from '../lib/auth.mjs'

const user = { email: 'ann@acme.com', name: 'Ann', role: 'member' }
const at = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  user,
  orgName: 'Acme',
  pinAttemptsLeft: 5,
  lastError: null,
  lastErrorDetail: null,
  ...extra
})

describe('the state machine', () => {
  test("each status maps to exactly the window's next screen", () => {
    expect(nextStep(at('loggedOut', { user: null }))).toBe('signIn')
    expect(nextStep(at('mustChangePassword'))).toBe('changePassword')
    expect(nextStep(at('needsPin'))).toBe('setPin')
    expect(nextStep(at('locked'))).toBe('unlock')
    expect(nextStep(at('ready'))).toBe('ready')
    expect(nextStep(at('initializing'))).toBe('initializing')
    expect(nextStep(null)).toBe('signIn')
  })

  test('the gate opens only on ready and names the fix per surface', () => {
    expect(authGate(at('ready'))).toBeNull()
    expect(authGate(at('loggedOut', { user: null }))).toContain('wfc login')
    expect(authGate(at('locked'))).toContain('wfc unlock')
    expect(authGate(at('needsPin'))).toContain('wfc login')
    expect(authGate(at('mustChangePassword'), (v: string) => `/${v}`)).toContain('/login')
    expect(authGate(at('initializing'))).toMatch(/starting/)
  })

  test('signed in means a session exists, locked or not', () => {
    expect(isSignedIn(at('ready'))).toBe(true)
    expect(isSignedIn(at('locked'))).toBe(true)
    expect(isSignedIn(at('needsPin'))).toBe(true)
    expect(isSignedIn(at('loggedOut', { user: null }))).toBe(false)
    expect(isSignedIn(at('initializing'))).toBe(false)
  })

  test('the flattened TUI shape (no user object) reads the same as the daemon shape', () => {
    const flat = {
      status: 'locked',
      email: 'ann@acme.com',
      name: 'Ann',
      role: 'member',
      org: 'Acme'
    }
    expect(describeAccount(flat)).toBe('Ann · Acme — locked (PIN)')
    expect(isSignedIn(flat)).toBe(true)
    expect(isSignedIn({ status: 'loggedOut', email: null, name: null, org: null })).toBe(false)
  })

  test('the account line says who and whether the door is open', () => {
    expect(describeAccount(at('ready'))).toBe('signed in as Ann · Acme')
    expect(describeAccount(at('locked'))).toContain('locked')
    expect(describeAccount(at('loggedOut', { user: null }))).toBe('not signed in')
  })
})

describe("the window's rules, restated", () => {
  test('passwords: 10+ characters and a matching confirmation', () => {
    expect(validatePassword('short', 'short')).toMatch(/10 characters/)
    expect(validatePassword('longenough1', 'longenough2')).toMatch(/match/)
    expect(validatePassword('longenough1', 'longenough1')).toBeNull()
  })
  test('PINs: exactly 4 digits, entered twice', () => {
    expect(validatePin('12', '12')).toMatch(/4 digits/)
    expect(validatePin('abcd', 'abcd')).toMatch(/4 digits/)
    expect(validatePin('1234', '1243')).toMatch(/match/)
    expect(validatePin('1234', '1234')).toBeNull()
  })
  test('emailed codes are 6 digits', () => {
    expect(validateCode('12345')).not.toBeNull()
    expect(validateCode(' 123456 ')).toBeNull()
  })
  test("error codes render the window's copy, unknown ones the generic line", () => {
    expect(authErrorText('invalid_credentials')).toBe('Wrong email or password.')
    expect(authErrorText('pin_lockout')).toMatch(/signed out/)
    expect(authErrorText('what_is_this')).toBe('Something went wrong. Try again.')
    expect(authErrorText('weak_password', 'min 10')).toContain('(min 10)')
  })
})
