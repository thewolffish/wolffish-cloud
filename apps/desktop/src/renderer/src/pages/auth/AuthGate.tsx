/**
 * The front door. Renders whichever auth step the main-process session
 * demands — sign in, forced first-login password change, PIN creation, or
 * the PIN lock — and nothing else of the app until the session is ready.
 * Tokens never reach this process; every action is an IPC call and the
 * screen is driven entirely by the redacted AuthState.
 *
 * Deliberately minimal chrome: no theme or language controls here — the
 * app defaults (English, system theme) carry until the user reaches
 * Settings.
 */
import { Avatar } from '@components/common/profile/Avatar'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { PasswordInput } from '@components/core/PasswordInput'
import { cn } from '@lib/utils/cn'
import type { AuthState } from '@preload/index'
import iconTransparent from '@resources/images/icon_transparent.png'
import { Alert02Icon, Cancel01Icon, Logout03Icon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * POC master repo only: every seeded Wolffish Inc account shares this
 * password, so the sign-in form prefills it and a demo needs just an email.
 * Client forks remove the prefill (and rotate the seed password).
 */
const DEMO_PASSWORD = 'wolffish123'

/** Wire error codes with a dedicated message; anything else falls back. */
const KNOWN_ERRORS = new Set([
  'invalid_credentials',
  'email_not_found',
  'wrong_password',
  'invalid_code',
  'code_expired',
  'email_send_failed',
  'email_not_configured',
  'rate_limited',
  'account_disabled',
  'temp_password_expired',
  'weak_password',
  'network',
  'pin_wrong',
  'pin_format',
  'pin_lockout',
  'session_expired',
  'session_revoked'
])

function errorText(t: (k: string) => string, code: string | null): string | null {
  if (!code) return null
  return KNOWN_ERRORS.has(code) ? t(`auth.errors.${code}`) : t('auth.errors.generic')
}

function Shell({
  title,
  subtitle,
  avatar,
  children
}: {
  title: string
  subtitle?: string
  /** Replaces the app logo in the header (e.g. the user's avatar on the lock screen). */
  avatar?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <main className="bg-bg flex min-h-full w-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-4 text-center">
          {avatar ?? (
            <img
              src={iconTransparent}
              alt=""
              aria-hidden
              className="h-20 w-20 object-contain"
              draggable={false}
            />
          )}
          <div className="flex flex-col gap-2">
            <h1 className="text-fg text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-muted text-sm leading-relaxed">{subtitle}</p>}
          </div>
        </header>
        <section className="bg-surface border-border flex w-full flex-col gap-4 rounded-2xl border p-6 shadow-sm dark:shadow-none">
          {children}
        </section>
      </div>
    </main>
  )
}

function ErrorLine({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return (
    <p role="alert" className="text-sm leading-relaxed text-red-500 dark:text-red-400" dir="auto">
      {text}
    </p>
  )
}

/** Red validation border, layered onto any field whose error is showing. */
const fieldErrCls = 'border-red-500/70 focus:border-red-500/80 focus-visible:ring-red-500/30'

const fieldClass = cn(
  'border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border px-3 py-2.5 text-sm',
  'focus:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-accent'
)

/** Failure card: icon chip, message, wire detail, dismiss. */
function ErrorCard({
  text,
  detail,
  onDismiss
}: {
  text: string | null
  detail?: string | null
  onDismiss: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!text) return null
  return (
    <div
      role="alert"
      className="bg-surface border-border flex w-full items-center gap-3 rounded-xl border px-4 py-3 shadow-sm"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
        <Alert02Icon size={18} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" dir="auto">
        <span className="text-fg text-sm font-medium">{text}</span>
        {detail && <p className="text-muted truncate text-xs">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.close')}
        className="text-muted hover:text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg p-1 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Cancel01Icon size={14} />
      </button>
    </div>
  )
}

/** One wide numeric field for the 4-digit PIN, rendered as spaced digits. */
function PinField({
  value,
  onChange,
  onSubmit,
  autoFocus,
  label,
  invalid
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  autoFocus?: boolean
  label: string
  invalid?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return (
    <input
      ref={ref}
      type="password"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder="••••"
      maxLength={4}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.length === 4) onSubmit()
      }}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldClass,
        'text-center text-2xl tracking-[0.6em] font-semibold tabular-nums',
        'py-3',
        invalid && fieldErrCls
      )}
      dir="ltr"
    />
  )
}

export function AuthGate({ auth }: { auth: AuthState }): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  // Local error shown for the CURRENT attempt; server state errors surface
  // through auth.lastError after each round trip.
  const [localError, setLocalError] = useState<string | null>(null)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [localErrorDetail, setLocalErrorDetail] = useState<string | null>(null)
  const [resetStage, setResetStage] = useState<null | 'request' | 'confirm'>(null)
  const [resetCode, setResetCode] = useState('')
  const toast = useToast()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState(DEMO_PASSWORD)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinStage, setPinStage] = useState<'enter' | 'confirm'>('enter')
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null)

  // Lock screen shows the signed-in user's photo; tokens still exist while
  // locked, so the fetch works pre-unlock (and is served instantly from the
  // main-process cache once warm). Initials cover the null case.
  useEffect(() => {
    if (auth.status !== 'locked') return
    let stale = false
    void window.api.auth.getAvatar().then((src) => {
      if (!stale) setAvatarSrc(src)
    })
    return () => {
      stale = true
    }
  }, [auth.status])

  // Background revalidation results (photo changed or removed elsewhere)
  // swap the image in place.
  useEffect(() => window.api.auth.onAvatarChanged(setAvatarSrc), [])

  // Leaving a step clears its transient inputs so nothing lingers between
  // accounts or retries (render-phase adjust, per the react docs pattern).
  const [prevStatus, setPrevStatus] = useState(auth.status)
  if (auth.status !== prevStatus) {
    setPrevStatus(auth.status)
    setLocalError(null)
    setLocalErrorDetail(null)
    setErrorDismissed(false)
    setResetStage(null)
    setResetCode('')
    setBusy(false)
    setPin('')
    setPinConfirm('')
    setPinStage('enter')
    setConfirmSignOut(false)
    if (auth.status === 'loggedOut') {
      setPassword(DEMO_PASSWORD)
      setNewPassword('')
      setConfirmPassword('')
      setAvatarSrc(null)
    }
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setLocalError(null)
    setLocalErrorDetail(null)
    setErrorDismissed(false)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  if (auth.status === 'initializing') {
    return (
      <main className="bg-bg flex min-h-full w-full items-center justify-center">
        <img
          src={iconTransparent}
          alt=""
          aria-hidden
          className="h-16 w-16 animate-pulse object-contain"
          draggable={false}
        />
      </main>
    )
  }

  if (auth.status === 'mustChangePassword') {
    const mismatched = confirmPassword.length > 0 && newPassword !== confirmPassword
    const canSubmit = newPassword.length >= 10 && newPassword === confirmPassword && !busy
    return (
      <Shell title={t('auth.change.title')} subtitle={t('auth.change.subtitle')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) void run(() => window.api.auth.changePassword(newPassword))
          }}
        >
          <PasswordInput
            value={newPassword}
            onChange={setNewPassword}
            placeholder={t('auth.change.newPassword')}
            autoFocus
            autoComplete="new-password"
            invalid={newPassword.length > 0 && newPassword.length < 10}
          />
          <PasswordInput
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder={t('auth.change.confirmPassword')}
            autoComplete="new-password"
            invalid={mismatched}
          />
          <p className="text-muted text-xs leading-relaxed">{t('auth.change.policy')}</p>
          <ErrorLine
            text={
              mismatched ? t('auth.change.mismatch') : (localError ?? errorText(t, auth.lastError))
            }
          />
          <Button size="lg" type="submit" className="w-full" disabled={!canSubmit}>
            {t('auth.change.submit')}
          </Button>
        </form>
        <button
          type="button"
          className="text-muted hover:text-fg cursor-pointer text-xs underline-offset-2 hover:underline"
          onClick={() => void run(() => window.api.auth.signOut())}
        >
          {t('auth.backToSignIn')}
        </button>
      </Shell>
    )
  }

  if (auth.status === 'needsPin') {
    const onFirst = (): void => {
      if (pin.length === 4) {
        setPinStage('confirm')
        setLocalError(null)
      }
    }
    const onConfirm = async (): Promise<void> => {
      if (pinConfirm.length !== 4) return
      if (pinConfirm !== pin) {
        setPin('')
        setPinConfirm('')
        setPinStage('enter')
        setLocalError(t('auth.pin.mismatch'))
        setErrorDismissed(false)
        return
      }
      await run(() => window.api.auth.setPin(pin))
    }
    return (
      <Shell
        title={t('auth.pin.createTitle')}
        subtitle={t('auth.pin.createSubtitle', { name: auth.user?.name ?? '' })}
      >
        {pinStage === 'enter' ? (
          <>
            <PinField
              value={pin}
              onChange={setPin}
              onSubmit={onFirst}
              autoFocus
              label={t('auth.pin.createTitle')}
            />
            {!errorDismissed && (
              <ErrorCard
                text={localError ?? errorText(t, auth.lastError)}
                detail={localError ? null : auth.lastErrorDetail}
                onDismiss={() => setErrorDismissed(true)}
              />
            )}
            <Button size="lg" className="w-full" disabled={pin.length !== 4} onClick={onFirst}>
              {t('auth.continue')}
            </Button>
          </>
        ) : (
          <>
            <p className="text-muted text-center text-sm">{t('auth.pin.confirmPrompt')}</p>
            <PinField
              value={pinConfirm}
              onChange={setPinConfirm}
              onSubmit={() => void onConfirm()}
              autoFocus
              label={t('auth.pin.confirmPrompt')}
              invalid={Boolean(localError)}
            />
            {!errorDismissed && (
              <ErrorCard text={localError} onDismiss={() => setErrorDismissed(true)} />
            )}
            <Button
              size="lg"
              className="w-full"
              disabled={pinConfirm.length !== 4 || busy}
              onClick={() => void onConfirm()}
            >
              {t('auth.pin.setSubmit')}
            </Button>
          </>
        )}
        <p className="text-muted text-center text-xs leading-relaxed">{t('auth.pin.note')}</p>
      </Shell>
    )
  }

  if (auth.status === 'locked') {
    return (
      <Shell
        title={t('auth.lock.title', {
          name: auth.user?.name ? `, ${auth.user.name.split(' ')[0]}` : ''
        })}
        avatar={<Avatar name={auth.user?.name ?? ''} size={80} src={avatarSrc} />}
      >
        <PinField
          value={pin}
          onChange={(next) => {
            setPin(next)
            if (next.length === 4) {
              void run(async () => {
                await window.api.auth.unlock(next)
                setPin('')
              })
            }
          }}
          onSubmit={() => undefined}
          autoFocus
          label={t('auth.lock.title', { name: '' })}
          invalid={!errorDismissed && auth.lastError === 'pin_wrong'}
        />
        {!errorDismissed && (
          <ErrorCard
            text={
              auth.lastError === 'pin_wrong' && auth.pinAttemptsLeft !== null
                ? t('auth.lock.wrongWithAttempts', { count: auth.pinAttemptsLeft })
                : errorText(t, auth.lastError)
            }
            detail={auth.lastErrorDetail}
            onDismiss={() => setErrorDismissed(true)}
          />
        )}
        <button
          type="button"
          className={cn(
            'flex cursor-pointer items-center justify-center gap-1.5 text-xs font-medium',
            'text-red-600 underline-offset-2 hover:text-red-700 hover:underline',
            'dark:text-red-400 dark:hover:text-red-300'
          )}
          onClick={() => setConfirmSignOut(true)}
        >
          <Logout03Icon size={14} />
          {t('auth.lock.signOutInstead')}
        </button>
        <Modal
          open={confirmSignOut}
          onClose={() => setConfirmSignOut(false)}
          dismissable={!busy}
          title={t('profile.signOutTitle')}
          footer={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmSignOut(false)}
                disabled={busy}
                className="flex-1"
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => window.api.auth.signOut())}
                className="flex-1 border border-transparent bg-red-600 text-white shadow-none hover:bg-red-700"
              >
                {t('profile.signOut')}
              </Button>
            </div>
          }
        >
          <p className="text-muted">{t('profile.signOutBody')}</p>
        </Modal>
      </Shell>
    )
  }

  // loggedOut (and the defensive default)
  const failToCard = (code?: string, detail?: string | null): void => {
    setLocalError(errorText(t, code ?? 'generic') ?? t('auth.errors.generic'))
    setLocalErrorDetail(detail ?? null)
  }

  if (auth.status === 'loggedOut' && resetStage === 'request') {
    const canSend = email.trim().length > 3 && !busy
    const send = (): void => {
      void run(async () => {
        const r = await window.api.auth.resetRequest(email)
        if (!r.ok) return failToCard(r.code, r.detail)
        setResetCode('')
        setNewPassword('')
        setConfirmPassword('')
        setResetStage('confirm')
      })
    }
    return (
      <Shell title={t('auth.reset.title')} subtitle={t('auth.reset.requestSubtitle')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSend) send()
          }}
        >
          <input
            type="email"
            className={fieldClass}
            placeholder={t('auth.signIn.email')}
            value={email}
            autoFocus
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            dir="ltr"
          />
          {!errorDismissed && (
            <ErrorCard
              text={localError}
              detail={localErrorDetail}
              onDismiss={() => setErrorDismissed(true)}
            />
          )}
          <Button size="lg" type="submit" className="w-full" disabled={!canSend}>
            {t('auth.reset.sendCode')}
          </Button>
        </form>
        <button
          type="button"
          className="text-muted hover:text-fg cursor-pointer text-xs underline-offset-2 hover:underline"
          onClick={() => {
            setResetStage(null)
            setLocalError(null)
            setLocalErrorDetail(null)
          }}
        >
          {t('auth.backToSignIn')}
        </button>
      </Shell>
    )
  }

  if (auth.status === 'loggedOut' && resetStage === 'confirm') {
    const mismatched = confirmPassword.length > 0 && newPassword !== confirmPassword
    const canReset =
      resetCode.length === 6 && newPassword.length >= 10 && newPassword === confirmPassword && !busy
    const submit = (): void => {
      void run(async () => {
        const r = await window.api.auth.resetConfirm(email, resetCode, newPassword)
        if (!r.ok) return failToCard(r.code, r.detail)
        toast.show({ tone: 'success', message: t('auth.reset.done') })
        setResetStage(null)
        setResetCode('')
        setNewPassword('')
        setConfirmPassword('')
        setPassword('')
      })
    }
    return (
      <Shell
        title={t('auth.reset.title')}
        subtitle={t('auth.reset.confirmSubtitle', { email: email.trim() })}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canReset) submit()
          }}
        >
          <input
            inputMode="numeric"
            maxLength={6}
            className={cn(fieldClass, 'text-center text-lg tracking-[0.5em]')}
            placeholder={t('auth.reset.codePlaceholder')}
            value={resetCode}
            autoFocus
            onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            dir="ltr"
          />
          <PasswordInput
            value={newPassword}
            onChange={setNewPassword}
            placeholder={t('auth.change.newPassword')}
            autoComplete="new-password"
            invalid={newPassword.length > 0 && newPassword.length < 10}
          />
          <PasswordInput
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder={t('auth.change.confirmPassword')}
            autoComplete="new-password"
            invalid={mismatched}
          />
          <p className="text-muted text-xs leading-relaxed">{t('auth.change.policy')}</p>
          {mismatched && <ErrorLine text={t('auth.change.mismatch')} />}
          {!errorDismissed && (
            <ErrorCard
              text={localError}
              detail={localErrorDetail}
              onDismiss={() => setErrorDismissed(true)}
            />
          )}
          <Button size="lg" type="submit" className="w-full" disabled={!canReset}>
            {t('auth.reset.submit')}
          </Button>
        </form>
        <button
          type="button"
          className="text-muted hover:text-fg cursor-pointer text-xs underline-offset-2 hover:underline"
          onClick={() => {
            setResetStage('request')
            setLocalError(null)
            setLocalErrorDetail(null)
          }}
        >
          {t('auth.reset.resend')}
        </button>
      </Shell>
    )
  }

  const canSignIn = email.trim().length > 3 && password.length > 0 && !busy
  const liveSignInError = !errorDismissed && !localError ? auth.lastError : null
  const doSignIn = (): void => {
    void run(async () => {
      const next = await window.api.auth.login(email, password)
      // A session came back (fresh device → PIN setup; known device → chat).
      if (next.status === 'needsPin' || next.status === 'ready') {
        toast.show({
          tone: 'success',
          message: t('auth.signedInToast', { name: next.user?.name ?? '' })
        })
      }
    })
  }
  return (
    <Shell title={t('auth.signIn.title')} subtitle={t('auth.signIn.subtitle')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSignIn) doSignIn()
        }}
      >
        <input
          type="email"
          className={cn(fieldClass, liveSignInError === 'email_not_found' && fieldErrCls)}
          aria-invalid={liveSignInError === 'email_not_found' || undefined}
          placeholder={t('auth.signIn.email')}
          value={email}
          autoFocus
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
        />
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder={t('auth.signIn.password')}
          autoComplete="current-password"
          invalid={liveSignInError === 'wrong_password'}
        />
        {!errorDismissed && (
          <ErrorCard
            text={localError ?? errorText(t, auth.lastError)}
            detail={auth.lastErrorDetail}
            onDismiss={() => setErrorDismissed(true)}
          />
        )}
        <Button size="lg" type="submit" className="w-full" disabled={!canSignIn}>
          {t('auth.signIn.submit')}
        </Button>
        <button
          type="button"
          className="text-muted hover:text-fg cursor-pointer text-xs underline-offset-2 hover:underline"
          onClick={() => {
            setResetStage('request')
            setLocalError(null)
            setLocalErrorDetail(null)
            setErrorDismissed(false)
          }}
        >
          {t('auth.reset.link')}
        </button>
      </form>
    </Shell>
  )
}
