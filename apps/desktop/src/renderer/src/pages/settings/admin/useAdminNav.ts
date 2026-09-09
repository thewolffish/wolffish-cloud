import { useCallback, useMemo, useState } from 'react'
import { ROOT_VIEW, popView, pushView, type AdminView } from '@pages/settings/admin/adminNav'

export type AdminNav = {
  /** The page on screen. */
  current: AdminView
  /** True when Back would leave admin rather than pop a page. */
  atRoot: boolean
  /** Go somewhere inside admin; the page being left is remembered. */
  push: (next: AdminView) => void
  /** One page back inside admin, or `onExit` when there is none. */
  back: () => void
}

/**
 * The admin screen's history, as a hook. Owned by the screen (Admin.tsx),
 * not the panel, because the screen's Back button sits outside the panel's
 * scroll area and has to pop the same stack the panel's drill links do.
 *
 * `onExit` is what Back does at the root. It is read at press time, so a
 * changing callback needs no effect to stay current.
 */
export function useAdminNav(onExit: () => void): AdminNav {
  const [stack, setStack] = useState<AdminView[]>([ROOT_VIEW])

  const push = useCallback((next: AdminView) => setStack((s) => pushView(s, next)), [])

  const back = useCallback(() => {
    const popped = popView(stack)
    if (popped === null) onExit()
    else setStack(popped)
  }, [stack, onExit])

  return useMemo(
    () => ({ current: stack[stack.length - 1]!, atRoot: stack.length <= 1, push, back }),
    [stack, push, back]
  )
}
