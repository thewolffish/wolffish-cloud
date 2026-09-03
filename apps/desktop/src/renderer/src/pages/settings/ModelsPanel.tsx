/**
 * Models — the org catalog, live from GET /v1/models (held app-wide by
 * ModelCatalogProvider, cached in main).
 *
 * Every row is what the org allows THIS user: name, id, context window,
 * pricing and capability chips, with the org default badged. Clicking a
 * row selects it — the same persistence path as the composer's picker
 * (config llm.model + live thalamus swap). No provider keys exist on the
 * device; the router enforces the allowlist server-side regardless of
 * what any client asks for.
 */
import { useFlow } from '@providers/flow/useFlow'
import { useModelCatalog } from '@providers/model-catalog/useModelCatalog'
import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import { AiBrain01Icon, CloudIcon, EyeIcon, Tick02Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

function priceLabel(inMicro: number, outMicro: number): string | null {
  if (inMicro === 0 && outMicro === 0) return null
  return `$${inMicro / 1e6} / $${outMicro / 1e6}`
}

export function ModelsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { status, refreshStatus } = useFlow()
  const { models: catalog, ready, revalidate } = useModelCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const model = selected ?? status?.config?.llm.model ?? null
  // Only a cache that has never answered shows the skeleton; the list is
  // held from launch, so a visit here normally paints it outright.
  const loading = !ready

  // A visit here is the natural moment to pick up an admin policy edit —
  // the revalidation answers from cache and pushes any change.
  useEffect(() => {
    revalidate()
  }, [revalidate])

  const pick = async (id: string): Promise<void> => {
    if (id === model || busy) return
    setBusy(true)
    setSelected(id)
    try {
      await window.api.modelSelect.select(id)
      await refreshStatus()
    } finally {
      setBusy(false)
    }
  }

  // Mirrors a catalog row's exact markup and text classes with invisible
  // filler text, so every bar gets the same line box as the text it stands
  // in for — the swap to real cards changes nothing about the layout.
  const skeletonCard = (i: number): React.JSX.Element => (
    <div
      key={i}
      aria-hidden
      className="border-border flex w-full animate-pulse items-center gap-3 rounded-xl border px-4 py-3"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'bg-border/60 select-none rounded text-sm font-medium text-transparent',
              i % 2 === 0 ? 'w-36' : 'w-28'
            )}
          >
            .
          </span>
          {i === 0 ? (
            <span className="border-border bg-border/40 select-none rounded-full border px-2 py-0.5 text-[10px] font-medium text-transparent">
              {t('settings.model.defaultBadge')}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'bg-border/40 block select-none rounded font-mono text-[11px] text-transparent',
            i % 2 === 0 ? 'w-56' : 'w-48'
          )}
        >
          .
        </span>
        {/* Two pills at gap-2, not the row's usual three at gap-1.5: solid
            fills need more whitespace than outlined chips to read as
            separate. Same chip classes, so the row height is unchanged. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-2">
          {['w-20', 'w-28'].map((w) => (
            <span
              key={w}
              className={cn(
                'border-border bg-border/40 select-none rounded-full border px-2 py-0.5 text-[10px] font-medium text-transparent',
                w
              )}
            >
              .
            </span>
          ))}
        </span>
      </span>
      <span className="w-5 shrink-0" />
    </div>
  )

  const chip = (label: string, Icon?: typeof EyeIcon): React.JSX.Element => (
    <span
      key={label}
      className="border-border bg-border/30 text-muted inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
    >
      {Icon ? <Icon size={10} className="shrink-0" /> : null}
      {label}
    </span>
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.model.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.model.orgSubtitle')}</p>
        </header>

        <section className="border-border bg-surface flex flex-col gap-3 rounded-2xl border p-6">
          <div className="flex items-center gap-2">
            <CloudIcon size={16} className="text-muted shrink-0" />
            <h2 className="text-fg text-sm font-semibold">{t('settings.model.catalogTitle')}</h2>
          </div>

          {loading ? (
            <div className="flex flex-col gap-2" dir="ltr">
              {[0, 1].map(skeletonCard)}
            </div>
          ) : catalog.length === 0 ? (
            <p className="text-muted text-sm leading-relaxed">{t('settings.model.loading')}</p>
          ) : (
            <div className="flex flex-col gap-2" dir="ltr">
              {catalog.map((entry) => {
                const isActive = entry.id === model
                const price = priceLabel(entry.inPerMtokMicroUsd, entry.outPerMtokMicroUsd)
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void pick(entry.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-start',
                      'focus-visible:ring-2 focus-visible:ring-accent',
                      isActive
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border hover:bg-border/20'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-fg truncate text-sm font-medium">{entry.name}</span>
                        {entry.default ? (
                          <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
                            {t('settings.model.defaultBadge')}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-muted block truncate font-mono text-[11px]">
                        {entry.id}
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {chip(`${formatCompact(entry.contextWindow)} ${t('settings.model.ctx')}`)}
                        {price ? chip(`${price} ${t('settings.model.perMtok')}`) : null}
                        {entry.reasoning
                          ? chip(t('settings.model.reasoningChip'), AiBrain01Icon)
                          : null}
                        {entry.vision ? chip(t('settings.model.visionChip'), EyeIcon) : null}
                      </span>
                    </span>
                    <span className="w-5 shrink-0">
                      {isActive ? <Tick02Icon size={18} className="text-primary" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-muted text-xs leading-relaxed">{t('settings.model.orgExplainer')}</p>
        </section>
      </div>
    </div>
  )
}
