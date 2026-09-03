import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import type { ReasoningMode } from '@main/runtime/reasoning'
import { useModelCatalog } from '@providers/model-catalog/useModelCatalog'
import {
  AiBrain01Icon,
  BrainIcon,
  BubbleChatIcon,
  CloudIcon,
  FireIcon,
  FlashIcon,
  SecurityCheckIcon,
  Tick02Icon,
  WorkflowSquare03Icon
} from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ChatMode = 'single' | 'workflow'

/** One-word title per reasoning mode, worn by its chip. */
const MODE_SHORT_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.shortOff',
  on: 'chat.reasoning.shortOn',
  high: 'chat.reasoning.shortHigh',
  max: 'chat.reasoning.shortMax'
}

/** One-line description per reasoning mode, carried as the chip's tooltip. */
const MODE_DESC_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.off',
  on: 'chat.reasoning.on',
  high: 'chat.reasoning.high',
  max: 'chat.reasoning.max'
}

/**
 * Effort ladder, one icon per mode: instant (no thinking) → brain →
 * amped brain → full burn.
 */
const MODE_ICON: Record<ReasoningMode, typeof BrainIcon> = {
  off: FlashIcon,
  on: BrainIcon,
  high: AiBrain01Icon,
  max: FireIcon
}

/** Model ids read best without their vendor path (`deepseek-ai/…`). */
function shortModelName(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

/**
 * Composer model control, cloud-first: ONE lane, so the trigger is a single
 * chip naming the selected model, and the hover/pin card carries the
 * per-turn knobs — reasoning effort, chat mode, and the permissions
 * (ask/bypass) switch — as chip rows above the model section.
 *
 * The model section renders the org catalog (GET /v1/models, held app-wide
 * by ModelCatalogProvider so the rows are on screen the instant the card
 * opens): every allowed model is a row, the selection persists through
 * modelSelect.select and the runtime follows live. Admin edits the policy
 * → main pushes the new list and the rows follow.
 */
export function ModelSwitch({
  model,
  disabled,
  reasoningModes,
  reasoningMode,
  chatMode,
  bypass,
  showControls,
  onSelectReasoning,
  onSelectChatMode,
  onToggleBypass
}: {
  /** The selected model id (config llm.model). Null = nothing selected. */
  model: string | null
  disabled: boolean
  /** Ordered reasoning modes this model honours (from reasoningModesFor). */
  reasoningModes: readonly ReasoningMode[]
  /** Active reasoning mode, already clamped to `reasoningModes`. */
  reasoningMode: ReasoningMode
  chatMode: ChatMode
  /** Live bypass-permissions state (config safety.bypassPermissions). */
  bypass: boolean
  /** Chip rows hidden while recording, exactly as the old pills were. */
  showControls: boolean
  onSelectReasoning: (next: ReasoningMode) => void
  onSelectChatMode: (next: ChatMode) => Promise<void>
  onToggleBypass: (next: boolean) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [optimisticChatMode, setOptimisticChatMode] = useState<ChatMode | null>(null)
  const [optimisticBypass, setOptimisticBypass] = useState<boolean | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  // Escape unpins/closes; clicking outside while open closes.
  useEffect(() => {
    if (!open && !pinned) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, pinned])

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    }
  }, [])

  const onEnter = (): void => {
    if (disabled) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(true), 150)
  }
  const onLeave = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (pinned) return
    hoverTimer.current = setTimeout(() => setOpen(false), 200)
  }
  const cardVisible = (open || pinned) && !disabled

  // Held app-wide from launch, so the rows paint with the card's first
  // frame. Opening still nudges main to revalidate a stale copy — an admin
  // policy edit shows up without a relaunch through the provider's push,
  // never as a loading state here.
  const { models: catalog, revalidate } = useModelCatalog()
  useEffect(() => {
    if (cardVisible) revalidate()
  }, [cardVisible, revalidate])

  const pickModel = (id: string): void => {
    if (id === model) return
    void window.api.modelSelect.select(id)
  }

  // Reasoning: unsupported models get the explanation line instead of chips,
  // and a single-mode model shows its chip inert — the old pill's rules.
  const reasoningSupported = reasoningModes.length > 0
  const reasoningSwitchable = reasoningModes.length > 1

  const pickReasoning = (next: ReasoningMode): void => {
    if (next !== reasoningMode) onSelectReasoning(next)
  }

  const shownChatMode = optimisticChatMode ?? chatMode
  const CHAT_MODES: Array<{
    key: ChatMode
    Icon: typeof BubbleChatIcon
    name: string
    desc: string
  }> = [
    {
      key: 'single',
      Icon: BubbleChatIcon,
      name: t('chat.modePicker.single'),
      desc: t('chat.modePicker.singleDesc')
    },
    {
      key: 'workflow',
      Icon: WorkflowSquare03Icon,
      name: t('chat.modePicker.workflow'),
      desc: t('chat.modePicker.workflowDesc')
    }
  ]

  const pickChatMode = async (next: ChatMode): Promise<void> => {
    setOptimisticChatMode(next)
    try {
      await onSelectChatMode(next)
    } finally {
      setOptimisticChatMode(null)
    }
  }

  const shownBypass = optimisticBypass ?? bypass
  const PERMISSION_MODES: Array<{
    key: boolean
    Icon: typeof BrainIcon
    name: string
    desc: string
  }> = [
    {
      key: false,
      Icon: SecurityCheckIcon,
      name: t('chat.permissions.ask'),
      desc: t('chat.permissions.askDesc')
    },
    {
      key: true,
      Icon: FlashIcon,
      name: t('chat.permissions.bypass'),
      desc: t('chat.permissions.bypassDesc')
    }
  ]

  const pickBypass = async (next: boolean): Promise<void> => {
    if (next === shownBypass) return
    setOptimisticBypass(next)
    try {
      await onToggleBypass(next)
    } finally {
      setOptimisticBypass(null)
    }
  }

  const chipClass = (active: boolean, interactive: boolean): string =>
    cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium',
      'focus-visible:ring-2 focus-visible:ring-accent',
      active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-fg',
      interactive && !active && 'hover:bg-border/40',
      interactive ? 'cursor-pointer' : 'cursor-default'
    )

  const triggerClass = cn(
    'flex h-7 items-center gap-1.5 rounded-lg px-2',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    'bg-primary/10 text-primary',
    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
  )

  return (
    <span
      ref={rootRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        disabled={disabled}
        aria-expanded={cardVisible}
        aria-label={t('chat.modeToggle.ariaLabel')}
        onClick={() => {
          if (disabled) return
          setPinned((p) => {
            const next = !p
            if (next) setOpen(true)
            return next
          })
        }}
        onFocus={onEnter}
        onBlur={onLeave}
        className={triggerClass}
      >
        <CloudIcon size={14} />
        <span
          className="max-w-96 truncate text-[11px] leading-tight font-medium"
          dir={model ? 'ltr' : 'auto'}
        >
          {model ? shortModelName(model) : t('chat.modeToggle.noModelShort')}
        </span>
      </button>

      {cardVisible && (
        <div
          role="dialog"
          className="border-border bg-surface absolute bottom-full inset-s-0 z-50 mb-2 w-[26rem] max-w-[90vw] rounded-xl border shadow-xl"
        >
          {showControls && (
            <div className="border-border flex flex-col gap-1.5 border-b px-3 py-2.5">
              <div
                role="group"
                aria-label={t('chat.reasoning.ariaLabel')}
                className="flex items-center gap-1.5"
              >
                <span className="text-muted w-14 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                  {t('chat.reasoning.label')}
                </span>
                {!reasoningSupported ? (
                  <span className="text-muted text-[11px] leading-snug" dir="auto">
                    {t('chat.reasoning.unsupported')}
                  </span>
                ) : (
                  reasoningModes.map((m) => {
                    const isActive = m === reasoningMode
                    const RowIcon = MODE_ICON[m]
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={!reasoningSwitchable}
                        title={t(MODE_DESC_KEY[m])}
                        onClick={() => pickReasoning(m)}
                        className={chipClass(isActive, reasoningSwitchable)}
                      >
                        <RowIcon
                          size={13}
                          className={cn('shrink-0', isActive ? 'text-primary' : 'text-muted')}
                        />
                        {t(MODE_SHORT_KEY[m])}
                      </button>
                    )
                  })
                )}
              </div>
              <div
                role="group"
                aria-label={t('chat.modePicker.ariaLabel')}
                className="flex items-center gap-1.5"
              >
                <span className="text-muted w-14 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                  {t('chat.modePicker.label')}
                </span>
                {CHAT_MODES.map(({ key, Icon, name, desc }) => {
                  const isActive = key === shownChatMode
                  return (
                    <button
                      key={key}
                      type="button"
                      title={desc}
                      onClick={() => void pickChatMode(key)}
                      className={chipClass(isActive, true)}
                    >
                      <Icon
                        size={13}
                        className={cn('shrink-0', isActive ? 'text-primary' : 'text-muted')}
                      />
                      {name}
                    </button>
                  )
                })}
              </div>
              <div
                role="group"
                aria-label={t('chat.permissions.ariaLabel')}
                className="flex items-center gap-1.5"
              >
                <span className="text-muted w-14 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                  {t('chat.permissions.label')}
                </span>
                {PERMISSION_MODES.map(({ key, Icon, name, desc }) => {
                  const isActive = key === shownBypass
                  return (
                    <button
                      key={String(key)}
                      type="button"
                      title={desc}
                      onClick={() => void pickBypass(key)}
                      className={chipClass(isActive, true)}
                    >
                      <Icon
                        size={13}
                        className={cn('shrink-0', isActive ? 'text-primary' : 'text-muted')}
                      />
                      {name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {/* Model ids are technical LTR identifiers — the section renders
              LTR even in the RTL UI so rows never mirror around the ids. */}
          <div className="p-1.5" dir="ltr">
            <div className="text-muted flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
              <CloudIcon size={12} />
              <span dir="auto">{t('chat.modelPicker.orgSection')}</span>
            </div>
            {catalog.length === 0 && model ? (
              <div className="bg-primary/10 text-fg flex w-full items-center gap-2 rounded-lg px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs" dir="ltr">
                  {model}
                </span>
                <span className="w-4 shrink-0">
                  <Tick02Icon size={14} className="text-primary" />
                </span>
              </div>
            ) : null}
            {catalog.map((entry) => {
              const isActive = entry.id === model
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => pickModel(entry.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start',
                    isActive ? 'bg-primary/10 text-fg' : 'text-fg hover:bg-border/40'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{entry.name}</span>
                    <span className="text-muted block truncate text-[10px]" dir="ltr">
                      {entry.id}
                      {' · '}
                      {formatCompact(entry.contextWindow)} ctx
                      {entry.reasoning ? ' · reasoning' : ''}
                      {entry.vision ? ' · vision' : ''}
                    </span>
                  </span>
                  <span className="w-4 shrink-0">
                    {isActive ? <Tick02Icon size={14} className="text-primary" /> : null}
                  </span>
                </button>
              )
            })}
            <p className="text-muted px-2 pt-1.5 pb-1 text-[11px] leading-snug" dir="auto">
              {t('chat.modelPicker.orgManaged')}
            </p>
          </div>
        </div>
      )}
    </span>
  )
}
