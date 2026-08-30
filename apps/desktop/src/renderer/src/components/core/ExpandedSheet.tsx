import { cn } from '@lib/utils/cn'
import { Cancel01Icon } from 'hugeicons-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export type ExpandedSheetProps = {
  open: boolean
  onClose: () => void
  /** Shown in the header bar; also used as the close button's accessible title. */
  title?: string
  /** Action controls rendered in the header before the close button. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * Centered 90%-of-viewport modal sheet for reading a file viewer's content at
 * a larger size. Reuses the expanded prompt-editor dialog's portal + backdrop +
 * panel styling, but — unlike that dialog — clicking the backdrop does NOT
 * dismiss it: only the × button or Escape close it, so a stray click while
 * reading a long document never loses the reader's place.
 *
 * Not built on core/Modal because Modal gates Escape and backdrop-click on a
 * single `dismissable` flag, so it can't express "Escape closes but a backdrop
 * click does not" — the exact behavior wanted here.
 */
export function ExpandedSheet({
  open,
  onClose,
  title,
  actions,
  children
}: ExpandedSheetProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Move focus into the dialog on open so keyboard/screen-reader users land
    // inside it rather than on the page behind the (non-dismissable) backdrop.
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="border-border bg-surface flex h-[90vh] w-[90vw] flex-col overflow-hidden rounded-2xl border shadow-xl"
      >
        <div className="border-border flex shrink-0 items-center gap-2 border-b px-5 py-3">
          <span
            id={titleId}
            className="text-fg min-w-0 flex-1 truncate text-sm font-semibold"
            title={title}
          >
            {title}
          </span>
          {actions}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('chat.fileCard.close')}
            title={t('chat.fileCard.close')}
            className={cn(
              'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
              'focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            <Cancel01Icon size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>,
    document.body
  )
}
