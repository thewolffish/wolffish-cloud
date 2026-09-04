import { formatCompact } from '@lib/utils/format'
import type { PlanCeilings, RosterPerson, TokenPlan } from '@preload/index'

/**
 * The admin screen's shared arithmetic and formatting. Kept apart from the
 * components because several of these are the kind of thing that is easy to
 * get subtly wrong in two places — cost is stored in MICRO-dollars, plan
 * usage is measured against the calendar month rather than the rolling
 * window, and "0" means unlimited everywhere caps appear.
 */

/** Costs are stored as integer microUSD so no row carries a float. */
export const usd = (microUsd: number): number => (microUsd || 0) / 1_000_000

export function formatUsd(microUsd: number, locale?: string): string {
  const v = usd(microUsd)
  // Below a cent, "$0.00" reads as free when it isn't. Show the real figure
  // with enough precision to be a number rather than a rounding artifact.
  const digits = v > 0 && v < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(v)
}

export const formatTokens = (n: number, locale?: string): string => formatCompact(n || 0, locale)

/**
 * How far into a ceiling a figure is, 0..1 — and null when there is no
 * ceiling at all. Null is a different answer from 0: an unmetered employee
 * has no meter to draw, and drawing an empty one would say "no usage".
 */
export function ratio(used: number, ceiling: number): number | null {
  if (!ceiling || ceiling <= 0) return null
  return Math.min(1, Math.max(0, (used || 0) / ceiling))
}

export type PlanStanding = {
  plan: TokenPlan
  inUsed: number
  outUsed: number
  ceilings: PlanCeilings
  /** null on an unmetered plan — nothing to fill. */
  inRatio: number | null
  outRatio: number | null
  /** The tighter of the two, which is the one that will actually bite. */
  worstRatio: number | null
  unmetered: boolean
}

export function planStanding(
  plan: TokenPlan,
  ceilings: PlanCeilings,
  monthIn: number,
  monthOut: number
): PlanStanding {
  const inRatio = ratio(monthIn, ceilings.monthlyIn)
  const outRatio = ratio(monthOut, ceilings.monthlyOut)
  const both = [inRatio, outRatio].filter((r): r is number => r !== null)
  return {
    plan,
    inUsed: monthIn || 0,
    outUsed: monthOut || 0,
    ceilings,
    inRatio,
    outRatio,
    worstRatio: both.length ? Math.max(...both) : null,
    unmetered: both.length === 0
  }
}

/** Tone for a meter, so the same thresholds are used everywhere. */
export type MeterTone = 'ok' | 'warn' | 'over'
export function toneFor(r: number | null): MeterTone {
  if (r === null) return 'ok'
  if (r >= 1) return 'over'
  if (r >= 0.8) return 'warn'
  return 'ok'
}

export const METER_TONE_CLASS: Record<MeterTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  over: 'bg-red-500'
}

export const STATUS_TONE_CLASS: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  invited: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  suspended: 'bg-red-500/15 text-red-600 dark:text-red-400',
  removed: 'bg-border/60 text-muted'
}

export const ROLE_TONE_CLASS: Record<string, string> = {
  owner: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  admin: 'border-primary/30 bg-primary/10 text-primary',
  support: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  employee: 'border-border bg-border/30 text-muted'
}

/**
 * The surfaces the API attributes spend to. '' is a call from a client that
 * named none — an older build or a script — and is shown as "unattributed"
 * rather than folded into one of the real surfaces, which would overstate it.
 */
export const SURFACE_ORDER = [
  'inapp',
  'mobile',
  'extension',
  'heartbeat',
  'procedure',
  'api',
  ''
] as const

/** A date-only day string (YYYY-MM-DD) rendered in the app's locale. */
export function formatDay(day: string, locale?: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(d)
}

export function formatWhen(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(d)
}

/**
 * Days since a timestamp, or null when there is none. Used for "last active"
 * where the exact minute matters less than the shape of the gap.
 */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

/** Total tokens across both directions — the headline "spend" on a card. */
export const totalTokens = (p: Pick<RosterPerson, 'tokens_in' | 'tokens_out'>): number =>
  (p.tokens_in || 0) + (p.tokens_out || 0)
