/**
 * Metering — the one writer of the usage ledger.
 *
 * Every decision on either lane (model or search) becomes one raw `usage`
 * row and one increment of the per-user, per-day, per-lane `usage_daily`
 * rollup, written in the SAME D1 batch (atomic). The raw row is the
 * authoritative record the desktop rebuilds its ledger from; the rollup is
 * what admin totals and the retention sweep rely on, so totals never depend
 * on raw rows surviving.
 *
 * Nothing here touches KV: the live quota counters live inside the gates
 * (ModelGate / SearchGate storage), which increment them atomically as part
 * of the call they already handle.
 */
import { costMicroUsd } from '@/lib/models'
import type { Env } from '@/index'

export type UsageDecision = 'allowed' | 'denied_model' | 'denied_quota' | 'error'

export type UsageEvent = {
  userId: string
  deviceId: string
  kind: 'chat' | 'search'
  model: string
  upstream?: string
  tokensIn?: number
  tokensOut?: number
  /** Prompt tokens served from the host's prefix cache (a subset of tokensIn). */
  tokensCached?: number
  latencyMs?: number
  decision: UsageDecision
  error?: string
  /** The host's own bill (USD) when it reports one — authoritative. */
  upstreamCostUsd?: number
  /** Fixed per-call price (search) in microUSD; overrides token pricing. */
  fixedCostMicroUsd?: number
}

const dayOf = (iso: string) => iso.slice(0, 10)

export async function recordUsage(env: Env, e: UsageEvent): Promise<void> {
  const tokensIn = Math.max(0, Math.floor(e.tokensIn ?? 0))
  const tokensOut = Math.max(0, Math.floor(e.tokensOut ?? 0))
  const tokensCached = Math.min(tokensIn, Math.max(0, Math.floor(e.tokensCached ?? 0)))
  const allowed = e.decision === 'allowed'
  const cost = !allowed
    ? 0
    : e.fixedCostMicroUsd !== undefined
      ? e.fixedCostMicroUsd
      : e.upstreamCostUsd !== undefined && Number.isFinite(e.upstreamCostUsd)
        ? Math.round(e.upstreamCostUsd * 1_000_000)
        : costMicroUsd(e.model, tokensIn, tokensOut, tokensCached)
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage (user_id, device_id, model, kind, upstream, tokens_in, tokens_out, tokens_cached,
         cost_microusd, latency_ms, decision, error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    ).bind(
      e.userId,
      e.deviceId,
      e.model,
      e.kind,
      e.upstream ?? '',
      tokensIn,
      tokensOut,
      tokensCached,
      cost,
      Math.max(0, Math.floor(e.latencyMs ?? 0)),
      e.decision,
      e.error ?? null,
      now
    ),
    env.DB.prepare(
      `INSERT INTO usage_daily (user_id, day, kind, requests, denied, tokens_in, tokens_out, tokens_cached, cost_microusd)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(user_id, day, kind) DO UPDATE SET
         requests = requests + 1,
         denied = denied + excluded.denied,
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         tokens_cached = tokens_cached + excluded.tokens_cached,
         cost_microusd = cost_microusd + excluded.cost_microusd`
    ).bind(
      e.userId,
      dayOf(now),
      e.kind,
      allowed ? 0 : 1,
      allowed ? tokensIn : 0,
      allowed ? tokensOut : 0,
      allowed ? tokensCached : 0,
      cost
    )
  ])
}

/**
 * Metering must never take a request down with it: a D1 hiccup is logged
 * (Workers Logs) and the response proceeds. Used from waitUntil and from
 * inline denial paths alike.
 */
export async function recordUsageSafe(env: Env, e: UsageEvent): Promise<void> {
  try {
    await recordUsage(env, e)
  } catch (err) {
    console.error('usage write failed', { message: (err as Error).message, kind: e.kind, decision: e.decision })
  }
}
