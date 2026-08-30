import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon } from '@/components/core/icons'
import type { ToolCallInfo, ToolResultInfo } from '@/lib/conversations/segments'
import type { ToolTiming } from '@/lib/conversations/types'
import { NEEDS_SELECT_SHEET, openSelectText } from '@/components/chat/SelectTextSheet'
import { cn } from '@/lib/utils/cn'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { I18nManager, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Verbose-feed tool card — the mobile take on the desktop ToolCard: status
 * pill, tool name, headline action, and expandable args/output/error blocks.
 * Long outputs are clamped; unknown tool names render fine (the workspace
 * data contains 150 distinct tools, some with typos — never assume a name).
 */

const OUTPUT_CLAMP = 1200

/** Best single-line summary of the call, like the desktop "action" headline. */
function headlineFor(call: ToolCallInfo): string | null {
  const args = call.args
  const candidates = ['command', 'path', 'file_path', 'url', 'query', 'prompt', 'to', 'title']
  for (const key of candidates) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function statusTone(status: ToolResultInfo['status'] | 'running'): {
  container: string
  text: string
} {
  switch (status) {
    case 'success':
      return { container: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' }
    case 'failed':
      return { container: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400' }
    case 'denied':
      return { container: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' }
    default:
      return { container: 'bg-primary/15', text: 'text-primary' }
  }
}

/** The monospace payload block. Shared with the approval card, which shows the
 *  exact command and args a flagged tool call would run.
 *
 *  A command, a path, an error string — this is the text most likely to be
 *  wanted in pieces, so it gets the same treatment as a message bubble: real
 *  in-place selection on Android, the free-selection sheet on iOS. The sheet
 *  shows the UNCLAMPED text, since a long output is exactly the case where the
 *  clamp would otherwise hide the line you were reaching for. */
export function CodeBlockText({
  text,
  error
}: {
  text: string
  error?: boolean
}): React.JSX.Element {
  const clamped = text.length > OUTPUT_CLAMP ? `${text.slice(0, OUTPUT_CLAMP)}…` : text
  return (
    <ScrollView
      horizontal={false}
      className={cn('bg-bg border-border max-h-48 rounded-md border', error && 'border-red-500/40')}
      nestedScrollEnabled
    >
      <Text
        selectable={!NEEDS_SELECT_SHEET}
        // The sheet gets the UNCLAMPED text: a long output is exactly the case
        // where the line you were reaching for is past the clamp.
        onLongPress={NEEDS_SELECT_SHEET ? () => openSelectText(text) : undefined}
        suppressHighlighting
        style={{ writingDirection: 'ltr' }}
        className={cn(
          'p-2.5 text-left font-mono text-xs leading-4',
          error ? 'text-red-600 dark:text-red-400' : 'text-fg'
        )}
      >
        {clamped}
      </Text>
    </ScrollView>
  )
}

export type ToolCardProps = {
  call: ToolCallInfo
  result?: ToolResultInfo
  timing?: ToolTiming
}

export const ToolCard = memo(function ToolCard({
  call,
  result,
  timing
}: ToolCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const status = result?.status ?? 'running'
  const tone = statusTone(status)
  const headline = headlineFor(call)
  const elapsed =
    timing?.endedAt && timing.startedAt
      ? `${((timing.endedAt - timing.startedAt) / 1000).toFixed(1)}s`
      : null
  const statusLabel = t(`chat.toolCard.status.${status === 'success' ? 'success' : status}`)
  // Collapsed chevron points into the reading direction.
  const Chevron = expanded
    ? ArrowDown01Icon
    : I18nManager.isRTL
      ? ArrowLeft01Icon
      : ArrowRight01Icon

  return (
    <View className="bg-surface border-border w-full max-w-full flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center gap-2"
      >
        <View className={cn('rounded-full px-2 py-0.5', tone.container)}>
          <Text className={cn('font-sans-medium text-[10px]', tone.text)}>{statusLabel}</Text>
        </View>
        <Text numberOfLines={1} className="text-fg font-sans-medium flex-1 text-left text-xs">
          {call.name}
        </Text>
        {elapsed && <Text className="text-muted font-sans text-[10px]">{elapsed}</Text>}
        <Chevron size={14} className="text-muted" />
      </Pressable>
      {headline && <CodeBlockText text={headline} />}
      {expanded && (
        <View className="flex-col gap-2">
          {Object.keys(call.args).length > 0 && (
            <View className="flex-col gap-1">
              <Text className="text-muted font-sans-medium text-left text-[10px]">
                {t('chat.toolCard.args')}
              </Text>
              <CodeBlockText text={JSON.stringify(call.args, null, 2)} />
            </View>
          )}
          {result?.output ? (
            <View className="flex-col gap-1">
              <Text className="text-muted font-sans-medium text-left text-[10px]">
                {t('chat.toolCard.output')}
              </Text>
              <CodeBlockText text={result.output} />
            </View>
          ) : null}
          {result?.error ? (
            <View className="flex-col gap-1">
              <Text className="text-muted font-sans-medium text-left text-[10px]">
                {t('chat.toolCard.error')}
              </Text>
              <CodeBlockText text={result.error} error />
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
})
