import { ProviderMark } from '@/components/core/providerLogos'
import { useConfigValue } from '@/state/demoConfig'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * The model answering, in the chrome the Local/Cloud switch used to wear —
 * one full-width bordered row: the provider's mark and the model id.
 *
 * Nothing here switches any more. The cloud edition has one lane through the
 * organization's API — no local engine to flip to, no provider keys to pick
 * between — and the desktop's snapshot names the current model without a
 * catalog, so there is nothing to choose from either. The row shows what the
 * desktop reports and never writes; picking a model stays a desktop act until
 * the phone is re-aimed at the API. Kept under its old name because the chat
 * menu and the Model screen both mount it where the switch stood.
 */
export function ModelSwitch(): React.JSX.Element {
  const { t } = useTranslation()
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')
  const label = brainModel || t('settings.model.noModel')

  return (
    <View
      accessibilityLabel={label}
      className="border-border bg-bg h-11 w-full flex-row items-center gap-2 rounded-lg border px-3"
    >
      <ProviderMark provider={brainProvider} size={16} className="text-fg" />
      <Text
        numberOfLines={1}
        selectable
        className="text-fg font-sans-medium flex-shrink text-xs"
        // A model id is an identifier, not a sentence — keep it LTR under an
        // RTL locale, as the composer's chip does.
        style={{ writingDirection: 'ltr' }}
      >
        {label}
      </Text>
    </View>
  )
}
