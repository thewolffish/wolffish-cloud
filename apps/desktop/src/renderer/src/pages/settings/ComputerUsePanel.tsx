import { Button } from '@components/core/Button'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { ComputerUsePermissions, ModelCapabilities } from '@preload/index'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'

/**
 * Computer Use has no capture settings to offer. Screenshot resolution and
 * format are chosen by the agent per capture (`max_width` / `format` on
 * computer_screenshot), so the values in `config.json → computerUse` are only
 * the fallback default — nothing a person needs to reach for mid-task. What
 * is left here is the part a person genuinely owns: the macOS permissions.
 */
export function ComputerUsePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const gate = useCapabilityGate('computer-use')

  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null)
  const [modelCaps, setModelCaps] = useState<ModelCapabilities | null>(null)
  const loaded = permissions !== null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [perms, caps] = await Promise.all([
        window.api.computerUse.checkPermissions(),
        window.api.model.capabilities().catch(() => null)
      ])
      if (cancelled) return
      setPermissions(perms)
      setModelCaps(caps)
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

              {/* Permissions */}
              {permissions.platform === 'darwin' && (
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
              {permissions.platform === 'linux' && permissions.hint && (
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
                  <li>{t('settings.services.computerUse.howItWorks.step5')}</li>
                </ul>
              </section>
            </>
          )}
        </CapabilityGateBody>
      </div>
    </div>
  )
}
