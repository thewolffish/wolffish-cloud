import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import {
  FlashIcon,
  Globe02Icon,
  Key01Icon,
  KeyboardIcon,
  QrCode01Icon
} from '@/components/core/icons'
import { formatPairingCode, pairingCodeIssue, pairWithCode, pairWithQr } from '@/lib/cloud/pairing'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The pairing sheet — one screen, two routes to the same session: type the
 * code the desktop shows, or point the camera at its QR.
 *
 * Both are a one-time offer the organization minted for that desktop.
 * Claiming it signs this phone in as the same person — no password on the
 * phone, nothing to configure — and from then on the phone talks to the
 * organization directly. Scanning is preferred because the offer travels
 * screen to camera; the typed code covers the cases scanning cannot: a
 * desktop reached over SSH, a headless machine, a denied camera permission.
 */
export function PairSheet({
  visible,
  onClose,
  onPaired
}: {
  visible: boolean
  onClose: () => void
  onPaired: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // Errors render inline, not as toasts: this sheet is a native Modal, and on
  // iOS the app's toast viewport is a sibling *below* that window.
  const [pairError, setPairError] = useState<string | null>(null)
  // A camera reports the same QR many times a second; one accepted scan must
  // not start several claims.
  const [claimed, setClaimed] = useState(false)
  // A ref, not state: the in-flight attempt reads this after awaiting, where a
  // state value captured at call time would still say "not cancelled".
  const cancelled = useRef(false)

  const reset = (): void => {
    setClaimed(false)
    setBusy(false)
    setCode('')
    setPairError(null)
  }

  const finish = async (run: () => Promise<void>): Promise<void> => {
    cancelled.current = false
    setBusy(true)
    setPairError(null)
    try {
      await run()
      if (cancelled.current) return
      reset()
      onPaired()
    } catch (error) {
      if (cancelled.current) return
      setClaimed(false)
      setBusy(false)
      setPairError(error instanceof Error ? error.message : t('pair.failed'))
    }
  }

  /** Abandon an attempt in flight — keeps the typed code, which is usually
   *  what someone wants to edit rather than retype. */
  const cancelPairing = (): void => {
    cancelled.current = true
    setClaimed(false)
    setBusy(false)
    setPairError(null)
  }

  const onScanned = (value: string): void => {
    if (claimed || busy) return
    setClaimed(true)
    void finish(() => pairWithQr(value))
  }

  const submitCode = (): void => {
    if (busy) return
    const tidied = formatPairingCode(code)
    if (tidied !== code) setCode(tidied)
    const issue = pairingCodeIssue(tidied)
    if (issue !== null) {
      if (issue !== 'empty') setPairError(t(`pair.codeIssue.${issue}`))
      return
    }
    void finish(() => pairWithCode(tidied))
  }

  const cameraReady = permission?.granted === true

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View
        className="bg-bg flex-1"
        style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }}
      >
        <View className="flex-row items-center justify-between px-6">
          <Text className="text-fg font-sans-bold text-lg">{t('pair.title')}</Text>
          <Pressable onPress={onClose} disabled={busy} className="px-2 py-1">
            <Text className="text-muted font-sans text-sm">{t('common.close')}</Text>
          </Pressable>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <Text className="text-muted mt-2 text-left font-sans text-sm leading-relaxed">
            {t('pair.instructions')}
          </Text>

          {/* What actually happens — the same three facts the desktop's
              Mobile panel states, so both devices tell one story. */}
          <View className="bg-surface border-border mt-4 gap-3 rounded-2xl border p-4">
            <Text className="text-fg text-left font-sans-medium text-sm">
              {t('pair.how.title')}
            </Text>
            <HowRow
              icon={<Key01Icon size={16} className="text-muted" />}
              title={t('pair.how.pairTitle')}
              body={t('pair.how.pairBody')}
            />
            <HowRow
              icon={<Globe02Icon size={16} className="text-muted" />}
              title={t('pair.how.orgTitle')}
              body={t('pair.how.orgBody')}
            />
            <HowRow
              icon={<FlashIcon size={16} className="text-muted" />}
              title={t('pair.how.liveTitle')}
              body={t('pair.how.liveBody')}
            />
          </View>

          <View className="bg-surface border-border mt-4 gap-4 rounded-2xl border p-4">
            <CardHeader
              icon={<QrCode01Icon size={18} className="text-muted" />}
              title={t('pair.qrTitle')}
              body={t('pair.qrDesc')}
            />
            {cameraReady ? (
              <View className="border-border aspect-square overflow-hidden rounded-xl border">
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => onScanned(data)}
                />
                {claimed && (
                  <View className="absolute inset-0 items-center justify-center gap-3 bg-black/60">
                    <ActivityIndicator size="large" color="#ffffff" />
                    <Text className="font-sans-medium text-center text-sm text-white">
                      {t('pair.qrFound')}
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View className="gap-3">
                {permission?.canAskAgain === false ? (
                  <Text className="text-muted text-left font-sans text-xs leading-relaxed">
                    {t('pair.cameraDenied')}
                  </Text>
                ) : (
                  <Button
                    style={{ alignSelf: 'stretch' }}
                    disabled={busy}
                    onPress={() => void requestPermission()}
                  >
                    {t('pair.allowCamera')}
                  </Button>
                )}
              </View>
            )}
          </View>

          <View className="bg-surface border-border mt-4 gap-3 rounded-2xl border p-4">
            <CardHeader
              icon={<KeyboardIcon size={18} className="text-muted" />}
              title={t('pair.codeTitle')}
              body={t('pair.codeDesc')}
            />
            <View className="flex-row items-end gap-2">
              <Input
                label={t('pair.codeLabel')}
                containerClassName="flex-1"
                value={code}
                onChangeText={(next) => {
                  // Stored exactly as typed: reshaping the value under a fast
                  // typist makes the controlled input drop keystrokes. The
                  // dash lands on blur, and the claim accepts any spelling.
                  setCode(next)
                  setPairError(null)
                }}
                onBlur={() => setCode((current) => formatPairingCode(current))}
                placeholder="K7M9-2QXR"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect={false}
                editable={!busy}
                onSubmitEditing={submitCode}
                returnKeyType="go"
                testID="pair-code-input"
              />
              {busy ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={cancelPairing}
                  style={{ alignSelf: 'flex-end' }}
                  className="h-10 flex-row items-center justify-center gap-2 rounded-lg bg-red-600 px-4 active:bg-red-700"
                >
                  <ActivityIndicator size="small" color="#ffffff" />
                  <Text className="font-sans-medium text-sm text-white">{t('common.cancel')}</Text>
                </Pressable>
              ) : (
                <Button
                  style={{ alignSelf: 'flex-end' }}
                  onPress={submitCode}
                  disabled={pairingCodeIssue(code) !== null}
                  testID="pair-code-submit"
                >
                  {t('pair.submit')}
                </Button>
              )}
            </View>
            {pairError !== null && (
              <Text className="text-left font-sans text-xs leading-relaxed text-rose-500">
                {pairError}
              </Text>
            )}
          </View>

          <Text className="text-muted mt-4 px-1 text-left font-sans text-xs leading-relaxed">
            {t('pair.operated')}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  )
}

function CardHeader({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}

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
    <View className="flex-row items-start gap-3">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}
