import type { WireUsageDay } from '@/lib/cloud/api'
import { providerForModel } from '@/state/demoConfig'
import type { UsageDay, UsageModelDay } from '@/lib/usage/stats'

/**
 * The org's per-day usage fold (`GET /v1/usage/days`) → the ledger rows the
 * Usage screen aggregates (lib/usage/stats), the same shape the demo bundle
 * carries. Model calls become per-model rows with a provider derived from
 * the model id (the org lane's models are DeepSeek's today; anything the
 * prefix table does not know reads as the org's `cloud` lane); web searches
 * count as that day's Brave queries and never as tokens.
 */
export function usageDaysFromWire(rows: WireUsageDay[]): UsageDay[] {
  const byDay = new Map<string, { models: Map<string, UsageModelDay>; braveQueries: number }>()
  for (const row of rows) {
    if (typeof row?.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue
    let day = byDay.get(row.day)
    if (!day) {
      day = { models: new Map(), braveQueries: 0 }
      byDay.set(row.day, day)
    }
    if (row.kind === 'search') {
      day.braveQueries += Math.max(0, Math.round(row.entries ?? 0))
      continue
    }
    const model = typeof row.model === 'string' ? row.model : 'unknown'
    const provider = providerForModel(model) ?? 'cloud'
    const key = `${provider}:${model}`
    const current = day.models.get(key) ?? {
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      entries: 0
    }
    current.inputTokens += Math.max(0, row.tokens_in ?? 0)
    current.outputTokens += Math.max(0, row.tokens_out ?? 0)
    current.cost += Math.max(0, row.cost_microusd ?? 0) / 1_000_000
    current.entries += Math.max(0, row.entries ?? 0)
    day.models.set(key, current)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, day]) => ({
      date,
      models: [...day.models.values()],
      braveQueries: day.braveQueries
    }))
}
