/**
 * Model metadata: display names, reasoning flags, and prices.
 *
 * The org lane is the frontier DeepSeek V4 line on DeepInfra, verified live
 * through the router: ids complete, `reasoning_effort` honoured (enum
 * none|minimal|low|medium|high|xhigh|max — 'none' produces zero reasoning),
 * and prices matching upstream's own `usage.estimated_cost` to the
 * microdollar.
 *
 * V4.1 Flash replaced V4 Flash-0731 on 2026-09-11 — DeepSeek's new Flash,
 * and the first one that sees. It carries no dated id upstream (DeepInfra
 * lists it only as `DeepSeek-V4.1-Flash`), so the catalog names it as is.
 * Verified live that day through this router: it answers "Purple" to a
 * 64x64 magenta PNG (so image parts genuinely travel), the same 1M window,
 * 'none' with zero reasoning and 'max' with reasoning_content, streaming
 * with [DONE], and `usage.estimated_cost` at exactly the list price on two
 * call sizes (7 and 1199 prompt tokens). It also retired Flash-Vision-Exp,
 * the experimental stopgap that gave a named pilot group image input: the
 * new Flash sees for every account at under half Vision-Exp's rate, whose
 * 51% promotion had ended by then anyway.
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
    id: 'deepseek-ai/DeepSeek-V4.1-Flash',
    name: 'DeepSeek V4.1 Flash',
    reasoning: true,
    vision: true,
    contextWindow: 1_048_576,
    // $0.20 / $0.60 per Mtok, no discount: the list block and two live
    // estimated_costs agree (2026-09-11). The cached rate is the list ratio
    // (0.03 of input) — no cached call has been billed through here yet.
    inPerM: 200_000,
    outPerM: 600_000,
    cachedInPerM: 6_000
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
 * DeepInfra 0.03 of the input rate for V4.1 Flash and one thirteenth for
 * V4 Pro. Every rate above comes from the host's own `pricing` block
 * (api.deepinfra.com/models/list) and was then checked against what it
 * actually bills: Pro reproduces the prices verified live on 2026-09-02,
 * V4.1 Flash the ones verified 2026-09-11. The list block is the starting
 * point, never the last word — it can carry a `discount` field, and a
 * model page price that has not been divided into a real `estimated_cost`
 * is a guess.
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
