/**
 * Model metadata: display names, reasoning flags, and prices.
 *
 * The org lane is the frontier DeepSeek V4 line, pinned to DeepInfra's
 * dated official-release ids and verified live 2026-09-01 through the
 * router: ids complete, `reasoning_effort` honoured (enum none|minimal|
 * low|medium|high|xhigh|max — 'none' produces zero reasoning), image
 * input rejected by the two text models ("does not accept image input"),
 * and prices matching upstream's own `usage.estimated_cost` to the
 * microdollar.
 *
 * Flash-Vision-Exp joined on 2026-09-04, the lane's first multimodal
 * model. Verified live that day through this router: it answers "Pink" to a
 * 64x64 magenta PNG (so image parts genuinely travel), the same 1M window,
 * and all three reasoning_effort rungs the desktop sends — 'none' with zero
 * reasoning, 'high' and 'max' with reasoning_content. It is experimental
 * upstream and ~2.7x Flash, so the seed provisions it to a named group
 * rather than putting it in the org-wide default allowlist — see
 * scripts/seed-demo.mjs.
 *
 * Its prices below are the DISCOUNTED rate DeepInfra actually bills, not
 * the list price its model page shows: the list block carries
 * `discount: 0.51`, and three live calls of different sizes all reported
 * `usage.estimated_cost` at exactly 0.49x list. If that promotion ends,
 * these three numbers are what go stale — re-derive them by dividing a real
 * `estimated_cost` by the token counts that earned it.
 *
 * Prices are microUSD per 1M tokens (in/out/cached-in) and are config, not truth —
 * unknown models meter at 0 cost but exact token counts, and upstream's
 * reported cost wins whenever it is present.
 */

export type ModelMeta = {
  id: string
  name: string
  reasoning: boolean
  /** Accepts image content parts. Text-only models hard-reject them. */
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
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    name: 'DeepSeek V4 Flash Vision',
    reasoning: true,
    vision: true,
    contextWindow: 1_048_576,
    // List $0.44/$1.32/$0.14 per Mtok, less the 51% promotion upstream is
    // actually billing (verified live 2026-09-04).
    inPerM: 215_600,
    outPerM: 646_800,
    cachedInPerM: 68_600
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
 * DeepInfra one fifth of the input rate for V4 Flash, one thirteenth for
 * V4 Pro and ~0.318 for Flash-Vision-Exp. Every rate above comes from the
 * host's own `pricing` block (api.deepinfra.com/models/list, read
 * 2026-09-04) and was then checked against what it actually bills: the two
 * text models carry no discount and reproduce the prices verified live on
 * 2026-09-02 exactly, while Flash-Vision-Exp bills 0.49x its listed rate.
 * The list block is the starting point, never the last word — a model page
 * price that has not been divided into a real `estimated_cost` is a guess.
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
