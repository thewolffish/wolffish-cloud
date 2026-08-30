import { HeartbeatActiveOverlay } from '@components/common/heartbeat-active-overlay/HeartbeatActiveOverlay'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { HeartbeatLogEntry, HeartbeatRunningJob, HeartbeatRunsSnapshot } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { Activity04Icon, HourglassIcon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Background AUTOMATION runs never block the app. Up to three run at once
// through the brainstem's pool; while any run, this surface is pinned
// top-center over every screen as a row of cards — one per live run, up to
// three side by side — each with its pulsing icon, job label, mode, and its
// own live activity feed. When more jobs are waiting behind a full pool, a
// full-width row under the cards shows how many are queued. Clicking a card
// expands that run's overlay — a dismissible modal — and closing it never
// touches the card: cards stay, undismissable, until their runs end. Cards
// and overlay render from the SAME state owned here, so the overlay can be
// closed and reopened mid-run without losing log history.
//
// NOTHING is shown by default. Each family of run carries a visibility switch
// — automations AND procedures share one, in Settings → Channels → In-app;
// compaction and reflection have their own, in their Knowledge panels — and
// every switch ships OFF, because a card floating over the chat for work
// nobody asked to watch is noise. Off changes only that: the runs happen, the
// logs are written, the panels' last-run cards still report them, and a failed
// run still toasts.
//
// Automations and procedure runs (the model-triggered procedure_run tool; job
// id prefixed "procedure:") share ONE switch because they are one question to
// the person watching — "is something running for me right now" — and a
// procedure is just a saved prompt run in the background. What differs is only
// which page they live on.

const MAX_LOG_ENTRIES = 50

const isProcedureId = (id: string): boolean => id.startsWith('procedure:')

const EMPTY_SNAPSHOT: HeartbeatRunsSnapshot = { running: [], queued: [] }

/**
 * Which families draw a card. Three switches, four families: procedures ride
 * the automations one. All off until the config lands, so the first frame
 * after a launch can never flash a card the user switched off.
 */
type CardVisibility = { automation: boolean; compaction: boolean; reflection: boolean }

const NOTHING_SHOWN: CardVisibility = { automation: false, compaction: false, reflection: false }

const shows = (family: HeartbeatRunningJob['family'], visible: CardVisibility): boolean =>
  family === 'procedure' ? visible.automation : visible[family]

/**
 * The three switches, live.
 *
 * Each is read once and then followed by the push its own writer fires, so a
 * flip made in this window, in another one, or on the paired phone reaches the
 * floating card without a refetch — the card is the thing the user just turned
 * off, and it disappearing on the next run instead of now would read as broken.
 * Reflection's push carries no payload (it announces the whole config), so that
 * one re-pulls; the other two carry theirs.
 */
function useCardVisibility(): CardVisibility {
  const [visible, setVisible] = useState<CardVisibility>(NOTHING_SHOWN)

  useEffect(() => {
    let cancelled = false
    const merge = (patch: Partial<CardVisibility>): void => {
      if (!cancelled) setVisible((prev) => ({ ...prev, ...patch }))
    }
    const pullReflection = (): void => {
      void window.api.runtime
        .getReflectionConfig()
        .then((cfg) => merge({ reflection: cfg.cards === true }))
        .catch(() => {})
    }
    void window.api.inapp
      .getConfig()
      .then((cfg) => merge({ automation: cfg.runCards === true }))
      .catch(() => {})
    void window.api.runtime
      .getCompactionConfig()
      .then((cfg) => merge({ compaction: cfg.cards === true }))
      .catch(() => {})
    pullReflection()

    const offInApp = window.api.inapp.onConfigChange((cfg) =>
      merge({ automation: cfg.runCards === true })
    )
    const offCompaction = window.api.runtime.onCompactionConfigChanged((cfg) =>
      merge({ compaction: cfg.cards === true })
    )
    const offReflection = window.api.runtime.onReflectionChanged(pullReflection)
    return () => {
      cancelled = true
      offInApp()
      offCompaction()
      offReflection()
    }
  }, [])

  return visible
}

// Grid variant per visible card count: cards sit side by side (up to three),
// and the queued row below spans every column. Static class strings — cn has
// no tailwind-merge, so the variant is picked, never overridden.
const GRID_BY_COUNT: Record<number, string> = {
  0: 'max-w-sm grid-cols-1',
  1: 'max-w-sm grid-cols-1',
  2: 'max-w-3xl grid-cols-2',
  3: 'max-w-5xl grid-cols-3'
}

// A run that dies because every provider attempt failed surfaces the raw
// ProviderFailure.reasonKey as its error (wernicke joins them with '; '), so
// payload.error arrives as a bare machine key like "offline". Map those to
// short toast-sized reasons; anything unrecognized is a real exception
// message and passes through (clamped so a stack-ish string can't balloon
// the toast).
const PROVIDER_REASON_MESSAGE: Record<string, string> = {
  offline: 'errors.runFailedReason.offline',
  'authentication failed': 'errors.runFailedReason.invalidKey',
  forbidden: 'errors.runFailedReason.invalidKey',
  'model not found': 'errors.runFailedReason.modelNotFound',
  'rate-limited': 'errors.runFailedReason.rateLimited',
  'bad request': 'errors.runFailedReason.badRequest',
  timeout: 'errors.runFailedReason.timeout',
  'server error': 'errors.runFailedReason.serverError',
  'gateway error': 'errors.runFailedReason.serverError',
  unavailable: 'errors.runFailedReason.serverError',
  overloaded: 'errors.runFailedReason.serverError'
}

const RAW_ERROR_TOAST_LIMIT = 100

const clampToastDetail = (text: string): string =>
  text.length <= RAW_ERROR_TOAST_LIMIT
    ? text
    : `${text.slice(0, RAW_ERROR_TOAST_LIMIT - 1).trimEnd()}…`

export function ActiveRunCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const toast = useToast()
  const { status } = useFlow()
  // Unstamped runs follow the global mode — show the effective value.
  const globalMode = status?.config?.llm.mode === 'workflow' ? 'workflow' : 'single'
  const visible = useCardVisibility()
  // The whole pool, NOT what is on screen: the visibility switches are applied
  // at render, so flipping one takes effect on the runs already in flight
  // instead of only on the next snapshot.
  const [snapshot, setSnapshot] = useState<HeartbeatRunsSnapshot>(EMPTY_SNAPSHOT)
  // Live activity per run, keyed by the id the log entries carry (the
  // brainstem job id; label kept as a fallback key for older emitters).
  const [logsById, setLogsById] = useState<Record<string, HeartbeatLogEntry[]>>({})
  const [overlayId, setOverlayId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.heartbeat
      .getRuns()
      .then((snap) => {
        if (!cancelled) setSnapshot(snap)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offRuns = window.api.heartbeat.onRunsChanged((snap) => {
      const next = snap
      setSnapshot(next)
      // Drop log buffers whose run is gone, so a later run of the same job
      // starts with a fresh feed (and procedure/finished buffers can't pile
      // up). Buffers for runs still live are kept across the transition.
      setLogsById((prev) => {
        const keep: Record<string, HeartbeatLogEntry[]> = {}
        for (const run of next.running) {
          for (const key of [run.id, run.label]) {
            if (prev[key]) keep[key] = prev[key]
          }
        }
        return keep
      })
      // The overlay follows its run: when that run ends, it closes. Cleared
      // here (not in an effect) so a stale id can't reopen the overlay when
      // the same job runs again later.
      setOverlayId((prev) => (prev && next.running.some((run) => run.id === prev) ? prev : null))
    })
    const offEnded = window.api.heartbeat.onJobEnded((payload) => {
      // A run that fails mid-execution has no other in-app surface (procedure
      // runs never had one), so surface the failure as a toast: what failed,
      // then why.
      if (payload.status === 'failed') {
        const title = t(isProcedureId(payload.id) ? 'procedures.runFailed' : 'heartbeat.runFailed')
        const reasonKey = PROVIDER_REASON_MESSAGE[payload.error?.split(';')[0]?.trim() ?? '']
        const detail = reasonKey ? t(reasonKey) : payload.error && clampToastDetail(payload.error)
        toast.show({
          tone: 'error',
          message: detail ? `${title} — ${detail}` : title
        })
      }
    })
    const offLog = window.api.heartbeat.onJobLog((entry) => {
      // Buffered by the entry's own id even before the runsChanged snapshot
      // lands (the 'started' entry broadcasts first) — the next snapshot
      // prunes buffers that never matched a visible run.
      setLogsById((prev) => {
        const bucket = [...(prev[entry.id] ?? []), entry]
        return {
          ...prev,
          [entry.id]: bucket.length > MAX_LOG_ENTRIES ? bucket.slice(-MAX_LOG_ENTRIES) : bucket
        }
      })
    })
    return () => {
      offRuns()
      offEnded()
      offLog()
    }
  }, [t, toast])

  // What this user has asked to see, out of what is actually running.
  const running = snapshot.running.filter((run) => shows(run.family, visible))
  const queued = snapshot.queued.filter((entry) => shows(entry.family, visible))
  if (running.length === 0 && queued.length === 0) return null

  const logsFor = (job: HeartbeatRunningJob): HeartbeatLogEntry[] =>
    logsById[job.id] ?? logsById[job.label] ?? []
  // Resolved against the VISIBLE runs, so switching a family off closes an
  // overlay standing over one of its runs rather than orphaning it.
  const overlayJob = overlayId ? running.find((run) => run.id === overlayId) : undefined

  return (
    <>
      {/* The wrapper spans the window so the grid can center; pointer events
          pass through it — only the cards and the queue row are targets. */}
      <div className="pointer-events-none fixed top-12 left-1/2 z-40 w-full -translate-x-1/2 px-4">
        <div
          className={cn('mx-auto grid w-full gap-2', GRID_BY_COUNT[Math.min(running.length, 3)])}
        >
          {running.map((job) => (
            <RunCard
              key={job.id}
              job={job}
              logs={logsFor(job)}
              mode={job.mode ?? globalMode}
              onOpen={() => setOverlayId(job.id)}
            />
          ))}
          {queued.length > 0 && (
            <div
              role="status"
              className="border-border bg-surface/95 pointer-events-auto col-span-full flex items-center gap-2.5 rounded-xl border px-3 py-2 shadow-lg backdrop-blur-sm"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
                <HourglassIcon size={13} className="text-amber-500" />
              </span>
              <span className="text-fg shrink-0 text-xs font-medium">
                {t('heartbeat.queuedCount', { count: queued.length })}
              </span>
              <span className="text-muted min-w-0 flex-1 truncate text-xs">
                {queued.map((entry) => entry.label).join(' · ')}
              </span>
            </div>
          )}
        </div>
      </div>
      {overlayJob ? (
        <HeartbeatActiveOverlay
          job={overlayJob}
          logs={logsFor(overlayJob)}
          onClose={() => setOverlayId(null)}
        />
      ) : null}
    </>
  )
}

function RunCard({
  job,
  logs,
  mode,
  onOpen
}: {
  job: HeartbeatRunningJob
  logs: HeartbeatLogEntry[]
  mode: 'single' | 'workflow'
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const logBoxRef = useRef<HTMLSpanElement>(null)

  // Pin the card's feed to the newest entry — the card shows exactly one line,
  // so this is what makes the feed readable at all. scrollTop (not
  // scrollIntoView) so a card floating over an arbitrary screen can never
  // scroll that screen.
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <button
      type="button"
      onClick={onOpen}
      className="border-border bg-surface/95 hover:bg-surface pointer-events-auto flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-xl border p-3 text-start shadow-lg backdrop-blur-sm"
    >
      <span className="flex w-full items-center gap-2.5">
        <span className="relative shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/20" />
          <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15">
            <Activity04Icon size={14} className="text-emerald-500 animate-pulse" />
          </span>
        </span>
        <span className="text-fg min-w-0 flex-1 truncate text-xs font-medium">{job.label}</span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
            mode === 'workflow'
              ? 'bg-primary/15 text-primary'
              : 'text-muted bg-bg border-border border'
          )}
        >
          {t(mode === 'workflow' ? 'chat.modePicker.workflow' : 'chat.modePicker.single')}
        </span>
      </span>
      {/* One line tall, still the same scrollable feed. The padding and border
          live on the outer box while the inner strip — exactly one 16px line —
          is the scroller, so scrolling to the end lands on the newest entry
          alone instead of leaving a sliver of the previous one above it (the
          box's own bottom padding would otherwise eat into the view).
          overscroll-contain keeps a flick at either end from scrolling the
          screen behind this floating card. */}
      <span className="bg-bg/60 border-border block w-full rounded-lg border px-2.5 py-1.5">
        <span
          ref={logBoxRef}
          className="block h-4 w-full overflow-y-auto overscroll-contain font-mono text-[10px] leading-[16px]"
        >
          {logs.length === 0 ? (
            <span className="text-muted/50 flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              {t('heartbeat.overlay.waiting')}
            </span>
          ) : (
            logs.map((entry, i) => (
              <span
                key={`${entry.timestamp}-${i}`}
                className={cn(
                  'block truncate',
                  i === logs.length - 1 ? 'text-fg' : 'text-muted/40'
                )}
              >
                {entry.summary}
              </span>
            ))
          )}
        </span>
      </span>
    </button>
  )
}
