import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { ConfigSwitchRow } from '@/components/settings/ConfigRows'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useTranslation } from 'react-i18next'

/**
 * Channels — the desktop's In-App and Mobile panels. Every row binds to a
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
          (in-app, then phone). All are real switches rather than status
          rows: nothing has to be started on the desktop for any of them to
          take effect, so the phone is free to drive its own channel. */}
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
    </PanelScreen>
  )
}
