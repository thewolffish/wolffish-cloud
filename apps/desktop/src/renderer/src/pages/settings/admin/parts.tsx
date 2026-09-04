import { SkeletonBar } from '@components/core/Skeleton'
import { cn } from '@lib/utils/cn'
import type { AdminDailyPoint, TokenPlan } from '@preload/index'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import {
  METER_TONE_CLASS,
  ROLE_TONE_CLASS,
  STATUS_TONE_CLASS,
  formatTokens,
  toneFor
} from '@pages/settings/admin/adminFormat'

/**
 * The admin screen's small parts. Each one ships with the skeleton that
 * stands in for it, side by side in the same file — the pair only stays
 * honest if changing one puts the other on screen at the same time.
 */

export function AdminSection({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-fg text-sm font-semibold">{title}</h2>
          {hint ? <p className="text-muted text-xs leading-relaxed">{hint}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

type IconComp = React.ComponentType<{ size?: number; className?: string }>

export function StatTile({
  icon: Icon,
  label,
  value,
  sub
}: {
  icon: IconComp
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div className="bg-surface border-border flex flex-col gap-1 rounded-xl border p-3">
      <div className="text-muted flex items-center gap-1.5 text-[11px]">
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <span className="text-fg text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-muted truncate text-[11px]">{sub ?? ' '}</span>
    </div>
  )
}

/** Same box, same three rows, same font sizes — only the values pulse. */
export function StatTileSkeleton({
  label,
  icon: Icon
}: {
  label: string
  icon: IconComp
}): React.JSX.Element {
  return (
    <div className="bg-surface border-border flex flex-col gap-1 rounded-xl border p-3">
      <div className="text-muted flex items-center gap-1.5 text-[11px]">
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <span className="text-lg font-semibold">
        <SkeletonBar className="w-16" />
      </span>
      <span className="text-[11px]">
        <SkeletonBar className="w-20" />
      </span>
    </div>
  )
}

/**
 * A plan ceiling, drawn. An unmetered plan has no bar at all — an empty one
 * would read as "no usage yet", which is the opposite of what unmetered
 * means.
 */
export function Meter({
  label,
  used,
  ceiling,
  locale
}: {
  label: string
  used: number
  ceiling: number
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const unlimited = !ceiling || ceiling <= 0
  const r = unlimited ? null : Math.min(1, Math.max(0, used / ceiling))
  const tone = toneFor(r)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted text-[11px]">{label}</span>
        <span className="text-fg text-xs tabular-nums" dir="ltr">
          {unlimited
            ? t('settings.admin.plan.noCeiling', { used: formatTokens(used, locale) })
            : `${formatTokens(used, locale)} / ${formatTokens(ceiling, locale)}`}
        </span>
      </div>
      <div className="bg-border/50 h-1.5 w-full overflow-hidden rounded-full">
        {r === null ? (
          // A dashed rail rather than a fill: there is a lane, but no wall.
          <div className="from-border/40 to-border/80 h-full w-full bg-gradient-to-r" />
        ) : (
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              METER_TONE_CLASS[tone]
            )}
            style={{ width: `${Math.max(r * 100, r > 0 ? 2 : 0)}%` }}
          />
        )}
      </div>
    </div>
  )
}

export function MeterSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted text-[11px]">{label}</span>
        <span className="text-xs">
          <SkeletonBar className="w-24" />
        </span>
      </div>
      <div className="bg-border/50 h-1.5 w-full animate-pulse overflow-hidden rounded-full" />
    </div>
  )
}

export function RoleBadge({ role }: { role: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        ROLE_TONE_CLASS[role] ?? ROLE_TONE_CLASS.employee
      )}
    >
      {t(`settings.admin.roles.${role}`, { defaultValue: role })}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        STATUS_TONE_CLASS[status] ?? STATUS_TONE_CLASS.removed
      )}
    >
      {t(`settings.admin.status.${status}`, { defaultValue: status })}
    </span>
  )
}

export function PlanBadge({ plan }: { plan: TokenPlan }): React.JSX.Element {
  const { t } = useTranslation()
  const tone =
    plan === 'unmetered'
      ? 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400'
      : plan === 'high'
        ? 'border-primary/30 bg-primary/10 text-primary'
        : 'border-border bg-border/30 text-muted'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        tone
      )}
    >
      {t(`settings.admin.plan.${plan}`)}
    </span>
  )
}

/**
 * The daily series as one small area chart. Deliberately unlabelled: it is
 * a shape, not a reading — the numbers next to it are the reading. Days
 * with no activity are real zeros, so the line touches the floor rather
 * than skipping the gap, which would flatter a quiet week.
 */
export function Sparkline({
  points,
  pick,
  className
}: {
  points: AdminDailyPoint[]
  pick: (p: AdminDailyPoint) => number
  className?: string
}): React.JSX.Element {
  const values = points.map(pick)
  const max = Math.max(1, ...values)
  const w = 100
  const h = 28
  const step = values.length > 1 ? w / (values.length - 1) : w
  const coords = values.map((v, i) => [i * step, h - (v / max) * (h - 2) - 1] as const)
  const line = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn('h-7 w-full', className)}
    >
      {values.length > 1 ? (
        <>
          <path d={area} className="fill-primary/15" />
          <path
            d={line}
            fill="none"
            className="stroke-primary"
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </svg>
  )
}

export function SparklineSkeleton(): React.JSX.Element {
  return <span aria-hidden="true" className="bg-border/60 block h-7 w-full animate-pulse rounded" />
}
