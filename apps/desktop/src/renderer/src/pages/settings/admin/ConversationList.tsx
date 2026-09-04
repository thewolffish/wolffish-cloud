import { SkeletonBar } from '@components/core/Skeleton'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import type { AdminConversationRow } from '@preload/index'
import { ChannelIcon } from '@components/common/channel-icon/ChannelIcon'
import { ComputerIcon, MessageMultiple01Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'
import { formatWhen } from '@pages/settings/admin/adminFormat'

/**
 * One employee's conversations. The row shows PROVENANCE — which surface
 * started it — and how much work it did, both read off the synced snapshot
 * envelope, so the list is answerable without opening a single transcript.
 */

/**
 * The channels ChannelIcon draws a glyph for. It deliberately renders
 * nothing for in-app conversations — the app is the default, not a badge —
 * but this list's icon column must never come up empty or the rows lose
 * their left rail, so anything it would skip gets the desktop glyph.
 */
const BADGED_CHANNELS = new Set(['mobile', 'heartbeat', 'procedure'])

function toolCallsOf(row: AdminConversationRow): number {
  const stats = row.stats as { allTime?: { toolCalls?: unknown } } | null
  const n = stats?.allTime?.toolCalls
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

export function ConversationList({
  rows,
  hasMore,
  loadingMore,
  onOpen,
  onLoadMore
}: {
  rows: AdminConversationRow[] | null
  hasMore: boolean
  loadingMore: boolean
  onOpen: (row: AdminConversationRow) => void
  onLoadMore: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()

  if (rows === null) {
    return (
      <ul className="flex flex-col" role="status" aria-label={t('common.loading')}>
        {Array.from({ length: 5 }, (_, i) => (
          <li
            key={i}
            className="border-border/60 flex items-center gap-3 border-b py-2.5 last:border-b-0"
          >
            <span className="bg-border/60 size-7 shrink-0 animate-pulse rounded-lg" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium">
                <SkeletonBar className="w-48" />
              </span>
              <span className="text-[11px]">
                <SkeletonBar className="w-32" />
              </span>
            </span>
            <span className="text-[11px]">
              <SkeletonBar className="w-24" />
            </span>
          </li>
        ))}
      </ul>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
        {t('settings.admin.conversations.empty')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col">
        {rows.map((row) => {
          const tools = toolCallsOf(row)
          return (
            <li key={row.id} className="border-border/60 border-b last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(row)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 py-2.5 text-start',
                  'hover:bg-border/20 -mx-2 rounded-lg px-2',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                )}
              >
                <span className="border-border bg-bg text-muted flex size-7 shrink-0 items-center justify-center rounded-lg border">
                  {row.icon ? (
                    <span className="text-xs">{row.icon}</span>
                  ) : BADGED_CHANNELS.has(row.channel ?? '') ? (
                    <ChannelIcon channel={row.channel} size={13} />
                  ) : (
                    <ComputerIcon size={13} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-fg truncate text-xs font-medium">
                    {row.title || t('settings.admin.conversations.untitled')}
                  </span>
                  <span className="text-muted truncate text-[11px]">
                    {t(`settings.admin.channels.${row.channel ?? 'unknown'}`, {
                      defaultValue: row.channel || t('settings.admin.channels.unknown')
                    })}
                    {' · '}
                    {t('settings.admin.conversations.messages', { count: row.message_count })}
                    {tools > 0
                      ? ` · ${t('settings.admin.conversations.actions', { count: tools })}`
                      : ''}
                    {row.archived_at ? ` · ${t('settings.admin.conversations.archived')}` : ''}
                  </span>
                </span>
                <span className="text-muted shrink-0 text-[11px]" dir="ltr">
                  {formatWhen(row.updated_at, locale) ?? ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="border-border text-fg hover:bg-border/40 cursor-pointer self-center rounded-lg border px-4 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="inline-flex items-center gap-1.5">
            <MessageMultiple01Icon size={12} />
            {t('settings.admin.conversations.loadMore')}
          </span>
        </button>
      ) : null}
    </div>
  )
}
