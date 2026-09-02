/**
 * Model metadata: display names, reasoning flags, and prices.
 *
 * The org lane is the frontier DeepSeek V4 pair, pinned to DeepInfra's
 * dated official-release ids and verified live 2026-09-01 through the
 * router: ids complete, `reasoning_effort` honoured (enum none|minimal|
 * low|medium|high|xhigh|max — 'none' produces zero reasoning), image
 * input rejected by both ("does not accept image input"), and prices
 * matching upstream's own `usage.estimated_cost` to the microdollar.
 *
 * Prices are microUSD per 1M tokens (in/out/cached-in) and are config, not truth —
 * unknown models meter at 0 cost but exact token counts, and upstream's
 * reported cost wins whenever it is present.
 */

export type ModelMeta = {
  id: string
  name: string
  reasoning: boolean
  /** Text-only lane today; vision models flip this when provisioned. */
  vision: boolean
  /** Input-token context window the client budgets against. */
  contextWindow: number
  inPerM: number // microUSD per 1M input tokens
  outPerM: number // microUSD per 1M output tokens
  /** microUSD per 1M prompt tokens served from the host's prefix cache. */
  cachedInPerM: number
}

const KNOWN: ModelMeta[] = [
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    vision: false,
    contextWindow: 1_048_576,
    inPerM: 80_000,
    outPerM: 180_000,
    cachedInPerM: 16_000
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    vision: false,
    contextWindow: 1_048_576,
    inPerM: 1_300_000,
    outPerM: 2_600_000,
    cachedInPerM: 100_000
  }
]

export function modelMeta(id: string): ModelMeta {
  return (
    KNOWN.find((m) => m.id === id) ?? {
      id,
      name: id.split('/').pop() ?? id,
      reasoning: /deepseek-v4|r1|reasoner|thinking/i.test(id),
      vision: /vl|vision|4v|gemini|gpt-4o|omni/i.test(id),
      contextWindow: 131_072,
      inPerM: 0,
      outPerM: 0,
      cachedInPerM: 0
    }
  )
}

/**
 * Fallback price when the host reports no cost of its own. Cached prompt
 * tokens (a subset of tokensIn) bill at the host's cache-read rate — on
 * DeepInfra one fifth of the input rate for V4 Flash and one thirteenth for
 * V4 Pro (deepinfra.com model pages, 2026-09-02).
 */
export function costMicroUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensCached = 0
): number {
  const meta = modelMeta(model)
  const cached = Math.min(Math.max(0, tokensCached), Math.max(0, tokensIn))
  const fresh = Math.max(0, tokensIn) - cached
  return Math.round(
    (fresh * meta.inPerM + cached * meta.cachedInPerM + tokensOut * meta.outPerM) / 1_000_000
  )
}
