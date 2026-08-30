import { ArrowDown01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The model's reasoning for a turn — a collapsed card at turn end that
 * expands to the raw thinking text on click. Mirrors the mobile app's
 * TurnEndCard reasoning block: collapsed by default, plain text when open.
 */
export function ReasoningCard({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-2.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 text-start"
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
