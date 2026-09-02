/**
 * Brave Search — provided by the organization, like the models.
 *
 * Nothing to configure here: the org holds the one Brave Search key behind
 * the API's /v1/search lane, and this panel renders that lane's status
 * (main/brave.ts ← GET /v1/search/status) — whether it is live, this
 * user's allowance for today, the org's monthly budget, the plan price and
 * rate limit. Read-only by design; admins change the switch and the caps
 * through the org settings, and this panel follows.
 */
import { Button } from '@components/core/Button'
import { BraveLogo } from '@components/core/ProviderLogos'
import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { BraveStatus } from '@preload/index'
import { CloudIcon, LinkSquare02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const BRAVE_URL = 'https://brave.com/search/api/'

const STATE_DOT: Record<BraveStatus['state'], string> = {
  ready: 'bg-emerald-500',
  disabled: 'bg-border',
  unconfigured: 'bg-amber-500',
  signed_out: 'bg-border',
  unreachable: 'bg-rose-500'
}

export function BravePanel(): React.JSX.Element {
  const { t } = useTranslation()
  // null while the first read is in flight — one paint, no flicker from a
  // guessed state to the real one (the same pattern the other panels use).
  const [status, setStatus] = useState<BraveStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true)
    try {
      const next = await window.api.brave.status({ refresh })
      setStatus(next)
    } finally {
      if (refresh) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.brave
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const allowance = (used: number, cap: number): string =>
    cap > 0
      ? t('settings.services.brave.rows.of', {
          used: formatCompact(used),
          cap: formatCompact(cap)
        })
      : `${formatCompact(used)} · ${t('settings.services.brave.rows.unlimited')}`

  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = status
    ? [
        {
          key: 'provider',
          label: t('settings.services.brave.rows.provider'),
          value: (
            <span className="flex items-center gap-1.5">
              <BraveLogo size={13} />
              <span>Brave Search</span>
            </span>
          )
        },
        {
          key: 'status',
          label: t('settings.services.brave.rows.status'),
          value: (
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT[status.state])}
              />
              <span>{t(`settings.services.brave.state.${status.state}`)}</span>
            </span>
          )
        },
        {
          key: 'today',
          label: t('settings.services.brave.rows.today'),
          value: allowance(status.usedToday, status.dailyCap)
        },
        {
          key: 'month',
          label: t('settings.services.brave.rows.month'),
          value: allowance(status.orgUsedMonth, status.orgMonthlyCap)
        },
        {
          key: 'price',
          label: t('settings.services.brave.rows.price'),
          value: `$${status.pricePerQueryUsd.toFixed(3)}`
        },
        {
          key: 'rate',
          label: t('settings.services.brave.rows.rate'),
          value: t('settings.services.brave.rows.perSecond', { count: status.planQps })
        }
      ]
    : []

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.services.brave.title')}
              </h1>
            </div>
            <a
              href={BRAVE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
              )}
            >
              <span>{t('settings.services.brave.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.brave.subtitle')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CloudIcon size={16} className="text-muted shrink-0" />
              <h2 className="text-fg text-sm font-semibold">
                {t('settings.services.brave.managedTitle')}
              </h2>
              <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
                {t('settings.services.brave.managedBadge')}
              </span>
            </div>
            <Button
              type="button"
              disabled={refreshing || status === null}
              onClick={() => void load(true)}
            >
              {refreshing
                ? t('settings.services.brave.refreshing')
                : t('settings.services.brave.refresh')}
            </Button>
          </div>

          <div className="border-border/60 border-t" />

          {status === null ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <span className="bg-border/40 h-3 w-32 animate-pulse rounded" />
                  <span className="bg-border/40 h-3 w-24 animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : (
            <dl className="flex flex-col gap-3">
              {rows.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3">
                  <dt className="text-muted text-xs font-medium uppercase tracking-wider">
                    {row.label}
                  </dt>
                  <dd className="text-fg text-sm">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {status?.error ? (
            <pre
              className={cn(
                'bg-bg/40 border-border rounded-md border px-3 py-2',
                'text-xs whitespace-pre-wrap wrap-break-word font-mono text-rose-500'
              )}
            >
              {status.error}
            </pre>
          ) : null}

          <div className="border-border/60 border-t" />

          <a
            href={BRAVE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-fg flex items-center gap-1.5 self-start text-xs"
          >
            <BraveLogo size={12} />
            <span>{t('settings.services.brave.attribution')}</span>
          </a>
        </section>

        <HowItWorksSection />
      </div>
    </div>
  )
}

function HowItWorksSection(): React.JSX.Element {
  const { t } = useTranslation()
  const points: string[] = [
    t('settings.services.brave.howItWorks.lane'),
    t('settings.services.brave.howItWorks.fair'),
    t('settings.services.brave.howItWorks.caps'),
    t('settings.services.brave.howItWorks.meter'),
    t('settings.services.brave.howItWorks.privacy')
  ]
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.brave.howItWorksTitle')}
        </h2>
      </header>
      <ul className="text-muted flex flex-col gap-1.5 text-xs leading-relaxed">
        {points.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
