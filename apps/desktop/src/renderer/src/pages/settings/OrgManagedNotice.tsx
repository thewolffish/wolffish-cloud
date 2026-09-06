import { cn } from '@lib/utils/cn'
import { useOrgLockedKeys } from '@hooks/use-org-locked-keys'
import { Building03Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/**
 * What the organization decides, said out loud.
 *
 * The API applies the org's config overlay on every read and forces it again
 * on every write, so a claimed setting IS the org's on this machine no matter
 * what the app does. Enforcement was never the gap — explanation was: an
 * employee would open Settings, change a value, and watch it revert two
 * minutes later with nothing anywhere saying why.
 *
 * It renders nothing while the org claims nothing, which is every deployment
 * until an admin decides otherwise — so the quiet case stays quiet, and the
 * notice appearing is itself the signal that something changed.
 *
 * Paths are shown verbatim. They are the admin's own words for the setting
 * ("channels.telegram.enabled"), and a friendly name invented here would be a
 * second vocabulary to keep in step with the admin console's.
 */
export function OrgManagedNotice({ className }: { className?: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const keys = useOrgLockedKeys()
  if (keys.length === 0) return null
  return (
    <section
      className={cn('border-border bg-bg-subtle rounded-xl border p-4', className)}
      aria-label={t('settings.orgManaged.title')}
    >
      <div className="flex items-start gap-3">
        <Building03Icon size={18} className="text-muted mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-fg text-sm font-semibold">{t('settings.orgManaged.title')}</h3>
            <span className="text-muted text-xs">
              {keys.length === 1
                ? t('settings.orgManaged.one')
                : t('settings.orgManaged.many', { count: keys.length })}
            </span>
          </div>
          <p className="text-muted mt-1 text-xs leading-relaxed">{t('settings.orgManaged.body')}</p>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {keys.map((key) => (
              <li
                key={key}
                className="border-border text-muted rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
              >
                {key}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
