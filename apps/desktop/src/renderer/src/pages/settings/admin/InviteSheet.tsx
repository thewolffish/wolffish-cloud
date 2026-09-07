import { Button } from '@components/core/Button'
import { CopyButton } from '@components/core/CopyButton'
import { EditorSheet } from '@components/core/EditorSheet'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import type { AdminInviteResult, AdminRole } from '@preload/index'
import { Alert02Icon, CheckmarkCircle02Icon, Mail01Icon } from 'hugeicons-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Adding a person — a trailing-edge sheet in the app's own editor language
 * (EditorSheet: same width and motion as the profile and conversations
 * sheets), because a centred dialog had nowhere to put the one thing this
 * form owes the admin: an explanation of what pressing the button actually
 * sends, and to whom.
 *
 * Nothing secret comes back any more. The API mails a 6-digit code to the
 * address and hands back only whether that send succeeded, so the closing
 * state is a receipt — "sent to this address, good until this date" — not a
 * credential to copy out and pass along. The one exception is an API with
 * no mail configured at all (a local worker), which returns the code so a
 * dev deployment can still onboard; that path is loud about being unusual.
 *
 * Role leads the form because it is the decision, not the detail: it
 * changes what the person can do the moment they sign in, while name and
 * email are transcription.
 */

const ROLES: AdminRole[] = ['employee', 'support', 'admin']

const fieldClass = cn(
  'border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border px-3 py-2.5 text-sm',
  'focus:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-accent'
)

export function InviteSheet({
  open,
  onClose,
  onInvited
}: {
  open: boolean
  onClose: () => void
  /** Fires once the person exists — the roster behind the sheet refetches. */
  onInvited: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // The send button lives in the sheet's pinned footer, outside the <form>.
  // Owning it through `form=` rather than an onClick keeps it the form's
  // default submit button, which is what makes Enter in either field send
  // the invitation.
  const formId = useId()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AdminRole>('employee')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AdminInviteResult | null>(null)

  const ready = name.trim().length > 0 && email.trim().length > 3
  // Anything typed or picked, before the invitation exists. While this is
  // true the sheet refuses every quiet dismissal — backdrop, Escape and the
  // header's X are all gone — so the only way out is Cancel, which says what
  // it does. Once the person has been added there is nothing left to lose,
  // and the receipt dismisses like anything else.
  const dirty =
    result === null && (name.trim() !== '' || email.trim() !== '' || role !== 'employee')

  const close = (): void => {
    setName('')
    setEmail('')
    setRole('employee')
    setError(null)
    setResult(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      setResult(await window.api.admin.invite({ email: email.trim(), name: name.trim(), role }))
      onInvited()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <EditorSheet
      open={open}
      onClose={close}
      dismissable={!dirty}
      closable={!dirty}
      title={t('settings.admin.invite.title')}
      footer={
        result ? (
          <Button size="lg" className="w-full" onClick={close}>
            {t('common.done')}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="lg" className="flex-1" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              size="lg"
              className="flex-1"
              disabled={!ready || busy}
            >
              {t('settings.admin.invite.submit')}
            </Button>
          </div>
        )
      }
    >
      {result ? (
        <InviteReceipt result={result} />
      ) : (
        <form
          id={formId}
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {/* Role first: the only field that changes what they can do. */}
          <div className="flex flex-col gap-2">
            <span className="text-fg text-sm font-medium">{t('settings.admin.invite.role')}</span>
            <div
              role="tablist"
              className="border-border bg-bg/40 grid w-full grid-cols-3 items-center rounded-lg border p-0.5"
            >
              {ROLES.map((r) => (
                <button
                  key={r}
                  role="tab"
                  type="button"
                  aria-selected={role === r}
                  onClick={() => setRole(r)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    role === r
                      ? 'bg-primary text-primary-fg shadow-sm'
                      : 'text-muted hover:text-fg cursor-pointer'
                  )}
                >
                  {t(`settings.admin.roles.${r}`)}
                </button>
              ))}
            </div>
            <p className="text-muted text-xs leading-relaxed">
              {t(`settings.admin.invite.roleHint.${role}`)}
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-fg text-sm font-medium">{t('settings.admin.invite.name')}</span>
            <input
              value={name}
              autoFocus
              placeholder={t('settings.admin.invite.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-fg text-sm font-medium">{t('settings.admin.invite.email')}</span>
            <input
              value={email}
              type="email"
              dir="ltr"
              placeholder={t('settings.admin.invite.emailPlaceholder')}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldClass}
            />
            <span className="text-muted text-xs leading-relaxed">
              {t('settings.admin.invite.emailHint')}
            </span>
          </label>

          {error ? (
            <p className="text-xs text-red-600 dark:text-red-400" dir="auto">
              {error}
            </p>
          ) : null}

          <HowItWorksCard />
        </form>
      )}
    </EditorSheet>
  )
}

/** The three steps, once, where the admin is deciding to send them. */
function HowItWorksCard(): React.JSX.Element {
  const { t } = useTranslation()
  const steps = ['send', 'enter', 'secure'] as const
  return (
    <section className="border-border bg-bg/40 flex flex-col gap-3 rounded-xl border p-4">
      <header className="flex items-center gap-2">
        <Mail01Icon size={14} className="text-muted shrink-0" />
        <h3 className="text-fg text-xs font-semibold">{t('settings.admin.invite.how.title')}</h3>
      </header>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={step} className="flex items-start gap-2.5">
            <span className="border-border text-muted mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums">
              {i + 1}
            </span>
            <span className="text-muted text-xs leading-relaxed">
              {t(`settings.admin.invite.how.${step}`)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-muted/80 text-[11px] leading-relaxed">
        {t('settings.admin.invite.how.footer')}
      </p>
    </section>
  )
}

/** What actually happened, once the person exists. */
function InviteReceipt({ result }: { result: AdminInviteResult }): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const expires = new Date(result.activation_expires_at)
  const expiresLabel = Number.isNaN(expires.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(expires)

  return (
    <div className="flex flex-col gap-4">
      {result.email_sent ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <CheckmarkCircle02Icon
            size={16}
            className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-fg text-xs font-medium" dir="auto">
              {t('settings.admin.invite.sent', { email: result.email })}
            </span>
            <span className="text-muted text-[11px] leading-relaxed">
              {t('settings.admin.invite.sentHint', { date: expiresLabel })}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <Alert02Icon size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-fg text-xs font-medium" dir="auto">
              {t('settings.admin.invite.notSent', { email: result.email })}
            </span>
            <span className="text-muted text-[11px] leading-relaxed">
              {/* A server with no mail at all hands the code back below, so
                  the way forward is that code — not "try again later". */}
              {result.email_error === 'email_not_configured'
                ? t('settings.admin.invite.notSentNoMail')
                : (result.email_error_detail ?? t('settings.admin.invite.notSentHint'))}
            </span>
          </div>
        </div>
      )}

      {/* Only ever present when the API has no mail configured at all. */}
      {result.activation_code ? (
        <div className="border-border bg-bg/40 flex items-center gap-3 rounded-xl border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-muted text-[11px]">{t('settings.admin.invite.codeLabel')}</span>
            <code className="text-fg font-mono text-lg tracking-[0.3em]" dir="ltr">
              {result.activation_code}
            </code>
            <span className="text-muted text-[11px] leading-relaxed">
              {t('settings.admin.invite.codeHint')}
            </span>
          </div>
          <CopyButton text={result.activation_code} variant="inline" ariaLabelKey="common.copy" />
        </div>
      ) : null}

      <HowItWorksCard />
    </div>
  )
}
