import {
  Activity04Icon,
  AiMagicIcon,
  BrainIcon,
  Database02Icon,
  PlayIcon,
  type IconProps
} from '@/components/core/icons'
import type { ActiveOverlay } from '@/lib/sync/overlays'
import { cn } from '@/lib/utils/cn'
import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

/**
 * The pieces the overlay card and its opened sheet both need: what each kind
 * looks like, how its title and prompt are resolved, and the pinged dot.
 *
 * Its own module because the card renders the sheet and the sheet renders the
 * card's chrome — sharing through either one would be a cycle.
 */

// ------------------------------------------------------------------- tones

/**
 * What each overlay kind looks like.
 *
 * The desktop deliberately draws all four the same emerald: three of them are
 * literally one component there, and the fourth owns the whole window, so
 * nothing has to be told apart at a glance. Stacked three-deep on a phone they
 * do, so each kind gets its own icon and hue.
 *
 * The colors are literal palette values, not tokens: RN cannot alpha-compose a
 * `var()` color, so `bg-primary/15` would silently render black (see
 * global.css) while `bg-emerald-500/15` is fine. Emerald stays with automations
 * because that is the desktop's card colour, and violet with compaction because
 * that is the colour of its in-chat compaction cards there; the other two are
 * new and only have to differ.
 */
export type OverlayTone = {
  icon: (props: IconProps) => React.JSX.Element
  /** The disc behind the icon. */
  disc: string
  /** The halo that pulses out from it. */
  halo: string
  /** The icon itself, and any label drawn in the kind's accent. */
  tint: string
  /** The reindex bar's fill — the one place a solid version is needed. */
  fill: string
}

export const OVERLAY_TONES: Record<ActiveOverlay['kind'], OverlayTone> = {
  automation: {
    icon: Activity04Icon,
    disc: 'bg-emerald-500/15',
    halo: 'bg-emerald-500/20',
    tint: 'text-emerald-600 dark:text-emerald-400',
    fill: 'bg-emerald-500'
  },
  compaction: {
    icon: AiMagicIcon,
    disc: 'bg-violet-500/15',
    halo: 'bg-violet-500/20',
    tint: 'text-violet-600 dark:text-violet-400',
    fill: 'bg-violet-500'
  },
  reflection: {
    icon: BrainIcon,
    disc: 'bg-sky-500/15',
    halo: 'bg-sky-500/20',
    tint: 'text-sky-600 dark:text-sky-400',
    fill: 'bg-sky-500'
  },
  procedure: {
    icon: PlayIcon,
    disc: 'bg-teal-500/15',
    halo: 'bg-teal-500/20',
    tint: 'text-teal-600 dark:text-teal-400',
    fill: 'bg-teal-500'
  },
  reindex: {
    icon: Database02Icon,
    disc: 'bg-indigo-500/15',
    halo: 'bg-indigo-500/20',
    tint: 'text-indigo-600 dark:text-indigo-400',
    fill: 'bg-indigo-500'
  }
}

// ------------------------------------------------------------------- text

/**
 * The title a card wears: the job's own heading where there is one — what the
 * user named it, and what the desktop shows — falling back to the kind's name
 * for a reindex, which carries no label, and for a desktop too old to send one.
 *
 * The built-in jobs' labels arrive in English, because they are the scheduler's
 * identity strings rather than copy. That is exactly what the desktop shows
 * too, so this matches rather than inventing a translation the two surfaces
 * would then disagree on.
 */
export function overlayTitle(overlay: ActiveOverlay, t: (key: string) => string): string {
  const label = overlay.kind === 'reindex' ? '' : overlay.label.trim()
  return label || t(`overlays.kind.${overlay.kind}`)
}

/**
 * The prompt, ready to render. An automation's body is the literal text the
 * user wrote; the built-in jobs carry an i18n key instead, which is the
 * desktop's own convention — see OverlayKind in the protocol.
 */
export function overlayDetail(overlay: ActiveOverlay, t: (key: string) => string): string {
  if (overlay.kind === 'reindex') return ''
  const body = overlay.body.trim()
  if (!body) return ''
  // A procedure's body is a saved prompt, the same as an automation's; only
  // the two built-in families carry an i18n key.
  return overlay.kind === 'automation' || overlay.kind === 'procedure' ? body : t(body)
}

/** mm:ss, growing an hours field only once there is one. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (total < 3600) return `${minutes}:${seconds}`
  return `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

// ------------------------------------------------------------------- icon

/** How long one halo takes to expand and fade — the desktop's `animate-ping`. */
const PULSE_MS = 1600

/**
 * The desktop's pinged dot: a disc with a halo expanding out of it, forever.
 * The one thing on these cards that says the run is still going, since nothing
 * else about them moves.
 */
export function PulsingIcon({
  tone,
  halo,
  size = 24,
  children
}: {
  tone: string
  halo: string
  size?: number
  children: React.ReactNode
}): React.JSX.Element {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.ease) }),
      -1,
      false
    )
  }, [progress])

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.8 }],
    opacity: 1 - progress.value
  }))

  return (
    <View style={{ width: size, height: size }} className="shrink-0 items-center justify-center">
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', width: size, height: size }, haloStyle]}
        className={cn('rounded-full', halo)}
      />
      <View
        style={{ width: size, height: size }}
        className={cn('items-center justify-center rounded-full', tone)}
      >
        {children}
      </View>
    </View>
  )
}
