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
import { CloudIcon } from 'hugeicons-react'
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

  // The labels are the same in both states and only the value column pulses
  // while the first read is in flight, so every row is the same height by
  // construction and nothing moves when the status lands.
  const rows: Array<{
    key: string
    label: string
    value: (s: BraveStatus) => React.ReactNode
    /** Width of the pulse bar that stands in for the value while loading. */
    placeholder: string
  }> = [
    {
      key: 'provider',
      label: t('settings.services.brave.rows.provider'),
      value: () => (
        <span className="flex items-center gap-1.5">
          <BraveLogo size={13} />
          <span>Brave Search</span>
        </span>
      ),
      placeholder: 'w-24'
    },
    {
      key: 'status',
      label: t('settings.services.brave.rows.status'),
      value: (s) => (
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT[s.state])}
          />
          <span>{t(`settings.services.brave.state.${s.state}`)}</span>
        </span>
      ),
      placeholder: 'w-16'
    },
    {
      key: 'today',
      label: t('settings.services.brave.rows.today'),
      value: (s) => allowance(s.usedToday, s.dailyCap),
      placeholder: 'w-20'
    },
    {
      key: 'month',
      label: t('settings.services.brave.rows.month'),
      value: (s) => allowance(s.orgUsedMonth, s.orgMonthlyCap),
      placeholder: 'w-20'
    },
    {
      key: 'price',
      label: t('settings.services.brave.rows.price'),
      value: (s) => `$${s.pricePerQueryUsd.toFixed(3)}`,
      placeholder: 'w-12'
    },
    {
      key: 'rate',
      label: t('settings.services.brave.rows.rate'),
      value: (s) => t('settings.services.brave.rows.perSecond', { count: s.planQps }),
      placeholder: 'w-24'
    }
  ]

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <PanelBackChevron />
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.services.brave.title')}
            </h1>
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
              {t('settings.services.brave.refresh')}
            </Button>
          </div>

          <div className="border-border/60 border-t" />

          <dl className="flex flex-col gap-3" aria-busy={status === null}>
            {rows.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3">
                <dt className="text-muted text-xs font-medium uppercase tracking-wider">
                  {row.label}
                </dt>
                <dd className="text-fg text-sm">
                  {status ? row.value(status) : <SkeletonBar className={row.placeholder} />}
                </dd>
              </div>
            ))}
          </dl>

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

/**
 * A pulse bar that is a real — if transparent — text node, so its height is
 * the exact line box of the value it stands in for (the same trick the Usage
 * panel uses). The hand-sized `h-3` bars this replaces were shorter than every
 * row, and there were four of them for six rows, which is what made the card
 * jump when the status landed.
 */
function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-border/60 inline-block animate-pulse rounded text-transparent select-none',
        className
      )}
    >
      &nbsp;
    </span>
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
