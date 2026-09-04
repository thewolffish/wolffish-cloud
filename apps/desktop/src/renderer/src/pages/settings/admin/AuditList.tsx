import { SkeletonBar } from '@components/core/Skeleton'
import { useLocale } from '@providers/locale/useLocale'
import type { AdminAuditEntry } from '@preload/index'
import { useTranslation } from 'react-i18next'
import { formatWhen } from '@pages/settings/admin/adminFormat'

/**
 * The audit trail, as a list. Shared by the org-wide log and the per-person
 * one, because they are the same rows read through different filters.
 *
 * `detail` is rendered as compact JSON rather than prose: it is written by
 * the server as a free-shaped object per action, and inventing a sentence
 * per action type would go stale the first time an action gained a field.
 * The one thing it never contains is user content — the config write logs
 * its size, not its body.
 */
export function AuditList({
  entries,
  emptyLabel
}: {
  entries: AdminAuditEntry[] | null
  emptyLabel: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()

  if (entries === null) {
    return (
      <ul className="flex flex-col" role="status" aria-label={t('common.loading')}>
        {Array.from({ length: 6 }, (_, i) => (
          <li
            key={i}
            className="border-border/60 flex flex-col gap-1 border-b py-2.5 last:border-b-0"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium">
                <SkeletonBar className="w-40" />
              </span>
              <span className="text-[11px]">
                <SkeletonBar className="w-28" />
              </span>
            </div>
            <span className="text-[11px]">
              <SkeletonBar className="w-full" />
            </span>
          </li>
        ))}
      </ul>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="border-border text-muted rounded-xl border border-dashed px-4 py-8 text-center text-xs">
        {emptyLabel}
      </p>
    )
  }

  return (
    <ul className="flex flex-col">
      {entries.map((e) => (
        <li
          key={e.id}
          className="border-border/60 flex flex-col gap-1 border-b py-2.5 last:border-b-0"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-fg min-w-0 truncate text-xs font-medium">
              {t(`settings.admin.audit.actions.${e.action}`, { defaultValue: e.action })}
              {e.target ? <span className="text-muted"> · {e.target}</span> : null}
            </span>
            <span className="text-muted shrink-0 text-[11px]" dir="ltr">
              {formatWhen(e.created_at, locale) ?? e.created_at}
            </span>
          </div>
          <span className="text-muted truncate text-[11px]" title={e.detail}>
            {e.actor_name || e.actor_email || e.actor_user_id}
            {e.detail && e.detail !== '{}' ? ` · ${e.detail}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
