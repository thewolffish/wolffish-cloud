import { Button } from '@/components/core/Button'
import { ChampionIcon } from '@/components/core/icons'
import { Input } from '@/components/core/Input'
import { PanelScreen } from '@/components/settings/SettingsUI'
import { leaderboard, type WireLeaderboardPage, type WireLeaderboardRow } from '@/lib/cloud/api'
import { cloudSession } from '@/lib/cloud/session'
import { cn } from '@/lib/utils/cn'
import { formatTokens } from '@/lib/utils/formatTokens'
import { useLocale } from '@/providers/locale/useLocale'
import { useAppStore } from '@/state/appStore'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/** Page 1 is the top ten, and every later page is ten more. */
const PAGE_SIZE = 10

/**
 * Row height, reserved whether the row is a placeholder, a person, or
 * nothing at all — the list keeps PAGE_SIZE of these as a floor, so a short
 * last page and an empty search leave the pager exactly where it was.
 * 56 is the two-line row's own height (an h-14 in NativeWind's 14px rem).
 */
const ROW_H = 56

/** Name-bar widths, so the placeholder reads as people rather than as one bar
 *  repeated ten times. Same idea as HistorySkeleton's per-row shapes. */
const PLACEHOLDER_WIDTHS = [
  'w-[52%]',
  'w-[38%]',
  'w-[64%]',
  'w-[44%]',
  'w-[58%]',
  'w-[34%]',
  'w-[70%]',
  'w-[46%]',
  'w-[60%]',
  'w-[40%]'
]

/**
 * Leaderboard — the org's standing on one column: token spend, conversations
 * and the tasks the agent ran on its own, for everybody, readable by
 * everybody (the org gates it with nothing but a session).
 *
 * The desktop screen's three numeric columns do not fit a phone beside a
 * name, so each row is the app's own two-line shape instead — the person on
 * top, their three figures as one muted line under it. Everything else is
 * the desktop's: the server owns the ranking, the paging and the search, so
 * a filtered row keeps the rank it holds in the WHOLE org, and this screen
 * never sorts or renumbers anything.
 */
export default function LeaderboardScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const paired = useAppStore((state) => state.paired)

  const [search, setSearch] = useState('')
  // What the query actually asks for: the field updates on every keystroke,
  // this settles a beat later so typing a name is one request, not eight.
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim())
      // A new search starts at the top of its own results; without this,
      // typing while on page 3 asks for matches 21–30 of a set holding two.
      setOffset(0)
    }, 250)
    return () => clearTimeout(timer)
  }, [search])

  const board = useQuery({
    queryKey: ['leaderboard', query, offset],
    enabled: paired,
    // Every page and search keeps the previous answer on screen while the
    // next one is fetched — the placeholder below is a COLD state only, so
    // paging never blanks a list that is already showing numbers.
    placeholderData: (previous: WireLeaderboardPage | undefined) => previous,
    queryFn: () =>
      cloudSession.withAccessToken((token) =>
        leaderboard(token, { limit: PAGE_SIZE, offset, q: query || undefined })
      )
  })

  const page = board.data
  const rows = page?.rows ?? []
  const total = page?.total ?? 0
  const me = page?.me ?? null
  // Pinned below the list — unless this page already shows it, where a
  // second copy of the same row is just noise.
  const mePinned = me && !rows.some((r) => r.user_id === me.user_id) ? me : null
  const cold = paired && board.isLoading
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total
  // Any fetch at all: the pager goes inert while one is in flight, so a
  // double tap cannot skip a page.
  const working = board.isFetching

  return (
    <PanelScreen title={t('leaderboard.title')} subtitle={t('leaderboard.subtitle')}>
      <Input
        value={search}
        onChangeText={setSearch}
        placeholder={t('leaderboard.search')}
        accessibilityLabel={t('leaderboard.search')}
        autoCapitalize="none"
        autoCorrect={false}
        editable={paired}
      />

      <View className="bg-surface border-border overflow-hidden rounded-2xl border">
        {/* The floor is PAGE_SIZE rows tall whatever is inside it, so a short
            page, an empty search and the cold placeholder all occupy the same
            box and the pager under it never moves. */}
        <View style={{ minHeight: ROW_H * PAGE_SIZE }}>
          {cold && (
            /* One pulse for the whole list — ten rows each animating their own
               opacity is costlier and visually noisier. */
            <View className="animate-pulse flex-col">
              {PLACEHOLDER_WIDTHS.map((width, i) => (
                <View
                  key={i}
                  style={{ height: ROW_H }}
                  className="border-border-soft flex-row items-center gap-3 border-b px-4"
                >
                  <View className="border-border h-7 w-7 items-center justify-center rounded-full border">
                    <View className="bg-border h-1.5 w-2 rounded-full opacity-60" />
                  </View>
                  <View className="flex-1 flex-col gap-1.5">
                    <View className={cn('bg-border h-3 rounded-full', width)} />
                    <View className="bg-border h-2 w-[46%] rounded-full opacity-60" />
                  </View>
                </View>
              ))}
            </View>
          )}

          {!cold && rows.length === 0 && (
            <View
              style={{ minHeight: ROW_H * PAGE_SIZE }}
              className="flex-1 items-center justify-center gap-3 px-6"
            >
              <ChampionIcon size={28} className="text-muted" />
              <Text className="text-muted text-center font-sans text-sm">
                {!paired
                  ? t('leaderboard.notConnected')
                  : board.isError
                    ? t('leaderboard.error')
                    : query
                      ? t('leaderboard.noMatches')
                      : t('leaderboard.empty')}
              </Text>
            </View>
          )}

          {!cold &&
            rows.map((row) => (
              <Row key={row.user_id} row={row} isMe={row.user_id === me?.user_id} locale={locale} />
            ))}
        </View>
      </View>

      {/* Where the reader stands, whatever the page or the search shows. The
          slot is reserved either way, so it never pushes the pager. */}
      <View style={{ minHeight: ROW_H }}>
        {mePinned && (
          <View className="bg-surface border-primary overflow-hidden rounded-2xl border">
            <Row row={mePinned} isMe locale={locale} />
          </View>
        )}
      </View>

      <View className="flex-row items-center gap-3">
        <Text numberOfLines={1} className="text-muted flex-1 text-left font-sans text-xs">
          {total > 0
            ? t('leaderboard.range', {
                from: offset + 1,
                to: Math.min(offset + rows.length, total),
                total
              })
            : ''}
        </Text>
        {/* Labels never change under load — a button that renames itself
            mid-tap is a moving target. Disabled is the whole signal. */}
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrev || working}
          onPress={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        >
          {t('leaderboard.previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext || working}
          onPress={() => setOffset((o) => o + PAGE_SIZE)}
        >
          {t('leaderboard.next')}
        </Button>
      </View>
    </PanelScreen>
  )
}

/**
 * One standing. The rank rides a fixed-size circle so a `1` and a `400`
 * render in identical geometry, and the three figures share one muted line
 * — the phone has no width for three numeric columns beside a name.
 */
function Row({
  row,
  isMe,
  locale
}: {
  row: WireLeaderboardRow
  isMe: boolean
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const figures = [
    t('leaderboard.tokensValue', { value: formatTokens(row.tokens, locale) }),
    t('leaderboard.conversationsValue', { count: row.conversations }),
    t('leaderboard.agenticValue', { count: row.agentic_tasks })
  ].join(' · ')
  return (
    <View
      style={{ height: ROW_H }}
      className={cn(
        'border-border-soft flex-row items-center gap-3 border-b px-4',
        isMe && 'bg-border-soft'
      )}
    >
      <View
        className={cn(
          'h-7 w-7 items-center justify-center rounded-full border',
          row.rank <= 3 ? 'border-primary' : 'border-border'
        )}
      >
        <Text
          // The rank is a number in every locale — Arabic included, where the
          // text around it runs the other way.
          style={{ writingDirection: 'ltr' }}
          className={cn(
            'font-sans-semibold text-[10px]',
            row.rank <= 3 ? 'text-primary' : 'text-muted'
          )}
        >
          {row.rank}
        </Text>
      </View>
      <View className="flex-1 flex-col gap-0.5">
        <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
          {row.name}
          {isMe ? (
            <Text className="text-muted font-sans text-xs"> {t('leaderboard.you')}</Text>
          ) : null}
        </Text>
        <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
          {figures}
        </Text>
      </View>
    </View>
  )
}
