import { cn } from '@lib/utils/cn'
import { Tick02Icon } from 'hugeicons-react'
import { forwardRef, type InputHTMLAttributes } from 'react'

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'checked' | 'defaultChecked'
> & {
  /** Controlled: the box is painted from this, so it is required. */
  checked: boolean
}

/**
 * A checkbox drawn the way the other core controls are drawn, so a panel of
 * `Input`s and `Select`s never has the platform's own square sitting in it.
 * The real input stays in the DOM — transparent, on top of the box, still
 * focusable — so a wrapping `<label>`, space-to-toggle and screen readers all
 * behave exactly as they do natively; only the paint is ours.
 *
 * The box carries `className`; everything else spreads onto the input.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, disabled = false, className, ...rest },
  ref
) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className={cn(
          'peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0',
          'disabled:cursor-not-allowed'
        )}
        {...rest}
      />
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded-sm border',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg',
          checked ? 'bg-primary border-primary text-primary-fg' : 'bg-bg border-border',
          disabled ? 'opacity-50' : !checked && 'peer-hover:border-muted',
          className
        )}
      >
        {checked && <Tick02Icon size={12} strokeWidth={3} />}
      </span>
    </span>
  )
})
