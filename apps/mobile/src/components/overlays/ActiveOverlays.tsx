import { FLOATING_AREA } from '@/components/chat/FloatingChrome'
import { HourglassIcon } from '@/components/core/icons'
import { OverlayDetailSheet } from '@/components/overlays/OverlayDetailSheet'
import {
  OVERLAY_TONES,
  overlayDetail,
  overlayTitle,
  PulsingIcon
} from '@/components/overlays/OverlayChrome'
import { useOverlayStack, type ActiveOverlay } from '@/lib/sync/overlays'
import { useConfigValue } from '@/state/demoConfig'
import { cn } from '@/lib/utils/cn'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'
import Animated, { FadeInUp, FadeOut, LinearTransition } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * What the desktop is doing right now, as cards over whatever screen the phone
 * is on — the visible half of lib/sync/overlays.ts.
 *
 * The desktop floats its version over everything (`fixed top-12`, app-wide,
 * three ACROSS), so this mounts app-wide too rather than living on the chat
 * screen. Three across does not fit a phone, so they stack down instead: one
 * row each, oldest at the top, capped at three.
 *
 * Each card is a header row and one line. The line is the prompt, scrolled
 * sideways rather than wrapped, because the alternative on a narrow screen is a
 * card whose height depends on how much the user wrote — three of those would
 * BE the screen. Tapping opens the whole thing, which is where a long prompt
 * belongs.
 *
 * Sits below the chat screen's floating discs (FLOATING_AREA) so the two never
 * collide. The transcript's own top padding is deliberately NOT grown to match:
 * these come and go on their own schedule, and messages shifting down because a
 * nightly job started is a worse surprise than messages passing underneath —
 * which is what they already do under the discs.
 */
export function ActiveOverlays(): React.JSX.Element | null {
  // Which families may interrupt this phone, from the mirrored desktop config.
  // All three ship OFF: the automations switch is this device's own, while
  // compaction and reflection each carry one switch both devices obey. A
  // reindex has no switch — it is the one thing that blocks the desktop
  // outright, and a phone left guessing why nothing responds is worse.
  const { active, queued, hidden } = useOverlayStack({
    automation: useConfigValue('mobileRunCards'),
    compaction: useConfigValue('compactionCards'),
    reflection: useConfigValue('reflectionCards')
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const insets = useSafeAreaInsets()

  // A card whose run ended takes its sheet with it. Derived during render, not
  // in an effect, so there is never a frame where the sheet stands open over a
  // run that has finished.
  const opened = active.find((overlay) => overlay.id === openId) ?? null
  useEffect(() => {
    if (openId !== null && opened === null) setOpenId(null)
  }, [openId, opened])

  if (active.length === 0 && queued.length === 0) return null

  return (
    <>
      <View
        // box-none, so only the cards take touches — the screen underneath
        // keeps working while something runs on the desktop.
        pointerEvents="box-none"
        style={{ position: 'absolute', top: insets.top + FLOATING_AREA, left: 0, right: 0 }}
        className="flex-col gap-1.5 px-3"
      >
        {active.map((overlay) => (
          <OverlayCard key={overlay.id} overlay={overlay} onOpen={() => setOpenId(overlay.id)} />
        ))}
        {(queued.length > 0 || hidden > 0) && <QueueStrip queued={queued} hidden={hidden} />}
      </View>
      <OverlayDetailSheet overlay={opened} onClose={() => setOpenId(null)} />
    </>
  )
}

function OverlayCard({
  overlay,
  onOpen
}: {
  overlay: ActiveOverlay
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tone = OVERLAY_TONES[overlay.kind]
  const Icon = tone.icon
  const title = overlayTitle(overlay, t)
  const detail = overlayDetail(overlay, t)

  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOut.duration(150)}
      // So the cards below rise into the gap rather than jumping when one of
      // three ends — three runs finishing one by one is the common case.
      layout={LinearTransition.duration(200)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('overlays.openHint')}
        onPress={onOpen}
        className="border-border-soft bg-surface w-full flex-col gap-1.5 rounded-xl border px-2.5 py-2 shadow-md active:opacity-70"
      >
        <View className="flex-row items-center gap-2">
          <PulsingIcon tone={tone.disc} halo={tone.halo}>
            <Icon size={12} className={tone.tint} />
          </PulsingIcon>
          <Text
            numberOfLines={1}
            className="text-fg font-sans-medium min-w-0 flex-1 text-left text-xs"
          >
            {title}
          </Text>
          {overlay.kind !== 'reindex' && overlay.mode !== null && (
            <Text
              className={cn(
                'font-sans-medium shrink-0 rounded-full px-1.5 py-px text-[9px] uppercase',
                overlay.mode === 'workflow'
                  ? 'bg-primary-soft text-primary'
                  : 'bg-bg text-muted border-border border'
              )}
            >
              {t(
                overlay.mode === 'workflow'
                  ? 'settings.chatModes.workflow'
                  : 'settings.chatModes.single'
              )}
            </Text>
          )}
        </View>
        {overlay.kind === 'reindex' ? (
          <ReindexLine done={overlay.done} total={overlay.total} tone={tone} />
        ) : (
          <DetailLine text={detail || t('overlays.noPrompt')} muted={!detail} />
        )}
      </Pressable>
    </Animated.View>
  )
}

/**
 * The prompt on one line, scrolled sideways.
 *
 * A horizontal scroller rather than a truncation because the first few words of
 * a prompt are rarely the ones that say what it does, and the card cannot
 * afford the height to wrap. Nested inside a Pressable, so `nestedScrollEnabled`
 * is on for Android — without it the parent swallows the drag.
 */
function DetailLine({ text, muted }: { text: string; muted: boolean }): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      className="bg-bg-soft border-border-soft w-full rounded-lg border"
      contentContainerClassName="px-2 py-1"
    >
      <Text
        numberOfLines={1}
        className={cn('text-left font-sans text-[11px]', muted ? 'text-muted' : 'text-fg')}
      >
        {text}
      </Text>
    </ScrollView>
  )
}

/** A reindex has no prompt — its detail is how far through the files it is. */
function ReindexLine({
  done,
  total,
  tone
}: {
  done: number
  total: number
  tone: (typeof OVERLAY_TONES)[keyof typeof OVERLAY_TONES]
}): React.JSX.Element {
  const { i18n } = useTranslation()
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <View className="bg-bg-soft border-border-soft w-full flex-row items-center gap-2 rounded-lg border px-2 py-1">
      <View className="bg-border h-1 min-w-0 flex-1 overflow-hidden rounded-full">
        <View className={cn('h-full rounded-full', tone.fill)} style={{ width: `${percent}%` }} />
      </View>
      {/* Pinned LTR: a count reads left to right in Arabic too, exactly as the
          desktop's own reindex overlay pins its `n / total`. */}
      <Text
        className={cn('font-sans-medium shrink-0 text-[10px]', tone.tint)}
        style={{ writingDirection: 'ltr' }}
      >
        {done.toLocaleString(i18n.language)} / {total.toLocaleString(i18n.language)}
      </Text>
    </View>
  )
}

/**
 * The overflow, in one line under the cards: the pool's FIFO queue, plus any
 * active overlay the three-row cap left out. Counted rather than dropped — a
 * stack that quietly showed three of five would be lying by omission.
 */
function QueueStrip({
  queued,
  hidden
}: {
  queued: Array<{ id: string; label: string }>
  hidden: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const parts = [
    hidden > 0 ? t('overlays.moreActive', { count: hidden }) : null,
    queued.length > 0 ? t('overlays.queuedCount', { count: queued.length }) : null
  ].filter(Boolean)
  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOut.duration(150)}
      layout={LinearTransition.duration(200)}
      accessibilityRole="text"
      className="border-border-soft bg-surface w-full flex-row items-center gap-2 rounded-xl border px-2.5 py-1.5 shadow-md"
    >
      <HourglassIcon size={12} className="shrink-0 text-amber-500" />
      <Text className="text-fg font-sans-medium shrink-0 text-left text-[10px]">
        {parts.join(' · ')}
      </Text>
      <Text numberOfLines={1} className="text-muted min-w-0 flex-1 text-left font-sans text-[10px]">
        {queued.map((entry) => entry.label).join(' · ')}
      </Text>
    </Animated.View>
  )
}
