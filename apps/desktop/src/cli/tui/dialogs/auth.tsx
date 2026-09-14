/**
 * The account, inside the session: /login, /logout, /unlock, /lock,
 * /account, /reset-password, /activate, /change-password, /change-pin.
 *
 * Each flow is plain async code over the prompt dialog (ask / confirm), so
 * it reads top to bottom exactly like the window's sign-in screens and the
 * classic `wfc login`: email + password → temporary password? new one →
 * first sign-in here? a 4-digit PIN → ready. Every rule and every message
 * comes from src/cli/lib/auth.mjs, shared with the classic verbs.
 */
import { TextAttributes } from '@opentui/core'
import { For, type JSX } from 'solid-js'
import { useApp, type AppContext } from '../context'
import type { AuthInfo } from '../store'
import { theme } from '../theme'
import { ask, confirm, DialogHeader } from '../ui/Dialog'
import {
  FATAL_ERRORS,
  authErrorText,
  describeAccount,
  isSignedIn,
  nextStep,
  validateCode,
  validatePassword,
  validatePin
} from '../../lib/auth.mjs'

const MAX_TRIES = 5
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const failed = (app: AppContext, auth: AuthInfo) =>
  app.toast.error(authErrorText(auth.lastError, auth.lastErrorDetail))

/** New password twice, until the pair passes the window's policy; null on esc. */
async function askNewPassword(app: AppContext, title: string): Promise<string | null> {
  for (;;) {
    const first = await ask(app, {
      title,
      hidden: true,
      placeholder: 'New password',
      hint: 'at least 10 characters · enter continue · esc cancel'
    })
    if (first === null) return null
    const second = await ask(app, {
      title: 'Confirm the new password',
      hidden: true,
      placeholder: 'Same password again'
    })
    if (second === null) return null
    const problem = validatePassword(first, second)
    if (!problem) return first
    app.toast.warning(problem)
  }
}

async function askNewPin(app: AppContext, title: string): Promise<string | null> {
  for (;;) {
    const first = await ask(app, {
      title,
      hidden: true,
      placeholder: '4 digits',
      hint: 'a quick lock for this machine, local to it · enter continue · esc cancel'
    })
    if (first === null) return null
    const second = await ask(app, {
      title: 'Enter the PIN again to confirm',
      hidden: true,
      placeholder: '4 digits'
    })
    if (second === null) return null
    const problem = validatePin(first, second)
    if (!problem) return first
    app.toast.warning(problem)
  }
}

/**
 * Drive the account from wherever it is to `ready`. Shared by /login,
 * /reset-password and /activate — each gets the session to the first step
 * and hands over here.
 */
async function continueToReady(app: AppContext, auth: AuthInfo, email: string): Promise<void> {
  let tries = 0
  for (;;) {
    switch (nextStep(auth)) {
      case 'ready':
        app.toast.success(describeAccount(auth))
        return
      case 'initializing':
        await sleep(400)
        auth = await app.actions.authRefresh()
        continue
      case 'signIn': {
        if (!email) {
          const typed = await ask(app, {
            title: 'Sign in — work email',
            placeholder: 'you@company.com',
            hint: 'enter continue · esc cancel · /reset-password if you forgot it · /activate for an invite'
          })
          if (typed === null) return
          email = typed.trim()
          if (!email) continue
        }
        const password = await ask(app, {
          title: `Password for ${email}`,
          hidden: true,
          placeholder: 'Password',
          hint: 'enter sign in · esc cancel'
        })
        if (password === null) return
        auth = await app.actions.authLogin(email, password)
        if (auth.status === 'loggedOut') {
          failed(app, auth)
          if (FATAL_ERRORS.has(auth.lastError ?? '') || ++tries >= MAX_TRIES) return
          if (auth.lastError === 'email_not_found') email = ''
        }
        continue
      }
      case 'changePassword': {
        const next = await askNewPassword(
          app,
          'Set your password — the temporary one must be replaced'
        )
        if (next === null) return
        auth = await app.actions.authChangePassword(next)
        if (auth.lastError) {
          failed(app, auth)
          if (auth.status === 'loggedOut' || FATAL_ERRORS.has(auth.lastError)) return
        }
        continue
      }
      case 'setPin': {
        const pin = await askNewPin(app, 'Create your PIN')
        if (pin === null) return
        auth = await app.actions.authSetPin(pin)
        if (auth.lastError) {
          failed(app, auth)
          if (auth.status === 'loggedOut') return
        }
        continue
      }
      case 'unlock':
        return unlockFlow(app)
    }
  }
}

export async function loginFlow(app: AppContext, opts: { email?: string } = {}): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (auth.status === 'ready') {
    app.toast.info(`already ${describeAccount(auth)} — /logout to switch accounts`)
    return
  }
  if (auth.status === 'locked') return unlockFlow(app)
  return continueToReady(app, auth, opts.email ?? '')
}

export async function unlockFlow(app: AppContext): Promise<void> {
  let auth = await app.actions.authRefresh()
  if (auth.status !== 'locked') {
    app.toast.info(
      auth.status === 'ready' ? 'not locked' : `nothing to unlock — ${describeAccount(auth)}`
    )
    return
  }
  const who = auth.name || auth.email || ''
  for (;;) {
    const pin = await ask(app, {
      title: `Welcome back${who ? `, ${who}` : ''} — enter your PIN`,
      hidden: true,
      placeholder: '4 digits',
      hint: 'enter unlock · esc cancel · forgot it? /logout, then sign in with your password'
    })
    if (pin === null) return
    auth = await app.actions.authUnlock(pin)
    if (auth.status === 'ready') {
      app.toast.success('unlocked')
      return
    }
    if (auth.status !== 'locked') {
      failed(app, auth)
      return
    }
    const left = auth.attemptsLeft
    app.toast.error(
      `Wrong PIN${typeof left === 'number' ? ` — ${left} left before sign-out` : ''}.`
    )
  }
}

export async function lockFlow(app: AppContext): Promise<void> {
  const auth = await app.actions.authLock()
  if (auth.status === 'locked') app.toast.success('locked — /unlock to continue')
  else app.toast.warning(`nothing to lock — ${describeAccount(auth)}`)
}

export async function logoutFlow(app: AppContext): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (!isSignedIn(auth)) {
    app.toast.info('not signed in')
    return
  }
  const ok = await confirm(app, {
    title: `Sign out ${auth.email ?? ''}?`,
    message:
      "Your session is revoked and this machine's cache is cleared. Nothing is lost — it comes back on the next sign-in.",
    confirmLabel: 'Sign out',
    cancelLabel: 'Stay',
    danger: true
  })
  if (!ok) return
  const next = await app.actions.authSignOut()
  if (next.status === 'loggedOut') app.toast.success('signed out — /login to sign in again')
  else failed(app, next)
}

/** The emailed 6-digit code, then a new password, then straight into sign-in. */
export async function resetFlow(app: AppContext, opts: { email?: string } = {}): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (isSignedIn(auth)) {
    app.toast.info(`${describeAccount(auth)} — change it with /change-password`)
    return
  }
  let email = (opts.email ?? '').trim()
  if (!email) {
    const typed = await ask(app, {
      title: 'Reset your password — work email',
      placeholder: 'you@company.com',
      hint: "we'll email you a 6-digit code · enter continue · esc cancel"
    })
    if (typed === null) return
    email = typed.trim()
    if (!email) return
  }
  const sent = await app.actions.authResetRequest(email)
  if (!sent.ok) {
    app.toast.error(authErrorText(sent.code, sent.detail))
    return
  }
  app.toast.success(`a 6-digit code is on its way to ${email}`)
  for (;;) {
    const code = await ask(app, {
      title: `Enter the code we emailed to ${email}`,
      placeholder: '6-digit code',
      hint: 'enter continue · esc cancel · leave empty to send a new code'
    })
    if (code === null) return
    if (!code.trim()) {
      const again = await app.actions.authResetRequest(email)
      if (again.ok) app.toast.success('a new code is on its way')
      else app.toast.error(authErrorText(again.code, again.detail))
      continue
    }
    const problem = validateCode(code)
    if (problem) {
      app.toast.warning(problem)
      continue
    }
    const password = await askNewPassword(app, 'Choose a new password')
    if (password === null) return
    const done = await app.actions.authResetConfirm(email, code.trim(), password)
    if (!done.ok) {
      app.toast.error(authErrorText(done.code, done.detail))
      if (done.code === 'invalid_code' || done.code === 'code_expired') continue
      return
    }
    app.toast.success('password reset — signing you in')
    const next = await app.actions.authLogin(email, password)
    return continueToReady(app, next, email)
  }
}

/** An invited account's first password, bought with the code from the invitation email. */
export async function activateFlow(app: AppContext, opts: { email?: string } = {}): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (isSignedIn(auth)) {
    app.toast.info(`already ${describeAccount(auth)}`)
    return
  }
  let email = (opts.email ?? '').trim()
  if (!email) {
    const typed = await ask(app, {
      title: 'Activate your account — work email',
      placeholder: 'you@company.com',
      hint: 'enter continue · esc cancel'
    })
    if (typed === null) return
    email = typed.trim()
    if (!email) return
  }
  for (;;) {
    const code = await ask(app, {
      title: 'Enter the code from your invitation email',
      placeholder: '6-digit code',
      hint: 'enter continue · esc cancel · leave empty to be emailed a new code'
    })
    if (code === null) return
    if (!code.trim()) {
      const again = await app.actions.authActivateRequest(email)
      if (again.ok) app.toast.success(`a new code is on its way to ${email}`)
      else app.toast.error(authErrorText(again.code, again.detail))
      continue
    }
    const problem = validateCode(code)
    if (problem) {
      app.toast.warning(problem)
      continue
    }
    const password = await askNewPassword(app, 'Choose your password')
    if (password === null) return
    const done = await app.actions.authActivateConfirm(email, code.trim(), password)
    if (!done.ok) {
      app.toast.error(authErrorText(done.code, done.detail))
      if (done.code === 'invalid_code' || done.code === 'code_expired') continue
      return
    }
    app.toast.success('account activated — signing you in')
    const next = await app.actions.authLogin(email, password)
    return continueToReady(app, next, email)
  }
}

export async function changePasswordFlow(app: AppContext): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (auth.status !== 'ready') {
    app.toast.warning(`${describeAccount(auth)} — sign in first`)
    return
  }
  const current = await ask(app, {
    title: 'Current password',
    hidden: true,
    placeholder: 'Password'
  })
  if (current === null) return
  const next = await askNewPassword(app, 'New password')
  if (next === null) return
  const result = await app.actions.authChangePasswordSelf(current, next)
  if (result.lastError) failed(app, result)
  else app.toast.success('password changed')
}

export async function changePinFlow(app: AppContext): Promise<void> {
  const auth = await app.actions.authRefresh()
  if (auth.status !== 'ready') {
    app.toast.warning(`${describeAccount(auth)} — sign in first`)
    return
  }
  const current = await ask(app, {
    title: 'Current PIN',
    hidden: true,
    placeholder: '4 digits'
  })
  if (current === null) return
  const next = await askNewPin(app, 'New PIN')
  if (next === null) return
  const result = await app.actions.authChangePin(current, next)
  if (result.lastError) failed(app, result)
  else app.toast.success('PIN changed')
}

/* ───────────────────────── account ───────────────────────── */

export function AccountDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  void app.actions.authRefresh()
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'q') app.dialog.clear()
  })
  const p = theme
  const rows = () => {
    const a = state.auth
    const list: Array<[string, string]> = [['status', describeAccount(a)]]
    if (a.email) list.push(['email', a.email])
    if (a.name) list.push(['name', a.name])
    if (a.role) list.push(['role', a.role])
    if (a.org) list.push(['organization', a.org])
    return list
  }
  const hint = () =>
    ({
      loggedOut: '/login to sign in · /reset-password · /activate',
      locked: '/unlock',
      needsPin: '/login to finish signing in',
      mustChangePassword: '/login to finish signing in',
      initializing: 'starting…',
      ready: '/logout · /lock · /change-password · /change-pin'
    })[state.auth.status]
  return (
    <box flexDirection="column">
      <DialogHeader title="Account" />
      <box flexDirection="column" marginTop={1}>
        <For each={rows()}>
          {([k, v]) => (
            <box flexDirection="row" paddingLeft={3}>
              <text fg={p().muted}>{k.padEnd(14)}</text>
              <text
                fg={k === 'status' && state.auth.status !== 'ready' ? p().warn : p().text}
                attributes={k === 'status' ? TextAttributes.BOLD : undefined}
              >
                {v}
              </text>
            </box>
          )}
        </For>
      </box>
      <box paddingLeft={3} marginTop={1}>
        <text fg={p().dim}>{hint()}</text>
      </box>
    </box>
  )
}
