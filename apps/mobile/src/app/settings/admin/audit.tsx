import { PanelScreen } from '@/components/settings/SettingsUI'
import { Bar } from '@/components/admin/AdminUI'
import { adminAudit } from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

const SKELETON_ROWS = 8
/** Two lines and its padding — reserved so the list never reflows. */
const ROW_H = 56

/**
 * Admin — the audit log.
 *
 * Every administrative action, newest first. `detail` is rendered as the
 * compact JSON the server wrote rather than as prose: it is a different
 * shape per action, and a sentence per action type would go stale the first
 * time one gained a field. The one thing it never contains is user content —
 * a config write logs its size, not its body.
 */
export default function AdminAuditScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const access = useAdminAccess()

  const audit = useQuery({
    queryKey: ['admin', 'audit'],
    enabled: access.canRead,
    queryFn: () => cloudSession.withAccessToken((token) => adminAudit(token, 120))
  })

  const entries = audit.data?.entries ?? []

  return (
    <PanelScreen
      title={t('settings.admin.audit.title')}
      subtitle={t('settings.admin.audit.subtitle')}
    >
      <View className="bg-surface border-border flex-col rounded-2xl border px-4">
        {audit.isLoading ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <View
              key={i}
              style={{ height: ROW_H }}
              className="border-border-soft flex-col justify-center gap-1 border-b"
            >
              <View className="flex-row items-center justify-between gap-3">
                <Bar className={i % 2 === 0 ? 'h-3 w-40' : 'h-3 w-32'} />
                <Bar className="h-2.5 w-12 opacity-70" />
              </View>
              <Bar className="h-2.5 w-[64%] opacity-70" />
            </View>
          ))
        ) : entries.length === 0 ? (
          <View className="py-10">
            <Text className="text-muted text-center font-sans text-sm">
              {audit.isError
                ? t('settings.admin.audit.loadFailed')
                : t('settings.admin.audit.empty')}
            </Text>
          </View>
        ) : (
          entries.map((entry) => {
            const at = Date.parse(entry.created_at)
            return (
              <View
                key={entry.id}
                style={{ minHeight: ROW_H }}
                className="border-border-soft flex-col justify-center gap-1 border-b py-2"
              >
                <View className="flex-row items-center justify-between gap-3">
                  <Text
                    numberOfLines={1}
                    className="text-fg font-sans-medium flex-1 text-left text-xs"
                  >
                    {t(`settings.admin.audit.actions.${entry.action}`, {
                      defaultValue: entry.action
                    })}
                  </Text>
                  <Text className="text-muted shrink-0 font-sans text-[11px]">
                    {Number.isFinite(at) ? formatRelativeTime(at, t) : ''}
                  </Text>
                </View>
                <Text numberOfLines={2} className="text-muted text-left font-sans text-[11px]">
                  {entry.actor_name || entry.actor_email || entry.actor_user_id}
                  {entry.target ? ` · ${entry.target}` : ''}
                  {entry.detail && entry.detail !== '{}' ? ` · ${entry.detail}` : ''}
                </Text>
              </View>
            )
          })
        )}
      </View>
    </PanelScreen>
  )
}
