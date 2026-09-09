import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { AdminPanel } from '@pages/settings/admin/AdminPanel'
import { useAdminNav } from '@pages/settings/admin/useAdminNav'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { ArrowLeft02Icon, ArrowRight02Icon } from 'hugeicons-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Admin, as a screen of its own.
 *
 * It sits directly below Settings in the sheet's page list — beside
 * Leaderboard, the other org-wide page — rather than inside Settings, because
 * it is not a knob on this app: it is a view of the whole company, and the
 * people who have it reach for it as a destination.
 *
 * THE WAY OUT LIVES HERE, and it is one step back — not one jump out. The
 * screen carries the same Back every other sheet-reached page does
 * (Leaderboard, Heartbeat), in the same place, with the same chevron. But
 * admin has pages inside it — a section, a person, one of their
 * conversations — and a Back that always left for chat stranded an admin
 * three levels deep: the person and the transcript they had open were gone.
 * So the screen keeps a history of where it has been (see adminNav.ts), and
 * Back pops one page; only at the root, with nothing left to pop, does it
 * leave admin for chat.
 *
 * The panel's own drill links ("All people", "Back to this person") pop the
 * SAME stack. One history, however the admin asks to go back.
 */
export function Admin(): React.JSX.Element {
  const { t } = useTranslation()
  const { goTo } = useFlow()
  const { locale } = useLocale()
  const BackIcon = RTL_LOCALES.has(locale) ? ArrowRight02Icon : ArrowLeft02Icon

  const exit = useCallback(() => goTo('chat'), [goTo])
  const nav = useAdminNav(exit)

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <div className="flex items-center gap-3 px-6 pt-3 pb-1">
        <button
          type="button"
          onClick={nav.back}
          aria-label={t('common.back')}
          className={cn(
            'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
            'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2'
          )}
        >
          <BackIcon size={16} />
          <span>{t('common.back')}</span>
        </button>
        <div className="flex-1" />
      </div>

      <div className="flex-1 overflow-y-auto">
        <AdminPanel nav={nav} />
      </div>
    </main>
  )
}
