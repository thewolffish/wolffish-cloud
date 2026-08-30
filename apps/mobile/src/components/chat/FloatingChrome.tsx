import { Menu01Icon, PlusSignIcon } from '@/components/core/icons'
import { UnreadBadge } from '@/components/core/UnreadBadge'
import { badgeTotal, useBadges } from '@/state/badges'
import { useTheme } from '@/providers/theme/useTheme'
import { BlurView } from 'expo-blur'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, View } from 'react-native'

/**
 * The chat screen's only chrome: two floating buttons over the transcript,
 * which scrolls underneath them.
 *
 * There is no top bar. A phone chat is one column of messages and a composer,
 * and a header spent a fixed strip of the shortest axis restating a title the
 * conversation itself already says. What it held that mattered — the way out to
 * everything else, and a new chat — is here instead, as two glass discs on the
 * leading and trailing edges.
 *
 * Direction-logical by construction: the row is a `flex-row`, which RN reverses
 * under RTL, so the navigator is always on the leading edge and the plus on the
 * trailing one without either being pinned to a physical side.
 */

/** Button diameter, and the strip the feed must not start inside. */
export const FLOATING_SIZE = 40
export const FLOATING_GAP = 8
/** What a caller has to add to the top inset to clear these buttons. */
export const FLOATING_AREA = FLOATING_SIZE + FLOATING_GAP * 2

function GlassButton({
  label,
  onPress,
  children
}: {
  label: string
  onPress: () => void
  children: ReactNode
}): React.JSX.Element {
  const { isDark } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={{ width: FLOATING_SIZE, height: FLOATING_SIZE }}
      // See-through rather than solid: the transcript passing underneath is
      // what tells the user these float over it rather than sitting in a bar.
      // The hairline keeps them legible against a white message bubble —
      // border, not border-soft: soft sits darker than the dark bg and reads
      // as a black ring on the glass.
      className="border-border items-center justify-center overflow-hidden rounded-full border active:opacity-60"
    >
      <BlurView
        pointerEvents="none"
        intensity={40}
        tint={isDark ? 'dark' : 'light'}
        blurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      {children}
    </Pressable>
  )
}

export function FloatingChrome({
  top,
  onOpenSheet,
  onNewChat
}: {
  /** Distance from the top of the screen — the caller's safe-area inset. */
  top: number
  onOpenSheet: () => void
  onNewChat: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Unread across every conversation — the disc that opens the navigator
  // wears the same count the rows inside it add up to. The one being read
  // clears on focus, so what remains really is "waiting elsewhere".
  const unreadTotal = useBadges(badgeTotal)
  return (
    <View
      // box-none, so only the two discs take touches and every tap between
      // them reaches the transcript scrolling underneath.
      pointerEvents="box-none"
      style={{ position: 'absolute', top, left: 0, right: 0 }}
      className="flex-row items-center justify-between px-3"
    >
      {/* The disc clips to its circle (overflow-hidden for the blur), so the
          badge hangs off a wrapper around it — top-trailing, half out of the
          disc, the same corner idiom the rank chips use for their origin
          badge. insetInlineEnd keeps it direction-aware with no RTL branch. */}
      <View className="relative">
        <GlassButton label={t('chat.conversations')} onPress={onOpenSheet}>
          <Menu01Icon size={18} className="text-fg" />
        </GlassButton>
        <View pointerEvents="none" style={{ position: 'absolute', top: -4, insetInlineEnd: -4 }}>
          <UnreadBadge count={unreadTotal} />
        </View>
      </View>
      <GlassButton label={t('chat.newChat')} onPress={onNewChat}>
        <PlusSignIcon size={18} className="text-fg" />
      </GlassButton>
    </View>
  )
}
