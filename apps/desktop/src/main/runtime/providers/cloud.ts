/**
 * The one provider — the Wolffish Cloud org API.
 *
 * Streams POST {org}/ai/v1/chat/completions: an OpenAI-compatible SSE
 * endpoint authenticated by the device's session access token (never an
 * API key). Model choice, allowlists and quotas are enforced server-side;
 * this class only speaks the wire shape — message conversion in,
 * text/reasoning/tool_call/turn_meta chunks out.
 *
 * Auth arrives via connectCloudProvider() at app startup (a seam, so the
 * runtime's import graph never touches electron and tests can inject a
 * bare token source). Errors throw as `HTTP <status>: …` messages, which
 * is exactly what thalamus's classifyError parses.
 */
import { effortFromMode, reasoningModesFor } from '@main/runtime/reasoning'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition
} from '@main/runtime/thalamus'

type CloudAuth = {
  apiBase: string
  getToken: () => Promise<string>
}

let auth: CloudAuth | null = null

export function connectCloudProvider(next: CloudAuth): void {
  auth = next
}

// ── Wire conversion (pure, unit-tested) ──────────────────────────────────

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<Record<string, unknown>> }
  | {
      role: 'assistant'
      content: string | null
      tool_calls: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export function toOpenAIMessages(system: string, messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content })
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
      } else {
        const parts = m.content.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text }
          if (b.type === 'image') {
            return {
              type: 'image_url',
              image_url: { url: `data:${b.mediaType};base64,${b.data}` }
            }
          }
          // PDF blocks have no OpenAI-wire equivalent on this lane; the
          // visual guard strips them for text-only models before we run,
          // so this is a defensive degrade, not the normal path.
          return { type: 'text', text: '[attached document omitted on this model]' }
        })
        out.push({ role: 'user', content: parts })
      }
    } else if (m.role === 'assistant') {
      if (m.toolUses && m.toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content.length > 0 ? m.content : null,
          tool_calls: m.toolUses.map((u) => ({
            id: u.id,
            type: 'function',
            function: { name: u.name, arguments: JSON.stringify(u.args ?? {}) }
          }))
        })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
    } else {
      // Tool result. OpenAI's tool role is text-only — images inside tool
      // results are handled upstream by the visual guard; anything left
      // degrades to its textual content.
      out.push({ role: 'tool', tool_call_id: m.toolUseId, content: m.content })
    }
  }
  return out
}

export function toOpenAITools(
  tools: ToolDefinition[]
): Array<{ type: 'function'; function: Record<string, unknown> }> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/**
 * The `reasoning_effort` value for THIS request, or null when the model
 * takes none (unknown models must not receive the parameter — DeepInfra
 * validates the enum and a rejected request kills the whole turn).
 *
 * Both directions are explicit on purpose: the V4 line does not reason
 * when the parameter is absent (verified live 2026-09-01), so 'off' sends
 * 'none' for determinism and anything else must actually ask. The mode
 * arrives normalized by thalamus against reasoningModesFor('cloud', …),
 * so off/high/max are the only values seen here in practice.
 */
export function reasoningEffortFor(
  model: string,
  thinkingMode: string | undefined
): 'none' | 'high' | 'max' | null {
  if (reasoningModesFor('cloud', model).length === 0) return null
  const effort = effortFromMode(thinkingMode)
  return effort === 'off' ? 'none' : effort
}

/**
 * The API's own advice on when to try again: a Retry-After header (seconds)
 * or a retry_after_ms field in the JSON body. The org gate sends one when
 * every host is resting; honoring it beats a blind ladder.
 */
export function retryAfterMs(header: string | null, bodyText: string): number | undefined {
  const secs = Number(header)
  if (header && Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  try {
    const j = JSON.parse(bodyText) as { retry_after_ms?: unknown }
    if (typeof j?.retry_after_ms === 'number' && j.retry_after_ms >= 0) {
      return Math.round(j.retry_after_ms)
    }
  } catch {
    // not JSON — no hint
  }
  return undefined
}

export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'unknown'
  }
}

/**
 * Accumulates streamed tool_call fragments (OpenAI indexes them) into
 * complete calls. Arguments arrive as JSON string fragments.
 */
export class ToolCallAssembler {
  private calls = new Map<number, { id: string; name: string; args: string }>()

  add(fragment: {
    index?: number
    id?: string | null
    function?: { name?: string | null; arguments?: string | null }
  }): void {
    const index = fragment.index ?? 0
    const cur = this.calls.get(index) ?? { id: '', name: '', args: '' }
    if (fragment.id) cur.id = fragment.id
    if (fragment.function?.name) cur.name += fragment.function.name
    if (fragment.function?.arguments) cur.args += fragment.function.arguments
    this.calls.set(index, cur)
  }

  complete(): Array<{ id: string; name: string; args: Record<string, unknown> }> {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        let args: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(c.args || '{}')
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        } catch {
          // Malformed argument JSON still surfaces the call — the engine's
          // tool layer reports bad args back to the model, which self-heals
          // far better than a dropped call.
          args = { __raw: c.args }
        }
        return { id: c.id || `call_${index}`, name: c.name, args }
      })
  }

  get size(): number {
    return this.calls.size
  }
}

type SseDelta = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

export class CloudProvider {
  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    if (!auth) {
      yield {
        type: 'error',
        message: 'Wolffish Cloud is not connected — sign in to use models.',
        recoverable: false
      }
      return
    }
    const model = options.model
    if (!model) {
      yield {
        type: 'error',
        message: 'no model resolved for this call',
        recoverable: false
      }
      return
    }

    const token = await auth.getToken()
    const body: Record<string, unknown> = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(options.system, options.messages)
    }
    const effort = reasoningEffortFor(model, options.thinkingMode)
    if (effort) body.reasoning_effort = effort
    if (options.tools && options.tools.length > 0) {
      body.tools = toOpenAITools(options.tools)
      body.tool_choice = 'auto'
    }
    if (options.cacheKey) body.prompt_cache_key = options.cacheKey

    const res = await fetch(`${auth.apiBase}/ai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        // Surface attribution for the org's usage ledger. Absent (or
        // unrecognised) is recorded as unattributed, never refused.
        ...(options.surface ? { 'x-wfc-surface': options.surface } : {})
      },
      body: JSON.stringify(body),
      signal: options.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`) as Error & {
        retryAfterMs?: number
      }
      const hinted = retryAfterMs(res.headers.get('retry-after'), text)
      if (hinted !== undefined) err.retryAfterMs = hinted
      throw err
    }

    const assembler = new ToolCallAssembler()
    let stopReason: StopReason = 'unknown'
    let usage: SseDelta['usage'] = null

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are newline-delimited; a chunk may split an event.
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          let parsed: SseDelta
          try {
            parsed = JSON.parse(payload) as SseDelta
          } catch {
            continue
          }
          if (parsed.usage) usage = parsed.usage
          const choice = parsed.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason)
          const delta = choice.delta
          if (!delta) continue
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (reasoning) yield { type: 'reasoning', text: reasoning }
          if (delta.content) yield { type: 'text', text: delta.content }
          if (delta.tool_calls) for (const frag of delta.tool_calls) assembler.add(frag)
        }
      }
    } finally {
      reader.releaseLock()
    }

    for (const call of assembler.complete()) {
      yield { type: 'tool_call', id: call.id, name: call.name, args: call.args }
    }
    if (assembler.size > 0 && stopReason === 'unknown') stopReason = 'tool_use'

    yield {
      type: 'turn_meta',
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0
      }
    }
  }
}
