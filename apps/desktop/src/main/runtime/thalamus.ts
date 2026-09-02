import type { Corpus } from '@main/runtime/corpus'
import { shapeOutbound } from '@main/runtime/outbound'
import { CloudProvider } from '@main/runtime/providers/cloud'
// Safe runtime import: usage.ts only imports the ProviderId TYPE from here.
import { catalogContextWindow } from '@main/cloud/catalog'
import { calculateCost } from '@main/runtime/usage'
import {
  cloudModelSupportsVision,
  hasVisualContent,
  isModalityReject,
  limitToolResultImages,
  REQUEST_MODALITY_STRIP_REASON,
  stripVisualContent,
  TOOL_RESULT_MODALITY_STRIP_REASON,
  type VisualStripScope
} from '@main/runtime/vision'
import { estimateImageTokens, selectInlineImages } from '@main/runtime/tool-images'
import { normalizeReasoningMode, reasoningModesFor } from '@main/runtime/reasoning'
import { net } from 'electron'

export type ToolUse = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string }

export type ToolResultImage = {
  mediaType: string
  data: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string | UserContentBlock[]
      /**
       * Marks a synthetic outbound-only message (the per-iteration runtime
       * status tail). Never present on internal history — it is appended to
       * the structural clone right before provider dispatch. Providers must
       * never place a cache breakpoint on a volatile message: its content
       * changes every call, so a breakpoint there would never match again.
       */
      volatile?: boolean
    }
  | { role: 'assistant'; content: string; toolUses?: ToolUse[]; reasoningContent?: string }
  | {
      role: 'tool'
      toolUseId: string
      toolName: string
      content: string
      isError?: boolean
      images?: ToolResultImage[]
    }

/**
 * One lane. Every model call goes through the Wolffish Cloud org API —
 * there are no vendor providers and no local models on the device. The id
 * survives as a type because usage records, stream chunks and renderer
 * chips all carry it on the wire.
 */
export type ProviderId = 'cloud'

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// Canonical reasoning scale lives in reasoning.ts. ThinkingMode is kept as an
// alias so the many existing references continue to resolve.
export type { ReasoningMode } from '@main/runtime/reasoning'
export type ThinkingMode = import('@main/runtime/reasoning').ReasoningMode

export type ProviderStreamOptions = {
  system: string
  messages: ChatMessage[]
  /**
   * The resolved model id for this call. Injected by thalamus at dispatch
   * (streamOnce / completeSingle) from the resolved entry — providers read
   * it, callers never set it.
   */
  model?: string
  tools?: ToolDefinition[]
  signal?: AbortSignal
  thinkingMode?: ThinkingMode
  /**
   * Per-iteration loop-position report (live tool counters). Appended to
   * the outbound structural clone as a final volatile user message so
   * everything before it stays a byte-stable, cacheable prefix. The
   * internal messages array is never touched.
   */
  volatileStatus?: string
  /**
   * Enables deterministic outbound truncation in the structural clone:
   * superseded page-state reads, byte-equal duplicate results, and stale
   * screenshots collapse to self-describing stubs. Internal history is
   * never touched. See outbound.ts for the exact (conservative) rules.
   */
  truncateOutbound?: boolean
  /**
   * Stable per-conversation key passed to providers that support cache
   * routing hints (OpenAI `prompt_cache_key`). Keeps all calls of a task
   * on the same cache shard — without it, sustained tool loops above
   * ~15 req/min on one prefix overflow to cold machines.
   */
  cacheKey?: string
  /**
   * Turn role for this call. 'agent' marks a workflow subagent (its effort is
   * clamped to the resolved model's reasoning support and it gets NO retry
   * budget — the master owns retries); 'summary' resolves like the Brain but
   * stamps the emitted llm.response with role:'summary' so summarization
   * side-calls are itemized as overhead. Per-call, so it's concurrency-safe.
   */
  role?: 'master' | 'agent' | 'summary'
  /**
   * Explicit provider+model for this call — the master's per-agent choice in
   * workflow mode. Resolved against the connected cloud providers; when the
   * provider isn't connected the call fails with a deterministic error (no
   * silent fallback — the failure is the master's signal to pick again).
   * Omitted ⇒ the Brain / local resolution.
   */
  modelOverride?: { provider: ProviderId; model: string }
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown'

export type StreamUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

export type NoProviderAvailableInfo = {
  provider: string
  providerLogo: string
  statusCode: number | null
  errorReason: string
  errorDetail: string | null
  retriesAttempted: number
  totalDurationMs: number
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  // provider/model are stamped by thalamus on relay so the agent can record
  // which model actually served the call (for usage capture and labelling).
  | {
      type: 'turn_meta'
      stopReason: StopReason
      usage?: StreamUsage
      provider?: ProviderId
      model?: string
    }
  | { type: 'error'; message: string; recoverable: boolean; failures?: NoProviderAvailableInfo[] }
  | { type: 'active_model'; provider: ProviderId; model: string }
  | { type: 'no_provider_available'; failures: NoProviderAvailableInfo[] }

export type ProviderHealth = {
  id: ProviderId
  healthy: boolean
  failCount: number
  cooldownUntil: number
}

export type ThalamusOptions = {
  corpus?: Corpus
  /**
   * Test-only: when set, cloud instantiate() returns this streamer instead
   * of constructing a real vendor client. Production never passes this.
   */
  testProvider?: {
    stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk>
  }
}

// How many requests a proven modality strip stays memoized before the next
// one probes with images again. See toolResultModalityRejects for why it
// expires at all rather than lasting the session.
export const MODALITY_MEMO_REQUESTS = 20

// Per-model cooldown after consecutive failures, exposed via getHealth()
// for diagnostics only. Resolution never skips the Brain because it is in
// cooldown — every turn re-tries the same selected model, and the retry
// budget below absorbs the actual back-off. Steps escalate so a
// genuinely-broken provider stays visibly degraded for longer.
const COOLDOWN_STEPS_MS = [30_000, 60_000, 120_000, 300_000]

// ~3 minutes total. The selected cloud model retries on transient failures
// (overloaded, rate-limited, gateway errors) with this schedule before the
// turn fails honestly. Slow but non-erroring streams never trip this —
// there's no per-call deadline, so a long response doesn't fail early.
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 90_000]

const PROVIDER_LOGO: Record<ProviderId, string> = {
  cloud: 'wolffish'
}

// Short English labels surfaced to the local fallback model via the
// <provider> notice in its runtime block. They aren't i18n keys —
// nothing translates them — they're plain-text hints the model can
// quote or paraphrase when explaining the situation to the user.
const STATUS_REASON_LABEL: Record<number, string> = {
  400: 'bad request',
  401: 'authentication failed',
  403: 'forbidden',
  404: 'model not found',
  429: 'rate-limited',
  500: 'server error',
  502: 'gateway error',
  503: 'unavailable',
  504: 'timeout',
  529: 'overloaded'
}

type ErrorClass = 'transient' | 'hard' | 'offline' | 'unknown'

type ProviderFailure = {
  provider: ProviderId
  statusCode: number | null
  errorClass: ErrorClass
  reasonKey: string
  rawMessage: string | null
  retries: number
  durationMs: number
}

interface StreamableProvider {
  stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk>
}

type CascadeEntry = {
  id: ProviderId
  model: string
  provider: StreamableProvider
}

/**
 * Thalamus is the sensory gateway — every input passes through it before
 * it reaches any other region.
 *
 * Maps to: the thalamus — a pair of egg-shaped nuclei that sit on top of
 * the brainstem and relay almost every sensory signal (sight, sound,
 * touch, taste — everything except smell) up to the cortex. Nothing
 * reaches conscious processing without being routed by the thalamus first.
 *
 * In Wolffish Cloud, Thalamus resolves the single user-chosen model and
 * streams it through the one lane that exists: the org's API. It retries on
 * transient failures and exposes a single async-generator interface so
 * downstream regions don't need to know what is answering. Resolution lives
 * behind one seam (resolveEntry) so the API integration phase swaps the
 * placeholder CloudProvider for the real client without touching callers.
 */
export class Thalamus {
  /** The selected model id; the org API is the authority on validity. */
  private model: string | null = null
  private cloud: StreamableProvider = new CloudProvider()
  private health = new Map<ProviderId, ProviderHealth>()
  private corpus: Corpus | null
  private testProvider: StreamableProvider | null
  /**
   * provider:model → the strip scope that actually cured a modality 400,
   * plus how many more requests it applies to. Written only after a
   * stripped retry succeeds, so a strip that did not cure never poisons
   * later turns.
   *
   * It expires because "the strip cured it" is not proof the model is
   * blind. A 400 whose text merely CONTAINS the word image trips
   * MODALITY_REJECT_PATTERN, and removing the picture cures that too —
   * DashScope's documented sub-10px complaint is exactly this shape, and
   * image_view can produce a sub-10px view since it never upscales. Left
   * permanent, one such 400 would blind a fully-capable model for the rest
   * of the session, silently. Expiring re-probes with images every
   * MODALITY_MEMO_REQUESTS requests: a genuinely text-only-in-tool-results
   * provider costs one extra retry per cycle, while a false positive heals
   * itself instead of degrading every answer until relaunch.
   */
  private toolResultModalityRejects = new Map<
    string,
    { scope: VisualStripScope; remaining: number }
  >()

  constructor(options: ThalamusOptions = {}) {
    this.corpus = options.corpus ?? null
    this.testProvider = options.testProvider ?? null
  }

  setCorpus(corpus: Corpus): void {
    this.corpus = corpus
  }

  /**
   * Set the selected model. Null clears it (nothing selected yet). The
   * catalog and policy live at the org API; this is just the choice.
   */
  setModel(model: string | null): void {
    this.model = model
  }

  /** The lane that would handle the next turn; null when nothing selected. */
  getActiveProvider(): ProviderId | null {
    return this.resolveEntry()?.id ?? null
  }

  /** Model name for the next turn. Null when nothing is selected. */
  getActiveModel(): string | null {
    return this.resolveEntry()?.model ?? null
  }

  /**
   * Per-entry multimodal gate. Vision blocks can reach a text-only entry
   * via replayed history or tool-result screenshots — and text-only APIs
   * reject the whole request with HTTP 400 when they see an image part
   * (DeepSeek: `unknown variant image_url, expected text`). Strip rather
   * than fail: the model gets a note about what was removed instead.
   */
  private async guardVisualContent(
    entry: CascadeEntry,
    options: ProviderStreamOptions
  ): Promise<ProviderStreamOptions> {
    if (!hasVisualContent(options.messages)) return options
    // Long screen-control sessions accumulate dozens of near-identical
    // screenshots; models mis-ground clicks on stale frames and the images
    // dominate cost. Keep only the newest few (batched, cache-friendly).
    const limited = limitToolResultImages(options.messages)
    if (limited !== options.messages) options = { ...options, messages: limited }
    const vision = cloudModelSupportsVision(entry.id, entry.model)
    if (!vision) {
      return { ...options, messages: stripVisualContent(options.messages) }
    }
    const memoKey = `${entry.id}:${entry.model}`
    const memo = this.toolResultModalityRejects.get(memoKey)
    if (memo) {
      // Spend one use, then let the next request probe with images again.
      memo.remaining -= 1
      if (memo.remaining <= 0) this.toolResultModalityRejects.delete(memoKey)
      const memoScope = memo.scope
      const reason =
        memoScope === 'tool' ? TOOL_RESULT_MODALITY_STRIP_REASON : REQUEST_MODALITY_STRIP_REASON
      return {
        ...options,
        messages: stripVisualContent(options.messages, reason, memoScope)
      }
    }
    return options
  }

  /**
   * Context-window size (input tokens) for the model that would handle the
   * next turn — i.e. the resolved active model. Returns a conservative
   * 8 000 when nothing is selected/ready.
   */
  getActiveContextWindow(): number {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    return this.windowForEntry(entry)
  }

  /**
   * Async sibling of {@link getActiveContextWindow}, kept for the
   * model:capabilities IPC. Cloud models resolve synchronously today; the
   * API integration phase can make this consult the org catalog.
   */
  async resolveActiveContextWindow(): Promise<number> {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    return this.windowForEntry(entry)
  }

  /**
   * Token budget for context assembly. Subtracts the model's output ceiling
   * from the context window so the combined input+max_tokens never exceeds
   * the model's limit. For Anthropic (separate input/output budgets) the
   * deduction is zero.
   */
  getContextBudget(): number {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    const window = this.windowForEntry(entry)
    const outputReserve = maxOutputForModel(entry.model)
    return Math.max(window - outputReserve, Math.floor(window * 0.5))
  }

  /**
   * Context window for an explicit per-agent model choice, falling back to
   * the active model when null. Workflow subagents on overridden models must
   * be budgeted against THEIR window, not the Brain's — an 8k-window agent
   * budgeted as a 200k brain overflows with a 400 instead of compacting.
   */
  getContextWindowFor(sel: { provider: ProviderId; model: string } | null): number {
    if (!sel) return this.getActiveContextWindow()
    return contextWindowForModel(sel.model)
  }

  /** Budget sibling of {@link getContextWindowFor} — window minus output reserve. */
  getContextBudgetFor(sel: { provider: ProviderId; model: string } | null): number {
    if (!sel) return this.getContextBudget()
    const window = contextWindowForModel(sel.model)
    const outputReserve = maxOutputForModel(sel.model)
    return Math.max(window - outputReserve, Math.floor(window * 0.5))
  }

  /**
   * Spawn-time validation for a master-supplied model choice. There is one
   * lane and the org's router is the authority on which model ids are
   * allowed, so every choice is streamable from here — a disallowed id
   * surfaces as that agent's deterministic API refusal.
   */
  validateModelChoice(_sel: { provider: ProviderId; model: string }): string | null {
    void _sel
    return null
  }

  /** Context window for a resolved entry, mapped by model name. */
  private windowForEntry(entry: CascadeEntry): number {
    return contextWindowForModel(entry.model)
  }

  /**
   * Raw LLM call for conversation-level summarization during compaction.
   * Takes a complete prompt (no hardcoded instruction)
   * and uses 5 retries with escalating backoff for resilience.
   *
   * If the prompt exceeds the model's context window, it is split into parts,
   * each summarized separately, and the results merged.
   */
  async summarize(
    prompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const promptTokens = Math.ceil(prompt.length / 4)

    const entry = this.resolveEntry()
    if (!entry) throw new Error('No summarization provider available')

    const modelWindow = contextWindowForModel(entry.model)
    const maxOutput = maxOutputForModel(entry.model)
    const available = modelWindow - maxOutput

    if (promptTokens <= available) {
      const result = await this.completeSingle(entry, '', prompt, 'summary', signal)
      if (result) return result
      throw new Error('Summarization provider failed')
    }

    const charsPerPart = Math.max(available * 4 - 500, 4000)
    const parts: string[] = []
    for (let i = 0; i < prompt.length; i += charsPerPart) {
      parts.push(prompt.slice(i, i + charsPerPart))
    }

    const summaries = await Promise.all(
      parts.map((part) => this.completeSingle(entry, '', part, 'summary', signal))
    )
    const valid = summaries.filter(Boolean) as {
      text: string
      provider: string
      model: string
    }[]
    if (valid.length === parts.length) {
      return {
        text: valid.map((s) => s.text).join('\n\n'),
        provider: valid[0].provider,
        model: valid[0].model
      }
    }
    throw new Error('Summarization provider failed')
  }

  /**
   * Title a conversation. This is a dedicated TITLING call — NOT a summarize:
   * the caller's titling instructions ride in the SYSTEM prompt and the user's
   * message is the user turn, so the model is asked to name the conversation
   * rather than compress it. Shares completeSingle's 5× retry so titling is as
   * resilient as everything else; throws only if every attempt fails (the
   * titler treats that as unreachable and falls back to a plain slice).
   */
  async title(
    userMessage: string,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const entry = this.resolveEntry()
    if (!entry) throw new Error('No titling provider available')
    const result = await this.completeSingle(entry, systemPrompt, userMessage, 'title', signal)
    if (result) return result
    throw new Error('Titling provider failed')
  }

  /**
   * One-shot analysis call for the diagnostic export: a system prompt plus the
   * conversation material as the user turn, exactly like {@link title}. No
   * tools, no streaming, no conversation created — the model only writes its
   * opinion of what went wrong, and the caller drops that text into the
   * diagnostic archive.
   *
   * Tagged role:'summary' rather than a role of its own, deliberately: this is
   * the same utility side-call family as summarization (Brain, reasoning off,
   * off every conversation's context meter), and a fourth role would have to
   * be threaded through the corpus event, the ledger and the meter's
   * side-spend split to buy nothing a reader of the ledger needs.
   */
  async diagnose(
    material: string,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const entry = this.resolveEntry()
    if (!entry) throw new Error('No diagnostic provider available')
    const result = await this.completeSingle(entry, systemPrompt, material, 'summary', signal)
    if (result) return result
    throw new Error('Diagnostic provider failed')
  }

  /**
   * The reasoning modes THIS entry's model actually honours — the same source
   * of truth the Brain button reads. Providers assume `thinkingMode` arrives
   * already clamped to this list (see xai.ts's grok-4.5 branch), so every
   * caller that synthesizes a mode rather than passing the user's own must
   * run it through here first.
   */
  private reasoningModesForEntry(entry: CascadeEntry): ThinkingMode[] {
    return reasoningModesFor(entry.id, entry.model)
  }

  /**
   * Single non-streaming completion with 5 retries and escalating backoff
   * (1s, 2s, 4s, 8s, 16s). `system` may be '' (plain summarize during
   * compaction) or a task prompt (titling). `role` tags the emitted spend so
   * the ledger itemizes titling distinctly from summarization — a title is not
   * a summary — while both stay OFF a conversation's context meter (overhead).
   */
  private async completeSingle(
    entry: CascadeEntry,
    system: string,
    prompt: string,
    role: 'summary' | 'title',
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string } | null> {
    const msgs: ChatMessage[] = [{ role: 'user', content: prompt }]
    const delays = [1000, 2000, 4000, 8000, 16000]

    // Titling and summarizing are utility side-calls on the configured Brain,
    // not judgement calls: reasoning buys nothing and costs everything. This
    // path never goes through stream()'s normalization, so an undefined
    // thinkingMode used to hit effortFromMode()'s 'high' default — every
    // title was a high-effort reasoning call (measured: p50 11.4s, p90 22.2s,
    // ~30% over the caller's 15s deadline, which then expired and left the
    // conversation permanently 'Untitled'), and compaction summaries paid the
    // same tax. Both roles now run with reasoning OFF — quick, cheap, and
    // independent of the user's per-model reasoning selection — clamped
    // through the same registry stream() uses, because providers assume a
    // normalized mode: an always-on reasoner (grok-4.5, qwq, k2-code) rejects
    // a raw 'off' and gets its lowest valid mode instead.
    const stream: ProviderStreamOptions = {
      system,
      messages: msgs,
      signal,
      model: entry.model,
      thinkingMode: normalizeReasoningMode('off', this.reasoningModesForEntry(entry))
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) return null
      const startedAt = Date.now()
      try {
        let text = ''
        let usage: StreamUsage | null = null
        for await (const chunk of entry.provider.stream(stream)) {
          if (chunk.type === 'text') text += chunk.text
          else if (chunk.type === 'turn_meta' && chunk.usage) usage = chunk.usage
        }
        if (text.length > 0) {
          // Side-call spend is real billed tokens. Emit it tagged with this
          // call's own `role` ('summary' or 'title') so the ledger listener
          // records it and the renderer can itemize it as overhead — without
          // it feeding the context meter (naming or compressing a conversation
          // is not conversation context). Cost rides along so the renderer's
          // all-time totals stay cost-complete for this spend too.
          if (usage) {
            this.emit('llm.response', {
              provider: entry.id,
              model: entry.model,
              role,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheCreationTokens: usage.cacheCreationTokens ?? 0,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              durationMs: Date.now() - startedAt,
              cost: calculateCost(
                entry.id,
                entry.model,
                usage.inputTokens,
                usage.outputTokens,
                usage.cacheCreationTokens,
                usage.cacheReadTokens
              )
            })
          }
          return { text, provider: entry.id, model: entry.model }
        }
        // Completed, but said nothing. Nothing threw, so the catch below never
        // runs and the emit above is inside the truthy branch — this attempt
        // would otherwise leave no trace at all, which is the same blind spot
        // the catch exists to close. It is also the expected shape of
        // "reasoning crowded out the answer", the failure thinkingMode:'off'
        // targets, so it is exactly what we want to be able to see.
        this.emit('llm.error', {
          provider: entry.id,
          error: `${role} ${entry.model} (attempt ${attempt + 1}/5): empty completion`
        })
      } catch (err) {
        // Titling/summarizing calls entry.provider.stream() directly, so it
        // bypasses streamOnce() where the llm.error emits live — and the usage
        // emit above only fires on SUCCESS. A failed or timed-out title was
        // therefore invisible everywhere: no corpus event, no ledger row, and
        // titleFromMessage swallows the throw. The literal 'Untitled' on disk
        // was the only tell, which is how this bug survived nine days — and now
        // that a deadline degrades to a readable slice, there'd be no tell at
        // all. Emit so a silently-degrading title stays measurable.
        //
        // Safe to emit: llm.error has no UI consumer and is NOT in
        // TURN_RELAYED_EVENTS, so it lands in the corpus log and nowhere else —
        // a titling hiccup must never surface as an error in the user's chat.
        // Deliberately does NOT markFailed(): one slow title is not evidence
        // the provider is unhealthy for the turn that's about to run.
        // The abort REASON rides along so the log separates a titling deadline
        // (a degradation worth counting) from a user pressing stop (expected
        // noise) — they unwind identically otherwise. Read off the signal
        // rather than importing the titler's constant, which would point this
        // module at the app layer.
        const why = signal?.aborted ? `, aborted: ${String(signal.reason)}` : ''
        this.emit('llm.error', {
          provider: entry.id,
          error: `${role} ${entry.model} (attempt ${attempt + 1}/5${why}): ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        if (attempt >= 4) return null
        await sleep(delays[attempt], signal)
      }
    }
    return null
  }

  /**
   * Stream a turn through the resolved active model.
   *
   * The selected cloud model (the Brain) gets a retry budget
   * (`RETRY_DELAYS_MS`) for transient failures (overloaded, rate-limited,
   * gateway errors); hard failures (auth, not-found) fail the turn
   * immediately. There is no cascade and no automatic substitution — the
   * chosen model runs, or the turn fails honestly. When the model is
   * permanently unavailable thalamus yields a single
   * `no_provider_available` chunk so the renderer can surface a structured
   * retry card. When nothing is selected (no Brain and not in local-only
   * mode, or no local model loaded) it yields a plain `error` chunk. The
   * local model never gets the retry budget. Once any text has streamed the
   * choice is committed — failures past that point surface as a committed
   * error rather than retrying.
   */
  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const entry = options.modelOverride
      ? this.resolveOverride(options.modelOverride)
      : this.resolveEntry()
    if (!entry) {
      const message = 'no model selected — choose a model in the chat composer'
      this.emit('llm.error', { provider: 'none', error: message })
      yield { type: 'error', message, recoverable: false }
      return
    }

    // Announce who's handling this turn so the renderer can show a chip.
    yield { type: 'active_model', provider: entry.id, model: entry.model }

    // Agent effort is chosen by the master, which can't know each agent
    // model's reasoning support (it differs widely: none / always-on / graded).
    // Clamp it to what THIS model actually offers — same source of truth as the
    // Brain button — so an unsupported pick degrades gracefully (max→high→on; a
    // non-reasoning model → off) instead of being sent verbatim and erroring.
    let opts = options
    if (options.role === 'agent') {
      const modes = this.reasoningModesForEntry(entry)
      opts = { ...options, thinkingMode: normalizeReasoningMode(options.thinkingMode, modes) }
    } else if (options.role === 'summary') {
      // Summarization side-calls that stream (the nightly memory compaction
      // job) mirror completeSingle's policy: reasoning OFF, on the configured
      // Brain, never the user's chat reasoning selection — utility work
      // should be quick and cheap. Normalized so an always-on reasoner
      // degrades to its lowest valid mode instead of erroring on a raw 'off'.
      const modes = this.reasoningModesForEntry(entry)
      opts = { ...options, thinkingMode: normalizeReasoningMode('off', modes) }
    }

    // Same-model retry: the selected model (master / single) gets the
    // transient retry budget. AGENTS do NOT — an agent is single-shot and any
    // failure surfaces immediately to the master, which owns all agent retry
    // decisions end-to-end (re-run, re-scope, or report).
    const retry = options.role !== 'agent'
    const result = yield* this.streamOnce(entry, opts, { retry })
    if (result.kind === 'success') return
    if (result.kind === 'committed-error') {
      const failures = result.failure ? [toInfo(result.failure)] : undefined
      yield { type: 'error', message: result.message, recoverable: false, failures }
      return
    }
    // kind === 'failed' — the one selected model is permanently unavailable.
    yield { type: 'no_provider_available', failures: [toInfo(result.failure)] }
  }

  private async *streamOnce(
    entry: CascadeEntry,
    options: ProviderStreamOptions,
    cfg: { retry: boolean }
  ): AsyncGenerator<
    StreamChunk,
    | { kind: 'success' }
    | { kind: 'committed-error'; message: string; failure?: ProviderFailure }
    | { kind: 'failed'; failure: ProviderFailure }
  > {
    let guarded = await this.guardVisualContent(entry, shapeOutbound(options))
    guarded = { ...guarded, model: entry.model }
    const overallStartedAt = Date.now()
    let attempt = 0
    let lastFailure: ProviderFailure | null = null
    let modalityStage: 0 | 1 | 2 = 0

    while (true) {
      if (options.signal?.aborted) {
        return {
          kind: 'failed',
          failure: lastFailure ?? {
            provider: entry.id,
            statusCode: null,
            errorClass: 'unknown',
            reasonKey: 'unavailable',
            rawMessage: null,
            retries: attempt,
            durationMs: Date.now() - overallStartedAt
          }
        }
      }

      // Offline halts the retries early — the only lane is a network lane.
      if (!net.isOnline()) {
        return {
          kind: 'failed',
          failure: {
            provider: entry.id,
            statusCode: null,
            errorClass: 'offline',
            reasonKey: 'offline',
            rawMessage: null,
            retries: attempt,
            durationMs: Date.now() - overallStartedAt
          }
        }
      }

      this.emit('llm.request', { provider: entry.id, model: entry.model })

      const startedAt = Date.now()
      let textEmitted = false
      let inputTokens = 0
      let outputTokens = 0
      let cacheCreationTokens = 0
      let cacheReadTokens = 0

      try {
        for await (const chunk of entry.provider.stream(guarded)) {
          if (chunk.type === 'text') {
            textEmitted = true
          } else if (chunk.type === 'turn_meta') {
            if (chunk.usage) {
              inputTokens = chunk.usage.inputTokens
              outputTokens = chunk.usage.outputTokens
              cacheCreationTokens = chunk.usage.cacheCreationTokens ?? 0
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0
            }
            // Stamp the entry that actually served this call so the agent
            // can pin the next iteration to it (active_model only names
            // the cascade head, which may not be who answered).
            yield { ...chunk, provider: entry.id, model: entry.model }
            continue
          }
          yield chunk
        }

        this.markHealthy(entry.id)
        if (modalityStage === 1 || modalityStage === 2) {
          this.toolResultModalityRejects.set(`${entry.id}:${entry.model}`, {
            scope: modalityStage === 1 ? 'tool' : 'all',
            remaining: MODALITY_MEMO_REQUESTS
          })
        }
        const durationMs = Date.now() - startedAt
        this.emit('llm.response', {
          provider: entry.id,
          model: entry.model,
          // Subagent calls keep the 'worker' wire value — renderer meter
          // routing and persisted stats predate the workflow rename.
          role:
            options.role === 'agent' ? 'worker' : options.role === 'summary' ? 'summary' : 'brain',
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          durationMs
        })
        return { kind: 'success' }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.markFailed(entry.id)
        this.emit('llm.error', { provider: entry.id, error: message })

        if (textEmitted) {
          // Provider had already streamed bytes to the user — committing
          // to a different provider mid-turn would be incoherent.
          const classified = classifyError(err)
          return {
            kind: 'committed-error',
            message,
            failure: {
              provider: entry.id,
              statusCode: classified.statusCode,
              errorClass: classified.errorClass,
              reasonKey: reasonKeyFor(classified.statusCode, message),
              rawMessage: extractProviderDetail(message) ?? message,
              retries: attempt,
              durationMs: Date.now() - overallStartedAt
            }
          }
        }
        if (isAbortError(err)) {
          return { kind: 'committed-error', message }
        }

        const classified = classifyError(err)
        lastFailure = {
          provider: entry.id,
          statusCode: classified.statusCode,
          errorClass: classified.errorClass,
          reasonKey: reasonKeyFor(classified.statusCode, message),
          rawMessage: extractProviderDetail(message) ?? message,
          retries: attempt,
          durationMs: Date.now() - overallStartedAt
        }

        // Two-stage modality ladder. Stage 1 strips only tool-result
        // images (user attachments stay). Stage 2 strips everything.
        // Bound: initial + two retries, then failed. Memo is written
        // on success, not here — a strip that didn't cure must not
        // poison the session.
        const status = classified.statusCode
        const modalityHit =
          (status === 400 || status === 422) &&
          isModalityReject(message) &&
          hasVisualContent(guarded.messages)
        if (modalityHit && modalityStage === 0) {
          modalityStage = 1
          const detail = extractProviderDetail(message) ?? message
          console.log(
            `[thalamus] modality reject on ${entry.id}/${entry.model} — retrying without tool-result images: ${detail}`
          )
          guarded = {
            ...guarded,
            messages: stripVisualContent(
              guarded.messages,
              TOOL_RESULT_MODALITY_STRIP_REASON,
              'tool'
            )
          }
          continue
        }
        // Stage 2 is forward-compat and unreachable today: it needs a user
        // image/document block to still be present after stage 1 stripped the
        // tool images, and nothing in the app produces one — every attachment
        // becomes a text reference note (uploads/file-processor.ts), so the
        // only visual content that ever exists is a tool result. It stays
        // because anthropic.ts already decodes native image/document blocks,
        // so the day user blocks are produced this arms itself. Kept rather
        // than deleted; the test covering it builds a synthetic user block.
        if (modalityHit && modalityStage === 1) {
          modalityStage = 2
          const detail = extractProviderDetail(message) ?? message
          console.log(
            `[thalamus] modality reject on ${entry.id}/${entry.model} after tool-only strip — retrying without any images: ${detail}`
          )
          guarded = {
            ...guarded,
            messages: stripVisualContent(guarded.messages, REQUEST_MODALITY_STRIP_REASON, 'all')
          }
          continue
        }

        // Hard errors aren't worth retrying on the same provider.
        if (classified.errorClass === 'hard' || !cfg.retry) {
          return { kind: 'failed', failure: lastFailure }
        }

        // Transient: back off and try again on the same provider.
        if (attempt >= RETRY_DELAYS_MS.length) {
          return { kind: 'failed', failure: lastFailure }
        }
        const delay = RETRY_DELAYS_MS[attempt]
        attempt += 1
        this.emit('llm.retry', {
          provider: entry.id,
          attempt,
          delayMs: delay,
          errorClass: classified.errorClass
        })
        const slept = await sleep(delay, options.signal)
        if (!slept) {
          return {
            kind: 'failed',
            failure: {
              ...lastFailure,
              retries: attempt,
              durationMs: Date.now() - overallStartedAt
            }
          }
        }
      }
    }
  }

  /**
   * Snapshot of health for the resolved active model, for diagnostics.
   */
  getHealth(): ProviderHealth[] {
    const entry = this.resolveEntry()
    if (!entry) return []
    const state = this.health.get(entry.id)
    return [
      state ?? {
        id: entry.id,
        healthy: true,
        failCount: 0,
        cooldownUntil: 0
      }
    ]
  }

  /**
   * The resolution seam — the ONE place that answers "which model handles
   * this request". Null when nothing is selected yet. Swapping the
   * resolution policy means swapping only this method body — callers never
   * change.
   */
  private resolveEntry(): CascadeEntry | null {
    if (!this.model) return null
    return { id: 'cloud', model: this.model, provider: this.testProvider ?? this.cloud }
  }

  /**
   * Resolve an explicit per-agent model choice (workflow mode). Same lane,
   * different model id — the org's router decides whether it's allowed.
   */
  private resolveOverride(sel: { provider: ProviderId; model: string }): CascadeEntry | null {
    return { id: 'cloud', model: sel.model, provider: this.testProvider ?? this.cloud }
  }

  private markHealthy(id: ProviderId): void {
    this.health.set(id, { id, healthy: true, failCount: 0, cooldownUntil: 0 })
  }

  private markFailed(id: ProviderId): void {
    const prev = this.health.get(id)
    const failCount = (prev?.failCount ?? 0) + 1
    const stepIdx = Math.min(failCount - 1, COOLDOWN_STEPS_MS.length - 1)
    const cooldown = COOLDOWN_STEPS_MS[stepIdx]
    this.health.set(id, {
      id,
      healthy: false,
      failCount,
      cooldownUntil: Date.now() + cooldown
    })
  }

  private emit<K extends 'llm.request' | 'llm.response' | 'llm.error' | 'llm.retry'>(
    event: K,
    payload: K extends 'llm.request'
      ? { provider: string; model: string }
      : K extends 'llm.response'
        ? {
            provider: string
            model: string
            role: 'brain' | 'worker' | 'summary' | 'title'
            inputTokens: number
            outputTokens: number
            cacheCreationTokens: number
            cacheReadTokens: number
            durationMs: number
            cost?: number
          }
        : K extends 'llm.error'
          ? { provider: string; error: string }
          : { provider: string; attempt: number; delayMs: number; errorClass: string }
  ): void {
    if (!this.corpus) return
    if (event === 'llm.request') {
      this.corpus.emit('llm.request', payload as { provider: string; model: string })
    } else if (event === 'llm.response') {
      this.corpus.emit(
        'llm.response',
        payload as {
          provider: string
          model: string
          role: 'brain' | 'worker' | 'summary' | 'title'
          inputTokens: number
          outputTokens: number
          cacheCreationTokens: number
          cacheReadTokens: number
          durationMs: number
          cost?: number
        }
      )
    } else if (event === 'llm.error') {
      this.corpus.emit('llm.error', payload as { provider: string; error: string })
    } else {
      this.corpus.emit(
        'llm.retry',
        payload as { provider: string; attempt: number; delayMs: number; errorClass: string }
      )
    }
  }
}

/** Map an internal provider failure to the renderer-facing error card shape. */
function toInfo(f: ProviderFailure): NoProviderAvailableInfo {
  return {
    provider: f.provider,
    providerLogo: PROVIDER_LOGO[f.provider],
    statusCode: f.statusCode,
    errorReason: f.reasonKey,
    errorDetail: f.rawMessage,
    retriesAttempted: f.retries,
    totalDurationMs: f.durationMs
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'AbortError'
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529])
// 413 (payload too large) is hard: retrying re-uploads the same oversized
// body through the whole backoff ladder — minutes of silent hang for a
// request that can never succeed. Same for 422 (unprocessable payload).
const HARD_STATUSES = new Set([400, 401, 403, 404, 413, 422])

function classifyError(err: unknown): { statusCode: number | null; errorClass: ErrorClass } {
  const message = err instanceof Error ? err.message : String(err)
  const status = parseHttpStatus(message)
  if (status !== null) {
    if (TRANSIENT_STATUSES.has(status)) return { statusCode: status, errorClass: 'transient' }
    if (HARD_STATUSES.has(status)) return { statusCode: status, errorClass: 'hard' }
    return { statusCode: status, errorClass: 'unknown' }
  }
  // Fetch-level network errors look like TypeError or AbortError; the
  // ECONNRESET / ETIMEDOUT family also surfaces as transient.
  if (/overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|timeout/i.test(message)) {
    return { statusCode: null, errorClass: 'transient' }
  }
  return { statusCode: null, errorClass: 'unknown' }
}

function parseHttpStatus(message: string): number | null {
  const match = /HTTP\s+(\d{3})/.exec(message)
  return match ? Number(match[1]) : null
}

function reasonKeyFor(statusCode: number | null, rawMessage?: string): string {
  if (statusCode !== null && STATUS_REASON_LABEL[statusCode]) {
    return STATUS_REASON_LABEL[statusCode]
  }
  if (rawMessage && /timeout/i.test(rawMessage)) {
    return 'timeout'
  }
  return 'unavailable'
}

function extractProviderDetail(raw: string): string | null {
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) return null
  try {
    const parsed = JSON.parse(raw.slice(jsonStart))
    const msg = parsed?.error?.message ?? parsed?.message
    return typeof msg === 'string' ? msg : null
  } catch {
    return null
  }
}

/**
 * Context window (input tokens) by model name. PLACEHOLDER heuristics for
 * the DeepSeek lane the org serves today — the API integration phase should
 * serve authoritative per-model metadata alongside the catalog and replace
 * this local table.
 */
export function contextWindowForModel(model: string): number {
  // The org catalog is authoritative when it has landed; name heuristics
  // cover the cold start before the first /v1/models fetch.
  const fromCatalog = catalogContextWindow(model)
  if (fromCatalog !== null) return fromCatalog
  const m = model.toLowerCase()
  if (m.includes('deepseek-v4')) return 1_000_000
  if (m.includes('deepseek')) return 128_000
  return 128_000
}

/**
 * Max output tokens the provider requests for a model. Reserved out of the
 * context budget. Same placeholder posture as contextWindowForModel.
 */
function maxOutputForModel(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('deepseek-v4')) return 65_536
  if (m.includes('deepseek')) return 32_768
  return 32_768
}

/**
 * Rough token estimate for a messages array. Uses the same 1-token ≈ 4-chars
 * heuristic as RAS.estimateTokens(). Accounts for all text content in
 * user, assistant, tool, and system messages plus base64 image payloads
 * (≈0.75 bytes per token after base64 overhead).
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        chars += m.content.length
        break
      case 'user':
        if (typeof m.content === 'string') {
          chars += m.content.length
        } else {
          for (const block of m.content) {
            if (block.type === 'text') chars += block.text.length
            else if (block.type === 'image') chars += estimateImageTokens(block) * 4
            else if (block.type === 'document') chars += block.data.length * 0.75
          }
        }
        break
      case 'assistant':
        chars += m.content.length
        if (m.reasoningContent) chars += m.reasoningContent.length
        if (m.toolUses) {
          for (const tu of m.toolUses) {
            chars += tu.name.length + JSON.stringify(tu.args).length
          }
        }
        break
      case 'tool':
        chars += m.content.length
        if (m.images) {
          for (const img of selectInlineImages(m.images, m.toolName).inline)
            chars += estimateImageTokens(img) * 4
        }
        break
    }
  }
  return Math.ceil(chars / 4)
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
