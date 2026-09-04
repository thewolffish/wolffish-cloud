import { Badge } from '@/components/core/Badge'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import {
  ActionRow,
  Bar,
  PlanMeter,
  PlanMeterSkeleton,
  SegmentedControl,
  StatPair,
  StatPairSkeleton,
  ceilingLabel,
  formatUsd,
  planBadgeVariant,
  statusBadgeVariant
} from '@/components/admin/AdminUI'
import {
  adminClearPin,
  adminResetPassword,
  adminRevokeSessions,
  adminSetPlan,
  adminUpdateUser,
  adminUserOverview,
  type AdminRole,
  type TokenPlan
} from '@/lib/cloud/admin'
import { cloudSession } from '@/lib/cloud/session'
import { useAdminAccess } from '@/lib/cloud/useAdminAccess'
import { formatTokens } from '@/lib/utils/formatTokens'
import { useLocale } from '@/providers/locale/useLocale'
import { useToast } from '@/providers/toast/useToast'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

const PLANS: TokenPlan[] = ['standard', 'high', 'unmetered']
const ROLES: AdminRole[] = ['employee', 'support', 'admin', 'owner']

/** Which confirmation is open, if any. Each maps to one destructive action. */
type Confirming = 'status' | 'password' | 'sessions' | null

/**
 * Admin — one person.
 *
 * Ordered for the phone, which is a different order from the desktop's. The
 * desk version leads with numbers because an admin sitting at a desk is
 * usually analysing; the phone leads with the PLAN and then the ACTIONS,
 * because an admin holding a phone is usually responding — somebody has hit
 * their ceiling, or lost their laptop, or been locked out on a weekend. The
 * spend, the surfaces and the devices follow for when the question is
 * "why", and their conversations are a row at the bottom rather than a
 * panel, because reading a transcript is the one job here that is genuinely
 * better at a desk.
 *
 * Every destructive action is confirmed. On a desktop a mis-click is rare
 * enough to accept; on a phone a mis-tap is not, and three of these actions
 * sign somebody out of everything.
 */
export default function AdminPersonScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const access = useAdminAccess()
  const queryClient = useQueryClient()
  const { userId } = useLocalSearchParams<{ userId: string }>()

  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)

  const overview = useQuery({
    queryKey: ['admin', 'user', userId],
    enabled: access.canRead && Boolean(userId),
    queryFn: () => cloudSession.withAccessToken((token) => adminUserOverview(token, userId, 30))
  })

  const data = overview.data ?? null
  const isSelf =
    access.email !== null && data?.user.email.toLowerCase() === access.email.toLowerCase()
  const targetIsOwner = data?.user.role === 'owner'
  // The same rule the API enforces, so the screen never offers a control
  // that would come back forbidden.
  const canMutate = access.canWrite && (!targetIsOwner || access.isOwner)
  const suspended = data?.user.status === 'suspended'

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'user', userId] })
    // The roster's figures for this person just changed too.
    await queryClient.invalidateQueries({ queryKey: ['admin', 'roster'] })
  }

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (busy !== null) return
    setBusy(key)
    try {
      await fn()
    } catch (error) {
      toast.show({ message: (error as Error).message, tone: 'error' })
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  const chat = data?.lanes.find((l) => l.kind === 'chat')
  const search = data?.lanes.find((l) => l.kind === 'search')
  // The gate's counters are what the ceiling is enforced against; the rollup
  // is the fallback for the moment a gate is unreachable.
  const monthIn = data?.standing.tokens?.userMonthIn ?? chat?.month_tokens_in ?? 0
  const monthOut = data?.standing.tokens?.userMonthOut ?? chat?.month_tokens_out ?? 0

  const surfaces = (data?.surfaces ?? []).reduce<Record<string, { tokens: number; cost: number }>>(
    (acc, s) => {
      const cur = acc[s.surface] ?? { tokens: 0, cost: 0 }
      cur.tokens += (s.tokens_in || 0) + (s.tokens_out || 0)
      cur.cost += s.cost_microusd || 0
      acc[s.surface] = cur
      return acc
    },
    {}
  )
  const surfaceRows = Object.entries(surfaces).sort((a, b) => b[1].cost - a[1].cost)

  return (
    <PanelScreen title={data?.user.name ?? t('settings.admin.user.title')}>
      {/* Identity — the same three lines whether or not the data has landed. */}
      <Section>
        <View className="flex-col gap-1">
          <View className="h-5 justify-center">
            {data ? (
              <Text numberOfLines={1} className="text-fg font-sans-semibold text-left text-base">
                {data.user.name}
              </Text>
            ) : (
              <Bar className="h-4 w-40" />
            )}
          </View>
          <View className="h-4 justify-center">
            {data ? (
              <Text
                numberOfLines={1}
                selectable
                className="text-muted text-left font-sans text-xs"
                style={{ writingDirection: 'ltr' }}
              >
                {data.user.email}
              </Text>
            ) : (
              <Bar className="h-3 w-52 opacity-70" />
            )}
          </View>
          <View className="mt-1 h-5 flex-row items-center gap-1.5">
            {data ? (
              <>
                <Badge
                  label={t(`settings.admin.status.${data.user.status}`, {
                    defaultValue: data.user.status
                  })}
                  variant={statusBadgeVariant(data.user.status)}
                />
                <Badge label={t(`settings.admin.roles.${data.user.role}`)} variant="default" />
                <Badge
                  label={t(`settings.admin.plan.${data.policy.token_plan}`)}
                  variant={planBadgeVariant(data.policy.token_plan)}
                />
              </>
            ) : (
              <>
                <Bar className="h-4 w-14" />
                <Bar className="h-4 w-16 opacity-70" />
                <Bar className="h-4 w-14 opacity-50" />
              </>
            )}
          </View>
        </View>
      </Section>

      {/* Plan first: the control an admin most often reaches for from a phone. */}
      <Section title={t('settings.admin.plan.title')}>
        <SegmentedControl<TokenPlan>
          value={data?.policy.token_plan ?? null}
          disabled={!canMutate || data === null || busy !== null}
          onChange={(plan) =>
            void run(`plan:${plan}`, async () => {
              await cloudSession.withAccessToken((token) => adminSetPlan(token, userId, plan))
              await refresh()
              toast.show({
                message: t('settings.admin.plan.changed', {
                  plan: t(`settings.admin.plan.${plan}`)
                }),
                tone: 'success'
              })
            })
          }
          options={PLANS.map((plan) => ({ value: plan, label: t(`settings.admin.plan.${plan}`) }))}
        />
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {data ? ceilingLabel(data.policy.ceilings, locale, t) : ' '}
        </Text>
        {data ? (
          <>
            <PlanMeter
              label={t('settings.admin.plan.monthInput')}
              used={monthIn}
              ceiling={data.policy.ceilings.monthlyIn}
              locale={locale}
            />
            <PlanMeter
              label={t('settings.admin.plan.monthOutput')}
              used={monthOut}
              ceiling={data.policy.ceilings.monthlyOut}
              locale={locale}
            />
          </>
        ) : (
          <>
            <PlanMeterSkeleton label={t('settings.admin.plan.monthInput')} />
            <PlanMeterSkeleton label={t('settings.admin.plan.monthOutput')} />
          </>
        )}
      </Section>

      {/* Then the things an admin came here to DO. */}
      <Section title={t('settings.admin.controls.title')}>
        {access.isOwner ? (
          <View className="flex-col gap-2">
            <Text className="text-fg font-sans-medium text-left text-sm">
              {t('settings.admin.controls.role')}
            </Text>
            <SegmentedControl<AdminRole>
              value={data?.user.role ?? null}
              disabled={data === null || busy !== null || isSelf}
              onChange={(role) =>
                void run(`role:${role}`, async () => {
                  await cloudSession.withAccessToken((token) =>
                    adminUpdateUser(token, userId, { role })
                  )
                  await refresh()
                })
              }
              options={ROLES.map((role) => ({
                value: role,
                label: t(`settings.admin.roles.${role}`)
              }))}
            />
            <Text className="text-muted text-left font-sans text-xs leading-relaxed">
              {isSelf
                ? t('settings.admin.controls.notYourself')
                : t('settings.admin.controls.roleHint')}
            </Text>
          </View>
        ) : null}

        <ActionRow
          label={t('settings.admin.controls.access')}
          hint={
            suspended
              ? t('settings.admin.controls.accessDisabledHint')
              : t('settings.admin.controls.accessHint')
          }
          action={
            <Button
              variant={suspended ? 'outline' : 'danger'}
              size="sm"
              disabled={!canMutate || data === null || busy !== null || isSelf}
              onPress={() => setConfirming('status')}
            >
              {suspended
                ? t('settings.admin.controls.enable')
                : t('settings.admin.controls.disable')}
            </Button>
          }
        />
        <ActionRow
          label={t('settings.admin.controls.password')}
          hint={t('settings.admin.controls.passwordHint')}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!canMutate || data === null || busy !== null}
              onPress={() => setConfirming('password')}
            >
              {t('settings.admin.controls.resetPassword')}
            </Button>
          }
        />
        {tempPassword ? <TempPassword value={tempPassword} /> : null}
        <ActionRow
          label={t('settings.admin.controls.pin')}
          hint={t('settings.admin.controls.pinHint')}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!canMutate || data === null || busy !== null}
              onPress={() =>
                void run('pin', async () => {
                  await cloudSession.withAccessToken((token) => adminClearPin(token, userId))
                  await refresh()
                  toast.show({ message: t('settings.admin.controls.pinCleared'), tone: 'success' })
                })
              }
            >
              {t('settings.admin.controls.clearPin')}
            </Button>
          }
        />
        <ActionRow
          label={t('settings.admin.controls.sessions')}
          hint={t('settings.admin.controls.sessionsHint')}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!canMutate || data === null || busy !== null}
              onPress={() => setConfirming('sessions')}
            >
              {t('settings.admin.controls.signOutEverywhere')}
            </Button>
          }
        />
        {!canMutate ? (
          <Text className="text-muted text-left font-sans text-xs leading-relaxed">
            {targetIsOwner && !access.isOwner
              ? t('settings.admin.controls.ownerOnly')
              : t('settings.admin.controls.readOnly')}
          </Text>
        ) : null}
      </Section>

      <Section title={t('settings.admin.spend.title')}>
        {data ? (
          <StatPair
            items={[
              {
                key: 'in',
                label: t('settings.admin.spend.tokensIn'),
                value: formatTokens(chat?.tokens_in ?? 0, locale),
                sub: t('settings.admin.spend.cached', {
                  value: formatTokens(chat?.tokens_cached ?? 0, locale)
                })
              },
              {
                key: 'out',
                label: t('settings.admin.spend.tokensOut'),
                value: formatTokens(chat?.tokens_out ?? 0, locale),
                sub: t('settings.admin.spend.requests', { count: chat?.requests ?? 0 })
              },
              {
                key: 'cost',
                label: t('settings.admin.spend.cost'),
                value: formatUsd((chat?.cost_microusd ?? 0) + (search?.cost_microusd ?? 0), locale),
                sub: t('settings.admin.spend.days', { days: data.window.days })
              },
              {
                key: 'searches',
                label: t('settings.admin.spend.searches'),
                value: formatTokens((search?.requests ?? 0) - (search?.denied ?? 0), locale),
                sub: formatUsd(search?.cost_microusd ?? 0, locale)
              }
            ]}
          />
        ) : (
          <StatPairSkeleton
            labels={[
              t('settings.admin.spend.tokensIn'),
              t('settings.admin.spend.tokensOut'),
              t('settings.admin.spend.cost'),
              t('settings.admin.spend.searches')
            ]}
          />
        )}
      </Section>

      <Section title={t('settings.admin.surfaces.title')}>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {t('settings.admin.surfaces.subtitle')}
        </Text>
        {data === null ? (
          <View className="flex-col">
            {[0, 1, 2].map((i) => (
              <View
                key={i}
                className="border-border-soft h-9 flex-row items-center justify-between border-b"
              >
                <Bar className={i === 0 ? 'h-3 w-24' : 'h-3 w-20 opacity-70'} />
                <Bar className="h-3 w-28 opacity-70" />
              </View>
            ))}
          </View>
        ) : surfaceRows.length === 0 ? (
          <Text className="text-muted text-left font-sans text-xs">
            {t('settings.admin.surfaces.empty')}
          </Text>
        ) : (
          <View className="flex-col">
            {surfaceRows.map(([name, totals]) => (
              <View
                key={name || 'unattributed'}
                className="border-border-soft h-9 flex-row items-center justify-between gap-3 border-b"
              >
                <Text numberOfLines={1} className="text-fg flex-1 text-left font-sans text-xs">
                  {t(`settings.admin.surfaces.names.${name || 'unattributed'}`, {
                    defaultValue: name || t('settings.admin.surfaces.names.unattributed')
                  })}
                </Text>
                <Text
                  className="text-muted shrink-0 font-sans text-xs"
                  style={{ writingDirection: 'ltr' }}
                >
                  {formatTokens(totals.tokens, locale)} · {formatUsd(totals.cost, locale)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Section>

      <Section title={t('settings.admin.devices.title')}>
        {data === null ? (
          <View className="flex-col">
            {[0, 1].map((i) => (
              <View
                key={i}
                className="border-border-soft h-11 flex-col justify-center gap-1 border-b"
              >
                <Bar className="h-3 w-28" />
                <Bar className="h-2.5 w-40 opacity-70" />
              </View>
            ))}
          </View>
        ) : data.devices.length === 0 ? (
          <Text className="text-muted text-left font-sans text-xs">
            {t('settings.admin.devices.empty')}
          </Text>
        ) : (
          <View className="flex-col">
            {data.devices.map((d) => (
              <View key={d.id} className="border-border-soft flex-col gap-0.5 border-b py-2">
                <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-xs">
                  {d.name || d.platform}
                  {d.status !== 'active' ? ` · ${t('settings.admin.devices.revoked')}` : ''}
                </Text>
                <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
                  {d.platform}
                  {' · '}
                  {d.pin_set
                    ? t('settings.admin.devices.pinSet')
                    : t('settings.admin.devices.noPin')}
                  {d.pin_clear_requested ? ` · ${t('settings.admin.devices.pinClearPending')}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Section>

      {/* Reading a transcript is a desk job, so it is a row rather than a
          panel — but it IS here, because "what were they actually doing"
          sometimes cannot wait for a desk. */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(`/settings/admin/conversations/${userId}`)}
        className="bg-surface border-border flex-col gap-0.5 rounded-xl border px-4 py-3 active:bg-border-soft"
      >
        <Text className="text-fg font-sans-medium text-left text-sm">
          {t('settings.admin.conversations.title')}
        </Text>
        <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
          {data
            ? t('settings.admin.conversations.count', { count: data.counts.conversations })
            : t('settings.admin.conversations.subtitle')}
        </Text>
      </Pressable>

      <ConfirmDialog
        open={confirming === 'status'}
        busy={busy !== null}
        title={
          suspended
            ? t('settings.admin.confirm.enableTitle')
            : t('settings.admin.confirm.disableTitle')
        }
        message={
          suspended
            ? t('settings.admin.confirm.enableMessage', { name: data?.user.name ?? '' })
            : t('settings.admin.confirm.disableMessage', { name: data?.user.name ?? '' })
        }
        confirmLabel={
          suspended ? t('settings.admin.controls.enable') : t('settings.admin.controls.disable')
        }
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirming(null)}
        onConfirm={() =>
          void run('status', async () => {
            const next = suspended ? 'active' : 'suspended'
            await cloudSession.withAccessToken((token) =>
              adminUpdateUser(token, userId, { status: next })
            )
            await refresh()
            toast.show({
              message:
                next === 'suspended'
                  ? t('settings.admin.controls.disabledToast')
                  : t('settings.admin.controls.enabledToast'),
              tone: 'success'
            })
          })
        }
      />

      <ConfirmDialog
        open={confirming === 'password'}
        busy={busy !== null}
        title={t('settings.admin.confirm.passwordTitle')}
        message={t('settings.admin.confirm.passwordMessage', { name: data?.user.name ?? '' })}
        confirmLabel={t('settings.admin.controls.resetPassword')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirming(null)}
        onConfirm={() =>
          void run('password', async () => {
            const res = await cloudSession.withAccessToken((token) =>
              adminResetPassword(token, userId)
            )
            setTempPassword(res.temp_password)
            await refresh()
          })
        }
      />

      <ConfirmDialog
        open={confirming === 'sessions'}
        busy={busy !== null}
        title={t('settings.admin.confirm.sessionsTitle')}
        message={t('settings.admin.confirm.sessionsMessage', { name: data?.user.name ?? '' })}
        confirmLabel={t('settings.admin.controls.signOutEverywhere')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirming(null)}
        onConfirm={() =>
          void run('sessions', async () => {
            const res = await cloudSession.withAccessToken((token) =>
              adminRevokeSessions(token, userId)
            )
            await refresh()
            toast.show({
              message: t('settings.admin.controls.sessionsRevoked', { count: res.revoked }),
              tone: 'success'
            })
          })
        }
      />
    </PanelScreen>
  )
}

/**
 * The one-time password, with the only control that matters for it on a
 * phone: copy. The server never stores it in the clear, so this is the only
 * time it exists — it stays on screen until the admin leaves, rather than
 * behind a toast that vanishes in three seconds.
 */
function TempPassword({ value }: { value: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.copy')}
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => {
          toast.show({ message: t('common.copied'), tone: 'success' })
        })
      }}
      className="flex-col gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 active:opacity-80"
    >
      <Text className="text-fg font-sans-medium text-left text-xs">
        {t('settings.admin.controls.tempPassword')}
      </Text>
      <Text
        selectable
        className="text-fg text-left font-mono text-base"
        style={{ writingDirection: 'ltr' }}
      >
        {value}
      </Text>
      <Text className="text-muted text-left font-sans text-[11px] leading-relaxed">
        {t('settings.admin.controls.tempPasswordHint')}
      </Text>
    </Pressable>
  )
}
