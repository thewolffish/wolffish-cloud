import { OllamaLogo, PROVIDER_LABELS, ProviderMark } from '@/components/core/providerLogos'
import { cn } from '@/lib/utils/cn'
import { setConfigValue, useConfigValue, useDemoConfig } from '@/state/demoConfig'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * The desktop composer's ModelSwitch as a full-width control: two tabs —
 * Local (Ollama logo + local model) and Cloud (active provider logo + model,
 * truncated). Picking a side flips llm.localOnly exactly like the desktop;
 * below it, the active side's model picker.
 */

export function ModelSwitch(): React.JSX.Element {
  const { t } = useTranslation()
  const localOnly = useConfigValue('localOnly')
  const localEnabled = useConfigValue('localEnabled')
  const localModel = useConfigValue('localModel')
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')

  const localActive = localOnly && localEnabled

  return (
    <View className="border-border bg-bg w-full flex-row items-stretch rounded-lg border p-0.5">
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: localActive, disabled: !localEnabled }}
        disabled={!localEnabled}
        onPress={() => setConfigValue('localOnly', true)}
        className={cn(
          'h-11 flex-1 flex-row items-center justify-center gap-2 rounded-md px-3',
          // No shadow class here: toggling one on/off between renders makes
          // NativeWind "upgrade" the view, and its dev-only upgrade warning
          // stringifies props — which walks React Navigation's throwing
          // context getters and red-boxes the app on every switch tap.
          localActive && 'bg-primary',
          !localEnabled && 'opacity-50'
        )}
      >
        <OllamaLogo size={16} className={localActive ? 'text-primary-fg' : 'text-muted'} />
        <Text
          numberOfLines={1}
          className={cn(
            'font-sans-medium flex-shrink text-xs',
            localActive ? 'text-primary-fg' : 'text-muted'
          )}
          style={{ writingDirection: 'ltr' }}
        >
          {localEnabled && localModel ? localModel : t('settings.model.noModel')}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: !localActive }}
        onPress={() => setConfigValue('localOnly', false)}
        className={cn(
          'h-11 flex-1 flex-row items-center justify-center gap-2 rounded-md px-3',
          !localActive && 'bg-primary'
        )}
      >
        <ProviderMark
          provider={brainProvider}
          size={16}
          className={!localActive ? 'text-primary-fg' : 'text-muted'}
        />
        <Text
          numberOfLines={1}
          className={cn(
            'font-sans-medium flex-shrink text-xs',
            !localActive ? 'text-primary-fg' : 'text-muted'
          )}
          style={{ writingDirection: 'ltr' }}
        >
          {brainModel || t('settings.model.noModel')}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * A picker row in the project chips' shape: the whole list on one x-scrolling
 * line, one tap to choose. Chips rather than a Select for the reason the chat
 * menu's project row states — the whole list is the point, and a Select hid
 * every option behind a modal and truncated the value it showed. The row never
 * wraps and scrolls freely on x, so every chip carries its full provider or
 * model name however long it runs.
 */
function ChipRow({
  label,
  chips,
  value,
  onChange
}: {
  label: string
  chips: readonly {
    value: string
    label: string
    /** By active, so a provider logo flips to primary-fg on the lit chip. */
    icon?: (active: boolean) => React.JSX.Element
  }[]
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  // The lit chip can start off the row's right edge — the row would open
  // reading as nothing chosen. Scroll it into view the once; every later
  // change comes from a tap, which is already in view. The latch turns only on
  // a scroll that actually happened, so a chip laid out at the start before
  // the provider list lands still gets carried in when the list pushes it
  // right.
  const rowRef = useRef<ScrollView | null>(null)
  const settled = useRef(false)
  const onActiveLayout = (x: number): void => {
    if (settled.current || x <= 0) return
    settled.current = true
    rowRef.current?.scrollTo({ x: Math.max(x - 12, 0), animated: false })
  }

  return (
    <View className="flex-col gap-1.5">
      <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>
      <ScrollView
        ref={rowRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        // The visible label above is a SIBLING Text, so without this the row
        // announces only its chips, with no hint of what they choose.
        accessibilityLabel={label}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 8 }}
      >
        {chips.map((chip) => {
          const active = chip.value === value
          return (
            <Pressable
              key={chip.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onLayout={active ? (event) => onActiveLayout(event.nativeEvent.layout.x) : undefined}
              onPress={() => onChange(chip.value)}
              className={cn(
                'h-9 shrink-0 flex-row items-center gap-2 rounded-lg border px-3',
                active ? 'bg-primary border-primary' : 'bg-bg border-border active:bg-border/40'
              )}
            >
              {chip.icon?.(active)}
              <Text
                numberOfLines={1}
                className={cn('font-sans-medium text-xs', active ? 'text-primary-fg' : 'text-fg')}
                // Provider and model names are identifiers, not sentences —
                // keep them LTR under an RTL locale like the switch above does.
                style={{ writingDirection: 'ltr' }}
              >
                {chip.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

/** The active side's model picker(s) — provider + model chips on cloud, model chips on local. */
export function ModelSelector(): React.JSX.Element {
  const { t } = useTranslation()
  const localOnly = useConfigValue('localOnly')
  const localEnabled = useConfigValue('localEnabled')
  const localModel = useConfigValue('localModel')
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')
  const providers = useDemoConfig((state) => state.providers)

  const providerChips = useMemo(() => {
    const markFor = (id: string) => (active: boolean) => (
      <ProviderMark provider={id} size={16} className={active ? 'text-primary-fg' : 'text-muted'} />
    )
    const rows = providers.map((provider) => ({
      value: provider.id,
      label: PROVIDER_LABELS[provider.id] ?? provider.id,
      icon: markFor(provider.id)
    }))
    // A brain whose provider is missing from that list still needs a chip, or
    // the row would show nothing lit.
    if (brainProvider && !providers.some((provider) => provider.id === brainProvider)) {
      rows.push({
        value: brainProvider,
        label: PROVIDER_LABELS[brainProvider] ?? brainProvider,
        icon: markFor(brainProvider)
      })
    }
    return rows
  }, [providers, brainProvider])

  const localModels = useDemoConfig((state) => state.localModels)
  const localChips = useMemo(() => {
    const rows = localModels.map((model) => ({ value: model, label: model }))
    if (localModel && !localModels.includes(localModel)) {
      rows.push({ value: localModel, label: localModel })
    }
    return rows
  }, [localModels, localModel])

  const activeProvider = providers.find((provider) => provider.id === brainProvider)
  const modelChips = useMemo(() => {
    const models = activeProvider?.models?.length ? [...activeProvider.models] : []
    // The chosen model can sit outside the provider's list (or the list can be
    // empty) — it still needs a chip, or the row would show nothing lit.
    if (brainModel && !models.includes(brainModel)) models.push(brainModel)
    return models.map((model) => ({ value: model, label: model }))
  }, [activeProvider, brainModel])

  if (localOnly && localEnabled) {
    return (
      <ChipRow
        label={t('settings.model.localTitle')}
        chips={localChips}
        value={localModel}
        onChange={(model) => setConfigValue('localModel', model)}
      />
    )
  }

  return (
    <View className="flex-col gap-4">
      <ChipRow
        label={t('settings.model.providersTitle')}
        chips={providerChips}
        value={brainProvider}
        onChange={(id) => {
          const provider = providers.find((candidate) => candidate.id === id)
          if (!provider) return
          setConfigValue('brainProvider', provider.id)
          setConfigValue('brainModel', provider.model ?? provider.models[0] ?? '')
        }}
      />
      <ChipRow
        // Switching provider swaps the whole chip set: remount so the fresh
        // row starts at its left edge and carries the new lit chip in.
        key={brainProvider}
        label={t('settings.model.brainLabel')}
        chips={modelChips}
        value={brainModel}
        onChange={(model) => {
          setConfigValue('brainModel', model)
          // Mirror onto the provider entry like the desktop's setBrain.
          setConfigValue(
            'providers',
            useDemoConfig
              .getState()
              .providers.map((provider) =>
                provider.id === brainProvider ? { ...provider, model } : provider
              )
          )
        }}
      />
    </View>
  )
}
