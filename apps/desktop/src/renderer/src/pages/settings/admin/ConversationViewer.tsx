import { SkeletonBar, SkeletonBlock } from '@components/core/Skeleton'
import { cn } from '@lib/utils/cn'
import { mapConversationMessages } from '@lib/conversation-open'
import { useLocale } from '@providers/locale/useLocale'
import type { ChatMessage } from '@providers/flow/useFlow'
import type { AdminTranscript } from '@preload/index'
import { AssistantBubble, UserBubble } from '@pages/Chat'
import { ArrowLeft02Icon, ArrowRight02Icon } from 'hugeicons-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RTL_LOCALES } from '@lib/i18n'
import { formatWhen } from '@pages/settings/admin/adminFormat'
import { actionLog, type ActionEntry } from '@pages/settings/admin/actionLog'

/**
 * One employee's conversation, as the admin sees it — which is to say, as
 * the EMPLOYEE saw it.
 *
 * The records are rebuilt into a ConversationFile by the same
 * `rebuildConversation` restore uses, mapped by the same
 * `mapConversationMessages` the chat page uses, and drawn by the same
 * `UserBubble` / `AssistantBubble` the chat page draws. Nothing here is an
 * admin-flavoured re-implementation, because a second renderer would drift
 * from the real one silently — showing a transcript that looks complete
 * while quietly dropping a card type nobody remembered to port.
 *
 * What IS different: it is read-only and it is never cached. The approval
 * and ask callbacks are inert (those decisions were made when the turn ran
 * and cannot be revisited months later from someone else's screen), and the
 * conversation never touches the admin's disk — closing the screen is the
 * end of its lifetime.
 *
 * Two tabs, because an admin arrives with one of two questions. The
 * TRANSCRIPT answers "what was said". The LOG answers "what did it DO" —
 * every tool call in order, which for a browser-extension conversation is
 * literally the list of actions taken in the employee's browser.
 */

type Tab = 'transcript' | 'log'

export function ConversationViewer({
  conversationId,
  title,
  onBack
}: {
  conversationId: string
  title: string
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const [tab, setTab] = useState<Tab>('transcript')
  const [data, setData] = useState<AdminTranscript | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Mounted fresh per conversation (the parent keys on the id), so this
  // effect only ever fetches — there is no previous conversation's state
  // left to clear, which is what a reset here would have been for.
  useEffect(() => {
    let cancelled = false
    void window.api.admin
      .readConversation(conversationId)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const messages = useMemo<ChatMessage[] | null>(
    () => (data ? mapConversationMessages(data.conversation) : null),
    [data]
  )
  const actions = useMemo(() => (data ? actionLog(data.conversation) : null), [data])

  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            'text-muted hover:text-fg -ms-2 flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <BackIcon size={16} />
          <span>{t('settings.admin.conversations.backToUser')}</span>
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-fg truncate text-xl font-semibold tracking-tight">
              {data?.conversation.title || title || t('settings.admin.conversations.untitled')}
            </h1>
            <p className="text-muted text-xs">
              {data ? (
                <>
                  {data.owner.name || data.owner.email || data.owner.userId}
                  {data.conversation.updatedAt
                    ? ` · ${formatWhen(new Date(data.conversation.updatedAt).toISOString(), locale)}`
                    : ''}
                </>
              ) : (
                <SkeletonBar className="w-56" />
              )}
            </p>
          </div>
          <div
            role="tablist"
            className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
          >
            {(['transcript', 'log'] as Tab[]).map((key) => (
              <button
                key={key}
                role="tab"
                type="button"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  tab === key
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer'
                )}
              >
                {t(`settings.admin.conversations.tabs.${key}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error !== null ? (
        <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
          {t('settings.admin.conversations.readFailed', { error })}
        </p>
      ) : null}

      {data?.truncated ? (
        <p className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-xl border px-4 py-2 text-xs">
          {t('settings.admin.conversations.truncated')}
        </p>
      ) : null}

      {tab === 'transcript' ? (
        <TranscriptView messages={messages} loading={data === null && error === null} />
      ) : (
        <LogView entries={actions} loading={data === null && error === null} />
      )}
    </div>
  )
}

/**
 * The transcript. `readOnly` is enforced by giving the interactive callbacks
 * nothing to do: approvals and asks belong to a turn that finished, and the
 * cards render in their settled state.
 */
function TranscriptView({
  messages,
  loading
}: {
  messages: ChatMessage[] | null
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const noop = (): void => undefined

  if (loading || messages === null) return <TranscriptSkeleton />

  if (messages.length === 0) {
    return (
      <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
        {t('settings.admin.conversations.emptyTranscript')}
      </p>
    )
  }

  return (
    <div className="bg-surface border-border flex flex-col gap-6 rounded-2xl border p-6">
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserBubble
            key={m.id}
            content={m.content}
            attachments={m.attachments}
            voicePrompt={m.voicePrompt}
            timestamp={m.timestamp}
            t={t}
          />
        ) : (
          <AssistantBubble
            key={m.id}
            message={m}
            awaitingApproval={false}
            awaitingAsk={false}
            onApprovalDecision={noop}
            onAskRespond={noop}
          />
        )
      )}
    </div>
  )
}

/**
 * A prompt bubble and a reply block, twice — the same alternating rhythm and
 * the same paddings the transcript has, so the panel is already its final
 * shape while the records load.
 */
function TranscriptSkeleton(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="bg-surface border-border flex flex-col gap-6 rounded-2xl border p-6"
      role="status"
      aria-label={t('common.loading')}
    >
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-6">
          <div className="flex w-full flex-col items-end gap-1.5">
            <SkeletonBlock className="h-10 w-[45%] rounded-2xl" />
          </div>
          <div className="flex w-full flex-col gap-2">
            <SkeletonBar className="w-[85%] text-sm" />
            <SkeletonBar className="w-[92%] text-sm" />
            <SkeletonBar className="w-[70%] text-sm" />
            <SkeletonBlock className="mt-1 h-9 w-full rounded-xl" />
          </div>
        </div>
      ))}
    </div>
  )
}

function LogView({
  entries,
  loading
}: {
  entries: ActionEntry[] | null
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation()

  if (loading || entries === null) {
    return (
      <div
        className="bg-surface border-border flex flex-col rounded-2xl border p-6"
        role="status"
        aria-label={t('common.loading')}
      >
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="border-border/60 flex items-baseline gap-3 border-b py-2 last:border-b-0"
          >
            <SkeletonBar className="w-28 shrink-0 font-mono text-xs" />
            <SkeletonBar className="min-w-0 flex-1 text-xs" />
          </div>
        ))}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
        {t('settings.admin.conversations.emptyLog')}
      </p>
    )
  }

  const browserCount = entries.filter((e) => e.browser).length
  return (
    <div className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <p className="text-muted text-xs">
        {t('settings.admin.conversations.logSummary', {
          count: entries.length,
          browser: browserCount
        })}
      </p>
      <ol className="flex flex-col">
        {entries.map((e, i) => (
          <li
            key={`${e.id}-${i}`}
            className="border-border/60 flex items-baseline gap-3 border-b py-2 last:border-b-0"
          >
            <span
              className={cn('shrink-0 font-mono text-xs', e.browser ? 'text-primary' : 'text-fg')}
              dir="ltr"
            >
              {e.name}
            </span>
            <span className="text-muted min-w-0 flex-1 truncate text-xs" dir="ltr" title={e.detail}>
              {e.detail}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
