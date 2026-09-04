import { Input } from '@/components/core/Input'
import { PanelScreen, Section, SwitchRow } from '@/components/settings/SettingsUI'
import { Bar, ceilingLabel } from '@/components/admin/AdminUI'
import { adminOrg, adminPatchOrg, adminRoster, type TokenPlan } from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import { formatTokens } from '@/lib/utils/formatTokens'
import { useLocale } from '@/providers/locale/useLocale'
import { useToast } from '@/providers/toast/useToast'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

const PLANS: TokenPlan[] = ['standard', 'high', 'unmetered']

/**
 * Admin — the organization.
 *
 * The settings that apply to everybody, and the distinction the screen has
 * to keep straight: a PLAN caps one person's month, the org monthly cap is
 * the whole company's, and the per-person daily cap is a rate limit rather
 * than a budget. All three are enforced and whichever binds first is the one
 * that bites, so they are shown together instead of on three screens.
 *
 * Numbers commit on blur rather than per keystroke: a cap being typed passes
 * through "3", "30", "300" on the way to 3,000,000, and saving those would
 * strangle the whole company for as long as it took to finish the number.
 */
export default function AdminOrgScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const access = useAdminAccess()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const org = useQuery({
    queryKey: ['admin', 'org'],
    enabled: access.canRead,
    queryFn: () => cloudSession.withAccessToken((token) => adminOrg(token))
  })

  // The plan catalogue is the server's, carried on the roster — so the
  // ceilings shown here are the ones actually enforced, not a copy.
  const roster = useQuery({
    queryKey: ['admin', 'roster'],
    enabled: access.canRead,
    queryFn: () => cloudSession.withAccessToken((token) => adminRoster(token, 30))
  })

  const settings = org.data?.org ?? null

  const save = async (patch: Parameters<typeof adminPatchOrg>[1]): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await cloudSession.withAccessToken((token) => adminPatchOrg(token, patch))
      await queryClient.invalidateQueries({ queryKey: ['admin', 'org'] })
      setDraft({})
      toast.show({ message: t('settings.admin.org.saved'), tone: 'success' })
    } catch (error) {
      toast.show({ message: (error as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const caps = [
    { key: 'user_daily_token_cap', label: t('settings.admin.org.userDailyTokens') },
    { key: 'org_monthly_token_cap', label: t('settings.admin.org.orgMonthlyTokens') },
    { key: 'user_daily_search_cap', label: t('settings.admin.org.userDailySearches') },
    { key: 'org_monthly_search_cap', label: t('settings.admin.org.orgMonthlySearches') }
  ] as const

  return (
    <PanelScreen title={t('settings.admin.org.title')} subtitle={t('settings.admin.org.subtitle')}>
      <Section title={t('settings.admin.org.identity')}>
        <View className="flex-col gap-1.5">
          <Text className="text-muted text-left font-sans text-xs">
            {t('settings.admin.org.name')}
          </Text>
          {settings === null ? (
            <View className="h-10 justify-center">
              <Bar className="h-4 w-40" />
            </View>
          ) : (
            <Input
              value={draft.name ?? settings.name}
              editable={access.canWrite && !busy}
              onChangeText={(v) => setDraft((d) => ({ ...d, name: v }))}
              onBlur={() => {
                const next = draft.name?.trim()
                if (next === undefined) return
                if (next.length === 0 || next === settings.name) {
                  setDraft(({ name: _dropped, ...rest }) => rest)
                  return
                }
                void save({ name: next })
              }}
            />
          )}
        </View>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-muted text-left font-sans text-sm">
            {t('settings.admin.org.defaultModel')}
          </Text>
          {settings === null ? (
            <Bar className="h-3 w-32 opacity-70" />
          ) : (
            <Text
              numberOfLines={1}
              className="text-fg font-sans-medium flex-shrink text-xs"
              style={{ writingDirection: 'ltr' }}
            >
              {settings.default_model}
            </Text>
          )}
        </View>
      </Section>

      <Section title={t('settings.admin.org.search')}>
        <SwitchRow
          label={t('settings.admin.org.searchEnabled')}
          description={t('settings.admin.org.searchHint')}
          value={settings !== null && Boolean(settings.search_enabled)}
          disabled={!access.canWrite || settings === null || busy}
          onValueChange={(next) => void save({ search_enabled: next })}
        />
      </Section>

      <Section title={t('settings.admin.org.capsTitle')}>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {t('settings.admin.org.capsSubtitle')}
        </Text>
        {caps.map((cap) => (
          <View key={cap.key} className="flex-col gap-1.5">
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="text-muted flex-1 text-left font-sans text-xs">{cap.label}</Text>
              {settings !== null ? (
                <Text className="text-muted font-sans text-[11px]">
                  {settings[cap.key] === 0
                    ? t('settings.admin.org.unlimited')
                    : formatTokens(settings[cap.key], locale)}
                </Text>
              ) : null}
            </View>
            {settings === null ? (
              <View className="h-10 justify-center">
                <Bar className="h-4 w-28" />
              </View>
            ) : (
              <Input
                value={draft[cap.key] ?? String(settings[cap.key])}
                keyboardType="number-pad"
                editable={access.canWrite && !busy}
                onChangeText={(v) => setDraft((d) => ({ ...d, [cap.key]: v }))}
                onBlur={() => {
                  const raw = draft[cap.key]
                  if (raw === undefined) return
                  const n = Math.floor(Number(raw))
                  // A cap must be a non-negative integer; anything else is a
                  // typo, and saving it would silently move a ceiling.
                  if (!Number.isFinite(n) || n < 0 || n === settings[cap.key]) {
                    setDraft((d) => {
                      const rest = { ...d }
                      delete rest[cap.key]
                      return rest
                    })
                    return
                  }
                  void save({ [cap.key]: n })
                }}
              />
            )}
          </View>
        ))}
      </Section>

      <Section title={t('settings.admin.org.plansTitle')}>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {t('settings.admin.org.plansSubtitle')}
        </Text>
        {PLANS.map((plan) => (
          <View
            key={plan}
            className="border-border-soft h-9 flex-row items-center justify-between gap-3 border-b"
          >
            <Text className="text-fg font-sans-medium text-left text-xs">
              {t(`settings.admin.plan.${plan}`)}
            </Text>
            {roster.data ? (
              <Text
                numberOfLines={1}
                className="text-muted shrink-0 font-sans text-xs"
                style={{ writingDirection: 'ltr' }}
              >
                {ceilingLabel(roster.data.plans[plan], locale, t)}
              </Text>
            ) : (
              <Bar className="h-3 w-32 opacity-70" />
            )}
          </View>
        ))}
      </Section>
    </PanelScreen>
  )
}
