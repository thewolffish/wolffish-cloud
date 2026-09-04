import { Badge, type BadgeVariant } from '@/components/core/Badge'
import { cn } from '@/lib/utils/cn'
import { formatTokens } from '@/lib/utils/formatTokens'
import type { PlanCeilings, RosterPerson, TokenPlan } from '@/lib/cloud/admin'
import { I18nManager, Pressable, Text, View } from 'react-native'
import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/core/icons'
import { useTranslation } from 'react-i18next'

/**
 * The admin screens' shared parts, phone-shaped.
 *
 * The desktop admin page is a wide two-column card grid with six-figure rows
 * and inline controls. None of that survives 375 points of width, so this is
 * not that layout shrunk — it is the app's own grammar applied to the same
 * data: single-column two-line rows (the History and Leaderboard shape),
 * full-width segmented controls instead of inline tab strips, and stats in
 * pairs rather than threes, because three numbers side by side on a phone
 * are three numbers nobody can read.
 *
 * Every placeholder here reserves the exact height of the thing it stands in
 * for, and fills are SOLID `bg-border` dimmed with `opacity-*` — NativeWind
 * drops `/opacity` on var() colours (see global.css), which is how a
 * placeholder becomes invisible instead of grey.
 */

/** One placeholder line. Callers own every dimension. */
export function Bar({ className }: { className: string }): React.JSX.Element {
  return <View className={cn('bg-border rounded-full', className)} />
}

/**
 * A person row: name and badges on top, their numbers as one muted line
 * under it. `h-16` (64px at NativeWind's 14px rem) whether it holds a person
 * or a placeholder, so a list never reflows when the roster lands.
 */
export const PERSON_ROW_H = 64

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  invited: 'primary',
  suspended: 'danger',
  removed: 'default'
}

const PLAN_VARIANT: Record<TokenPlan, BadgeVariant> = {
  standard: 'default',
  high: 'primary',
  unmetered: 'primary'
}

export function PersonRow({
  person,
  isSelf,
  locale,
  onPress
}: {
  person: RosterPerson
  isSelf: boolean
  locale: string
  onPress: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const Chevron = I18nManager.isRTL ? ArrowLeft01Icon : ArrowRight01Icon
  const tokens = (person.tokens_in || 0) + (person.tokens_out || 0)
  // The plan meter is the one graphic worth a row's width here: it answers
  // "are they about to be cut off?", which is the reason an admin opens this
  // list on a phone in the first place.
  const ceiling = person.ceilings.monthlyIn
  const ratio = ceiling > 0 ? Math.min(1, person.month_tokens_in / ceiling) : null

  // Composed as ONE string rather than a run of JSX fragments: a screen
  // reader announces this line once instead of reading three unrelated
  // pieces, and it is the row's whole summary either way.
  const summary = [
    t(`settings.admin.plan.${person.token_plan}`),
    formatTokens(tokens, locale),
    person.last_active_day
      ? t('settings.admin.people.activeDays', { count: person.days_active })
      : t('settings.admin.people.neverActive')
  ].join(' · ')

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${t(`settings.admin.status.${person.status}`, { defaultValue: person.status })}`}
      onPress={onPress}
      style={{ height: PERSON_ROW_H }}
      className={cn(
        'bg-surface border-border flex-row items-center gap-3 rounded-xl border px-3 active:bg-border-soft',
        person.status === 'suspended' && 'opacity-70'
      )}
    >
      <View className="flex-1 flex-col gap-1">
        <View className="flex-row items-center gap-1.5">
          <Text
            numberOfLines={1}
            className="text-fg font-sans-medium flex-shrink text-left text-sm"
          >
            {person.name}
          </Text>
          {isSelf ? (
            <Text className="text-muted shrink-0 font-sans text-[10px]">
              {t('settings.admin.people.you')}
            </Text>
          ) : null}
          {person.status !== 'active' ? (
            <Badge
              label={t(`settings.admin.status.${person.status}`, { defaultValue: person.status })}
              variant={STATUS_VARIANT[person.status] ?? 'default'}
            />
          ) : null}
          {person.role !== 'employee' ? (
            <Badge label={t(`settings.admin.roles.${person.role}`)} variant="default" />
          ) : null}
        </View>
        <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
          {summary}
        </Text>
        {ratio !== null ? <MeterBar ratio={ratio} className="mt-0.5" /> : null}
      </View>
      <Chevron size={16} className="text-muted shrink-0" />
    </Pressable>
  )
}

/** Row for row the same box, with only the values as bars. */
export function PersonRowSkeleton({ index }: { index: number }): React.JSX.Element {
  const shape = PLACEHOLDER_SHAPES[index % PLACEHOLDER_SHAPES.length]!
  return (
    <View
      style={{ height: PERSON_ROW_H }}
      className="bg-surface border-border flex-row items-center gap-3 rounded-xl border px-3"
    >
      <View className="flex-1 flex-col gap-1">
        <View className="h-4 flex-row items-center gap-1.5">
          <Bar className={cn('h-3', shape.name)} />
          {shape.badge ? <Bar className="h-3 w-10 opacity-70" /> : null}
        </View>
        <View className="h-4 justify-center">
          <Bar className={cn('h-2.5 opacity-70', shape.meta)} />
        </View>
        <View className="mt-0.5 h-1 justify-center">
          <Bar className="h-1 w-full opacity-40" />
        </View>
      </View>
      <Bar className="h-3 w-3 shrink-0 opacity-50" />
    </View>
  )
}

/** No two placeholder rows repeat — a column of identical bars reads as one
 *  row loading many times rather than as a list of people. */
const PLACEHOLDER_SHAPES = [
  { name: 'w-[46%]', meta: 'w-[70%]', badge: false },
  { name: 'w-[34%]', meta: 'w-[54%]', badge: true },
  { name: 'w-[58%]', meta: 'w-[62%]', badge: false },
  { name: 'w-[40%]', meta: 'w-[76%]', badge: false },
  { name: 'w-[52%]', meta: 'w-[48%]', badge: true },
  { name: 'w-[36%]', meta: 'w-[66%]', badge: false }
]

/**
 * A meter's fill. Amber from 80%, red at the ceiling — the same thresholds
 * the desktop uses, so a person who looks fine on one surface looks fine on
 * the other.
 */
export function MeterBar({
  ratio,
  className
}: {
  ratio: number
  className?: string
}): React.JSX.Element {
  const tone = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <View className={cn('bg-border h-1 w-full overflow-hidden rounded-full', className)}>
      <View
        className={cn('h-full rounded-full', tone)}
        style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }}
      />
    </View>
  )
}

/**
 * A plan ceiling with its numbers. An unmetered plan draws no fill at all —
 * an empty bar would read as "no usage", which is the opposite of what
 * unmetered means.
 */
export function PlanMeter({
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
  return (
    <View className="flex-col gap-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-muted text-left font-sans text-xs">{label}</Text>
        <Text className="text-fg font-sans-medium text-xs" style={{ writingDirection: 'ltr' }}>
          {unlimited
            ? t('settings.admin.plan.noCeiling', { used: formatTokens(used, locale) })
            : `${formatTokens(used, locale)} / ${formatTokens(ceiling, locale)}`}
        </Text>
      </View>
      {unlimited ? (
        <View className="bg-border h-1 w-full rounded-full opacity-50" />
      ) : (
        <MeterBar ratio={Math.min(1, used / ceiling)} />
      )}
    </View>
  )
}

export function PlanMeterSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <View className="flex-col gap-1.5">
      <View className="h-4 flex-row items-baseline justify-between gap-3">
        <Text className="text-muted text-left font-sans text-xs">{label}</Text>
        <Bar className="h-3 w-24 opacity-70" />
      </View>
      <View className="bg-border h-1 w-full rounded-full opacity-40" />
    </View>
  )
}

/**
 * Stats in PAIRS. The desktop puts six of these in a three-wide grid; at
 * phone width a third column leaves each number about eleven characters,
 * which is fewer than "1.2M tokens" needs.
 */
export function StatPair({
  items
}: {
  items: Array<{ key: string; label: string; value: string; sub?: string }>
}): React.JSX.Element {
  return (
    <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
      {items.map((item) => (
        <View key={item.key} className="w-1/2 px-1 py-1">
          <View className="bg-bg border-border flex-col gap-0.5 rounded-xl border p-3">
            <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
              {item.label}
            </Text>
            <Text
              numberOfLines={1}
              className="text-fg font-sans-semibold text-left text-base"
              style={{ writingDirection: 'ltr' }}
            >
              {item.value}
            </Text>
            <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
              {item.sub ?? ' '}
            </Text>
          </View>
        </View>
      ))}
    </View>
  )
}

export function StatPairSkeleton({ labels }: { labels: string[] }): React.JSX.Element {
  return (
    <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
      {labels.map((label, i) => (
        <View key={label} className="w-1/2 px-1 py-1">
          <View className="bg-bg border-border flex-col gap-0.5 rounded-xl border p-3">
            <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
              {label}
            </Text>
            <View className="h-6 justify-center">
              <Bar className={cn('h-4', i % 2 === 0 ? 'w-16' : 'w-12')} />
            </View>
            <View className="h-4 justify-center">
              <Bar className="h-2.5 w-20 opacity-70" />
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

/**
 * A full-width choice. The desktop's inline tab strip is a 24px-tall row of
 * three text buttons; here each segment is a real touch target across the
 * screen, because a plan change made from a phone is usually made in a hurry.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  disabled,
  onChange
}: {
  value: T | null
  options: Array<{ value: T; label: string }>
  disabled?: boolean
  onChange: (next: T) => void
}): React.JSX.Element {
  return (
    <View className="border-border bg-bg flex-row rounded-lg border p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
            disabled={disabled}
            onPress={() => onChange(opt.value)}
            className={cn(
              'h-9 flex-1 items-center justify-center rounded-md',
              active ? 'bg-primary' : 'active:bg-border-soft',
              disabled && 'opacity-60'
            )}
          >
            <Text
              numberOfLines={1}
              className={cn('font-sans-medium text-xs', active ? 'text-primary-fg' : 'text-muted')}
            >
              {opt.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * One thing an admin can do, as a full-width row: what it is on the left,
 * the control on the right, and the consequence spelled out underneath —
 * "signs them out everywhere" has to be readable BEFORE the tap, not
 * discovered after it.
 */
export function ActionRow({
  label,
  hint,
  action
}: {
  label: string
  hint: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{hint}</Text>
      </View>
      <View className="shrink-0">{action}</View>
    </View>
  )
}

export function planBadgeVariant(plan: TokenPlan): BadgeVariant {
  return PLAN_VARIANT[plan] ?? 'default'
}

export function statusBadgeVariant(status: string): BadgeVariant {
  return STATUS_VARIANT[status] ?? 'default'
}

/** Costs are stored as integer microUSD so no row carries a float. */
export function formatUsd(microUsd: number, locale: string): string {
  const v = (microUsd || 0) / 1_000_000
  // Below a cent, "$0.00" reads as free when it is not.
  const digits = v > 0 && v < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(v)
}

export function ceilingLabel(
  ceilings: PlanCeilings,
  locale: string,
  t: (k: string, o?: Record<string, unknown>) => string
): string {
  if (!ceilings.monthlyIn && !ceilings.monthlyOut) return t('settings.admin.plan.unmeteredHint')
  return t('settings.admin.plan.ceilingHint', {
    in: formatTokens(ceilings.monthlyIn, locale),
    out: formatTokens(ceilings.monthlyOut, locale)
  })
}
