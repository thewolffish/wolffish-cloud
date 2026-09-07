import { Avatar } from '@components/common/profile/Avatar'
import { CopyButton } from '@components/core/CopyButton'
import { SkeletonBar } from '@components/core/Skeleton'
import { useToast } from '@components/core/toast/useToast'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { formatBytesL } from '@lib/utils/format'
import { useLocale } from '@providers/locale/useLocale'
import type {
  AdminAccess,
  AdminConversationRow,
  AdminAuditEntry,
  AdminRole,
  AdminUserOverview,
  TokenPlan
} from '@preload/index'
import {
  Alert02Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  BubbleChatIcon,
  CloudIcon,
  ComputerIcon,
  Database02Icon,
  Key01Icon,
  SearchList01Icon,
  SmartPhone01Icon,
  Wallet01Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuditList } from '@pages/settings/admin/AuditList'
import { ConversationList } from '@pages/settings/admin/ConversationList'
import {
  formatTokens,
  formatUsd,
  formatWhen,
  planStanding,
  SURFACE_ORDER
} from '@pages/settings/admin/adminFormat'
import {
  AdminSection,
  Meter,
  MeterSkeleton,
  PlanBadge,
  RoleBadge,
  Sparkline,
  SparklineSkeleton,
  StatTile,
  StatTileSkeleton,
  StatusBadge
} from '@pages/settings/admin/parts'

const TILES = [
  { key: 'tokensIn', icon: CloudIcon },
  { key: 'tokensOut', icon: CloudIcon },
  { key: 'cost', icon: Wallet01Icon },
  { key: 'searches', icon: SearchList01Icon },
  { key: 'conversations', icon: BubbleChatIcon },
  { key: 'storage', icon: Database02Icon }
] as const

const PLANS: TokenPlan[] = ['standard', 'high', 'unmetered']
const ASSIGNABLE_ROLES: AdminRole[] = ['employee', 'support', 'admin', 'owner']

/**
 * One employee, in full — the screen an admin opens to help somebody or to
 * explain a bill.
 *
 * The whole thing is ONE overview call plus two lazy lists (conversations,
 * audit), so it paints once rather than in a dozen staggered arrivals.
 * Every section has a skeleton that mirrors it row for row: the panel is
 * already its final height while the numbers are in flight, and the data
 * landing stops a pulse rather than moving anything.
 */
export function UserDetail({
  userId,
  access,
  onBack,
  onOpenConversation,
  onChanged
}: {
  userId: string
  access: AdminAccess
  onBack: () => void
  onOpenConversation: (row: AdminConversationRow) => void
  /** Roster figures went stale — a role, plan or status changed. */
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon

  const [data, setData] = useState<AdminUserOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [resent, setResent] = useState<{ code?: string; sent: boolean } | null>(null)
  const [conversations, setConversations] = useState<AdminConversationRow[] | null>(null)
  const [convCursor, setConvCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [audit, setAudit] = useState<AdminAuditEntry[] | null>(null)

  const isSelf =
    access.email !== null && data?.user.email.toLowerCase() === access.email.toLowerCase()
  // Only an owner may act on an owner — the same rule the API enforces, so
  // the screen never offers a control that would come back 403.
  const targetIsOwner = data?.user.role === 'owner'
  const canMutate = access.canWrite && (!targetIsOwner || access.isOwner)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setData(await window.api.admin.userOverview(userId, 30))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [userId])

  // Mounted fresh per person (the parent keys on the user id), so this
  // effect only fetches. Clearing state here instead would mean a render
  // pass showing the PREVIOUS person's numbers under the new person's name.
  useEffect(() => {
    let cancelled = false
    void window.api.admin
      .userOverview(userId, 30)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    // The two lists are their own calls so the headline numbers are not
    // held hostage to them; each fills its own skeleton when it lands.
    void window.api.admin
      .listConversations(userId, { limit: 20 })
      .then((res) => {
        if (cancelled) return
        setConversations(res.conversations)
        setConvCursor(res.next)
      })
      .catch(() => {
        if (!cancelled) setConversations([])
      })
    void window.api.admin
      .userAudit(userId, 40)
      .then((res) => {
        if (!cancelled) setAudit(res.entries)
      })
      .catch(() => {
        if (!cancelled) setAudit([])
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const run = useCallback(
    async (key: string, fn: () => Promise<void>): Promise<void> => {
      if (busy !== null) return
      setBusy(key)
      try {
        await fn()
      } catch (err) {
        toast.show({ message: (err as Error).message, tone: 'error' })
      } finally {
        setBusy(null)
      }
    },
    [busy, toast]
  )

  const loadMore = useCallback((): void => {
    if (!convCursor || loadingMore) return
    setLoadingMore(true)
    void window.api.admin
      .listConversations(userId, { before: convCursor, limit: 20 })
      .then((res) => {
        setConversations((prev) => [...(prev ?? []), ...res.conversations])
        setConvCursor(res.next)
      })
      .finally(() => setLoadingMore(false))
  }, [convCursor, loadingMore, userId])

  const chat = data?.lanes.find((l) => l.kind === 'chat')
  const search = data?.lanes.find((l) => l.kind === 'search')
  const standing = data
    ? planStanding(
        data.policy.token_plan,
        data.policy.ceilings,
        // The GATE's counters are the enforcement truth; the rollup is the
        // fallback for the window where a gate is unreachable.
        data.standing.tokens?.userMonthIn ?? chat?.month_tokens_in ?? 0,
        data.standing.tokens?.userMonthOut ?? chat?.month_tokens_out ?? 0
      )
    : null

  const surfaces = useMemo(() => {
    if (!data) return []
    const byName = new Map<
      string,
      { tokens: number; cost: number; requests: number; searches: number }
    >()
    for (const s of data.surfaces) {
      const cur = byName.get(s.surface) ?? { tokens: 0, cost: 0, requests: 0, searches: 0 }
      cur.tokens += (s.tokens_in || 0) + (s.tokens_out || 0)
      cur.cost += s.cost_microusd || 0
      cur.requests += s.requests || 0
      if (s.kind === 'search') cur.searches += (s.requests || 0) - (s.denied || 0)
      byName.set(s.surface, cur)
    }
    return SURFACE_ORDER.filter((name) => byName.has(name)).map((name) => ({
      name,
      ...byName.get(name)!
    }))
  }, [data])

  return (
    <div className="flex w-full flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          'text-muted hover:text-fg -ms-2 flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
        )}
      >
        <BackIcon size={16} />
        <span>{t('settings.admin.people.backToPeople')}</span>
      </button>

      {error !== null ? (
        <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
          {error}
        </p>
      ) : null}

      {/* Identity — always the same three-line block, loaded or not. */}
      <section className="bg-surface border-border flex items-center gap-4 rounded-2xl border p-6">
        {data ? (
          <Avatar name={data.user.name} size={52} />
        ) : (
          <span className="bg-border/60 size-13 animate-pulse rounded-full" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-fg truncate text-xl font-semibold tracking-tight">
            {data ? data.user.name : <SkeletonBar className="w-40" />}
          </h1>
          <p className="text-muted truncate text-xs" dir="ltr">
            {data ? data.user.email : <SkeletonBar className="w-56" />}
          </p>
          <p className="text-muted truncate text-[11px]">
            {data ? (
              data.user.last_login_at ? (
                t('settings.admin.user.lastLogin', {
                  when: formatWhen(data.user.last_login_at, locale) ?? ''
                })
              ) : (
                t('settings.admin.user.neverSignedIn')
              )
            ) : (
              <SkeletonBar className="w-44" />
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {data ? (
            <>
              <StatusBadge status={data.user.status} />
              <RoleBadge role={data.user.role} />
              <PlanBadge plan={data.policy.token_plan} />
            </>
          ) : (
            <>
              <SkeletonBar className="w-16 rounded-full text-[10px]" />
              <SkeletonBar className="w-14 rounded-full text-[10px]" />
              <SkeletonBar className="w-16 rounded-full text-[10px]" />
            </>
          )}
        </div>
      </section>

      {/* Plan — the control this screen exists for, and its live standing. */}
      <AdminSection title={t('settings.admin.plan.title')} hint={t('settings.admin.plan.subtitle')}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg text-sm font-medium">{t('settings.admin.plan.assigned')}</span>
            <div
              role="tablist"
              className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
            >
              {PLANS.map((plan) => {
                const active = data?.policy.token_plan === plan
                return (
                  <button
                    key={plan}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    disabled={!canMutate || data === null || busy !== null}
                    title={
                      data
                        ? data.plans[plan].monthlyIn === 0
                          ? t('settings.admin.plan.unmeteredHint')
                          : t('settings.admin.plan.ceilingHint', {
                              in: formatTokens(data.plans[plan].monthlyIn, locale),
                              out: formatTokens(data.plans[plan].monthlyOut, locale)
                            })
                        : undefined
                    }
                    onClick={() =>
                      void run(`plan:${plan}`, async () => {
                        await window.api.admin.setPlan(userId, plan)
                        await reload()
                        onChanged()
                        toast.show({
                          message: t('settings.admin.plan.changed', {
                            plan: t(`settings.admin.plan.${plan}`)
                          }),
                          tone: 'success'
                        })
                      })
                    }
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      active
                        ? 'bg-primary text-primary-fg shadow-sm'
                        : 'text-muted hover:text-fg cursor-pointer',
                      (!canMutate || data === null || busy !== null) &&
                        'cursor-not-allowed opacity-60'
                    )}
                  >
                    {t(`settings.admin.plan.${plan}`)}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="border-border/60 border-t" />
          {standing ? (
            <div className="flex flex-col gap-3">
              <Meter
                label={t('settings.admin.plan.monthInput')}
                used={standing.inUsed}
                ceiling={standing.ceilings.monthlyIn}
                locale={locale}
              />
              <Meter
                label={t('settings.admin.plan.monthOutput')}
                used={standing.outUsed}
                ceiling={standing.ceilings.monthlyOut}
                locale={locale}
              />
              <p className="text-muted text-[11px] leading-relaxed">
                {standing.unmetered
                  ? t('settings.admin.plan.unmeteredNote')
                  : t('settings.admin.plan.resetNote', { month: data?.window.month_start ?? '' })}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <MeterSkeleton label={t('settings.admin.plan.monthInput')} />
              <MeterSkeleton label={t('settings.admin.plan.monthOutput')} />
              <span className="text-[11px]">
                <SkeletonBar className="w-64" />
              </span>
            </div>
          )}
        </div>
      </AdminSection>

      {/* Spend over the window, with the shape of it. */}
      <AdminSection
        title={t('settings.admin.spend.title')}
        hint={t('settings.admin.spend.subtitle', { days: data?.window.days ?? 30 })}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            {data ? (
              <>
                <StatTile
                  icon={CloudIcon}
                  label={t('settings.admin.spend.tokensIn')}
                  value={formatTokens(chat?.tokens_in ?? 0, locale)}
                  sub={t('settings.admin.spend.cached', {
                    value: formatTokens(chat?.tokens_cached ?? 0, locale)
                  })}
                />
                <StatTile
                  icon={CloudIcon}
                  label={t('settings.admin.spend.tokensOut')}
                  value={formatTokens(chat?.tokens_out ?? 0, locale)}
                  sub={t('settings.admin.spend.requests', { count: chat?.requests ?? 0 })}
                />
                <StatTile
                  icon={Wallet01Icon}
                  label={t('settings.admin.spend.cost')}
                  value={formatUsd(
                    (chat?.cost_microusd ?? 0) + (search?.cost_microusd ?? 0),
                    locale
                  )}
                  sub={t('settings.admin.spend.monthCost', {
                    value: formatUsd(
                      (chat?.month_cost_microusd ?? 0) + (search?.month_cost_microusd ?? 0),
                      locale
                    )
                  })}
                />
                <StatTile
                  icon={SearchList01Icon}
                  label={t('settings.admin.spend.searches')}
                  value={formatTokens((search?.requests ?? 0) - (search?.denied ?? 0), locale)}
                  sub={t('settings.admin.spend.searchCost', {
                    value: formatUsd(search?.cost_microusd ?? 0, locale)
                  })}
                />
                <StatTile
                  icon={BubbleChatIcon}
                  label={t('settings.admin.spend.conversations')}
                  value={String(data.counts.conversations)}
                  sub={t('settings.admin.spend.denied', { count: chat?.denied ?? 0 })}
                />
                <StatTile
                  icon={Database02Icon}
                  label={t('settings.admin.spend.storage')}
                  value={formatBytesL(data.counts.bytes, t)}
                  sub={t('settings.admin.spend.files', { count: data.counts.files })}
                />
              </>
            ) : (
              TILES.map((tile) => (
                <StatTileSkeleton
                  key={tile.key}
                  icon={tile.icon}
                  label={t(`settings.admin.spend.${tile.key}`)}
                />
              ))
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted text-[11px]">{t('settings.admin.spend.daily')}</span>
            {data ? (
              <Sparkline points={data.daily} pick={(p) => p.cost_microusd} />
            ) : (
              <SparklineSkeleton />
            )}
          </div>
        </div>
      </AdminSection>

      {/* Where it was spent — the answer to "is this the phone or the extension?" */}
      <AdminSection
        title={t('settings.admin.surfaces.title')}
        hint={t('settings.admin.surfaces.subtitle')}
      >
        {data === null ? (
          <ul className="flex flex-col" role="status" aria-label={t('common.loading')}>
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="border-border/60 flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
              >
                <SkeletonBar className="w-24 text-xs" />
                <SkeletonBar className="w-40 text-xs" />
              </li>
            ))}
          </ul>
        ) : surfaces.length === 0 ? (
          <p className="border-border text-muted rounded-xl border border-dashed px-4 py-6 text-center text-xs">
            {t('settings.admin.surfaces.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {surfaces.map((s) => (
              <li
                key={s.name || 'unattributed'}
                className="border-border/60 flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
              >
                <span className="text-fg text-xs font-medium">
                  {t(`settings.admin.surfaces.names.${s.name || 'unattributed'}`, {
                    defaultValue: s.name || t('settings.admin.surfaces.names.unattributed')
                  })}
                </span>
                <span className="text-muted text-xs tabular-nums" dir="ltr">
                  {formatTokens(s.tokens, locale)} · {formatUsd(s.cost, locale)}
                  {s.searches > 0
                    ? ` · ${t('settings.admin.surfaces.searches', { count: s.searches })}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      {/* Controls — the "help this person" half of the screen. */}
      <AdminSection
        title={t('settings.admin.controls.title')}
        hint={t('settings.admin.controls.subtitle')}
      >
        <div className="flex flex-col gap-5">
          {access.isOwner ? (
            <>
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-fg text-sm font-medium">
                    {t('settings.admin.controls.role')}
                  </span>
                  <span className="text-muted text-xs">
                    {t('settings.admin.controls.roleHint')}
                  </span>
                </div>
                <div
                  role="tablist"
                  className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
                >
                  {ASSIGNABLE_ROLES.map((role) => {
                    const active = data?.user.role === role
                    return (
                      <button
                        key={role}
                        role="tab"
                        type="button"
                        aria-selected={active}
                        disabled={data === null || busy !== null || isSelf}
                        onClick={() =>
                          void run(`role:${role}`, async () => {
                            await window.api.admin.updateUser(userId, { role })
                            await reload()
                            onChanged()
                          })
                        }
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs font-medium',
                          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                          active
                            ? 'bg-primary text-primary-fg shadow-sm'
                            : 'text-muted hover:text-fg cursor-pointer',
                          (data === null || busy !== null || isSelf) &&
                            'cursor-not-allowed opacity-60'
                        )}
                      >
                        {t(`settings.admin.roles.${role}`)}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="border-border/60 border-t" />
            </>
          ) : null}

          <ControlRow
            label={t('settings.admin.controls.access')}
            hint={
              data?.user.status === 'suspended'
                ? t('settings.admin.controls.accessDisabledHint')
                : t('settings.admin.controls.accessHint')
            }
            action={
              <button
                type="button"
                disabled={!canMutate || data === null || busy !== null || isSelf}
                onClick={() =>
                  void run('status', async () => {
                    const next = data?.user.status === 'suspended' ? 'active' : 'suspended'
                    await window.api.admin.updateUser(userId, { status: next })
                    await reload()
                    onChanged()
                    toast.show({
                      message:
                        next === 'suspended'
                          ? t('settings.admin.controls.disabledToast')
                          : t('settings.admin.controls.enabledToast'),
                      tone: 'success'
                    })
                  })
                }
                className={cn(
                  'shrink-0 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  data?.user.status === 'suspended'
                    ? 'border-border text-fg hover:bg-border/40'
                    : 'border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400'
                )}
              >
                {data?.user.status === 'suspended'
                  ? t('settings.admin.controls.enable')
                  : t('settings.admin.controls.disable')}
              </button>
            }
          />
          {/* An account nobody has signed into yet is still waiting on its
              invite, so the control it needs is a re-send, not a password. */}
          {data?.user.status === 'invited' ? (
            <>
              <div className="border-border/60 border-t" />
              <ControlRow
                label={t('settings.admin.controls.invitation')}
                hint={t('settings.admin.controls.invitationHint')}
                action={
                  <button
                    type="button"
                    disabled={!canMutate || data === null || busy !== null}
                    onClick={() =>
                      void run('activation', async () => {
                        const res = await window.api.admin.resendActivation(userId)
                        setResent({ code: res.activation_code, sent: res.email_sent })
                        if (res.email_sent) {
                          toast.show({
                            message: t('settings.admin.controls.invitationSent', {
                              email: res.email
                            }),
                            tone: 'success'
                          })
                        }
                      })
                    }
                    className="border-border text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('settings.admin.controls.resendInvitation')}
                  </button>
                }
              />
              {resent && !resent.sent ? (
                <div className="border-amber-500/40 bg-amber-500/10 flex items-center gap-3 rounded-xl border px-4 py-3">
                  <Alert02Icon size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-fg text-xs font-medium">
                      {t('settings.admin.controls.invitationNotSent')}
                    </span>
                    {resent.code ? (
                      <code className="text-fg font-mono text-sm tracking-[0.3em]" dir="ltr">
                        {resent.code}
                      </code>
                    ) : null}
                    <span className="text-muted text-[11px]">
                      {t('settings.admin.controls.invitationNotSentHint')}
                    </span>
                  </div>
                  {resent.code ? (
                    <CopyButton text={resent.code} variant="inline" ariaLabelKey="common.copy" />
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <div className="border-border/60 border-t" />
          <ControlRow
            label={t('settings.admin.controls.password')}
            hint={t('settings.admin.controls.passwordHint')}
            action={
              <button
                type="button"
                disabled={!canMutate || data === null || busy !== null}
                onClick={() =>
                  void run('password', async () => {
                    const res = await window.api.admin.resetPassword(userId)
                    setTempPassword(res.temp_password)
                    await reload()
                  })
                }
                className="border-border text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('settings.admin.controls.resetPassword')}
              </button>
            }
          />
          {tempPassword ? (
            <div className="border-amber-500/40 bg-amber-500/10 flex items-center gap-3 rounded-xl border px-4 py-3">
              <Alert02Icon size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-fg text-xs font-medium">
                  {t('settings.admin.controls.tempPassword')}
                </span>
                <code className="text-fg truncate font-mono text-sm" dir="ltr">
                  {tempPassword}
                </code>
                <span className="text-muted text-[11px]">
                  {t('settings.admin.controls.tempPasswordHint')}
                </span>
              </div>
              <CopyButton text={tempPassword} variant="inline" ariaLabelKey="common.copy" />
            </div>
          ) : null}
          <div className="border-border/60 border-t" />
          <ControlRow
            label={t('settings.admin.controls.pin')}
            hint={t('settings.admin.controls.pinHint')}
            action={
              <button
                type="button"
                disabled={!canMutate || data === null || busy !== null}
                onClick={() =>
                  void run('pin', async () => {
                    await window.api.admin.clearPin(userId)
                    await reload()
                    toast.show({
                      message: t('settings.admin.controls.pinCleared'),
                      tone: 'success'
                    })
                  })
                }
                className="border-border text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('settings.admin.controls.clearPin')}
              </button>
            }
          />
          <div className="border-border/60 border-t" />
          <ControlRow
            label={t('settings.admin.controls.sessions')}
            hint={t('settings.admin.controls.sessionsHint')}
            action={
              <button
                type="button"
                disabled={!canMutate || data === null || busy !== null}
                onClick={() =>
                  void run('sessions', async () => {
                    const res = await window.api.admin.revokeSessions(userId)
                    await reload()
                    toast.show({
                      message: t('settings.admin.controls.sessionsRevoked', { count: res.revoked }),
                      tone: 'success'
                    })
                  })
                }
                className="border-border text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('settings.admin.controls.signOutEverywhere')}
              </button>
            }
          />
          {!canMutate ? (
            <p className="text-muted text-[11px] leading-relaxed">
              {targetIsOwner && !access.isOwner
                ? t('settings.admin.controls.ownerOnly')
                : t('settings.admin.controls.readOnly')}
            </p>
          ) : null}
        </div>
      </AdminSection>

      {/* Devices — what this person signs in from. */}
      <AdminSection
        title={t('settings.admin.devices.title')}
        hint={t('settings.admin.devices.subtitle')}
      >
        {data === null ? (
          <ul className="flex flex-col" role="status" aria-label={t('common.loading')}>
            {[0, 1].map((i) => (
              <li
                key={i}
                className="border-border/60 flex items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <span className="bg-border/60 size-7 shrink-0 animate-pulse rounded-lg" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <SkeletonBar className="w-32 text-xs" />
                  <SkeletonBar className="w-44 text-[11px]" />
                </span>
              </li>
            ))}
          </ul>
        ) : data.devices.length === 0 ? (
          <p className="border-border text-muted rounded-xl border border-dashed px-4 py-6 text-center text-xs">
            {t('settings.admin.devices.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {data.devices.map((d) => (
              <li
                key={d.id}
                className="border-border/60 flex items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <span className="border-border bg-bg text-muted flex size-7 shrink-0 items-center justify-center rounded-lg border">
                  {d.platform === 'mobile' ? (
                    <SmartPhone01Icon size={13} />
                  ) : (
                    <ComputerIcon size={13} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-fg truncate text-xs font-medium">
                    {d.name || d.platform}
                    {d.status !== 'active' ? ` · ${t('settings.admin.devices.revoked')}` : ''}
                  </span>
                  <span className="text-muted truncate text-[11px]">
                    {d.app_version ? `v${d.app_version} · ` : ''}
                    {d.pin_set
                      ? t('settings.admin.devices.pinSet')
                      : t('settings.admin.devices.noPin')}
                    {d.pin_clear_requested
                      ? ` · ${t('settings.admin.devices.pinClearPending')}`
                      : ''}
                    {d.last_seen_at ? ` · ${formatWhen(d.last_seen_at, locale)}` : ''}
                  </span>
                </span>
                {canMutate ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`pin:${d.id}`, async () => {
                        await window.api.admin.clearPin(userId, d.id)
                        await reload()
                      })
                    }
                    className="border-border text-muted hover:text-fg hover:bg-border/40 shrink-0 cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Key01Icon size={11} />
                      {t('settings.admin.devices.clearPin')}
                    </span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <AdminSection
        title={t('settings.admin.conversations.title')}
        hint={t('settings.admin.conversations.subtitle')}
      >
        <ConversationList
          rows={conversations}
          hasMore={convCursor !== null}
          loadingMore={loadingMore}
          onOpen={onOpenConversation}
          onLoadMore={loadMore}
        />
      </AdminSection>

      <AdminSection
        title={t('settings.admin.audit.userTitle')}
        hint={t('settings.admin.audit.userSubtitle')}
      >
        <AuditList entries={audit} emptyLabel={t('settings.admin.audit.empty')} />
      </AdminSection>
    </div>
  )
}

function ControlRow({
  label,
  hint,
  action
}: {
  label: string
  hint: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg text-sm font-medium">{label}</span>
        <span className="text-muted text-xs leading-relaxed">{hint}</span>
      </div>
      {action}
    </div>
  )
}
