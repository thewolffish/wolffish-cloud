import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { ModeAndThinkingControls } from '@/components/chat/ChatControls'
import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useTranslation } from 'react-i18next'
import { Text } from 'react-native'

/**
 * Model — the org lane. Behavior controls up top (the two knobs touched every
 * session), then the model answering, chosen from the organization's catalog.
 *
 * That is the whole screen on purpose. The cloud edition has one lane through
 * the organization's API: no provider cards or API keys (the desktop holds no
 * keys), no local engine (no Ollama, no models folder). The one choice that
 * remains — which of the org's models answers — is the chip row below, and it
 * writes through to the desktop, which is the machine that runs the turn.
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
