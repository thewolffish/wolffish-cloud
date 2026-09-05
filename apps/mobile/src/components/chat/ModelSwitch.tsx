import { ProviderMark } from '@/components/core/providerLogos'
import { formatTokens } from '@/lib/utils/formatTokens'
import { shortModelName } from '@/lib/utils/modelName'
import { cn } from '@/lib/utils/cn'
import {
  setConfigValue,
  useConfigValue,
  useModelCatalog,
  useSettingsReadOnly,
  type ModelCatalogEntry
} from '@/state/demoConfig'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * The model answering, as a row of chips — one per model the organization
 * allows this user, the selected one lit.
 *
 * Chips rather than a list or a select, for the reason the project row is
 * chips: the whole catalog is the point, an org lane holds a handful of named
 * models, and one tap is the entire interaction. The row never wraps; it
 * scrolls freely on x however many models the policy grants, so a catalog that
 * doubles costs this panel no height. It is mounted in two places — the chat
 * menu sheet and the Model settings screen — and is the same control in both.
 *
 * Picking writes `brainModel`, which the desktop accepts through the exact
 * handler its own composer picker calls (`model:select` → persistModel →
 * thalamus.setModel → `provider:updated`), so a pick made here IS a pick made
 * there: the desktop's composer chip moves within the same breath, and the
 * confirming snapshot comes back on that broadcast. The API remains the
 * authority on what is allowed — this row can only ever offer what the catalog
 * it was handed contains.
 *
 * The catalog itself rides the config snapshot (`llm.models`). When it is
 * empty — an older desktop, a demo bundle from before models were pickable, or
 * a live desktop whose catalog has not landed yet — the row still shows the
 * current model as its one chip rather than rendering nothing, the same rule
 * the project chips use for a project their list has lost.
 */
export function ModelSwitch(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'en'
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')
  const catalog = useModelCatalog()
  // Paired but disconnected: the desktop owns this value and cannot be told,
  // so the chips go inert rather than lighting under a finger and snapping
  // back on the next snapshot.
  const readOnly = useSettingsReadOnly()

  const chips = useMemo<ModelCatalogEntry[]>(() => {
    // The selected model always has a chip. Without this the row would show
    // nothing lit whenever the desktop is on a model the catalog no longer
    // lists (a policy change mid-session, a catalog that has not arrived), and
    // the user could not see what is answering them.
    if (!brainModel || catalog.some((entry) => entry.id === brainModel)) return catalog
    return [
      ...catalog,
      {
        id: brainModel,
        name: shortModelName(brainModel),
        reasoning: false,
        vision: false,
        contextWindow: 0,
        default: false
      }
    ]
  }, [catalog, brainModel])

  const selected = chips.find((entry) => entry.id === brainModel) ?? null

  // The lit chip can start off the row's right edge — the panel would open on
  // a row that reads as though something else were selected. Carry it into
  // view the once; every later change comes from a tap, already in view. The
  // latch turns only on a scroll that actually happened, so a chip laid out
  // before the catalog lands still gets carried in when the list pushes it
  // right. (The project row does exactly this, for exactly this reason.)
  const rowRef = useRef<ScrollView | null>(null)
  const settled = useRef(false)
  const onActiveLayout = (x: number): void => {
    if (settled.current || x <= 0) return
    settled.current = true
    rowRef.current?.scrollTo({ x: Math.max(x - 12, 0), animated: false })
  }

  const onPick = (id: string): void => {
    if (id === brainModel) return
    // Optimistic here, authoritative there: setConfigValue moves the chip now
    // and pushes to the desktop, which either persists it or refuses — and a
    // refusal re-pulls the snapshot, putting the old chip back.
    setConfigValue('brainModel', id)
  }

  // What the desktop's own picker prints under each model's name, for the one
  // that is selected: the raw id, its window, and the two capabilities that
  // change what you can send it.
  const specs = selected
    ? [
        selected.id,
        ...(selected.contextWindow > 0
          ? [
              t('settings.model.contextSpec', {
                value: formatTokens(selected.contextWindow, locale)
              })
            ]
          : []),
        ...(selected.reasoning ? [t('settings.model.reasoningSpec')] : []),
        ...(selected.vision ? [t('settings.model.visionSpec')] : [])
      ].join(' · ')
    : null

  return (
    <View className="flex-col gap-2">
      <ScrollView
        ref={rowRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        // No visible label of its own: this row is mounted under a "Model"
        // section header on one screen and at the head of the chat controls on
        // the other, so the label lives here where a screen reader needs it
        // rather than as a second copy of a heading already on screen.
        accessibilityLabel={t('settings.model.modelTitle')}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 8 }}
      >
        {chips.length === 0 ? (
          <View className="border-border bg-bg h-11 flex-row items-center gap-2 rounded-lg border px-3">
            <ProviderMark provider={brainProvider} size={16} className="text-muted" />
            <Text className="text-muted font-sans-medium text-xs">
              {t('settings.model.noModel')}
            </Text>
          </View>
        ) : (
          chips.map((entry) => {
            const active = entry.id === brainModel
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active, disabled: readOnly }}
                accessibilityLabel={entry.name}
                disabled={readOnly}
                onLayout={
                  active ? (event) => onActiveLayout(event.nativeEvent.layout.x) : undefined
                }
                onPress={() => onPick(entry.id)}
                className={cn(
                  'h-11 shrink-0 flex-row items-center gap-2 rounded-lg border px-3',
                  active
                    ? 'bg-primary border-primary'
                    : 'bg-bg border-border active:bg-border-soft',
                  readOnly && !active && 'opacity-50'
                )}
              >
                <ProviderMark
                  provider={brainProvider}
                  size={16}
                  className={active ? 'text-primary-fg' : 'text-fg'}
                />
                <Text
                  numberOfLines={1}
                  className={cn(
                    'font-sans-medium max-w-[180px] text-xs',
                    active ? 'text-primary-fg' : 'text-fg'
                  )}
                >
                  {entry.name}
                </Text>
              </Pressable>
            )
          })
        )}
      </ScrollView>

      {specs ? (
        <Text
          selectable
          numberOfLines={2}
          className="text-muted text-left font-sans text-[11px] leading-4"
          // A model id is an identifier, not a sentence — keep the line LTR
          // under an RTL locale, as the composer's chip does.
          style={{ writingDirection: 'ltr' }}
        >
          {specs}
        </Text>
      ) : null}
    </View>
  )
}
