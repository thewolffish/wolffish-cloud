import {
  CancelCircleIcon,
  Clock01Icon,
  Image02Icon,
  PauseIcon,
  PlayIcon
} from '@/components/core/icons'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { ComposerSubmit } from '@/components/chat/Composer'

/**
 * Messages written while a turn was still running, waiting for it to end.
 *
 * The desktop's queue, unchanged: a prompt submitted mid-turn is not refused
 * and does not enter the feed — it waits in a cancelable row above the
 * composer and is sent, through the ordinary send path, the moment the running
 * turn finishes. A message only becomes a bubble once it is actually sent.
 *
 * A queued row owns nothing but its description. Its files are still the local
 * picks the composer staged (nothing has been uploaded — the phone uploads at
 * the send, see chat.tsx), and a voice take is still the recorder's file in the
 * cache directory. Cancelling therefore costs nothing and reaches nowhere.
 */

/** A submit held back, plus the identity its row is keyed by. */
export type QueuedPrompt = ComposerSubmit & { id: string }

export function QueuedPromptTray({
  prompts,
  onCancel
}: {
  prompts: QueuedPrompt[]
  onCancel: (id: string) => void
}): React.JSX.Element | null {
  if (prompts.length === 0) return null
  return (
    // Capped and scrollable, like the desktop's: a queue of ten must not push
    // the composer up the screen. Roughly three rows before it scrolls.
    <ScrollView
      className="max-h-28"
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 10 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {prompts.map((prompt) =>
        prompt.kind === 'voice' ? (
          <QueuedVoiceRow key={prompt.id} prompt={prompt} onCancel={() => onCancel(prompt.id)} />
        ) : (
          <QueuedTextRow key={prompt.id} prompt={prompt} onCancel={() => onCancel(prompt.id)} />
        )
      )}
    </ScrollView>
  )
}

/** m:ss for a take's length — the composer's recording bar reads the same. */
function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

function QueueRow({
  children,
  onCancel
}: {
  children: React.ReactNode
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <View className="border-border bg-surface flex-row items-center gap-2 rounded-lg border px-2.5 py-1.5">
      <Clock01Icon size={12} className="text-muted" />
      {children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.queue.remove')}
        hitSlop={8}
        onPress={onCancel}
      >
        <CancelCircleIcon size={14} className="text-muted" />
      </Pressable>
    </View>
  )
}

/**
 * A typed prompt, or an attachment-only one — which labels itself with its
 * file names, since that is all there is to say about it.
 */
function QueuedTextRow({
  prompt,
  onCancel
}: {
  prompt: Extract<QueuedPrompt, { kind: 'text' }>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <QueueRow onCancel={onCancel}>
      <Text numberOfLines={1} className="text-fg flex-1 text-left font-sans text-xs">
        {prompt.text || prompt.files.map((file) => file.name).join(', ')}
      </Text>
      {prompt.files.length > 0 && (
        // Labelled as a whole: a bare "3" beside a picture glyph reads as
        // nothing at all to a screen reader.
        <View
          accessible
          accessibilityLabel={t('chat.queue.attachmentCount', { count: prompt.files.length })}
          className="flex-row items-center gap-1"
        >
          <Image02Icon size={11} className="text-muted" />
          <Text className="text-muted font-sans text-[10px]">{prompt.files.length}</Text>
        </View>
      )}
    </QueueRow>
  )
}

/**
 * A take waiting its turn. It plays back here because there is nothing else to
 * show — the audio is transcribed by the desktop when the row is sent, not
 * when it is queued, so there is no text to preview.
 *
 * The player belongs to the row: it is released when the row leaves the queue
 * (cancelled, or sent), which is also what stops playback mid-play.
 */
function QueuedVoiceRow({
  prompt,
  onCancel
}: {
  prompt: Extract<QueuedPrompt, { kind: 'voice' }>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const player = useAudioPlayer(prompt.uri)
  const status = useAudioPlayerStatus(player)
  const playing = status.playing
  return (
    <QueueRow onCancel={onCancel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? t('chat.voice.pause') : t('chat.voice.play')}
        hitSlop={8}
        onPress={() => {
          if (playing) {
            player.pause()
            return
          }
          const duration = status.duration ?? 0
          const position = status.currentTime ?? 0
          if (status.didJustFinish || (duration > 0 && position >= duration)) player.seekTo(0)
          player.play()
        }}
      >
        {playing ? (
          <PauseIcon size={12} className="text-muted" />
        ) : (
          <PlayIcon size={12} className="text-muted" />
        )}
      </Pressable>
      <Text numberOfLines={1} className="text-fg flex-1 text-left font-sans text-xs">
        {t('chat.voice.queued')}
      </Text>
      <Text className="text-muted font-sans text-[10px]" style={{ writingDirection: 'ltr' }}>
        {mmss(prompt.durationSeconds)}
      </Text>
    </QueueRow>
  )
}
