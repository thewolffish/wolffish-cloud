import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { AdminPanel } from '@pages/settings/admin/AdminPanel'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { ArrowLeft02Icon, ArrowRight02Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/**
 * Admin, as a screen of its own.
 *
 * It sits directly below Settings in the sheet's page list — beside
 * Leaderboard, the other org-wide page — rather than inside Settings, because
 * it is not a knob on this app: it is a view of the whole company, and the
 * people who have it reach for it as a destination.
 *
 * THE WAY OUT LIVES HERE. As a settings tab this panel borrowed Settings'
 * own back chevron; standing alone it had none, and an admin who opened it
 * was stranded on it. So the screen carries the same exit every other
 * sheet-reached page does (Leaderboard, Heartbeat): one "Back" to chat, in
 * the same place, with the same chevron.
 *
 * It does NOT collide with the panel's own drill links. Those move UP a
 * level inside admin — "All people", "Back to this person" — and say so;
 * this one leaves admin entirely. Two affordances, two labels, two
 * destinations, no guessing which is which.
 */
export function Admin(): React.JSX.Element {
  const { t } = useTranslation()
  const { goTo } = useFlow()
  const { locale } = useLocale()
  const BackIcon = RTL_LOCALES.has(locale) ? ArrowRight02Icon : ArrowLeft02Icon

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <div className="flex items-center gap-3 px-6 pt-3 pb-1">
        <button
          type="button"
          onClick={() => goTo('chat')}
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
        <AdminPanel />
      </div>
    </main>
  )
}
