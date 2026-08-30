import { CodeBlock } from '@components/core/CodeBlock'
import { cn } from '@lib/utils/cn'
import type { Segment, ToolResultStatus } from '@preload/index'
import type { ToolTiming } from '@providers/flow/useFlow'
import { ArrowDown01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ToolCallSegment = Extract<Segment, { kind: 'tool_call' }>
type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>

type CardStatus = ToolResultStatus | 'running'

const STATUS_COLOR: Record<CardStatus, string> = {
  running: 'bg-accent/10 text-accent',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  denied: 'bg-muted/20 text-muted'
}

export function ToolCard({
  call,
  result,
  timing
}: {
  call: ToolCallSegment
  result?: ToolResultSegment
  timing?: ToolTiming
}): React.JSX.Element {
  const { t } = useTranslation()
  const status: CardStatus = result?.status ?? 'running'
  const isRunning = status === 'running'
  const argsKeys = Object.keys(call.args)
  const hasOutput = !!result?.output && result.output.length > 0
  const canExpand = argsKeys.length > 0 || hasOutput || !!result?.error

  // Cards stay expanded by default — both while running and once done —
  // so finished work stays visible without a click. We never auto-collapse
  // on status transitions (running → success, etc.); only the user's manual
  // toggle changes the state, and it sticks.
  const [expanded, setExpanded] = useState<boolean>(true)

  // Live-tick a wall clock while the tool is running so the elapsed
  // counter on the card moves. Once the result lands, timing.endedAt is
  // set and the effect tears the interval down — the card freezes the
  // final duration instead of drifting.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!timing || timing.endedAt !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [timing])

  const elapsedMs = timing ? (timing.endedAt ?? now) - timing.startedAt : null
  const action = describeAction(call.args)

  return (
    <div className="group border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        className="flex w-full items-center justify-between gap-3 text-start disabled:cursor-default"
      >
        <div className="flex items-center gap-2 truncate">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_COLOR[status],
              isRunning && 'animate-pulse'
            )}
          >
            {t(`chat.toolCard.status.${status}`)}
          </span>
          <code dir="ltr" className="text-fg truncate font-medium">
            {call.name}
          </code>
          {canExpand &&
            (expanded ? (
              <ArrowDown01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ) : (
              <ArrowRight01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ))}
        </div>
        {elapsedMs !== null && (
          <span className="text-muted shrink-0 text-xs tabular-nums">
            {formatElapsedCompact(elapsedMs)}
          </span>
        )}
      </button>

      {action && (
        <CodeBlock content={action} language={detectActionLanguage(call.args)} className="mt-2" />
      )}

      {expanded && argsKeys.length > 0 && (
        <CodeBlock content={jsonInline(call.args)} language="json" className="mt-2" />
      )}
      {/* On failure the error block below carries the full raw original, so
          suppress the output block to avoid showing the classified message
          and the raw dump as two near-identical blocks. */}
      {expanded && hasOutput && !result?.error && result && (
        <CodeBlock content={result.output} maxH="max-h-48" className="mt-2" />
      )}
      {expanded && result?.error && (
        <CodeBlock content={result.error} tone="error" maxH="max-h-72" className="mt-2" />
      )}
    </div>
  )
}

// Pick a sensible language hint for the inline action preview based on
// which arg the describeAction function picked up.
function detectActionLanguage(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string' && args.command.length > 0) return 'bash'
  if (typeof args.find === 'string' && typeof args.replace === 'string') return 'diff'
  return undefined
}

// Pick the most meaningful "what's happening" line for the card. Most
// tools have one primary input (a command, a path) — that's what the
// user wants to see at a glance. Returns null when no obvious primary
// arg exists; the card falls back to the expandable args view.
function describeAction(args: Record<string, unknown>): string | null {
  if (typeof args.command === 'string' && args.command.length > 0) {
    return args.command
  }
  if (typeof args.path === 'string' && args.path.length > 0) {
    if (typeof args.find === 'string' && typeof args.replace === 'string') {
      return `${args.path}\n- ${truncate(args.find, 80)}\n+ ${truncate(args.replace, 80)}`
    }
    if (typeof args.startLine === 'number' || typeof args.endLine === 'number') {
      const start = args.startLine ?? ''
      const end = args.endLine ?? ''
      return `${args.path}:${start}-${end}`
    }
    return args.path
  }
  if (typeof args.query === 'string' && args.query.length > 0) {
    return args.query
  }
  return null
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function formatElapsedCompact(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
