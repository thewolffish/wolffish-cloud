import { Avatar } from '@components/common/profile/Avatar'
import { SkeletonBar } from '@components/core/Skeleton'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import type { AdminRoster, RosterPerson } from '@preload/index'
import { CalendarCheckOut02Icon, Search01Icon, SmartPhone01Icon } from 'hugeicons-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatTokens,
  formatUsd,
  planStanding,
  totalTokens
} from '@pages/settings/admin/adminFormat'
import {
  Meter,
  MeterSkeleton,
  PlanBadge,
  RoleBadge,
  StatusBadge
} from '@pages/settings/admin/parts'

type SortKey = 'name' | 'spend' | 'active'

/**
 * The people screen: one card per employee, in the same grid and the same
 * card shape as Services — because it is the same kind of screen. A card
 * carries what an admin scans for before deciding whom to open: who they
 * are, what they cost, how much of their plan is gone, and whether they
 * have been around lately.
 *
 * Every number on a card comes from ONE roster call for the whole company,
 * so opening this screen is one request regardless of headcount.
 */
export function PeopleGrid({
  roster,
  selfEmail,
  onOpen
}: {
  roster: AdminRoster | null
  selfEmail: string | null
  onOpen: (userId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('spend')

  const people = useMemo(() => {
    if (!roster) return []
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? roster.people.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.email.toLowerCase().includes(needle) ||
            p.role.includes(needle)
        )
      : roster.people
    const sorted = [...matched]
    if (sort === 'spend')
      sorted.sort((a, b) => b.cost_microusd - a.cost_microusd || totalTokens(b) - totalTokens(a))
    else if (sort === 'active') {
      // Never active sorts last, not first — an empty string would win a
      // plain descending compare on the day stamp.
      sorted.sort((a, b) => (b.last_active_day ?? '').localeCompare(a.last_active_day ?? ''))
    } else sorted.sort((a, b) => a.name.localeCompare(b.name))
    return sorted
  }, [roster, query, sort])

  const loading = roster === null

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search01Icon
            size={16}
            className="text-muted pointer-events-none absolute start-3 top-1/2 -translate-y-1/2"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.admin.people.searchPlaceholder')}
            aria-label={t('settings.admin.people.searchPlaceholder')}
            className={cn(
              'bg-surface text-fg border-border placeholder:text-muted hover:border-muted',
              'h-10 w-full rounded-lg border ps-10 pe-3 text-sm',
              'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          />
        </div>
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {(['spend', 'active', 'name'] as SortKey[]).map((key) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={sort === key}
              onClick={() => setSort(key)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                sort === key
                  ? 'bg-primary text-primary-fg shadow-sm'
                  : 'text-muted hover:text-fg cursor-pointer'
              )}
            >
              {t(`settings.admin.people.sort.${key}`)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <ul className="grid grid-cols-2 gap-3" role="status" aria-label={t('common.loading')}>
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="min-w-0">
              <PersonCardSkeleton />
            </li>
          ))}
        </ul>
      ) : people.length === 0 ? (
        <div className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
          {t('settings.admin.people.noMatches')}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3">
          {people.map((p) => (
            <li key={p.id} className="min-w-0">
              <PersonCard
                person={p}
                isSelf={selfEmail !== null && p.email.toLowerCase() === selfEmail.toLowerCase()}
                locale={locale}
                onOpen={() => onOpen(p.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PersonCard({
  person,
  isSelf,
  locale,
  onOpen
}: {
  person: RosterPerson
  isSelf: boolean
  locale: string
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const standing = planStanding(
    person.token_plan,
    person.ceilings,
    person.month_tokens_in,
    person.month_tokens_out
  )
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'bg-surface border-border hover:border-muted flex h-full w-full cursor-pointer flex-col gap-3 rounded-2xl border p-4 text-start',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        person.status === 'suspended' && 'opacity-70'
      )}
    >
      <span className="flex w-full items-start gap-3">
        <Avatar name={person.name} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-fg truncate text-sm font-semibold">{person.name}</span>
            {isSelf ? (
              <span className="text-muted shrink-0 text-[10px]">
                {t('settings.admin.people.you')}
              </span>
            ) : null}
          </span>
          <span className="text-muted truncate text-xs" dir="ltr">
            {person.email}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={person.status} />
          <RoleBadge role={person.role} />
        </span>
      </span>

      {/* The glance row: spend, activity, reach. */}
      <span className="grid grid-cols-3 gap-2">
        <Glance
          label={t('settings.admin.people.tokens')}
          value={formatTokens(totalTokens(person), locale)}
        />
        <Glance
          label={t('settings.admin.people.cost')}
          value={formatUsd(person.cost_microusd, locale)}
        />
        <Glance
          label={t('settings.admin.people.daysActive')}
          value={String(person.days_active)}
          icon={CalendarCheckOut02Icon}
        />
      </span>

      <span className="flex flex-col gap-2">
        <span className="flex items-center justify-between gap-2">
          <PlanBadge plan={person.token_plan} />
          <span className="text-muted truncate text-[11px]">
            {person.last_active_day
              ? t('settings.admin.people.lastActive', { day: person.last_active_day })
              : t('settings.admin.people.neverActive')}
          </span>
        </span>
        <Meter
          label={t('settings.admin.plan.monthInput')}
          used={standing.inUsed}
          ceiling={standing.ceilings.monthlyIn}
          locale={locale}
        />
      </span>

      <span className="text-muted flex items-center gap-3 text-[11px]">
        <span>{t('settings.admin.people.conversations', { count: person.conversations })}</span>
        <span>·</span>
        <span>{t('settings.admin.people.searches', { count: person.searches })}</span>
        {person.phones > 0 ? (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <SmartPhone01Icon size={11} />
              {person.phones}
            </span>
          </>
        ) : null}
      </span>
    </button>
  )
}

function Glance({
  label,
  value,
  icon: Icon
}: {
  label: string
  value: string
  icon?: React.ComponentType<{ size?: number; className?: string }>
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted flex items-center gap-1 text-[10px]">
        {Icon ? <Icon size={10} className="shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className="text-fg truncate text-sm font-semibold tabular-nums" dir="ltr">
        {value}
      </span>
    </span>
  )
}

/**
 * Row for row, the same card: same avatar box, same two identity lines, the
 * same three glances, the same badge row and the same meter. Only the
 * values pulse, so when the roster lands nothing moves.
 */
function PersonCardSkeleton(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="bg-surface border-border flex h-full w-full flex-col gap-3 rounded-2xl border p-4">
      <div className="flex w-full items-start gap-3">
        <span className="bg-border/60 size-9 shrink-0 animate-pulse rounded-full" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">
            <SkeletonBar className="w-28" />
          </span>
          <span className="text-xs">
            <SkeletonBar className="w-36" />
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <SkeletonBar className="w-16 rounded-full text-[10px]" />
          <SkeletonBar className="w-14 rounded-full text-[10px]" />
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          t('settings.admin.people.tokens'),
          t('settings.admin.people.cost'),
          t('settings.admin.people.daysActive')
        ].map((label) => (
          <span key={label} className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted truncate text-[10px]">{label}</span>
            <span className="text-sm font-semibold">
              <SkeletonBar className="w-12" />
            </span>
          </span>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className="flex items-center justify-between gap-2">
          <SkeletonBar className="w-16 rounded-full text-[10px]" />
          <SkeletonBar className="w-24 text-[11px]" />
        </span>
        <MeterSkeleton label={t('settings.admin.plan.monthInput')} />
      </div>

      <span className="text-[11px]">
        <SkeletonBar className="w-40" />
      </span>
    </div>
  )
}
