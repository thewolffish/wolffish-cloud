import { File01Icon } from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import * as Sharing from 'expo-sharing'
import { Component, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'

/**
 * Shared card chrome for every file viewer — the bordered surface, header
 * (icon · name · meta) and footer action row the desktop viewers all share.
 * Mobile collapses the desktop's three file actions (open externally, reveal
 * in folder, download) into one: the system share sheet, which is where
 * "open in…", "save to Files" and "print" live on both platforms.
 */

export type Align = 'start' | 'end'

/** Hand a cached file to the OS — Quick Look / open-in / save, per platform. */
export function shareFile(uri: string | null): void {
  if (!uri) return
  void Sharing.shareAsync(uri).catch(() => {
    // Best-effort: a dismissed or unavailable share sheet is not an error.
  })
}

export function MissingCard({
  label,
  align = 'start'
}: {
  label: string
  align?: Align
}): React.JSX.Element {
  return (
    <View
      className={cn(
        // Same width as the card it replaces — a file going missing must not
        // change the shape of the feed.
        'bg-surface border-border w-[85%] flex-row items-center gap-2 rounded-xl border px-4 py-3 opacity-60',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      <File01Icon size={16} className="text-muted" />
      <Text className="text-muted font-sans text-left text-xs">{label}</Text>
    </View>
  )
}

/** The card surface: bordered, rounded, clipped, chat-bubble width. */
export function CardShell({
  children,
  align = 'start'
}: {
  children: ReactNode
  align?: Align
}): React.JSX.Element {
  return (
    <View
      className={cn(
        'bg-surface border-border w-[85%] flex-col overflow-hidden rounded-2xl border',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      {children}
    </View>
  )
}

export function CardHeader({
  icon,
  name,
  meta
}: {
  icon: ReactNode
  name: string
  meta?: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      {icon}
      <Text numberOfLines={1} className="text-fg font-sans-medium min-w-0 flex-1 text-left text-xs">
        {name}
      </Text>
      {meta ? <Text className="text-muted font-sans text-[10px]">{meta}</Text> : null}
    </View>
  )
}

/** Footer: a muted label on the leading edge, action buttons trailing. */
export function CardFooter({
  label,
  children
}: {
  label?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <View className="border-border flex-row items-center gap-1 border-t px-3 py-1.5">
      <Text numberOfLines={1} className="text-muted font-sans min-w-0 flex-1 text-left text-[10px]">
        {label ?? ''}
      </Text>
      {children}
    </View>
  )
}

/**
 * Renders `children`, or `fallback` if they throw. Agent-authored files are
 * not guaranteed well-formed — a malformed .svg must degrade to its source,
 * never take the whole feed down with it.
 */
export class RenderGuard extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function IconAction({
  icon,
  label,
  onPress,
  selected
}: {
  icon: ReactNode
  label: string
  onPress: () => void
  selected?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={6}
      onPress={onPress}
      className="rounded p-1.5 active:opacity-60"
    >
      {icon}
    </Pressable>
  )
}
