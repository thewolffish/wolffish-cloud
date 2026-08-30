import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import {
  ConfigSelectRow,
  ConfigStatusRow,
  ConfigSwitchRow,
  ConfigTextRow
} from '@/components/settings/ConfigRows'
import { InfoRow, PanelScreen, Section, StatusRow } from '@/components/settings/SettingsUI'
import { useCliStatus } from '@/state/demoConfig'
import { Text } from 'react-native'
import { useTranslation } from 'react-i18next'

const STALE_HOURS = ['1', '3', '6', '12', '24'].map((value) => ({ value, label: value }))

/**
 * Channels — the desktop's In-App / Telegram / WhatsApp panels. Mobile edits
 * a channel's settings (allow-list, auto-refresh, stale window, verbose,
 * hide-automations) but never its power switch: enabling a channel starts a
 * bridge process on the desktop, which is the desktop's to start, so the
 * enabled row reports state and the rest gate on it. Every row binds to a
 * single config key, so a toggle re-renders only itself.
 */
export default function ChannelsScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()

  return (
    <PanelScreen title={t('settings.tabs.channels')} subtitle={t('settings.channels.subtitle')}>
      {/* One in-app feed setting, not two: `inapp.verbose` is the desktop's
          own key and it drives this device's chat as well — the preference
          belongs to the workspace, not to whichever screen renders it. */}
      <Section title={t('settings.channels.inapp')}>
        <ConfigSwitchRow
          field="inappVerbose"
          label={t('settings.verbose.label')}
          description={t('settings.verbose.description')}
        />
        {/* The desktop's floating automation cards — that machine's screen,
            edited from here. This phone's own copy of the question lives in
            the section below, because the two are answered differently. */}
        <ConfigSwitchRow
          field="inappRunCards"
          label={t('settings.channels.runCards')}
          description={t('settings.channels.runCardsDesktopDescription')}
        />
      </Section>

      {/* This device, as the desktop's Mobile panel sees it — the same two
          settings, the same words, in the desktop's own channel order
          (in-app, phone, Telegram, WhatsApp). Both are real switches rather
          than status rows: unlike a Telegram bridge, nothing has to be
          started on the desktop for either to take effect, so the phone is
          free to drive its own channel. */}
      <Section title={t('settings.channels.phone')}>
        <ConfigSwitchRow
          field="mobileNotifications"
          label={t('settings.channels.notifications')}
          description={t('settings.channels.notificationsDescription')}
        />
        <ConfigSwitchRow
          field="mobileVerbose"
          label={t('settings.channels.taskResults')}
          description={t('settings.channels.taskResultsDescription')}
        />
        {/* Whether a run on the desktop cards over THIS phone. Off by
            default: the pushes still arrive, the Automations screen still
            shows what ran — only the interruption goes away. */}
        <ConfigSwitchRow
          field="mobileRunCards"
          label={t('settings.channels.runCards')}
          description={t('settings.channels.runCardsPhoneDescription')}
        />
      </Section>

      <Section title="Telegram">
        <ConfigStatusRow
          field="telegramEnabled"
          label={t('settings.channels.enabled')}
          description={t('settings.channels.telegramDescription')}
        />
        {/* One write on blur, not one per keystroke: an allow-list change
            restarts the desktop's bridge, so it must arrive as a single
            deliberate act — the same reason its panel saves on a button. */}
        <ConfigTextRow
          field="telegramAllowedUserIds"
          label={t('settings.channels.allowedUserIds')}
          placeholder={t('settings.channels.allowedUserIdsPlaceholder')}
          requires="telegramEnabled"
          commitOnEndEditing
        />
        <ConfigSwitchRow
          field="telegramAutoRefresh"
          label={t('settings.channels.autoRefresh')}
          description={t('settings.channels.autoRefreshDescription')}
          requires="telegramEnabled"
        />
        <ConfigSelectRow
          field="telegramStaleHours"
          label={t('settings.channels.staleHours')}
          options={STALE_HOURS}
        />
        <ConfigSwitchRow
          field="telegramHideAutomations"
          label={t('settings.channels.hideAutomations')}
          description={t('settings.channels.hideAutomationsDescription')}
          requires="telegramEnabled"
        />
        <ConfigSwitchRow
          field="telegramVerbose"
          label={t('settings.verbose.label')}
          description={t('settings.verbose.channelDescription')}
          requires="telegramEnabled"
        />
      </Section>

      <Section title="WhatsApp">
        <ConfigStatusRow
          field="whatsappEnabled"
          label={t('settings.channels.enabled')}
          description={t('settings.channels.whatsappDescription')}
        />
        {/* Same one-write-on-blur contract as Telegram's allow-list above. */}
        <ConfigTextRow
          field="whatsappAllowedNumbers"
          label={t('settings.channels.allowedNumbers')}
          placeholder={t('settings.channels.allowedNumbersPlaceholder')}
          requires="whatsappEnabled"
          keyboardType="phone-pad"
          commitOnEndEditing
        />
        <ConfigSwitchRow
          field="whatsappAutoRefresh"
          label={t('settings.channels.autoRefresh')}
          description={t('settings.channels.autoRefreshDescription')}
          requires="whatsappEnabled"
        />
        <ConfigSelectRow
          field="whatsappStaleHours"
          label={t('settings.channels.staleHours')}
          options={STALE_HOURS}
        />
        <ConfigSwitchRow
          field="whatsappHideAutomations"
          label={t('settings.channels.hideAutomations')}
          description={t('settings.channels.hideAutomationsDescription')}
          requires="whatsappEnabled"
        />
        <ConfigSwitchRow
          field="whatsappVerbose"
          label={t('settings.verbose.label')}
          description={t('settings.verbose.channelDescription')}
          requires="whatsappEnabled"
        />
      </Section>

      <CliCards />
    </PanelScreen>
  )
}

/**
 * The terminal channel, at the bottom of the screen.
 *
 * Last rather than second (where the desktop's own sub-tab sits) because it is
 * the one channel this device cannot use: `wolffish` runs in a shell on the
 * desktop, so these cards are about a machine you are holding a remote for.
 * Reading them is the point — is the command findable, did autostart take —
 * and the single row that writes is the feed preference, which is an ordinary
 * config key like every other channel's.
 *
 * Split in two the way the desktop panel is: the command and its feed, then
 * the autostart registration, which is a different subject with a different
 * owner. Everything but `cliVerbose` is a StatusRow/InfoRow on purpose — see
 * CliStatus in the store for why none of it is a switch here.
 */
function CliCards(): React.JSX.Element {
  const { t } = useTranslation()
  const cli = useCliStatus()

  return (
    <>
      <Section title={t('settings.channels.cli.title')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.channels.cli.description')}
        </Text>
        <StatusRow
          label={t('settings.channels.cli.command')}
          description={t('settings.channels.cli.commandDescription')}
          // Three readings, three tones. `null` is the desktop's probe having
          // failed or predating this card — grey and "Unknown", never the red
          // of a command that is genuinely missing.
          tone={cli.pathInstalled === null ? 'idle' : cli.pathInstalled ? 'ok' : 'error'}
          value={
            cli.pathInstalled === null
              ? t('settings.channels.cli.unknown')
              : cli.pathInstalled
                ? t('settings.channels.cli.commandReady')
                : t('settings.channels.cli.commandMissing')
          }
        />
        {/* `verbose.label`, not the phone card's "Task results": that wording
            belongs to this device's own feed, and every OTHER channel's row on
            this screen already says "Verbose task results". A second row
            labelled like the phone's would read as a second setting for the
            phone. */}
        <ConfigSwitchRow
          field="cliVerbose"
          label={t('settings.verbose.label')}
          description={t('settings.channels.cli.verboseDescription')}
        />
      </Section>

      <Section title={t('settings.channels.cli.service')}>
        <StatusRow
          label={t('settings.channels.cli.serviceState')}
          description={t('settings.channels.cli.serviceDescription')}
          tone={cli.serviceActive === null ? 'idle' : cli.serviceActive ? 'ok' : 'idle'}
          value={
            cli.serviceActive === null
              ? t('settings.channels.cli.unknown')
              : cli.serviceActive
                ? t('settings.channels.cli.serviceRegistered')
                : t('settings.channels.cli.serviceNotRegistered')
          }
        />
        <InfoRow
          label={t('settings.channels.cli.mode')}
          value={t(`settings.channels.cli.modes.${cli.runMode}`)}
        />
        {/* launchd / systemd / schtasks — a technical name, so it keeps LTR
            under Arabic like every other value the app prints as code. */}
        <InfoRow
          label={t('settings.channels.cli.mechanism')}
          value={cli.mechanism ?? '—'}
          mono
          code
        />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.channels.cli.serviceOnDesktop')}
        </Text>
      </Section>
    </>
  )
}
