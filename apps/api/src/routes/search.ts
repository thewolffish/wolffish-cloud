/**
 * The web-search lane — the model router's twin, for the search providers.
 *
 * POST /v1/search: session → org switch → the SearchGate (one global queue
 * in front of the org's search plans, see lib/search-gate.ts — it also
 * holds the per-user daily and org monthly counters and refuses a capped
 * employee before queueing) → normalize → meter. The desktop's web-search
 * plugin points here with the session token; the org's keys exist only
 * behind this door, never on a device.
 *
 * GET /v1/search/status is the "auto configured" half — what the settings
 * panel renders: provider, whether the org lane is live, this user's
 * standing against the caps, the plan price and the gate's live limit.
 *
 * Privacy: the query goes upstream with the org key and nothing else. The
 * usage row records that a search happened (who, when, latency, cost),
 * never the query text — metadata always, content never.
 */
import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import { getEffectivePolicy, getOrgConfig } from '@/lib/policy'
import { normalizeSurface } from '@/lib/plans'
import { SearchSchema } from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { recordUsageSafe, type UsageEvent } from '@/lib/meter'
import {
  BRAVE_DEFAULT_QPS,
  SEARCH_PRICE_MICROUSD,
  loadSearchProviders,
  type BraveWebBody,
  type GateResult
} from '@/lib/search-gate'
import type { Env } from '@/index'

export const SEARCH_MODEL = 'brave/web-search'

const search = new Hono<{ Bindings: Env; Variables: AuthVars }>()

search.use('*', requireAuth)

const gateOf = (env: Env) => env.SEARCH_GATE.get(env.SEARCH_GATE.idFromName('org'))

export type SearchResult = { title: string; snippet: string; url: string }

/** Brave's web.results → the plugin's shape (the model never sees more). */
export function normalizeResults(body: BraveWebBody, count: number): SearchResult[] {
  const raw = body?.web?.results
  if (!Array.isArray(raw)) return []
  const out: SearchResult[] = []
  for (const row of raw) {
    if (out.length >= count) break
    const title = typeof row?.title === 'string' ? row.title : ''
    const url = typeof row?.url === 'string' ? row.url : ''
    if (!title || !/^https?:/i.test(url)) continue
    out.push({ title, snippet: typeof row.description === 'string' ? row.description : '', url })
  }
  return out
}

search.get('/search/status', async (c) => {
  const auth = c.get('auth')
  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  const policy = await getEffectivePolicy(c.env, auth.sub)
  const configured = loadSearchProviders(c.env).length > 0
  const gate = gateOf(c.env)
  const [stats, standing] = configured
    ? await Promise.all([gate.stats().catch(() => null), gate.standing(auth.sub).catch(() => null)])
    : [null, null]
  return c.json({
    provider: 'brave',
    configured,
    enabled: org.search_enabled,
    ready: configured && org.search_enabled,
    daily_cap: policy.dailySearchCap,
    used_today: standing?.userDayUsed ?? 0,
    org_monthly_cap: org.org_monthly_search_cap,
    org_used_month: standing?.orgMonthUsed ?? 0,
    price_per_query_microusd: SEARCH_PRICE_MICROUSD,
    plan_qps: stats?.planQps ?? BRAVE_DEFAULT_QPS,
    gate: stats
  })
})

search.post('/search', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, SearchSchema)
  if (body instanceof Response) return body

  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  if (!org.search_enabled) return c.json({ error: 'search_disabled' }, 403)
  if (loadSearchProviders(c.env).length === 0) return c.json({ error: 'search_not_configured' }, 503)

  const policy = await getEffectivePolicy(c.env, auth.sub)
  const base: Omit<UsageEvent, 'decision'> = {
    userId: auth.sub,
    deviceId: auth.dev,
    kind: 'search',
    model: SEARCH_MODEL,
    // Same attribution as the model lane: search spend splits by surface too,
    // so "the extension is what burns the search quota" is answerable.
    surface: normalizeSurface(c.req.header('x-wfc-surface'))
  }

  const count = body.count ?? 5
  let result: GateResult
  try {
    result = await gateOf(c.env).search({
      userId: auth.sub,
      query: body.query,
      count,
      country: body.country?.toUpperCase(),
      searchLang: body.search_lang,
      freshness: body.freshness,
      caps: { userDaily: policy.dailySearchCap, orgMonthly: org.org_monthly_search_cap }
    })
  } catch {
    await recordUsageSafe(c.env, { ...base, decision: 'error', error: 'gate_unavailable' })
    return c.json({ error: 'search_unavailable' }, 503, { 'retry-after': '5' })
  }

  if (!result.ok) {
    if (result.error === 'search_quota_exceeded') {
      await recordUsageSafe(c.env, { ...base, decision: 'denied_quota' })
      return c.json(
        { error: 'search_quota_exceeded', scope: result.scope, used: result.used, cap: result.cap },
        429
      )
    }
    await recordUsageSafe(c.env, {
      ...base,
      latencyMs: result.latencyMs,
      decision: 'error',
      error: result.error
    })
    const headers = result.retryAfterMs
      ? { 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) }
      : undefined
    switch (result.error) {
      case 'search_not_configured':
        return c.json({ error: 'search_not_configured' }, 503)
      case 'search_busy':
        return c.json({ error: 'search_busy', retry_after_ms: result.retryAfterMs ?? 2000 }, 503, headers)
      case 'search_quota_exhausted':
        // Every plan's own monthly window, not an org cap: the plans are spent.
        return c.json(
          { error: 'search_quota_exhausted', scope: 'plan_monthly', retry_after_ms: result.retryAfterMs ?? 0 },
          429,
          headers
        )
      default:
        return c.json(
          { error: 'upstream_error', upstream: result.error, detail: result.detail ?? null },
          502
        )
    }
  }

  const results = normalizeResults(result.body, count)
  c.executionCtx.waitUntil(
    recordUsageSafe(c.env, {
      ...base,
      upstream: result.provider,
      latencyMs: result.latencyMs,
      decision: 'allowed',
      fixedCostMicroUsd: SEARCH_PRICE_MICROUSD
    })
  )
  return c.json({
    provider: 'brave',
    results,
    meta: {
      latency_ms: result.latencyMs,
      waited_ms: result.waitedMs,
      coalesced: result.coalesced,
      upstream: result.provider,
      used_today: result.standing.userDayUsed,
      daily_cap: policy.dailySearchCap
    }
  })
})

export default search
