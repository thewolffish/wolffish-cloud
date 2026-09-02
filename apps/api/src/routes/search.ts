/**
 * The web-search lane — the model router's twin, for Brave Search.
 *
 * POST /v1/search: session → org switch → per-user daily cap → org monthly
 * cap → the SearchGate (one global queue in front of Brave, see
 * lib/search-gate.ts) → normalize → meter. The desktop's web-search plugin
 * points here with the session token; the org's Brave key exists only
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
import {
  bumpSearchQuota,
  getEffectivePolicy,
  getOrgConfig,
  searchQuotaStanding
} from '@/lib/policy'
import { SearchSchema } from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import {
  BRAVE_DEFAULT_QPS,
  SEARCH_PRICE_MICROUSD,
  type BraveWebBody,
  type GateResult
} from '@/lib/search-gate'
import type { Env } from '@/index'

export const SEARCH_MODEL = 'brave/web-search'

const search = new Hono<{ Bindings: Env; Variables: AuthVars }>()

search.use('*', requireAuth)

const gateOf = (env: Env) => env.SEARCH_GATE.get(env.SEARCH_GATE.idFromName('org'))

type SearchMeter = {
  userId: string
  deviceId: string
  latencyMs: number
  decision: 'allowed' | 'denied_quota' | 'error'
  error?: string
}

async function meter(env: Env, m: SearchMeter): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (user_id, device_id, model, kind, tokens_in, tokens_out, tokens_cached,
       cost_microusd, latency_ms, decision, error)
     VALUES (?1, ?2, ?3, 'search', 0, 0, 0, ?4, ?5, ?6, ?7)`
  )
    .bind(
      m.userId,
      m.deviceId,
      SEARCH_MODEL,
      m.decision === 'allowed' ? SEARCH_PRICE_MICROUSD : 0,
      m.latencyMs,
      m.decision,
      m.error ?? null
    )
    .run()
  if (m.decision === 'allowed') await bumpSearchQuota(env, m.userId)
}

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
  const configured = Boolean(c.env.BRAVE_API_KEY)
  const standing = await searchQuotaStanding(c.env, auth.sub, policy, org)
  const gate = configured ? await gateOf(c.env).stats().catch(() => null) : null
  return c.json({
    provider: 'brave',
    configured,
    enabled: org.search_enabled,
    ready: configured && org.search_enabled,
    daily_cap: standing.cap,
    used_today: standing.used,
    org_monthly_cap: standing.orgCap,
    org_used_month: standing.orgUsed,
    price_per_query_microusd: SEARCH_PRICE_MICROUSD,
    plan_qps: gate?.planQps ?? BRAVE_DEFAULT_QPS,
    gate
  })
})

search.post('/search', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, SearchSchema)
  if (body instanceof Response) return body

  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  if (!org.search_enabled) return c.json({ error: 'search_disabled' }, 403)
  if (!c.env.BRAVE_API_KEY) return c.json({ error: 'search_not_configured' }, 503)

  const policy = await getEffectivePolicy(c.env, auth.sub)
  const quota = await searchQuotaStanding(c.env, auth.sub, policy, org)
  if (!quota.ok) {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      latencyMs: 0,
      decision: 'denied_quota'
    })
    return c.json(
      { error: 'search_quota_exceeded', scope: quota.scope, used: quota.used, cap: quota.cap },
      429
    )
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
      freshness: body.freshness
    })
  } catch {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      latencyMs: 0,
      decision: 'error',
      error: 'gate_unavailable'
    })
    return c.json({ error: 'search_unavailable' }, 503)
  }

  if (!result.ok) {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      latencyMs: result.latencyMs,
      decision: 'error',
      error: result.error
    })
    const headers = result.retryAfterMs
      ? { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) }
      : undefined
    switch (result.error) {
      case 'search_not_configured':
        return c.json({ error: 'search_not_configured' }, 503)
      case 'search_busy':
        return c.json({ error: 'search_busy', retry_after_ms: result.retryAfterMs ?? 2000 }, 503, headers)
      case 'search_quota_exhausted':
        // Brave's own monthly window, not an org cap: the plan is spent.
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
    meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      latencyMs: result.latencyMs,
      decision: 'allowed'
    })
  )
  return c.json({
    provider: 'brave',
    results,
    meta: {
      latency_ms: result.latencyMs,
      waited_ms: result.waitedMs,
      coalesced: result.coalesced,
      used_today: quota.used + 1,
      daily_cap: quota.cap
    }
  })
})

export default search
