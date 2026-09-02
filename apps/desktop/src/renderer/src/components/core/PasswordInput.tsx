/**
 * Password input with a show/hide toggle — the one used everywhere a
 * password is typed (sign-in, forced change, profile change). The eye sits
 * at the END edge via logical positioning (inset-e), so it lands on the
 * right in LTR and the left in RTL without any direction math; the input
 * pads the same edge to keep text clear of it.
 */
import { cn } from '@lib/utils/cn'
import { ViewIcon, ViewOffIcon } from 'hugeicons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

const baseFieldClass = cn(
  'border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border px-3 py-2.5 text-sm',
  'focus:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-accent'
)

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  autoComplete,
  onEnter,
  className,
  invalid
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  autoFocus?: boolean
  autoComplete?: string
  onEnter?: () => void
  className?: string
  /** Paints the red validation border (pairs with an error line below). */
  invalid?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <span className={cn('relative block w-full', className)}>
      <input
        type={visible ? 'text' : 'password'}
        aria-invalid={invalid || undefined}
        className={cn(
          baseFieldClass,
          'pe-10',
          invalid && 'border-red-500/70 focus:border-red-500/80 focus-visible:ring-red-500/30'
        )}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.()
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        onClick={() => setVisible((v) => !v)}
        className="text-muted hover:text-fg absolute inset-e-2 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded"
      >
        {visible ? <ViewOffIcon size={16} /> : <ViewIcon size={16} />}
      </button>
    </span>
  )
}
