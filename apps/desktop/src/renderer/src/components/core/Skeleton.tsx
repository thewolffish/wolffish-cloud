import { cn } from '@lib/utils/cn'
import type { ReactNode } from 'react'

/**
 * The loading primitive: a bar that occupies EXACTLY the space its real
 * content will.
 *
 * It renders a non-breaking space in transparent text, so its height comes
 * from the line-height of whatever context it sits in — put it inside a
 * `text-xs` row and it is a `text-xs` row tall, put it in a `text-2xl`
 * heading and it is that tall. Hand-sized bars (`h-3`, `h-4`) cannot do
 * this: they come out shorter than the text they stand in for, and the
 * whole card jumps a few pixels the moment the data lands.
 *
 * The rule that goes with it: a skeleton mirrors the loaded layout row for
 * row, with the real labels rendered as real text, and only the VALUE areas
 * pulsing. If the loaded state has four rows and a heading, so does the
 * skeleton — then nothing moves, nothing resizes, and the transition is a
 * pulse stopping rather than a relayout.
 */
export function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-border/60 inline-block animate-pulse rounded text-transparent select-none',
        className
      )}
    >
      &nbsp;
    </span>
  )
}

/**
 * A pulsing block for non-text areas (a chart body, an avatar, a glyph
 * tile). Sized by the caller, because unlike text these have no intrinsic
 * height to borrow — give it the same box the real element occupies.
 */
export function SkeletonBlock({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('bg-border/60 block animate-pulse rounded', className)}
    />
  )
}

/**
 * Marks a subtree as a loading placeholder for assistive tech, so a screen
 * reader announces "loading" once instead of reading a wall of blank bars.
 */
export function SkeletonRegion({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      {children}
    </div>
  )
}
