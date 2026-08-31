/**
 * Model metadata: display names, reasoning flags, and prices.
 *
 * Prices are microUSD per 1M tokens (in/out) and are config, not truth —
 * unknown models meter at 0 cost but exact token counts. Pin real
 * DeepInfra catalog ids and prices when the org key is provisioned.
 */

export type ModelMeta = {
  id: string
  name: string
  reasoning: boolean
  inPerM: number // microUSD per 1M input tokens
  outPerM: number // microUSD per 1M output tokens
}

const KNOWN: ModelMeta[] = [
  {
    id: 'deepseek-ai/DeepSeek-V3.1',
    name: 'DeepSeek V3.1',
    reasoning: false,
    inPerM: 270_000,
    outPerM: 1_000_000
  },
  {
    id: 'deepseek-ai/DeepSeek-R1-0528',
    name: 'DeepSeek R1',
    reasoning: true,
    inPerM: 500_000,
    outPerM: 2_150_000
  }
]

export function modelMeta(id: string): ModelMeta {
  return (
    KNOWN.find((m) => m.id === id) ?? {
      id,
      name: id.split('/').pop() ?? id,
      reasoning: /r1|reasoner|thinking/i.test(id),
      inPerM: 0,
      outPerM: 0
    }
  )
}

export function costMicroUsd(model: string, tokensIn: number, tokensOut: number): number {
  const meta = modelMeta(model)
  return Math.round((tokensIn * meta.inPerM + tokensOut * meta.outPerM) / 1_000_000)
}
