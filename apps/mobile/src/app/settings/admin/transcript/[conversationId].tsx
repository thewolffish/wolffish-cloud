import { AssistantMessageView, UserBubble } from '@/components/chat/MessageBubbles'
import { PanelScreen } from '@/components/settings/SettingsUI'
import { Bar, SegmentedControl } from '@/components/admin/AdminUI'
import { actionLog } from '@/lib/admin/actionLog'
import { adminTranscript } from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { rebuildConversation, rebuiltToMessages } from '@/lib/sync/rebuild'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import type { ConversationMessage } from '@/lib/conversations/types'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

type Tab = 'transcript' | 'log'

/**
 * Admin — one conversation, read as its owner reads it.
 *
 * The records are rebuilt with `rebuildConversation` — the same function
 * this phone uses on its own conversations — and drawn with the same
 * `UserBubble` and `AssistantMessageView` the chat screen draws. Not a
 * simplified admin rendering: a second renderer drifts one message type at
 * a time, and the drift is invisible, producing a transcript that looks
 * complete while quietly omitting a card.
 *
 * It is read-only and it is never stored. Nothing here reaches SQLite, and
 * the query is excluded from the persisted cache (lib/query/queryClient) —
 * a lost phone must not be carrying the company's transcripts.
 *
 * Two tabs, because an admin arrives with one of two questions. TRANSCRIPT
 * answers "what was said"; LOG answers "what did it DO" — every tool call
 * in order, which for a conversation that drove the browser extension is
 * the list of actions taken in that person's browser.
 */
export default function AdminTranscriptScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const access = useAdminAccess()
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>()
  const [tab, setTab] = useState<Tab>('transcript')

  const transcript = useQuery({
    queryKey: ['admin', 'transcript', conversationId],
    enabled: access.canRead && Boolean(conversationId),
    queryFn: () => cloudSession.withAccessToken((token) => adminTranscript(token, conversationId))
  })

  const messages = useMemo<ConversationMessage[] | null>(
    () =>
      transcript.data ? rebuiltToMessages(rebuildConversation(transcript.data.records)) : null,
    [transcript.data]
  )
  const actions = useMemo(() => (messages ? actionLog(messages) : null), [messages])

  const owner = transcript.data?.conversation
  const cold = transcript.isLoading

  return (
    <PanelScreen title={owner?.title || t('settings.admin.conversations.untitled')}>
      <View className="h-4 justify-center">
        {owner ? (
          <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
            {owner.user_name || owner.user_email || owner.user_id}
          </Text>
        ) : (
          <Bar className="h-3 w-40 opacity-70" />
        )}
      </View>

      <SegmentedControl<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'transcript', label: t('settings.admin.conversations.tabs.transcript') },
          { value: 'log', label: t('settings.admin.conversations.tabs.log') }
        ]}
      />

      {transcript.isError ? (
        <View className="border-border rounded-xl border border-dashed px-4 py-10">
          <Text className="text-muted text-center font-sans text-sm">
            {t('settings.admin.conversations.loadFailed')}
          </Text>
        </View>
      ) : null}

      {transcript.data?.truncated ? (
        <View className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <Text className="text-fg text-left font-sans text-xs leading-relaxed">
            {t('settings.admin.conversations.truncated')}
          </Text>
        </View>
      ) : null}

      {tab === 'transcript' ? (
        cold ? (
          <TranscriptSkeleton />
        ) : messages && messages.length > 0 ? (
          <View className="flex-col gap-5">
            {messages.map((message) =>
              message.role === 'user' ? (
                <UserBubble key={message.id} message={message} />
              ) : (
                <AssistantMessageView key={message.id} message={message} verbose={false} />
              )
            )}
          </View>
        ) : transcript.isError ? null : (
          <Text className="text-muted text-center font-sans text-sm">
            {t('settings.admin.conversations.emptyTranscript')}
          </Text>
        )
      ) : cold ? (
        <LogSkeleton />
      ) : actions && actions.length > 0 ? (
        <View className="flex-col gap-2">
          <Text className="text-muted text-left font-sans text-xs">
            {t('settings.admin.conversations.logSummary', {
              count: actions.length,
              browser: actions.filter((a) => a.browser).length
            })}
          </Text>
          <View className="bg-surface border-border flex-col rounded-2xl border px-4">
            {actions.map((entry, i) => (
              <View
                key={`${entry.id}-${i}`}
                className="border-border-soft flex-col gap-0.5 border-b py-2.5"
              >
                <Text
                  numberOfLines={1}
                  className={`text-left font-mono text-xs ${entry.browser ? 'text-primary' : 'text-fg'}`}
                  style={{ writingDirection: 'ltr' }}
                >
                  {entry.name}
                </Text>
                {entry.detail ? (
                  <Text
                    numberOfLines={2}
                    className="text-muted text-left font-sans text-[11px]"
                    style={{ writingDirection: 'ltr' }}
                  >
                    {entry.detail}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      ) : transcript.isError ? null : (
        <Text className="text-muted text-center font-sans text-sm">
          {t('settings.admin.conversations.emptyLog')}
        </Text>
      )}
    </PanelScreen>
  )
}

/**
 * A prompt and a reply, twice — the transcript's own alternating rhythm at
 * its own widths, so the screen is already its final shape while the records
 * are in flight.
 */
function TranscriptSkeleton(): React.JSX.Element {
  return (
    <View className="flex-col gap-5">
      {[0, 1].map((i) => (
        <View key={i} className="flex-col gap-5">
          <View className="items-end">
            <View className="bg-border h-10 w-[55%] rounded-2xl opacity-70" />
          </View>
          <View className="flex-col gap-2">
            <Bar className="h-3 w-[88%]" />
            <Bar className="h-3 w-[94%]" />
            <Bar className="h-3 w-[62%]" />
            <View className="bg-border mt-1 h-9 w-full rounded-xl opacity-50" />
          </View>
        </View>
      ))}
    </View>
  )
}

function LogSkeleton(): React.JSX.Element {
  const widths = ['w-24', 'w-32', 'w-20', 'w-28', 'w-36', 'w-24', 'w-30', 'w-20']
  return (
    <View className="bg-surface border-border flex-col rounded-2xl border px-4">
      {widths.map((w, i) => (
        <View key={i} className="border-border-soft h-14 flex-col justify-center gap-1 border-b">
          <Bar className={`h-3 ${w}`} />
          <Bar className="h-2.5 w-[70%] opacity-70" />
        </View>
      ))}
    </View>
  )
}
