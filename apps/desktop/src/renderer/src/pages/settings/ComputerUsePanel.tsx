import { Button } from '@components/core/Button'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { ComputerUseConfig, ComputerUsePermissions, ModelCapabilities } from '@preload/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'

const RESOLUTION_OPTIONS = [
  { value: 640, label: '640px' },
  { value: 960, label: '960px' },
  { value: 1280, label: '1280px' },
  { value: 1920, label: '1920px' }
]

export function ComputerUsePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const gate = useCapabilityGate('computer-use')

  const [config, setConfig] = useState<ComputerUseConfig | null>(null)
  const [savedConfig, setSavedConfig] = useState<ComputerUseConfig | null>(null)
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null)
  const [modelCaps, setModelCaps] = useState<ModelCapabilities | null>(null)
  const [busy, setBusy] = useState(false)
  const loaded = config !== null
  const dirty =
    loaded &&
    savedConfig !== null &&
    (config!.screenshotMaxWidth !== savedConfig.screenshotMaxWidth ||
      config!.screenshotFormat !== savedConfig.screenshotFormat)

  // Mirror of savedConfig for the remote-change listener below: an event
  // callback cannot read fresh state, and the dirty check must never compare
  // against a stale baseline.
  const savedConfigRef = useRef<ComputerUseConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [cfg, perms, caps] = await Promise.all([
        window.api.computerUse.getConfig(),
        window.api.computerUse.checkPermissions(),
        window.api.model.capabilities().catch(() => null)
      ])
      if (cancelled) return
      setConfig(cfg)
      setSavedConfig(cfg)
      savedConfigRef.current = cfg
      setPermissions(perms)
      setModelCaps(caps)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The paired phone (or another window) saved this service: re-seed. The
  // baseline always moves; the staged controls move only when the user has
  // no unsaved change — a half-staged edit must not vanish under the cursor.
  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'computerUse') return
        void window.api.computerUse.getConfig().then((cfg) => {
          setConfig((current) => {
            const saved = savedConfigRef.current
            const staged =
              current !== null &&
              saved !== null &&
              (current.screenshotMaxWidth !== saved.screenshotMaxWidth ||
                current.screenshotFormat !== saved.screenshotFormat)
            return staged ? current : cfg
          })
          setSavedConfig(cfg)
          savedConfigRef.current = cfg
        })
      }),
    []
  )

  const handleSave = useCallback(async () => {
    if (!config) return
    setBusy(true)
    try {
      const result = await window.api.computerUse.setConfig(config)
      setConfig(result.config)
      setSavedConfig(result.config)
      savedConfigRef.current = result.config
      toast.show({ message: t('settings.services.computerUse.saveSuccess'), tone: 'success' })
    } catch {
      toast.show({ message: t('settings.services.computerUse.saveError'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }, [config, t, toast])

  const handleResolution = useCallback(
    (value: number) => {
      if (!config) return
      setConfig({ ...config, screenshotMaxWidth: value })
    },
    [config]
  )

  const handleFormat = useCallback(
    (format: 'jpeg' | 'png') => {
      if (!config) return
      setConfig({ ...config, screenshotFormat: format })
    },
    [config]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <PanelBackChevron />
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.services.computerUse.title')}
            </h1>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.computerUse.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.tabs.computerUse')} />

        <CapabilityGateBody gate={gate}>
          {loaded && (
            <>
              {modelCaps !== null && modelCaps.model !== null && !modelCaps.supportsVision && (
                <section className="border-amber-500/30 bg-amber-500/5 flex flex-col gap-1 rounded-2xl border p-5">
                  <h2 className="text-fg text-sm font-semibold">
                    {t('settings.services.computerUse.visionWarningTitle')}
                  </h2>
                  <p className="text-muted text-sm leading-relaxed">
                    {t('settings.services.computerUse.visionWarning', { model: modelCaps.model })}
                  </p>
                </section>
              )}
              <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
                {/* Screenshot resolution */}
                <div className="flex flex-col gap-2">
                  <label className="text-fg text-sm font-medium">
                    {t('settings.services.computerUse.resolutionLabel')}
                  </label>
                  <p className="text-muted text-xs">
                    {t('settings.services.computerUse.resolutionHint')}
                  </p>
                  <div className="flex gap-2">
                    {RESOLUTION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleResolution(opt.value)}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-sm cursor-pointer',
                          config!.screenshotMaxWidth === opt.value
                            ? 'bg-primary text-primary-fg border-primary'
                            : 'border-border text-muted hover:bg-border/40 hover:text-fg'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Screenshot format */}
                <div className="flex flex-col gap-2">
                  <label className="text-fg text-sm font-medium">
                    {t('settings.services.computerUse.formatLabel')}
                  </label>
                  <p className="text-muted text-xs">
                    {t('settings.services.computerUse.formatHint')}
                  </p>
                  <div className="flex gap-2">
                    {(['jpeg', 'png'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => handleFormat(fmt)}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-sm cursor-pointer uppercase',
                          config!.screenshotFormat === fmt
                            ? 'bg-primary text-primary-fg border-primary'
                            : 'border-border text-muted hover:bg-border/40 hover:text-fg'
                        )}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>

                <Button onClick={handleSave} disabled={busy || !dirty} className="self-start">
                  {t('settings.services.computerUse.save')}
                </Button>
              </section>

              {/* Permissions */}
              {permissions?.platform === 'darwin' && (
                <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
                  <h2 className="text-fg text-sm font-semibold">
                    {t('settings.services.computerUse.permissionsTitle')}
                  </h2>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={permissions.accessibility ? 'text-green-500' : 'text-red-400'}
                      >
                        {permissions.accessibility ? '●' : '○'}
                      </span>
                      <span className="text-fg">
                        {t('settings.services.computerUse.permAccessibility')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={permissions.screenRecording ? 'text-green-500' : 'text-red-400'}
                      >
                        {permissions.screenRecording ? '●' : '○'}
                      </span>
                      <span className="text-fg">
                        {t('settings.services.computerUse.permScreenRecording')}
                      </span>
                    </div>
                  </div>
                  {permissions.hint && (
                    <p className="text-muted text-sm leading-relaxed">{permissions.hint}</p>
                  )}
                  <Button
                    onClick={async () => {
                      const updated = await window.api.computerUse.checkPermissions()
                      setPermissions(updated)
                    }}
                    className="self-start"
                  >
                    {t('settings.services.computerUse.recheckPermissions')}
                  </Button>
                </section>
              )}
              {permissions?.platform === 'linux' && permissions.hint && (
                <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
                  <h2 className="text-fg text-sm font-semibold">
                    {t('settings.services.computerUse.permissionsTitle')}
                  </h2>
                  <p className="text-muted text-sm leading-relaxed">{permissions.hint}</p>
                </section>
              )}

              {/* How it works */}
              <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
                <h2 className="text-fg text-sm font-semibold">
                  {t('settings.services.computerUse.howItWorksTitle')}
                </h2>
                <ul className="text-muted flex flex-col gap-2 text-sm leading-relaxed">
                  <li>{t('settings.services.computerUse.howItWorks.step1')}</li>
                  <li>{t('settings.services.computerUse.howItWorks.step2')}</li>
                  <li>{t('settings.services.computerUse.howItWorks.step3')}</li>
                  <li>{t('settings.services.computerUse.howItWorks.step4')}</li>
                </ul>
              </section>
            </>
          )}
        </CapabilityGateBody>
      </div>
    </div>
  )
}
