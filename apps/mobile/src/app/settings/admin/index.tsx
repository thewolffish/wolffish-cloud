import { Input } from '@/components/core/Input'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import {
  Bar,
  PersonRow,
  PersonRowSkeleton,
  SegmentedControl,
  formatUsd
} from '@/components/admin/AdminUI'
import { adminRoster, type RosterPerson } from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { formatTokens } from '@/lib/utils/formatTokens'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import { useLocale } from '@/providers/locale/useLocale'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

type SortKey = 'spend' | 'active' | 'name'

/** Placeholder rows: enough to fill a phone screen, not the whole company. */
const SKELETON_ROWS = 7

/**
 * Admin — People.
 *
 * The desktop lands an admin on a two-column card grid of the whole company.
 * A phone gets the same data as a single column of two-line rows, because
 * that is what the rest of this app is (History, Leaderboard) and because a
 * card grid at this width is two columns of truncation.
 *
 * The list is sorted by SPEND first rather than by name. On a desktop an
 * admin is browsing; on a phone they have a reason — usually "who is burning
 * the budget" or "find the person who just messaged me" — and the search
 * field handles the second while this ordering handles the first.
 *
 * One roster call carries the whole company, so this screen is one request
 * no matter the headcount, and pull-to-refresh is the same one request.
 */
export default function AdminPeopleScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const access = useAdminAccess()

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('spend')

  // The field updates on every keystroke; the filter settles a beat later.
  // Filtering is local (the roster is already here), so this is only about
  // not re-sorting the list under the user's thumb mid-word.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim().toLowerCase()), 180)
    return () => clearTimeout(timer)
  }, [search])

  const roster = useQuery({
    queryKey: ['admin', 'roster'],
    enabled: access.canRead,
    queryFn: () => cloudSession.withAccessToken((token) => adminRoster(token, 30))
  })

  const people = useMemo<RosterPerson[]>(() => {
    const all = roster.data?.people ?? []
    const matched = query
      ? all.filter(
          (p) =>
            p.name.toLowerCase().includes(query) ||
            p.email.toLowerCase().includes(query) ||
            p.role.includes(query)
        )
      : all
    const sorted = [...matched]
    if (sort === 'spend') {
      sorted.sort((a, b) => b.cost_microusd - a.cost_microusd || b.tokens_in - a.tokens_in)
    } else if (sort === 'active') {
      // Never-active sorts last, not first: a plain descending compare on an
      // empty day string would put everyone who has never signed in on top.
      sorted.sort((a, b) => (b.last_active_day ?? '').localeCompare(a.last_active_day ?? ''))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    }
    return sorted
  }, [roster.data, query, sort])

  if (!access.canRead) {
    return (
      <PanelScreen title={t('settings.admin.title')}>
        <Section>
          <Text className="text-muted text-left font-sans text-sm leading-relaxed">
            {t('settings.admin.noAccess')}
          </Text>
        </Section>
      </PanelScreen>
    )
  }

  const cold = roster.isLoading
  const totals = roster.data
    ? roster.data.people.reduce(
        (acc, p) => ({
          active: acc.active + (p.status === 'active' ? 1 : 0),
          people: acc.people + 1,
          tokens: acc.tokens + p.tokens_in + p.tokens_out,
          cost: acc.cost + p.cost_microusd
        }),
        { active: 0, people: 0, tokens: 0, cost: 0 }
      )
    : null

  return (
    <PanelScreen
      title={t('settings.admin.title')}
      subtitle={
        access.canWrite ? t('settings.admin.subtitle') : t('settings.admin.subtitleReadOnly')
      }
    >
      {/* The company in one line, above the list — the number an admin
          checks before they decide whether to open anybody. */}
      <Section>
        <View className="flex-row">
          {(
            [
              { key: 'people', value: totals ? `${totals.active}/${totals.people}` : null },
              { key: 'tokens', value: totals ? formatTokens(totals.tokens, locale) : null },
              { key: 'cost', value: totals ? formatUsd(totals.cost, locale) : null }
            ] as const
          ).map((cell) => (
            <View key={cell.key} className="flex-1 flex-col gap-1">
              <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
                {t(`settings.admin.summary.${cell.key}`)}
              </Text>
              <View className="h-6 justify-center">
                {cell.value === null ? (
                  <Bar className="h-4 w-14" />
                ) : (
                  <Text
                    numberOfLines={1}
                    className="text-fg font-sans-semibold text-left text-base"
                    style={{ writingDirection: 'ltr' }}
                  >
                    {cell.value}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      </Section>

      <View className="flex-col gap-3">
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder={t('settings.admin.people.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        <SegmentedControl<SortKey>
          value={sort}
          onChange={setSort}
          options={[
            { value: 'spend', label: t('settings.admin.people.sort.spend') },
            { value: 'active', label: t('settings.admin.people.sort.active') },
            { value: 'name', label: t('settings.admin.people.sort.name') }
          ]}
        />
      </View>

      <View className="flex-col gap-2">
        {cold ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => <PersonRowSkeleton key={i} index={i} />)
        ) : people.length === 0 ? (
          <View className="border-border rounded-xl border border-dashed px-4 py-10">
            <Text className="text-muted text-center font-sans text-sm">
              {roster.isError
                ? t('settings.admin.people.loadFailed')
                : t('settings.admin.people.noMatches')}
            </Text>
          </View>
        ) : (
          people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              isSelf={
                access.email !== null && person.email.toLowerCase() === access.email.toLowerCase()
              }
              locale={locale}
              onPress={() => router.push(`/settings/admin/person/${person.id}`)}
            />
          ))
        )}
      </View>

      {/* The two org-wide screens live below the list rather than behind a
          tab bar: on a phone they are visited rarely, and a tab strip would
          spend permanent screen width on them. */}
      <View className="flex-col gap-2">
        <NavTile
          label={t('settings.admin.org.title')}
          hint={t('settings.admin.org.subtitle')}
          onPress={() => router.push('/settings/admin/org')}
        />
        <NavTile
          label={t('settings.admin.audit.title')}
          hint={t('settings.admin.audit.subtitle')}
          onPress={() => router.push('/settings/admin/audit')}
        />
      </View>
    </PanelScreen>
  )
}

function NavTile({
  label,
  hint,
  onPress
}: {
  label: string
  hint: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="bg-surface border-border flex-col gap-0.5 rounded-xl border px-4 py-3 active:bg-border-soft"
    >
      <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
      <Text numberOfLines={2} className="text-muted text-left font-sans text-xs leading-relaxed">
        {hint}
      </Text>
    </Pressable>
  )
}
