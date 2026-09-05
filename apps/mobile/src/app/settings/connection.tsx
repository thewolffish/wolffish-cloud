import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import {
  Activity04Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  CancelCircleIcon,
  Clock01Icon,
  ComputerIcon,
  FlashIcon,
  QrCode01Icon,
  RefreshIcon
} from '@/components/core/icons'
import { InfoRow, PanelScreen, Section, StatusDot } from '@/components/settings/SettingsUI'
import { cn } from '@/lib/utils/cn'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { applyConfigSnapshot } from '@/lib/demo/importer'
import { getDemoLastSyncAt, useDemoConnectionState } from '@/lib/demo/connection'
import { clearAllBadges, unregisterPush } from '@/lib/notifications/push'
import { beginSync } from '@/lib/sync/activity'
import { getLastSyncedAt, refreshConfig, refreshSync, refreshUsage } from '@/lib/sync/sync'
import { bridgeClient } from '@/lib/cloud/bridge'
import { cloudSession } from '@/lib/cloud/session'
import { describeBridgeStatus, useBridgeState, useBridgeStatus } from '@/lib/cloud/useBridgeStatus'
import { useAppStore } from '@/state/appStore'
import { useToast } from '@/providers/toast/useToast'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Connection — the link to the organization and, through it, to the desktop.
 *
 * The first screen in Settings when paired — and in demo mode, where the
 * same rows say the honest thing: nothing is paired, and here is how to pair
 * something (lib/demo/connection). Two facts are kept visibly apart: whether
 * the org is reachable (everything on this phone comes from there) and
 * whether the desktop is on the bridge (the machine that runs turns). A
 * phone whose desktop is asleep is not broken; this screen says exactly
 * which half is missing.
 */
export default function ConnectionScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const setPaired = useAppStore((state) => state.setPaired)
  const demoMode = useAppStore((state) => state.demoMode)
  const liveState = useBridgeState()
  const demoState = useDemoConnectionState()
  // One variable for every row below, so none of them knows which mode it is
  // rendering — the demo state is a real BridgeState, just an invented one.
  const state = demoMode ? demoState : liveState
  const liveStatus = useBridgeStatus()
  // Demo mode is genuinely not connected, and says so: the same describe()
  // the live path uses, over the demo's own (idle) state.
  const { label: statusLabel, tone: statusTone } = demoMode
    ? { label: t('connection.demoNotPaired'), tone: 'idle' as const }
    : liveStatus
  const readLastSyncAt = demoMode ? getDemoLastSyncAt : getLastSyncedAt
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(readLastSyncAt)
  const [, setTick] = useState(0)
  const account = demoMode ? null : cloudSession.current

  // The catch-up that runs on foreground finishes after this screen mounts,
  // so poll the module's timestamp rather than reading it once.
  useEffect(() => {
    const timer = setInterval(() => {
      setLastSyncAt(readLastSyncAt())
      setTick((n) => n + 1)
    }, 5_000)
    return () => clearInterval(timer)
    // readLastSyncAt is picked by demoMode, which cannot change while this
    // screen is mounted — both exits unmount the whole stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resync = async (): Promise<void> => {
    setBusy(true)
    if (demoMode) {
      await applyConfigSnapshot()
      setLastSyncAt(readLastSyncAt())
      toast.show({ tone: 'success', message: t('connection.resynced', { count: 0 }) })
      setBusy(false)
      return
    }
    // Reported so a slow manual sync gets the same dialog a background one
    // does. Everything the user can see: settings, the index, usage.
    const progress = beginSync()
    try {
      let settings = false
      let conversations = false
      const [, result] = await Promise.all([
        refreshConfig().finally(() => {
          settings = true
          progress.step({ settings, conversations })
        }),
        refreshSync(true).finally(() => {
          conversations = true
          progress.step({ settings, conversations })
        }),
        refreshUsage().catch(() => undefined)
      ])
      setLastSyncAt(Date.now())
      toast.show({ tone: 'success', message: t('connection.resynced', { count: result.changed }) })
    } catch (error) {
      bridgeClient.reportRpcFailure(error)
      toast.show({ tone: 'error', message: t('connection.resyncFailed') })
    } finally {
      progress.end()
      setBusy(false)
    }
  }

  /** Drop the socket and build a fresh one — the manual version of what
   *  returning to the app does, for a link that has gone quiet. Not awaited:
   *  the status row above reports the outcome as it happens. */
  const reconnect = (): void => {
    bridgeClient.refresh()
  }

  /**
   * Sign out: revoke this phone's session at the org AND wipe everything
   * that came down. The synced conversations, settings and usage on this
   * phone are a copy of the org's record, readable by anyone holding the
   * unlocked phone; the org keeps the originals, so pairing again restores
   * all of it.
   */
  const signOut = async (): Promise<void> => {
    setBusy(true)
    setConfirming(false)
    try {
      if (demoMode) {
        await factoryResetDevice()
      } else {
        // Badges and the push registration first, while the socket is still
        // up: the bridge's per-device count and token are reachable only over
        // the live socket, and a signed-out phone must stop being pushable.
        await clearAllBadges()
        await unregisterPush()
        await bridgeClient.disconnect()
        await factoryResetDevice()
        setPaired(false)
      }
    } catch {
      setBusy(false)
      toast.show({ tone: 'error', message: t('connection.signOutFailed') })
      return
    }
    setBusy(false)
    router.replace('/')
  }

  const syncLine = lastSyncAt
    ? t('connection.syncLive', { ago: formatRelativeTime(lastSyncAt, t) })
    : t('connection.syncLivePending')

  const desktopName = state.desktop?.name || account?.desktop?.name || null

  return (
    <PanelScreen title={t('settings.tabs.connection')} subtitle={t('connection.subtitle')}>
      <Section title={t('connection.org')}>
        <View className="flex-row items-center justify-between px-1 py-2">
          <Text className="text-muted font-sans text-sm">{t('connection.status.label')}</Text>
          <View className="flex-row items-center gap-2">
            <StatusDot tone={statusTone} />
            <Text className="text-fg font-sans text-sm">{statusLabel}</Text>
          </View>
        </View>
        <InfoRow
          label={t('connection.account')}
          value={demoMode ? t('connection.demoAccount') : (account?.session.user.email ?? '—')}
        />
        <InfoRow
          label={t('connection.organization')}
          value={demoMode ? 'Wolffish Inc' : (account?.orgName ?? '—')}
        />
        <InfoRow
          label={t('connection.since')}
          value={state.connectedAt ? formatRelativeTime(state.connectedAt, t) : '—'}
        />
        <CodeLine label={t('connection.endpoint')} value={state.apiBase} />
        {state.lastError && state.status === 'error' ? (
          <CodeLine label={t('connection.lastError')} value={state.lastError} tone="error" />
        ) : null}
      </Section>

      {/* The desktop as its own card: it is the half that can be away while
          everything else on this phone keeps working. */}
      <Section title={t('connection.desktop')}>
        <View className="flex-row items-start gap-3 px-1 py-2">
          <View className="mt-0.5">
            <ComputerIcon size={18} className="text-muted" />
          </View>
          <View className="flex-1 gap-0.5">
            <Text className="text-fg text-left font-sans-medium text-sm">
              {demoMode
                ? t('connection.desktopNone')
                : (desktopName ?? t('connection.desktopUnknown'))}
            </Text>
            <Text className="text-muted text-left font-sans text-xs leading-relaxed">
              {demoMode
                ? t('connection.desktopNoneHint')
                : state.desktop
                  ? t('connection.desktopOnline')
                  : t('connection.desktopOffline')}
            </Text>
          </View>
          <View className="mt-1">
            <StatusDot tone={state.desktop ? 'ok' : 'idle'} />
          </View>
        </View>
      </Section>

      <Section title={t('connection.sync')}>
        <ActionRow
          icon={<RefreshIcon size={18} className="text-muted" />}
          title={t('connection.resync')}
          description={t('connection.resyncHint')}
          action={
            <Button size="sm" variant="outline" onPress={() => void resync()} disabled={busy}>
              {t('connection.resyncNow')}
            </Button>
          }
        />
        <HowRow
          icon={<FlashIcon size={16} className="text-muted" />}
          title={t('connection.how.pushTitle')}
          body={t('connection.how.pushBody')}
        />
        <HowRow
          icon={<Activity04Icon size={16} className="text-muted" />}
          title={t('connection.how.wakeTitle')}
          body={t('connection.how.wakeBody')}
        />
        <HowRow
          icon={<Clock01Icon size={16} className="text-muted" />}
          title={t('connection.how.lastTitle')}
          body={syncLine}
        />
      </Section>

      <Section title={t('connection.manage')}>
        {/* Reconnect belongs to a link that exists. In demo there is none —
            the row below, which pairs a real desktop, is the whole offer. */}
        {!demoMode && (
          <ActionRow
            icon={<Activity04Icon size={18} className="text-muted" />}
            title={t('connection.reconnect')}
            description={t('connection.reconnectHint')}
            action={
              <Button size="sm" variant="outline" onPress={reconnect} disabled={busy}>
                {t('connection.reconnectAction')}
              </Button>
            }
          />
        )}
        <ActionRow
          icon={<QrCode01Icon size={18} className="text-muted" />}
          title={t('connection.repair')}
          description={t(demoMode ? 'connection.repairDemoHint' : 'connection.repairHint')}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => router.push('/?stay=1')}
            >
              {t('connection.repairAction')}
            </Button>
          }
        />
        <ActionRow
          icon={<CancelCircleIcon size={18} className="text-rose-500" />}
          title={t('connection.signOut')}
          description={t(demoMode ? 'connection.demoSignOutHint' : 'connection.signOutHint')}
          action={
            <Button size="sm" variant="danger" onPress={() => setConfirming(true)} disabled={busy}>
              {t('connection.signOutAction')}
            </Button>
          }
        />
      </Section>

      <Section title={t('connection.traffic')}>
        <IconRow
          icon={<ArrowUp02Icon size={16} className="text-muted" />}
          label={t('connection.framesSent')}
          value={String(state.framesSent)}
        />
        <IconRow
          icon={<ArrowDown02Icon size={16} className="text-muted" />}
          label={t('connection.framesReceived')}
          value={String(state.framesReceived)}
        />
        <IconRow
          icon={<RefreshIcon size={16} className="text-muted" />}
          label={t('connection.reconnects')}
          value={String(state.reconnects)}
        />
      </Section>

      <Section title={t('connection.privacy')}>
        <Text className="text-muted px-1 font-sans text-sm leading-relaxed">
          {t('connection.privacyBody')}
        </Text>
      </Section>

      <ConfirmDialog
        open={confirming}
        busy={busy}
        title={t(
          demoMode ? 'connection.demoSignOutConfirmTitle' : 'connection.signOutConfirmTitle'
        )}
        message={t(
          demoMode ? 'connection.demoSignOutConfirmBody' : 'connection.signOutConfirmBody'
        )}
        confirmLabel={t('connection.signOutAction')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void signOut()}
        onCancel={() => setConfirming(false)}
      />
    </PanelScreen>
  )
}

/** An action with its reason attached: icon, what it is, what it does. */
function ActionRow({
  icon,
  title,
  description,
  action
}: {
  icon: React.ReactNode
  title: string
  description: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3 px-1 py-2">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {description}
        </Text>
      </View>
      <View className="shrink-0">{action}</View>
    </View>
  )
}

/** A stat with its direction shown, not just named. */
function IconRow({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center justify-between px-1 py-2">
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-muted font-sans text-sm">{label}</Text>
      </View>
      <Text className="text-fg font-sans text-sm">{value}</Text>
    </View>
  )
}

/** One fact about how syncing behaves — the pairing sheet's row, reused. */
function HowRow({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3 px-1 py-2">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}

/** A value to be read exactly — an endpoint, an error — in its own block. */
function CodeLine({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'error'
}): React.JSX.Element {
  return (
    <View className="gap-1 px-1 py-2">
      <Text className="text-muted text-left font-sans text-xs">{label}</Text>
      <View
        className={cn(
          'bg-bg border-border rounded-lg border px-3 py-2',
          tone === 'error' && 'border-rose-500/40'
        )}
      >
        <Text
          selectable
          style={{ writingDirection: 'ltr' }}
          className="text-fg text-left font-mono text-[11px] leading-4"
        >
          {value}
        </Text>
      </View>
    </View>
  )
}
