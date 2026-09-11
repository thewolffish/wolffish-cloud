import type { Corpus } from '@main/runtime/corpus'
import type { NoProviderAvailableInfo, StreamChunk } from '@main/runtime/thalamus'

/**
 * Broca produces the final, user-facing response.
 *
 * Maps to: Broca's area — a region in the left frontal lobe that handles
 * speech production. Patients with Broca's aphasia understand language
 * fine, but struggle to produce it: they know what they want to say, but
 * the words come out halting and broken. Production is Broca's job.
 *
 * In Wolffish, Broca tees the unified stream coming from Thalamus into
 * an ordered series of `Segment`s — text deltas, tool calls, tool
 * results, and a final turn_end marker. The segment stream is what the
 * renderer consumes; the underlying chunk stream still passes through
 * to Wernicke for parsing. Broca writes no prose itself: every visible
 * artifact comes from the model or from a tool's own output.
 */

export type SegmentTurnEndReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'error'
  | 'no_provider_available'

export type ToolResultStatus = 'success' | 'failed' | 'denied'

/**
 * LEGACY (removed Orchestrator mode, ≤1.0.204): segments persisted by old
 * conversations may carry this tag, set on subagent output that was forwarded
 * into the orchestrator turn's stream. Workflow mode no longer forwards
 * subagent segments — the workflow card is the subagent surface — but every
 * render/replay path must keep SKIPPING worker-tagged segments or old
 * conversations replay subagent prose as the assistant's own.
 */
export type SegmentWorker = { id: string; label: string }

export type WorkflowPhaseStatus = 'pending' | 'active' | 'done'

export type WorkflowAgentView = {
  id: string
  name: string
  /** Truncated task snippet for display — the full prompt lives in logs. */
  task: string
  phase?: string
  provider: string
  model: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  llmCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  resultChars?: number
}

/**
 * The deterministic state of one workflow-mode run, built by WorkflowSession
 * from the harness's own observations (spawn lifecycle, LLM usage callbacks,
 * tool-call counts, wall-clock) — never from model claims. Carried whole on
 * every `workflow` segment: each snapshot REPLACES the previous one for the
 * same workflowId (see upsertWorkflowSegment), so exactly one card persists
 * per run and live/reload render identically.
 */
export type WorkflowSnapshot = {
  workflowId: string
  status: 'running' | 'completed' | 'canceled' | 'error'
  startedAt: number
  endedAt?: number
  /** Optional master-declared plan note (via workflow_plan). */
  note?: string
  phases: Array<{ title: string; status: WorkflowPhaseStatus }>
  agents: WorkflowAgentView[]
  /** Agents-only sums (one row per agent above). */
  totals: {
    agents: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
  /**
   * The master turn's OWN LLM usage, fed per-call from the agent loop so the
   * card can show the true whole-turn cost — agents-only totals under-report
   * the run (the first real run hid ~4.6% of spend). Optional: snapshots
   * persisted before this field shipped lack it.
   */
  master?: {
    llmCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
}

/**
 * A file change a tool made, as a unified diff. Produced by the filesystem
 * tools (file_edit / file_write) and carried on the tool_result segment's
 * `meta` so the feed can render red/green hunks and a +N −M chip — live and
 * on reload alike, since the segment persists whole.
 */
export type ToolResultDiff = {
  file: string
  /** Standard unified diff text (`--- a/…`, `+++ b/…`, `@@` hunks). */
  patch: string
  additions: number
  deletions: number
  kind: 'edit' | 'create' | 'overwrite'
}

/**
 * Structured facts about a tool result, for the UI only. Display-only in
 * the strict sense: both model-context rebuild paths ignore `meta` — the
 * model sees `output`, the user sees what `meta` renders. Optional on every
 * result; readers that predate it (mobile, CLI) ignore the field.
 */
export type ToolResultMeta = {
  diff?: ToolResultDiff
  /** Shell exit code, null when killed. */
  exitCode?: number | null
  durationMs?: number
  /** Absolute path of the full output when it was spilled to disk. */
  outputPath?: string
  truncated?: boolean
  /** The directory a command ran in. */
  cwd?: string
  /** A short human label chosen by the tool (e.g. "Run tests"). */
  label?: string
}

/**
 * The tools whose call changes the user's project — an edit, a write, a shell
 * run. Every clean feed (the in-app chat, the phone's live mirror) shows
 * these as a compact activity row even with verbose off; every other tool
 * call stays mechanics. One list, so the surfaces cannot drift.
 */
export const CODE_ACTIVITY_TOOLS: ReadonlySet<string> = new Set([
  'file_edit',
  'file_write',
  'file_patch',
  'shell_exec'
])

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/**
 * One item of the model's task list (todo_write). The whole list rides every
 * `todo` segment; consumers upsert by turnId so a turn shows exactly ONE
 * checklist card, at the position of its first write, in its latest state.
 */
export type TodoItem = {
  content: string
  status: TodoStatus
  priority?: 'high' | 'medium' | 'low'
}

/**
 * The master's workflow-management tools. Their tool_call/tool_result
 * segments persist and replay into model context like any tool (the master's
 * memory of agent reports lives in agents_await results), but NO render
 * surface shows them as chips — the workflow card and the channels' phase
 * messages are their user-facing surface.
 */
export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  'workflow_plan',
  'agent_spawn',
  'agent_send',
  'agents_await',
  'agent_cancel'
])

/**
 * Replace-by-id upsert for workflow snapshot segments: the latest snapshot
 * for a workflowId supersedes any earlier one in an accumulated segment
 * array. Shared by every surface that accumulates segments (renderer
 * messages, channel ActiveTurn.segments, autonomous-run sinks) so persisted
 * conversations hold exactly ONE card per workflow run.
 */
export function upsertWorkflowSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'workflow' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'workflow' && s.snapshot.workflowId === segment.snapshot.workflowId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-turnId upsert for the todo checklist — one card per turn, in
 * its latest state, at the position of the first write. Same contract as
 * the snapshot upserts above; shared by every surface that accumulates
 * segments so live and reloaded conversations render identically.
 */
/** The list a todo segment belongs to — its own turn unless it continues an earlier one. */
export function todoListId(segment: Extract<Segment, { kind: 'todo' }>): string {
  return segment.listId ?? segment.turnId
}

/**
 * Every task list in a conversation in its LATEST state, keyed by list id,
 * walking the messages' segments in order (a later write replaces an
 * earlier one). Renderers draw each list once, on the card of the turn that
 * created it, with these items — so a continuation write in a later turn
 * resolves the earlier card in place.
 */
export function latestTodoLists(
  segmentLists: Array<ReadonlyArray<Segment> | undefined>
): Map<string, TodoItem[]> {
  const out = new Map<string, TodoItem[]>()
  for (const segments of segmentLists) {
    if (!segments) continue
    for (const segment of segments) {
      if (segment.kind === 'todo') out.set(todoListId(segment), segment.items)
    }
  }
  return out
}

export type OpenTodoList = { listId: string; items: TodoItem[] }

/**
 * The conversation's most recently written task list when it still has
 * unfinished items (pending or in_progress) — the list a turn inherits,
 * so the model can carry it on and mark it done. Null when the latest list
 * is settled or there is none.
 */
export function openTodoList(
  segmentLists: Array<ReadonlyArray<Segment> | undefined>
): OpenTodoList | null {
  let latest: OpenTodoList | null = null
  for (const segments of segmentLists) {
    if (!segments) continue
    for (const segment of segments) {
      if (segment.kind === 'todo') latest = { listId: todoListId(segment), items: segment.items }
    }
  }
  if (!latest) return null
  const open = latest.items.some((i) => i.status === 'pending' || i.status === 'in_progress')
  return open ? latest : null
}

export function upsertTodoSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'todo' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'todo' && s.turnId === segment.turnId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Append a text or reasoning segment, folding it into the previous one when
 * both are adjacent parts of the same run — same kind, same author (worker
 * or main line, same worker id) with nothing between them. Shared by every
 * surface that accumulates segments, exactly like the snapshot upserts above.
 *
 * Without this, a streamed reply persisted one segment PER MODEL TICK — a
 * few characters each. One heartbeat automation's reply landed as 2,441
 * text segments (~250 KB of segment envelope wrapped around a 10 KB
 * answer), and every later reader — this app's own renderer, the wire to
 * the phone, the phone's store — paid O(ticks) forever after. Folded here,
 * a prose run is ONE segment; boundaries stay boundaries, and the first
 * tick's segmentId keeps naming the run so nothing keyed on it moves.
 * Reasoning streams tick-by-tick exactly like text, so it folds under the
 * same rule — kinds never fold into each other.
 */
export function appendTextSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'text' | 'reasoning' }>
): void {
  const last = segments[segments.length - 1]
  if (
    last &&
    (last.kind === 'text' || last.kind === 'reasoning') &&
    last.kind === segment.kind &&
    last.turnId === segment.turnId &&
    Boolean(last.worker) === Boolean(segment.worker) &&
    last.worker?.id === segment.worker?.id
  ) {
    segments[segments.length - 1] = { ...last, delta: last.delta + segment.delta }
    return
  }
  segments.push(segment)
}

export type Segment =
  | { kind: 'text'; turnId: string; segmentId: string; delta: string; worker?: SegmentWorker }
  | {
      /**
       * A run of the model's thinking, streamed in place — one delta per
       * provider tick, folded per run by appendTextSegment exactly like text,
       * so the whole turn's reasoning renders at its true position (before
       * the prose/tool calls it produced), not just the final iteration's.
       * Display-only: both model-context rebuild paths ignore it.
       *
       * Dual-published on purpose: the final iteration's thinking still rides
       * `turn_end.reasoningContent` (unchanged) so surfaces that predate this
       * kind — the mobile app, the CLI renderer — keep their turn-end
       * reasoning card. The in-app renderer prefers these in-place segments
       * and skips the turn_end copy whenever a message contains any.
       */
      kind: 'reasoning'
      turnId: string
      segmentId: string
      delta: string
      worker?: SegmentWorker
    }
  | {
      kind: 'tool_call'
      turnId: string
      segmentId: string
      toolCallId: string
      name: string
      args: Record<string, unknown>
      worker?: SegmentWorker
    }
  | {
      kind: 'tool_result'
      turnId: string
      segmentId: string
      toolCallId: string
      status: ToolResultStatus
      output: string
      error?: string
      /** UI-only structured facts (diff, exit code, duration). See ToolResultMeta. */
      meta?: ToolResultMeta
      worker?: SegmentWorker
    }
  | {
      /**
       * The model's task list after a todo_write call (see TodoItem).
       * Replace-by-turnId semantics — NOT append — on every surface, so a
       * turn carries one checklist card in its latest state. Display-only:
       * both model-context rebuild paths ignore it (the model keeps the list
       * through the todo_write tool result it already has).
       */
      kind: 'todo'
      turnId: string
      segmentId: string
      items: TodoItem[]
      /**
       * The list this write belongs to — the turnId of the turn that created
       * it. Absent (or equal to turnId) on the creating write. A later turn
       * that continues an open list writes with the ORIGINAL list id, and
       * every renderer draws that card, at its original position, in the
       * latest state (latestTodoLists) — the model "goes back" and marks
       * the earlier card done rather than growing a second checklist.
       */
      listId?: string
    }
  | {
      kind: 'active_model'
      turnId: string
      segmentId: string
      provider: string
      model: string
    }
  | {
      kind: 'turn_end'
      turnId: string
      segmentId: string
      stopReason: SegmentTurnEndReason
      iterationCount: number
      providerErrors?: NoProviderAvailableInfo[]
      reasoningContent?: string
    }
  | { kind: 'separator'; turnId: string; segmentId: string }
  | {
      /**
       * Full-state snapshot of a workflow-mode run (see WorkflowSnapshot).
       * Replace-by-workflowId semantics — NOT append — on every surface.
       * Display-only: both model-context rebuild paths ignore it.
       */
      kind: 'workflow'
      turnId: string
      segmentId: string
      snapshot: WorkflowSnapshot
    }
  | {
      kind: 'compaction_started'
      turnId: string
      segmentId: string
      messagesCount: number
      targetsCount: number
      tokenCount: number
      tokenBudget: number
      startedAt: number
    }
  | {
      kind: 'compaction'
      turnId: string
      segmentId: string
      /** Number of tool results that were compacted. */
      targetsCount: number
      /** Total tokens reclaimed by compaction. */
      tokensSaved: number
      /** How long the compaction took in milliseconds. */
      durationMs: number
      /** Per-target details for the card. */
      details: Array<{
        toolName?: string
        originalChars: number
        compactedChars: number
        /** Model name that performed the compaction (or 'truncate'). */
        compactedBy: string
      }>
    }

export type SegmentSink = (segment: Segment) => void

export type BrocaOptions = {
  corpus?: Corpus
  /**
   * Predicate consulted when a tool_call chunk arrives. Returning true
   * marks that tool call as silent: broca skips both its tool_call and
   * its eventual tool_result segments, so the renderer shows nothing
   * for the call. Used for wolffish-internal housekeeping (memory
   * writes, episode logs) that the user never asked about.
   */
  shouldSilenceToolCall?: (name: string, args: Record<string, unknown>) => boolean
}

export class Broca {
  private turnId: string | null = null
  private sink: SegmentSink | null = null
  private counter = 0
  private turnEnded = false
  private silentToolCallIds = new Set<string>()
  /**
   * Tool calls whose tool_call segment has been emitted but whose
   * tool_result segment has not. Drained by emitToolResult. Anything still
   * here when the turn ends (a run stopped mid-tool) is closed by
   * closeOpenToolCalls so the persisted segment stream never carries a
   * tool_call without a matching result.
   */
  private openToolCallIds = new Set<string>()

  constructor(private options: BrocaOptions = {}) {
    void this.options
  }

  /**
   * True if the given toolCallId was marked silent when its tool_call
   * chunk arrived. Callers that bypass broca (the agent's approval
   * loop) check this before requesting approval or treating the call
   * as user-visible.
   */
  isSilent(toolCallId: string): boolean {
    return this.silentToolCallIds.has(toolCallId)
  }

  /**
   * Open a per-turn segment channel. The agent calls this once per
   * user message, before any LLM stream begins. Resets the segment
   * counter so segmentIds are monotonic per turn.
   */
  beginTurn(turnId: string, sink: SegmentSink): void {
    this.turnId = turnId
    this.sink = sink
    this.counter = 0
    this.turnEnded = false
    this.silentToolCallIds.clear()
    this.openToolCallIds.clear()
  }

  /**
   * Close the per-turn channel. Called from the agent's finally block
   * so a thrown error doesn't leave the channel half-open.
   */
  endTurn(): void {
    this.turnId = null
    this.sink = null
    this.counter = 0
    this.turnEnded = false
    this.silentToolCallIds.clear()
    this.openToolCallIds.clear()
  }

  /**
   * Tee an upstream chunk stream: emit a Segment for every text and
   * tool_call chunk while passing every chunk through to whoever is
   * downstream (typically Wernicke). turn_meta and error chunks aren't
   * surfaced as segments — turn_meta is internal metadata, and errors
   * are surfaced via the agent's turn_end with stopReason='error'.
   */
  async *streamSegments(chunks: AsyncGenerator<StreamChunk>): AsyncGenerator<StreamChunk> {
    for await (const chunk of chunks) {
      if (chunk.type === 'text' && chunk.text.length > 0) {
        this.emit({
          kind: 'text',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          delta: chunk.text
        })
      } else if (chunk.type === 'reasoning' && chunk.text.length > 0) {
        this.emit({
          kind: 'reasoning',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          delta: chunk.text
        })
      } else if (chunk.type === 'tool_call') {
        if (this.options.shouldSilenceToolCall?.(chunk.name, chunk.args)) {
          this.silentToolCallIds.add(chunk.id)
        } else {
          this.emit({
            kind: 'tool_call',
            turnId: this.requireTurn(),
            segmentId: this.nextId(),
            toolCallId: chunk.id,
            name: chunk.name,
            args: chunk.args
          })
          this.openToolCallIds.add(chunk.id)
        }
      } else if (chunk.type === 'active_model') {
        this.emit({
          kind: 'active_model',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          provider: chunk.provider,
          model: chunk.model
        })
      }
      yield chunk
    }
  }

  /**
   * Emit a synthetic tool_call segment for the active turn. Used by the
   * dependency resolver to surface install actions that aren't part of
   * the LLM's stream — without this segment, the renderer has nowhere
   * to anchor the approval card and it never appears, even though the
   * IPC fired.
   */
  emitToolCall(
    turnId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.options.shouldSilenceToolCall?.(name, args)) {
      this.silentToolCallIds.add(toolCallId)
      return
    }
    this.emit({
      kind: 'tool_call',
      turnId,
      segmentId: this.nextId(),
      toolCallId,
      name,
      args
    })
    this.openToolCallIds.add(toolCallId)
  }

  /**
   * Emit a tool_result segment for the active turn. Status mirrors the
   * motor/safety outcome: 'success' or 'failed' from execution, 'denied'
   * for amygdala-blocked or user-denied calls.
   */
  emitToolResult(
    turnId: string,
    toolCallId: string,
    status: ToolResultStatus,
    output: string,
    error?: string,
    meta?: ToolResultMeta
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.silentToolCallIds.has(toolCallId)) {
      this.silentToolCallIds.delete(toolCallId)
      return
    }
    this.openToolCallIds.delete(toolCallId)
    const segment: Segment = {
      kind: 'tool_result',
      turnId,
      segmentId: this.nextId(),
      toolCallId,
      status,
      output
    }
    if (error !== undefined) segment.error = error
    if (meta !== undefined) segment.meta = meta
    this.emit(segment)
  }

  /**
   * Emit the model's task list after a todo_write call. The Agent is the
   * only caller. Consumers upsert by turnId — see upsertTodoSegment.
   */
  emitTodo(turnId: string, items: TodoItem[], listId?: string): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'todo',
      turnId,
      segmentId: this.nextId(),
      items,
      ...(listId && listId !== turnId ? { listId } : {})
    })
  }

  /**
   * Emit a synthetic tool_result for every tool_call this turn announced
   * but never resolved — the case where the user stops a run while a tool
   * is still in flight. Without it the persisted segment stream holds a
   * tool_call with no matching result, and the next request rebuilt from
   * those segments (renderer textHistory / channel assistantSegmentsToHistory)
   * sends an assistant tool_calls message with no tool results, which every
   * cloud provider rejects ("tool_calls must be followed by tool messages").
   *
   * Call immediately before emitTurnEnd. A no-op when nothing is open (the
   * normal end-of-turn case), so it is safe to call unconditionally.
   * Returns the ids that were closed.
   */
  closeOpenToolCalls(turnId: string, status: ToolResultStatus, output: string): string[] {
    if (this.turnId !== turnId || !this.sink) return []
    if (this.openToolCallIds.size === 0) return []
    const closed: string[] = []
    for (const toolCallId of this.openToolCallIds) {
      this.emit({
        kind: 'tool_result',
        turnId,
        segmentId: this.nextId(),
        toolCallId,
        status,
        output
      })
      closed.push(toolCallId)
    }
    this.openToolCallIds.clear()
    return closed
  }

  /**
   * Emit a text segment directly into the active turn. Used by _to_chat
   * tools so plugins can inject content into the chat stream without
   * relying on the model to copy tool output verbatim.
   */
  emitText(turnId: string, text: string): void {
    if (this.turnId !== turnId || !this.sink) return
    if (text.trim().length === 0) return
    this.emit({
      kind: 'text',
      turnId,
      segmentId: this.nextId(),
      delta: text
    })
  }

  /**
   * Emit a separator segment that tells the renderer to flush the current
   * text buffer into its own bubble before continuing. Used by _to_chat
   * tools that return multiple items (e.g. several GIFs) so each renders
   * in its own message block rather than a single concatenated bubble.
   */
  emitSeparator(turnId: string): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'separator', turnId, segmentId: this.nextId() })
  }

  /**
   * Emit a workflow snapshot into the active turn. The WorkflowSession is
   * the only caller; it throttles token-only updates itself. Consumers
   * upsert by snapshot.workflowId — see upsertWorkflowSegment.
   */
  emitWorkflow(turnId: string, snapshot: WorkflowSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'workflow', turnId, segmentId: this.nextId(), snapshot })
  }

  emitCompactionStarted(
    turnId: string,
    messagesCount: number,
    targetsCount: number,
    tokenCount: number,
    tokenBudget: number
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'compaction_started',
      turnId,
      segmentId: this.nextId(),
      messagesCount,
      targetsCount,
      tokenCount,
      tokenBudget,
      startedAt: Date.now()
    })
  }

  /**
   * Emit a compaction card so the renderer can show the user that context
   * was intelligently summarized before this LLM call.
   */
  emitCompaction(
    turnId: string,
    targetsCount: number,
    tokensSaved: number,
    durationMs: number,
    details: Array<{
      toolName?: string
      originalChars: number
      compactedChars: number
      compactedBy: string
    }>
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'compaction',
      turnId,
      segmentId: this.nextId(),
      targetsCount,
      tokensSaved,
      durationMs,
      details
    })
  }

  /**
   * Emit the turn_end segment that closes the turn from the renderer's
   * perspective. Called from every loop exit path in the agent so the
   * renderer always sees a closing marker. Idempotent — a second call
   * within the same turn is dropped, so an error path that triggers
   * this from both the catch handler and the finally block doesn't
   * double-render.
   */
  emitTurnEnd(
    turnId: string,
    stopReason: SegmentTurnEndReason,
    iterationCount: number,
    providerErrors?: NoProviderAvailableInfo[],
    reasoningContent?: string
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.turnEnded) return
    this.turnEnded = true
    const segment: Segment = {
      kind: 'turn_end',
      turnId,
      segmentId: this.nextId(),
      stopReason,
      iterationCount
    }
    if (providerErrors?.length) segment.providerErrors = providerErrors
    if (reasoningContent) segment.reasoningContent = reasoningContent
    this.emit(segment)
  }

  private requireTurn(): string {
    if (!this.turnId) throw new Error('Broca.streamSegments called outside a turn')
    return this.turnId
  }

  private nextId(): string {
    this.counter += 1
    return `seg_${this.counter}`
  }

  private emit(segment: Segment): void {
    try {
      this.sink?.(segment)
    } catch {
      // a renderer that's gone away shouldn't tear down the agent
    }
  }
}
