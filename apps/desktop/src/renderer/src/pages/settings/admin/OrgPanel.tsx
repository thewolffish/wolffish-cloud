import { SkeletonBar } from '@components/core/Skeleton'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import type { AdminAccess, AdminOrgSettings, PlanCeilings, TokenPlan } from '@preload/index'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTokens } from '@pages/settings/admin/adminFormat'
import { AdminSection } from '@pages/settings/admin/parts'

const PLANS: TokenPlan[] = ['standard', 'high', 'unmetered']

/**
 * The org's own settings: the name, the org-wide ceilings that sit ABOVE
 * every individual plan, and the web-search switch.
 *
 * The distinction worth keeping straight on screen: a plan caps ONE
 * employee's month, while the org monthly cap is the whole company's, and
 * the per-user daily cap is a rate limit rather than a budget. All three are
 * enforced, and whichever binds first is the one that bites — so they are
 * shown together rather than on three screens.
 */
export function OrgPanel({
  access,
  plans
}: {
  access: AdminAccess
  /** The plan catalogue, so the ceilings shown here are the server's. */
  plans: Record<TokenPlan, PlanCeilings> | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const [org, setOrg] = useState<AdminOrgSettings | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<void> => {
    const res = await window.api.admin.getOrg()
    setOrg(res.org)
    setDraft({})
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.admin
      .getOrg()
      .then((res) => {
        if (!cancelled) setOrg(res.org)
      })
      .catch(() => {
        if (!cancelled) setOrg(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (key: string, patch: Parameters<typeof window.api.admin.patchOrg>[0]): Promise<void> => {
      if (busy !== null) return
      setBusy(key)
      try {
        await window.api.admin.patchOrg(patch)
        await load()
        toast.show({ message: t('settings.admin.org.saved'), tone: 'success' })
      } catch (err) {
        toast.show({ message: (err as Error).message, tone: 'error' })
      } finally {
        setBusy(null)
      }
    },
    [busy, load, t, toast]
  )

  const clearDraft = useCallback(
    (key: string) =>
      setDraft((d) => {
        const rest = { ...d }
        delete rest[key]
        return rest
      }),
    []
  )

  const capFields = [
    { key: 'user_daily_token_cap', label: t('settings.admin.org.userDailyTokens') },
    { key: 'org_monthly_token_cap', label: t('settings.admin.org.orgMonthlyTokens') },
    { key: 'user_daily_search_cap', label: t('settings.admin.org.userDailySearches') },
    { key: 'org_monthly_search_cap', label: t('settings.admin.org.orgMonthlySearches') }
  ] as const

  return (
    <div className="flex w-full flex-col gap-5">
      <AdminSection title={t('settings.admin.org.title')} hint={t('settings.admin.org.subtitle')}>
        <div className="flex flex-col gap-4">
          <Field
            label={t('settings.admin.org.name')}
            value={org?.name ?? null}
            draft={draft.name}
            disabled={!access.canWrite || busy !== null}
            onDraft={(v) => setDraft((d) => ({ ...d, name: v }))}
            onCancel={() => clearDraft('name')}
            onCommit={(v) => void save('name', { name: v })}
          />
          <div className="border-border/60 border-t" />
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-fg text-sm font-medium">
                {t('settings.admin.org.defaultModel')}
              </span>
              <span className="text-muted truncate text-xs" dir="ltr">
                {org ? org.default_model : <SkeletonBar className="w-48" />}
              </span>
            </div>
          </div>
          <div className="border-border/60 border-t" />
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-fg text-sm font-medium">{t('settings.admin.org.search')}</span>
              <span className="text-muted text-xs">{t('settings.admin.org.searchHint')}</span>
            </div>
            <div
              role="tablist"
              className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
            >
              {[true, false].map((on) => {
                const active = org !== null && Boolean(org.search_enabled) === on
                return (
                  <button
                    key={String(on)}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    disabled={!access.canWrite || org === null || busy !== null}
                    onClick={() => void save('search', { search_enabled: on })}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      active
                        ? 'bg-primary text-primary-fg shadow-sm'
                        : 'text-muted hover:text-fg cursor-pointer',
                      (!access.canWrite || org === null || busy !== null) &&
                        'cursor-not-allowed opacity-60'
                    )}
                  >
                    {t(on ? 'settings.admin.org.on' : 'settings.admin.org.off')}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </AdminSection>

      <AdminSection
        title={t('settings.admin.org.capsTitle')}
        hint={t('settings.admin.org.capsSubtitle')}
      >
        <div className="flex flex-col gap-4">
          {capFields.map((f, i) => (
            <div key={f.key} className="flex flex-col gap-4">
              {i > 0 ? <div className="border-border/60 border-t" /> : null}
              <Field
                label={f.label}
                numeric
                value={org ? String(org[f.key]) : null}
                draft={draft[f.key]}
                hint={
                  org && org[f.key] === 0
                    ? t('settings.admin.org.unlimited')
                    : org
                      ? formatTokens(org[f.key], locale)
                      : undefined
                }
                disabled={!access.canWrite || busy !== null}
                onDraft={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                onCancel={() => clearDraft(f.key)}
                onCommit={(v) => {
                  const n = Math.floor(Number(v))
                  // A cap must be a non-negative integer; anything else is a
                  // typo, and saving it would silently change a ceiling.
                  if (!Number.isFinite(n) || n < 0) {
                    clearDraft(f.key)
                    return
                  }
                  void save(f.key, { [f.key]: n })
                }}
              />
            </div>
          ))}
        </div>
      </AdminSection>

      <AdminSection
        title={t('settings.admin.org.plansTitle')}
        hint={t('settings.admin.org.plansSubtitle')}
      >
        <ul className="flex flex-col">
          {PLANS.map((plan) => (
            <li
              key={plan}
              className="border-border/60 flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
            >
              <span className="text-fg text-xs font-medium">
                {t(`settings.admin.plan.${plan}`)}
              </span>
              <span className="text-muted text-xs tabular-nums" dir="ltr">
                {plans === null ? (
                  <SkeletonBar className="w-40" />
                ) : plans[plan].monthlyIn === 0 ? (
                  t('settings.admin.plan.unmeteredHint')
                ) : (
                  t('settings.admin.plan.ceilingHint', {
                    in: formatTokens(plans[plan].monthlyIn, locale),
                    out: formatTokens(plans[plan].monthlyOut, locale)
                  })
                )}
              </span>
            </li>
          ))}
        </ul>
      </AdminSection>
    </div>
  )
}

/**
 * An inline editable value. It commits on blur or Enter and reverts on
 * Escape, so a half-typed cap is never saved by a stray click, and the field
 * shows the SERVER's value whenever it is not being edited.
 */
function Field({
  label,
  value,
  draft,
  hint,
  numeric,
  disabled,
  onDraft,
  onCancel,
  onCommit
}: {
  label: string
  value: string | null
  draft: string | undefined
  hint?: string
  numeric?: boolean
  disabled: boolean
  onDraft: (v: string) => void
  /** Drop the local edit and go back to showing the server's value. */
  onCancel: () => void
  onCommit: (v: string) => void
}): React.JSX.Element {
  const editing = draft !== undefined
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg text-sm font-medium">{label}</span>
        {hint ? <span className="text-muted text-xs">{hint}</span> : null}
      </div>
      {value === null ? (
        <span className="w-48 shrink-0 text-sm">
          <SkeletonBar className="w-full" />
        </span>
      ) : (
        <input
          type={numeric ? 'number' : 'text'}
          min={numeric ? 0 : undefined}
          value={editing ? draft : value}
          disabled={disabled}
          dir="ltr"
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => {
            if (!editing) return
            // An unchanged edit is not a save: drop the draft so the field
            // goes back to mirroring the server, rather than pinning the
            // typed text as a permanent local override.
            if (draft === value) onCancel()
            else onCommit(draft)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              onCancel()
              e.currentTarget.blur()
            }
          }}
          className={cn(
            'bg-bg text-fg border-border h-9 w-48 shrink-0 rounded-lg border px-3 text-sm tabular-nums',
            'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            disabled && 'cursor-not-allowed opacity-60'
          )}
        />
      )}
    </div>
  )
}
