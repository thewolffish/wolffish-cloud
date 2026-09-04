import { SkeletonBar } from '@components/core/Skeleton'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import type {
  AdminAccess,
  AdminConversationRow,
  AdminAuditEntry,
  AdminRole,
  AdminRoster
} from '@preload/index'
import { Add01Icon, Alert02Icon, Refresh01Icon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '@components/core/CopyButton'
import { AuditList } from '@pages/settings/admin/AuditList'
import { ConversationViewer } from '@pages/settings/admin/ConversationViewer'
import { OrgPanel } from '@pages/settings/admin/OrgPanel'
import { PeopleGrid } from '@pages/settings/admin/PeopleGrid'
import { UserDetail } from '@pages/settings/admin/UserDetail'
import { formatUsd, formatTokens } from '@pages/settings/admin/adminFormat'

/**
 * The admin page — everything an owner or admin needs to run the deployment,
 * inside the app the company already uses.
 *
 * Three sections and two drills. People is the landing grid; opening a card
 * drills into one person, and opening one of their conversations drills once
 * more into the transcript. Organization holds the settings that apply to
 * everybody, and Log is the audit trail.
 *
 * Two decisions worth stating.
 *
 * THE ROSTER IS FETCHED ONCE and kept while the screen is open, because it
 * is one call for the whole company and the people grid is what every drill
 * returns to. A mutation deeper in (a plan change, a suspension) calls back
 * up here to refetch it, so the card the admin returns to already shows what
 * they just did rather than the number from before.
 *
 * NOTHING IS PERSISTED. Not to disk, not to the config, not between
 * sessions — this is other people's data (see main/admin-ipc.ts). Closing
 * Settings is the end of it.
 */

type Section = 'people' | 'org' | 'audit'
type View =
  | { kind: 'people' }
  | { kind: 'user'; userId: string }
  | { kind: 'conversation'; userId: string; conversationId: string; title: string }

const SECTIONS: Section[] = ['people', 'org', 'audit']

export function AdminPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()

  const [access, setAccess] = useState<AdminAccess | null>(null)
  const [section, setSection] = useState<Section>('people')
  const [view, setView] = useState<View>({ kind: 'people' })
  const [roster, setRoster] = useState<AdminRoster | null>(null)
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [audit, setAudit] = useState<AdminAuditEntry[] | null>(null)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    void window.api.admin.getAccess().then(setAccess)
  }, [])

  const loadRoster = useCallback(async (): Promise<void> => {
    try {
      setRoster(await window.api.admin.roster(30))
      setRosterError(null)
    } catch (err) {
      setRosterError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    if (access?.canRead !== true) return
    let cancelled = false
    void window.api.admin
      .roster(30)
      .then((res) => {
        if (!cancelled) {
          setRoster(res)
          setRosterError(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setRosterError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [access?.canRead])

  useEffect(() => {
    if (access?.canRead !== true || section !== 'audit' || audit !== null) return
    void window.api.admin
      .audit(150)
      .then((res) => setAudit(res.entries))
      .catch(() => setAudit([]))
  }, [access?.canRead, section, audit])

  // A role change while the window is open must not leave the admin screen
  // standing: the server would refuse every call, and the screen would look
  // broken rather than gone.
  useEffect(
    () => window.api.auth.onChanged(() => void window.api.admin.getAccess().then(setAccess)),
    []
  )

  if (access === null) return <AdminPanelSkeleton />
  if (!access.canRead) {
    return (
      <Shell>
        <p className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          {t('settings.admin.noAccess')}
        </p>
      </Shell>
    )
  }

  const openUser = (userId: string): void => setView({ kind: 'user', userId })
  const backToPeople = (): void => setView({ kind: 'people' })

  return (
    <Shell>
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.admin.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {access.canWrite ? t('settings.admin.subtitle') : t('settings.admin.subtitleReadOnly')}
          </p>
        </div>
        {view.kind === 'people' && section === 'people' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void loadRoster()}
              aria-label={t('common.refresh')}
              className="border-border text-muted hover:text-fg hover:bg-border/40 cursor-pointer rounded-lg border p-2"
            >
              <Refresh01Icon size={14} />
            </button>
            {access.canWrite ? (
              <button
                type="button"
                onClick={() => setInviting(true)}
                className="bg-primary text-primary-fg cursor-pointer rounded-lg px-4 py-2 text-sm font-medium shadow-sm"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Add01Icon size={14} />
                  {t('settings.admin.invite.open')}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* The section nav only makes sense at the top level; a drill replaces
          the whole body, and its own back link is the way out. */}
      {view.kind === 'people' ? (
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex w-fit items-center rounded-lg border p-0.5"
        >
          {SECTIONS.map((key) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={section === key}
              onClick={() => setSection(key)}
              className={cn(
                'rounded-md px-4 py-1.5 text-xs font-medium',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                section === key
                  ? 'bg-primary text-primary-fg shadow-sm'
                  : 'text-muted hover:text-fg cursor-pointer'
              )}
            >
              {t(`settings.admin.sections.${key}`)}
            </button>
          ))}
        </div>
      ) : null}

      {rosterError !== null && view.kind === 'people' && section === 'people' ? (
        <p className="border-border text-muted rounded-xl border border-dashed px-4 py-6 text-center text-xs">
          {rosterError}
        </p>
      ) : null}

      {view.kind === 'people' && section === 'people' ? (
        <>
          <OrgSummary roster={roster} locale={locale} />
          <PeopleGrid roster={roster} selfEmail={access.email} onOpen={openUser} />
        </>
      ) : null}

      {view.kind === 'people' && section === 'org' ? (
        <OrgPanel access={access} plans={roster?.plans ?? null} />
      ) : null}

      {view.kind === 'people' && section === 'audit' ? (
        <div className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <header className="flex flex-col gap-1">
            <h2 className="text-fg text-sm font-semibold">{t('settings.admin.audit.title')}</h2>
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.admin.audit.subtitle')}
            </p>
          </header>
          <AuditList entries={audit} emptyLabel={t('settings.admin.audit.empty')} />
        </div>
      ) : null}

      {view.kind === 'user' ? (
        <UserDetail
          // Keyed so switching person remounts with empty state and paints
          // its skeleton, instead of showing the last person's figures
          // under the new person's name for a frame.
          key={view.userId}
          userId={view.userId}
          access={access}
          onBack={backToPeople}
          onChanged={() => void loadRoster()}
          onOpenConversation={(row: AdminConversationRow) =>
            setView({
              kind: 'conversation',
              userId: view.userId,
              conversationId: row.id,
              title: row.title
            })
          }
        />
      ) : null}

      {view.kind === 'conversation' ? (
        <ConversationViewer
          key={view.conversationId}
          conversationId={view.conversationId}
          title={view.title}
          onBack={() => setView({ kind: 'user', userId: view.userId })}
        />
      ) : null}

      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onInvited={() => {
            void loadRoster()
            toast.show({ message: t('settings.admin.invite.done'), tone: 'success' })
          }}
        />
      ) : null}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-4xl flex-col gap-6">{children}</div>
    </div>
  )
}

/** The company in one line: headcount, spend, and what is being spent on. */
function OrgSummary({
  roster,
  locale
}: {
  roster: AdminRoster | null
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const totals = roster
    ? roster.people.reduce(
        (acc, p) => ({
          people: acc.people + 1,
          active: acc.active + (p.status === 'active' ? 1 : 0),
          tokens: acc.tokens + p.tokens_in + p.tokens_out,
          cost: acc.cost + p.cost_microusd,
          searches: acc.searches + p.searches
        }),
        { people: 0, active: 0, tokens: 0, cost: 0, searches: 0 }
      )
    : null

  const cells: Array<{ key: string; value: string }> = totals
    ? [
        { key: 'people', value: `${totals.active} / ${totals.people}` },
        { key: 'tokens', value: formatTokens(totals.tokens, locale) },
        { key: 'cost', value: formatUsd(totals.cost, locale) },
        { key: 'searches', value: formatTokens(totals.searches, locale) }
      ]
    : [{ key: 'people' }, { key: 'tokens' }, { key: 'cost' }, { key: 'searches' }].map((c) => ({
        ...c,
        value: ''
      }))

  return (
    <section className="bg-surface border-border grid grid-cols-4 gap-4 rounded-2xl border p-5">
      {cells.map((c) => (
        <div key={c.key} className="flex min-w-0 flex-col gap-1">
          <span className="text-muted truncate text-[11px]">
            {t(`settings.admin.summary.${c.key}`)}
          </span>
          <span className="text-fg text-lg font-semibold tabular-nums" dir="ltr">
            {totals ? c.value : <SkeletonBar className="w-16" />}
          </span>
        </div>
      ))}
    </section>
  )
}

const ROLES: AdminRole[] = ['employee', 'support', 'admin']

/**
 * Inviting someone. The temp password comes back exactly once — the server
 * never stores it in the clear — so the dialog stays open on success with
 * the password and a copy button, rather than closing and losing it.
 */
function InviteDialog({
  onClose,
  onInvited
}: {
  onClose: () => void
  onInvited: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AdminRole>('employee')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ email: string; temp: string } | null>(null)

  const submit = async (): Promise<void> => {
    if (busy || !name.trim() || !email.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.admin.invite({ email: email.trim(), name: name.trim(), role })
      setResult({ email: res.email, temp: res.temp_password })
      onInvited()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="bg-surface border-border flex w-full max-w-md flex-col gap-4 rounded-2xl border p-6 shadow-xl">
        <h2 className="text-fg text-sm font-semibold">{t('settings.admin.invite.title')}</h2>
        {result ? (
          <>
            <div className="border-amber-500/40 bg-amber-500/10 flex items-start gap-3 rounded-xl border px-4 py-3">
              <Alert02Icon
                size={16}
                className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-fg text-xs font-medium">
                  {t('settings.admin.invite.created', { email: result.email })}
                </span>
                <code className="text-fg truncate font-mono text-sm" dir="ltr">
                  {result.temp}
                </code>
                <span className="text-muted text-[11px]">
                  {t('settings.admin.invite.tempHint')}
                </span>
              </div>
              <CopyButton text={result.temp} variant="inline" ariaLabelKey="common.copy" />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="bg-primary text-primary-fg cursor-pointer rounded-lg px-4 py-2 text-sm font-medium"
            >
              {t('common.done')}
            </button>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('settings.admin.invite.name')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-bg text-fg border-border h-9 rounded-lg border px-3 text-sm focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('settings.admin.invite.email')}</span>
              <input
                value={email}
                type="email"
                dir="ltr"
                onChange={(e) => setEmail(e.target.value)}
                className="bg-bg text-fg border-border h-9 rounded-lg border px-3 text-sm focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              />
            </label>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted text-xs">{t('settings.admin.invite.role')}</span>
              <div
                role="tablist"
                className="border-border bg-bg/40 inline-flex items-center rounded-lg border p-0.5"
              >
                {ROLES.map((r) => (
                  <button
                    key={r}
                    role="tab"
                    type="button"
                    aria-selected={role === r}
                    onClick={() => setRole(r)}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium',
                      role === r
                        ? 'bg-primary text-primary-fg shadow-sm'
                        : 'text-muted hover:text-fg cursor-pointer'
                    )}
                  >
                    {t(`settings.admin.roles.${r}`)}
                  </button>
                ))}
              </div>
            </div>
            {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="border-border text-fg hover:bg-border/40 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !name.trim() || !email.trim()}
                className="bg-primary text-primary-fg cursor-pointer rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('settings.admin.invite.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The whole page while the access check is in flight. Same header block,
 * same section nav, same summary strip and the same card grid the People
 * section lands on — so the screen is already its final shape before the
 * first byte arrives.
 */
function AdminPanelSkeleton(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Shell>
      <div role="status" aria-label={t('common.loading')} className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            <SkeletonBar className="w-40" />
          </h1>
          <p className="text-sm">
            <SkeletonBar className="w-96" />
          </p>
        </header>
        <SkeletonBar className="h-8 w-56 rounded-lg" />
        <section className="bg-surface border-border grid grid-cols-4 gap-4 rounded-2xl border p-5">
          {['people', 'tokens', 'cost', 'searches'].map((k) => (
            <div key={k} className="flex min-w-0 flex-col gap-1">
              <span className="text-muted truncate text-[11px]">
                {t(`settings.admin.summary.${k}`)}
              </span>
              <span className="text-lg font-semibold">
                <SkeletonBar className="w-16" />
              </span>
            </div>
          ))}
        </section>
      </div>
    </Shell>
  )
}
