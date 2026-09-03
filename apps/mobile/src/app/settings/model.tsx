import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { ModeAndThinkingControls } from '@/components/chat/ChatControls'
import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useTranslation } from 'react-i18next'
import { Text } from 'react-native'

/**
 * Model — the org lane. Behavior controls up top (the two knobs touched every
 * session), then the model answering, as the desktop reports it.
 *
 * That is the whole screen on purpose. The cloud edition has one lane through
 * the organization's API: no provider cards or API keys (the desktop holds no
 * keys), no local engine (no Ollama, no models folder), and the snapshot names
 * the current model without a catalog to pick from — so this screen shows the
 * model rather than offering a choice it could not honor. Re-aiming the phone
 * at the API, catalog included, is a later phase.
 */
export default function ModelScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()

  return (
    <PanelScreen title={t('settings.tabs.model')} subtitle={t('settings.model.subtitle')}>
      <Section title={t('settings.model.behaviorTitle')}>
        <ModeAndThinkingControls />
      </Section>

      <Section title={t('settings.model.modelTitle')}>
        <ModelSwitch />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.model.orgNote')}
        </Text>
      </Section>
    </PanelScreen>
  )
}
