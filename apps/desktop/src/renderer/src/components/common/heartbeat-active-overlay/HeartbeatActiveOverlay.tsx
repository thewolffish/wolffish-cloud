import { CopyButton } from '@components/core/CopyButton'
import { cn } from '@lib/utils/cn'
import type { HeartbeatLogEntry, HeartbeatRunningJob } from '@preload/index'
import { Activity04Icon } from 'hugeicons-react'
import { useFlow } from '@providers/flow/useFlow'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

// Expanded view of a running AUTOMATION, opened by clicking the ActiveRunCard.
// An 80vw × 80vh panel (same footprint as the chat's expanded-prompt dialog)
// that keeps the original full-screen overlay's look: bg-bg canvas with a
// centered max-w-md column. Purely presentational: the card owns the run
// subscription and passes the live job + logs down, so closing and reopening
// this modal mid-run keeps the full log history. Dismissed by backdrop click
// or Escape — the run itself keeps going in the background either way.

type HeartbeatActiveOverlayProps = {
  job: HeartbeatRunningJob
  logs: HeartbeatLogEntry[]
  onClose: () => void
}

export function HeartbeatActiveOverlay({
  job,
  logs,
  onClose
}: HeartbeatActiveOverlayProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { status } = useFlow()
  // Unstamped runs follow the global mode — show the effective value.
  const globalMode = status?.config?.llm.mode === 'workflow' ? 'workflow' : 'single'
  const [now, setNow] = useState(() => Date.now())
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const elapsed = Math.max(0, Math.floor((now - job.startedAt) / 1000))
  const mm = Math.floor(elapsed / 60)
  const ss = elapsed % 60
  const elapsedStr = `${mm}:${ss.toString().padStart(2, '0')}`
  const startedStr = new Date(job.startedAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  })

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={job.label}
        onClick={(e) => e.stopPropagation()}
        className="border-border bg-bg flex h-[80vh] w-[80vw] flex-col overflow-y-auto rounded-2xl border shadow-xl"
      >
        <div className="m-auto flex w-full max-w-md flex-col items-center gap-6 px-6 py-8">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-emerald-500/20" />
            <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
              <Activity04Icon size={20} className="text-emerald-500 animate-pulse" />
            </div>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <h2 className="text-fg text-sm font-medium">{job.label}</h2>
            <div className="text-muted flex items-center gap-2 text-xs">
              <span>{t('heartbeat.overlay.startedAt', { time: startedStr })}</span>
              <span className="text-border">·</span>
              <span className="tabular-nums font-mono">{elapsedStr}</span>
              <span className="text-border">·</span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
                  (job.mode ?? globalMode) === 'workflow'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted bg-surface border-border border'
                )}
              >
                {t(
                  (job.mode ?? globalMode) === 'workflow'
                    ? 'chat.modePicker.workflow'
                    : 'chat.modePicker.single'
                )}
              </span>
            </div>
          </div>

          {job.body ? (
            <div className="relative w-full">
              <div className="absolute top-2 inset-e-2 z-10">
                <CopyButton text={job.body} variant="overlay" />
              </div>
              <pre className="text-muted bg-surface border-border max-h-40 w-full overflow-auto rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                {t(job.body)}
              </pre>
            </div>
          ) : null}

          <div className="border-border bg-surface/50 w-full rounded-lg border">
            <div className="text-muted border-border border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide">
              {t('heartbeat.overlay.activity')}
            </div>
            <div className="max-h-48 overflow-y-auto px-3 py-2">
              {logs.length === 0 ? (
                <div className="text-muted/50 flex items-center gap-2 py-2 text-[11px]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  {t('heartbeat.overlay.waiting')}
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {logs.map((entry, i) => {
                    const isLast = i === logs.length - 1
                    return (
                      <div
                        key={`${entry.timestamp}-${i}`}
                        className={cn(
                          'flex items-start gap-2 rounded px-1 py-0.5 text-[11px] leading-relaxed',
                          isLast ? 'text-fg' : 'text-muted/40'
                        )}
                      >
                        <LogKindDot kind={entry.kind} active={isLast} />
                        <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
                      </div>
                    )
                  })}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function LogKindDot({
  kind,
  active
}: {
  kind: HeartbeatLogEntry['kind']
  active: boolean
}): React.JSX.Element {
  const color = (() => {
    switch (kind) {
      case 'tool_call':
        return 'bg-blue-500'
      case 'tool_result':
        return 'bg-violet-500'
      case 'completed':
        return 'bg-emerald-500'
      case 'failed':
        return 'bg-red-500'
      case 'skipped':
        return 'bg-amber-500'
      default:
        return 'bg-muted/40'
    }
  })()
  return (
    <span
      className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', color, active && 'animate-pulse')}
    />
  )
}
