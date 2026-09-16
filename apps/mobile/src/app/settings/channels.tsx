import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { BrowserLogo } from '@/components/core/browserLogos'
import { Input } from '@/components/core/Input'
import type { SelectOption } from '@/components/core/Select'
import { ConfigSelectRow, ConfigSwitchRow, ConfigTextRow } from '@/components/settings/ConfigRows'
import {
  InfoRow,
  PanelScreen,
  Section,
  StatusDot,
  StatusRow
} from '@/components/settings/SettingsUI'
import {
  useCliStatus,
  useConfigValue,
  useDemoConfig,
  type ExtensionBrowser,
  type ExtensionReadiness
} from '@/state/demoConfig'
import { Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'

const SCREENSHOT_WIDTHS: readonly SelectOption<string>[] = ['640', '960', '1280', '1920'].map(
  (value) => ({ value, label: `${value}px` })
)

const SCREENSHOT_FORMATS: readonly SelectOption<string>[] = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' }
]

/**
 * Channels — the desktop's In-App, Mobile, Browser and CLI panels. Every row
 * binds to a single config key, so a toggle re-renders only itself.
 *
 * The cards follow the desktop's own channel order — in-app, phone, browser —
 * with the terminal moved to the end for the reason CliCards gives.
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
        {/* Not a desktop-only row despite the section it sits in: like the
            feed switch at the top, `inapp.reasoning` is the workspace's
            answer, so this drives this phone's chat as well. */}
        <ConfigSwitchRow
          field="inappReasoning"
          label={t('settings.channels.reasoning')}
          description={t('settings.channels.reasoningDescription')}
        />
      </Section>

      {/* This device, as the desktop's Mobile panel sees it — the same
          settings, the same words, in the desktop's own channel order
          (in-app, phone, browser, terminal). Both are real switches rather
          than status rows: nothing has to be started on the desktop for either
          to take effect, so the phone is free to drive its own channel. */}
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
      </Section>

      <BrowserChannel />

      <CliCards />
    </PanelScreen>
  )
}

/**
 * One connected browser, exactly as the desktop's extension panel draws it:
 * the browser's mark, its name with the major version, and the identity line
 * (profile · OS · connected time), with the extension version as a chip.
 */
function BrowserCard({ browser }: { browser: ExtensionBrowser }): React.JSX.Element {
  const { t } = useTranslation()
  const major = browser.browserVersion ? browser.browserVersion.split('.')[0] : null
  const connectedAt = browser.connectedAt
    ? t('settings.channels.browser.connectedAtTime', {
        time: new Date(browser.connectedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      })
    : null
  const detail = [browser.profileEmail, browser.os, connectedAt].filter(Boolean).join(' · ')
  return (
    <View className="bg-bg flex-row items-center gap-3 rounded-xl px-3 py-2.5">
      <BrowserLogo browser={browser.browser} size={20} />
      <View className="min-w-0 flex-1 flex-col">
        <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
          {browser.name}
          {major ? <Text className="text-muted font-sans"> {major}</Text> : null}
        </Text>
        {detail ? (
          <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
            {detail}
          </Text>
        ) : null}
      </View>
      {browser.extensionVersion ? (
        <Text className="bg-surface text-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
          v{browser.extensionVersion}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * The desktop's readiness verdict, reduced to one row.
 *
 * It renders NOTHING when there is nothing to say — no desktop has reported
 * yet, or it reported a tier of 'none' with no blockers. A permanently grey
 * "unknown" row would be worse than silence: the point of this row is that the
 * user can act on it, and the fix itself lives on the desktop.
 */
function ReadinessRow({ readiness }: { readiness: ExtensionReadiness }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!readiness.ready && readiness.blockers === 0 && readiness.tier === 'none') return null
  const label = readiness.ready
    ? t('settings.channels.browser.readinessReady')
    : readiness.blockers > 0
      ? t('settings.channels.browser.readinessBlockers', { count: readiness.blockers })
      : t('settings.channels.browser.readinessLimited')
  return (
    <View className="bg-bg flex-col gap-1 rounded-xl px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <StatusDot tone={readiness.ready ? 'ok' : readiness.blockers > 0 ? 'error' : 'busy'} />
        {/* The label is a sentence, so it wraps rather than truncating — but it
            has to give up its width first, or the tier chip is pushed off the
            card (the same min-w-0/flex-1 the browser rows above use). */}
        <Text className="text-fg font-sans-medium min-w-0 flex-1 text-left text-sm">{label}</Text>
        <Text className="bg-surface text-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
          {t(`settings.channels.browser.tier.${readiness.tier}`, {
            defaultValue: readiness.tier
          })}
        </Text>
      </View>
      {/* The first blocker only. The desktop walks the rest. */}
      {readiness.top ? (
        <Text className="text-muted text-left font-sans text-xs leading-5">{readiness.top}</Text>
      ) : null}
      {!readiness.ready ? (
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.channels.browser.readinessFixOnDesktop')}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * The browser channel — the desktop's Browser sub-tab, card for card.
 *
 * A channel rather than a service, which is the desktop's own reading: the
 * agent works IN your browser the way it works in a terminal, instead of
 * borrowing a key from it. So the card opens the way every other channel's
 * does — one line for whether the agent can reach you there — and only then
 * lists the browsers that answered.
 *
 * The state row stays even while browsers are listed: a card whose emptiness
 * is the whole message has to say so in words, or a desktop with no browser
 * paired reads as a screenshot-settings form with nothing above it.
 */
function BrowserChannel(): React.JSX.Element {
  const { t } = useTranslation()
  // Whether any browser is talking to the desktop, read from the same services
  // map the settings list reads (the desktop's flag, falling back to the
  // browsers it listed) — so this row and the mark on the Channels row can
  // never disagree about the same fact.
  const connected = useDemoConfig((state) =>
    state.services.some((service) => service.key === 'browserExtension' && service.connected)
  )
  const browsers = useDemoConfig((state) => state.extensionBrowsers)
  const readiness = useDemoConfig((state) => state.extensionReadiness)
  const port = useConfigValue('browserExtensionPort')

  return (
    <Section title={t('settings.channels.browser.title')}>
      <StatusRow
        label={t('settings.channels.browser.extension')}
        description={t('settings.channels.browser.extensionDescription')}
        tone={connected ? 'ok' : 'idle'}
        value={
          connected
            ? t('settings.channels.browser.extensionConnected')
            : t('settings.channels.browser.extensionNone')
        }
      />
      {browsers.map((browser, index) => (
        <BrowserCard key={`${browser.browser}-${index}`} browser={browser} />
      ))}
      <ReadinessRow readiness={readiness} />
      {/* The port stays the desktop's: moving it restarts the pairing
          server that extension connections dial into. */}
      <View className="flex-col gap-1.5">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('settings.channels.browser.port')}
        </Text>
        <Input value={port} editable={false} />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.channels.browser.portManagedOnDesktop')}
        </Text>
      </View>
      <ConfigSelectRow
        field="browserScreenshotMaxWidth"
        label={t('settings.channels.browser.screenshotMaxWidth')}
        options={SCREENSHOT_WIDTHS}
      />
      <ConfigSelectRow
        field="browserScreenshotFormat"
        label={t('settings.channels.browser.screenshotFormat')}
        options={SCREENSHOT_FORMATS}
      />
      <ConfigTextRow
        field="browserScreenshotQuality"
        label={t('settings.channels.browser.quality')}
        placeholder="80"
        keyboardType="number-pad"
      />
      {/* Not a desktop-only note — the settings above ARE editable here; only
          the install-and-pair handshake is desktop-bound. */}
      <Text className="text-muted text-left font-sans text-xs leading-5">
        {t('settings.channels.browser.pairingNote')}
      </Text>
    </Section>
  )
}

/**
 * The terminal channel, at the bottom of the screen.
 *
 * Last rather than second (where the desktop's own sub-tab sits) because it is
 * the one channel this device cannot use: `wfc` runs in a shell on the
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
            belongs to this device's own feed, and the in-app row on this
            screen already says "Show all tool activity". A second row labelled
            like the phone's would read as a second setting for the phone. */}
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
