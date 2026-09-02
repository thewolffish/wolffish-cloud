import { ArrowDown01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Nearest scrollable ancestor — in Chat this is the column-reverse feed. */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * The model's reasoning for a turn — a collapsed card at turn end that
 * expands to the raw thinking text on click. Mirrors the mobile app's
 * TurnEndCard reasoning block: collapsed by default, plain text when open.
 */
export function ReasoningCard({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const headRef = useRef<HTMLButtonElement>(null)
  // Armed by a real click so the effect never scrolls on mount — opening a
  // conversation renders every card at once and must land bottom-pinned.
  const armedRef = useRef(false)

  // The column-reverse feed glues the BOTTOM edge through height changes, so
  // an unmanaged toggle strands the reader: expanding keeps the tail pinned
  // and flings the card's head far above the viewport, while collapsing
  // clamps the scroll offset against the shrunken content and lands at the
  // very top of the feed. Restore the intent explicitly once the toggle has
  // laid out (pre-paint, so there is no flash of the stranded position).
  useLayoutEffect(() => {
    if (!armedRef.current) return
    const head = headRef.current
    if (!head) return
    if (expanded) {
      // 'nearest' no-ops while the head is still visible (short reasoning)
      // and pulls it back to the top edge when it flew off. It must target
      // the small header, not the card: an element taller than the scrollport
      // counts as fully "in view", and 'nearest' on it would not move at all.
      head.scrollIntoView({ block: 'nearest' })
    } else {
      // Closing returns the feed to its resting state — pinned to the newest
      // message. Assigning past the maximum clamps to the bottom in both
      // normal and column-reverse scrollers.
      const scroller = nearestScroller(head)
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    }
  }, [expanded])

  return (
    <div className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-2.5">
      {/* scroll-mt-16 keeps the restored head clear of the floating glass
          discs overlaying the transcript's top edge. */}
      <button
        ref={headRef}
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          armedRef.current = true
          setExpanded((v) => !v)
        }}
        className="flex w-full scroll-mt-16 cursor-pointer items-center justify-between gap-3 text-start"
      >
        <span className="text-fg truncate text-xs font-medium">
          {t('chat.reasoningCard.title')}
        </span>
        {expanded ? (
          <ArrowDown01Icon size={14} className="text-muted shrink-0" aria-hidden />
        ) : (
          <ArrowRight01Icon size={14} className="text-muted shrink-0" aria-hidden />
        )}
      </button>
      {expanded && (
        <p
          data-select-root
          className="text-muted wrap-anywhere mt-2 whitespace-pre-wrap text-start text-xs leading-5"
        >
          {content.trim()}
        </p>
      )}
    </div>
  )
}
