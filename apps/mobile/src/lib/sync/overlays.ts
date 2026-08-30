import { tunnelClient } from '@/lib/tunnel/client'
import {
  Rpc,
  type AutomationQueuedRun,
  type AutomationRun,
  type AutomationRuns,
  type OverlaySeed,
  type ReindexStatus
} from '@/lib/tunnel/protocol'
import { useMemo } from 'react'
import { create } from 'zustand'

/**
 * Overlays — what the desktop is busy doing right now, as cards over whatever
 * screen the phone is on.
 *
 * The desktop draws four of these and treats them as two unrelated systems.
 * Three (automations, compaction, reflection) are the brainstem's run pool, all
 * rendered by one floating card; the fourth (reindexing) is a blocking overlay
 * that replaces its chat screen for the duration. The phone shows all four the
 * same way, because a phone that cannot be used at all while an index rebuilds
 * is a phone that looks broken, and because four kinds of "the desktop is
 * working" should not be four kinds of interruption.
 *
 * IN MEMORY ONLY, and cleared the moment the tunnel drops. Every card claims
 * something is happening *right now* on a machine this one cannot see; a card
 * that survived a relaunch, or an hour offline, would be asserting that on no
 * evidence. There is nothing to restore it from either — the desktop announces
 * transitions, not history — which is what `seedOverlays` is for.
 *
 * Both halves arrive as pushes and neither has a screen that fetches it, so a
 * phone connecting mid-run has already missed the only announcement it was
 * going to get. `seedOverlays()` closes that window once per connection; the
 * pushes keep it current after that.
 *
 * Unpaired (demo) phones have no overlays and never will: there is no desktop
 * running anything. The stack renders nothing, which is the truth.
 */

/** How many cards the stack shows at once. See composeOverlays for the rest. */
export const MAX_OVERLAYS = 3

const RUN_KINDS = ['automation', 'compaction', 'reflection', 'procedure'] as const
type RunKind = (typeof RUN_KINDS)[number]

/**
 * One card's worth of state. A union rather than one widened row because the
 * two shapes genuinely differ: a run has a prompt and a mode and no idea how
 * far along it is, a reindex has a file count and neither of the others.
 */
export type ActiveOverlay =
  | {
      kind: RunKind
      /** The brainstem job id — stable for the life of the run. */
      id: string
      label: string
      /**
       * The prompt, ready to render for `kind: 'automation'`; an i18n KEY for
       * the built-in compaction and reflection jobs, which is the desktop's own
       * convention — see OverlayKind in the protocol. `''` when the desktop is
       * too old to send it.
       */
      body: string
      /** 0 when unknown (an older desktop), which hides the elapsed clock. */
      startedAt: number
      mode: 'single' | 'workflow' | null
    }
  | {
      kind: 'reindex'
      id: 'reindex'
      startedAt: number
      done: number
      total: number
    }

export type OverlayStack = {
  /** At most MAX_OVERLAYS, in the order they are drawn. */
  active: ActiveOverlay[]
  /** The run pool's FIFO overflow — labels only, one strip under the cards. */
  queued: AutomationQueuedRun[]
  /** Active overlays the cap left out, so the strip can own up to them. */
  hidden: number
}

type OverlayState = {
  runs: AutomationRuns
  reindex: ReindexStatus | null
}

const EMPTY_RUNS: AutomationRuns = { running: [], queued: [] }

export const useOverlayStore = create<OverlayState>()(() => ({
  runs: EMPTY_RUNS,
  reindex: null
}))

// ------------------------------------------------------------------ reading

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function runKind(value: unknown): RunKind {
  return (RUN_KINDS as readonly string[]).includes(text(value)) ? (value as RunKind) : 'automation'
}

/**
 * A run off the wire, or null if it is not one.
 *
 * Everything past `id`/`label` was added for these cards, so a phone talking to
 * an older desktop gets rows without it — hence defaults rather than trust.
 * `startedAt` falls back to 0 rather than "now": now would restart the elapsed
 * clock on every tick, and a clock that never advances is worse than none.
 */
function readRun(row: unknown): AutomationRun | null {
  const source = row as Partial<AutomationRun> | null
  const id = text(source?.id)
  if (!id) return null
  return {
    id,
    label: text(source?.label),
    body: text(source?.body),
    kind: runKind(source?.kind),
    startedAt: count(source?.startedAt),
    mode: source?.mode === 'single' || source?.mode === 'workflow' ? source.mode : null
  }
}

function readQueued(row: unknown): AutomationQueuedRun | null {
  const source = row as Partial<AutomationQueuedRun> | null
  const id = text(source?.id)
  if (!id) return null
  return {
    id,
    label: text(source?.label),
    kind: runKind(source?.kind),
    queuedAt: count(source?.queuedAt)
  }
}

export function readRuns(payload: unknown): AutomationRuns {
  const source = payload as { running?: unknown; queued?: unknown } | null
  const running = Array.isArray(source?.running) ? source.running : []
  const queued = Array.isArray(source?.queued) ? source.queued : []
  return {
    running: running.map(readRun).filter((row): row is AutomationRun => row !== null),
    queued: queued.map(readQueued).filter((row): row is AutomationQueuedRun => row !== null)
  }
}

/**
 * A reindex status off the wire, or null — which is also what the desktop sends
 * when a rebuild ENDS, and is therefore what retires the card.
 *
 * A rebuild with no files (`total` 0) is dropped: there is nothing to report
 * and a bar over zero has no meaning.
 */
export function readReindex(payload: unknown): ReindexStatus | null {
  const status = (payload as { status?: unknown } | null)?.status as Partial<ReindexStatus> | null
  if (!status || typeof status !== 'object') return null
  const total = count(status.total)
  if (total <= 0) return null
  return { startedAt: count(status.startedAt), done: Math.min(count(status.done), total), total }
}

// ------------------------------------------------------------------ writing

/**
 * Bumped by everything that writes newer knowledge than a seed in flight —
 * a push, or the tunnel dropping. See seedOverlays for what reads it.
 */
let revision = 0

/**
 * Fold an `automations.runs` push. The push carries the whole pool, so it IS
 * the state — read it off the wire with `readRuns` first.
 */
export function applyOverlayRuns(runs: AutomationRuns): void {
  revision += 1
  useOverlayStore.setState({ runs })
}

/** Fold a `reindex.status` push. `null` is the end, and retires the card. */
export function applyOverlayReindex(reindex: ReindexStatus | null): void {
  revision += 1
  useOverlayStore.setState({ reindex })
}

/** Nothing is knowably running once the tunnel is gone. See the file doc. */
export function clearOverlays(): void {
  revision += 1
  useOverlayStore.setState({ runs: EMPTY_RUNS, reindex: null })
}

/**
 * Ask the desktop what is running, once per connection.
 *
 * Discarded if anything else wrote while it was in flight. The seed is issued
 * on the same edge that attaches the push handlers, so a run that starts or
 * ends during that round trip arrives as a push FIRST and the answer — already
 * describing a world that has moved on — would put the finished run back. The
 * push after it would eventually correct that, except the push that ended the
 * run may well have been the last one that pool was ever going to send, which
 * leaves a card standing over nothing until the next unrelated one.
 *
 * Never throws: a desktop too old to answer this leaves the stack empty until
 * the next push, which is exactly the behaviour before these cards existed.
 */
export async function seedOverlays(): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  const issued = revision
  try {
    const seed = (await tunnel.rpc(Rpc.overlaysRead)) as OverlaySeed | null
    if (revision !== issued) return
    useOverlayStore.setState({
      runs: readRuns(seed?.runs),
      reindex: readReindex({ status: seed?.reindex })
    })
  } catch {
    // Deliberately silent, and deliberately NOT reportRpcFailure: an
    // unsupported method is not a sick tunnel, and nothing the user asked for
    // has failed.
  }
}

// ---------------------------------------------------------------- composing

/**
 * Which run families draw a card here, out of the desktop's config: the
 * automations switch is this phone's own (`mobile.runCards`) and covers
 * procedure runs too, while compaction and reflection each carry one switch
 * that both devices obey. Every one of them ships OFF — see composeOverlays.
 */
export type OverlayVisibility = {
  /** Automations AND procedure runs — one switch, because to the person
   *  watching they are one question: is something running for me. */
  automation: boolean
  compaction: boolean
  reflection: boolean
}

/** No filter at all — what an unfiltered compose means, and the tests' case. */
export const ALL_OVERLAYS_VISIBLE: OverlayVisibility = {
  automation: true,
  compaction: true,
  reflection: true
}

/**
 * The run pool and the reindex, as one ordered stack.
 *
 * Reindex leads because it is the only one that blocks the desktop outright —
 * on that machine it takes the whole window — and because it is the one the
 * user can neither have started nor stop. The runs follow oldest first, which
 * is the order the desktop's own cards sit in (its pool is a Map, and insertion
 * order is start order), so a run does not jump position as others end.
 *
 * The pool caps itself at three, but a reindex can overlap it and make four.
 * The cap here is the phone's own: three rows is what fits above the fold
 * without the stack becoming the screen. What it leaves out is counted rather
 * than dropped silently — `hidden` is what the queue strip owns up to.
 *
 * `visible` is the user's answer to "which of these do I want interrupting
 * me", and every family is off by default — a phone that lit up nightly for
 * the desktop's own housekeeping was the whole complaint. A run switched off
 * is filtered out ENTIRELY: not carded, not queued, not counted in `hidden`,
 * because a strip announcing "1 more" that can never be opened is the same
 * interruption wearing a smaller coat. The reindex has no switch — it is the
 * one that blocks the desktop outright.
 */
export function composeOverlays(
  runs: AutomationRuns,
  reindex: ReindexStatus | null,
  visible: OverlayVisibility = ALL_OVERLAYS_VISIBLE
): OverlayStack {
  const shown = (kind: RunKind): boolean =>
    kind === 'procedure' ? visible.automation : visible[kind]
  const all: ActiveOverlay[] = []
  if (reindex) {
    all.push({
      kind: 'reindex',
      id: 'reindex',
      startedAt: reindex.startedAt,
      done: reindex.done,
      total: reindex.total
    })
  }
  for (const run of [...runs.running]
    .filter((run) => shown(run.kind))
    .sort((a, b) => a.startedAt - b.startedAt)) {
    all.push({
      kind: run.kind,
      id: run.id,
      label: run.label,
      body: run.body,
      startedAt: run.startedAt,
      mode: run.mode
    })
  }
  return {
    active: all.slice(0, MAX_OVERLAYS),
    queued: runs.queued.filter((entry) => shown(entry.kind)),
    hidden: Math.max(0, all.length - MAX_OVERLAYS)
  }
}

/**
 * The stack, for the one component that draws it — given which families the
 * user allows to interrupt them. The switches are READ by the caller (they
 * live in the mirrored desktop config, which this module deliberately does not
 * import: overlays stay pure wire-folding), so a flip made on either device
 * lands on the very next render, including for runs already in flight.
 *
 * The two slices are selected separately and composed in a memo rather than
 * composed inside the selector: a selector that builds a new array on every
 * call has no stable snapshot for useSyncExternalStore to compare, and React
 * says so at runtime.
 */
export function useOverlayStack(visible: OverlayVisibility): OverlayStack {
  const runs = useOverlayStore((state) => state.runs)
  const reindex = useOverlayStore((state) => state.reindex)
  const { automation, compaction, reflection } = visible
  // Destructured into the dep list rather than depending on the object: the
  // caller reads three switches off the config store and builds the record
  // inline, so its identity changes on every render and would defeat the memo.
  return useMemo(
    () => composeOverlays(runs, reindex, { automation, compaction, reflection }),
    [runs, reindex, automation, compaction, reflection]
  )
}
