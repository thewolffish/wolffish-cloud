import { PanelScreen } from '@/components/settings/SettingsUI'
import { Bar } from '@/components/admin/AdminUI'
import { ChannelBadge } from '@/components/conversations/ChannelBadge'
import { adminConversations, type AdminConversationRow } from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { useInfiniteQuery } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/** Reserved height for a row, placeholder or real — the list never reflows. */
const ROW_H = 60
const SKELETON_ROWS = 6

/**
 * Admin — one person's conversations.
 *
 * Each row says where the conversation came from and how much work it did,
 * both read off the synced snapshot envelope, so this list answers "was the
 * phone or an automation doing this?" without opening anything. Opening one
 * is the only thing here that is audited, which is why the list carries so
 * much: most questions should be answerable before that point.
 */
export default function AdminConversationsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const access = useAdminAccess()
  const { userId } = useLocalSearchParams<{ userId: string }>()

  const list = useInfiniteQuery({
    queryKey: ['admin', 'conversations', userId],
    enabled: access.canRead && Boolean(userId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      cloudSession.withAccessToken((token) =>
        adminConversations(token, userId, { before: pageParam, limit: 25 })
      ),
    getNextPageParam: (last) => last.next ?? undefined
  })

  const rows = list.data?.pages.flatMap((p) => p.conversations) ?? []
  const cold = list.isLoading

  return (
    <PanelScreen title={t('settings.admin.conversations.title')}>
      <Text className="text-muted text-left font-sans text-xs leading-relaxed">
        {t('settings.admin.conversations.subtitle')}
      </Text>

      <View className="flex-col gap-2">
        {cold ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => <RowSkeleton key={i} index={i} />)
        ) : rows.length === 0 ? (
          <View className="border-border rounded-xl border border-dashed px-4 py-10">
            <Text className="text-muted text-center font-sans text-sm">
              {list.isError
                ? t('settings.admin.conversations.loadFailed')
                : t('settings.admin.conversations.empty')}
            </Text>
          </View>
        ) : (
          rows.map((row) => (
            <ConversationRow
              key={row.id}
              row={row}
              onPress={() => router.push(`/settings/admin/transcript/${row.id}`)}
            />
          ))
        )}
      </View>

      {list.hasNextPage ? (
        <Pressable
          accessibilityRole="button"
          disabled={list.isFetchingNextPage}
          onPress={() => void list.fetchNextPage()}
          className="border-border h-10 items-center justify-center self-center rounded-lg border px-4 active:bg-border-soft"
        >
          <Text className="text-fg font-sans-medium text-sm">
            {t('settings.admin.conversations.loadMore')}
          </Text>
        </Pressable>
      ) : null}
    </PanelScreen>
  )
}

function toolCallsOf(row: AdminConversationRow): number {
  const stats = row.stats as { allTime?: { toolCalls?: unknown } } | null
  const n = stats?.allTime?.toolCalls
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function ConversationRow({
  row,
  onPress
}: {
  row: AdminConversationRow
  onPress: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tools = toolCallsOf(row)
  const updated = Date.parse(row.updated_at)
  // One string, one announcement — see PersonRow for why.
  const summary = [
    t(`settings.admin.channels.${row.channel ?? 'unknown'}`, {
      defaultValue: row.channel || t('settings.admin.channels.unknown')
    }),
    t('settings.admin.conversations.messages', { count: row.message_count }),
    ...(tools > 0 ? [t('settings.admin.conversations.actions', { count: tools })] : []),
    ...(Number.isFinite(updated) ? [formatRelativeTime(updated, t)] : [])
  ].join(' · ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.title || t('settings.admin.conversations.untitled')}
      onPress={onPress}
      style={{ height: ROW_H }}
      className="bg-surface border-border flex-row items-center gap-2 rounded-xl border px-3 active:bg-border-soft"
    >
      <View className="flex-1 flex-col gap-1">
        <View className="flex-row items-center gap-1.5">
          <ChannelBadge
            icon={row.icon}
            channel={row.channel as Parameters<typeof ChannelBadge>[0]['channel']}
            size={12}
          />
          <Text numberOfLines={1} className="text-fg font-sans-medium flex-1 text-left text-sm">
            {row.title || t('settings.admin.conversations.untitled')}
          </Text>
        </View>
        <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
          {summary}
        </Text>
      </View>
    </Pressable>
  )
}

const SHAPES = ['w-[62%]', 'w-[44%]', 'w-[74%]', 'w-[38%]', 'w-[56%]', 'w-[68%]']

function RowSkeleton({ index }: { index: number }): React.JSX.Element {
  return (
    <View
      style={{ height: ROW_H }}
      className="bg-surface border-border flex-row items-center gap-2 rounded-xl border px-3"
    >
      <View className="flex-1 flex-col gap-1">
        <View className="h-4 flex-row items-center gap-1.5">
          <Bar className="h-3 w-3 opacity-70" />
          <Bar className={`h-3 ${SHAPES[index % SHAPES.length]}`} />
        </View>
        <View className="h-4 justify-center">
          <Bar className="h-2.5 w-[58%] opacity-70" />
        </View>
      </View>
    </View>
  )
}
