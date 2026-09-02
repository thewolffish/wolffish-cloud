/**
 * Model governance: effective allowlists and caps.
 *
 * D1 is the source of truth; CONFIG_KV holds cached copies so the hot path
 * never reads D1 for config. Two rules keep the cache from ever becoming a
 * failure: a cache write is best-effort (KV allows one write per key per
 * second and throws a 429 above it — a burst of concurrent misses all
 * re-filling the same key is normal at scale, and only one of them needs to
 * land), and a miss simply reads D1. Admin mutations delete the cached keys,
 * so edits land within the edge cache window (~a minute) regardless of the
 * long expiry.
 *
 * The live quota COUNTERS no longer live here: they are kept by the gates
 * (ModelGate for tokens, SearchGate for queries) in durable object storage,
 * incremented atomically by the call they already admit. The usage table
 * remains the authoritative record.
 */
import type { Env } from '@/index'

export type OrgConfig = {
  name: string
  default_model: string
  default_allowed_models: string[]
  user_daily_token_cap: number
  org_monthly_token_cap: number
  /** The web-search lane's switch and caps (queries; 0 = unlimited). */
  search_enabled: boolean
  user_daily_search_cap: number
  org_monthly_search_cap: number
}

export type EffectivePolicy = {
  allowed: string[] // empty means "org default model only"
  dailyCap: number
  /** Searches per day for this user (0 = unlimited). */
  dailySearchCap: number
}

/** How long a cached copy lives centrally; misses are rare, refills are cheap. */
const CACHE_TTL_SECONDS = 3600
/** Edge read cache: the propagation window an admin edit is allowed to take. */
const EDGE_TTL_SECONDS = 60

/**
 * One shape from either source: the D1 row (integers for booleans, JSON
 * text for the list) or our own cached copy (already typed). Search-lane
 * fields default when absent so a cached copy from before migration 0008
 * can never crash the lane.
 */
function normalizeOrg(o: Record<string, unknown>): OrgConfig {
  const list = o.default_allowed_models
  return {
    name: typeof o.name === 'string' ? o.name : '',
    default_model: typeof o.default_model === 'string' ? o.default_model : '',
    default_allowed_models: Array.isArray(list)
      ? list.filter((x): x is string => typeof x === 'string')
      : safeArray(typeof list === 'string' ? list : null),
    user_daily_token_cap: Number(o.user_daily_token_cap ?? 0),
    org_monthly_token_cap: Number(o.org_monthly_token_cap ?? 0),
    search_enabled: o.search_enabled === undefined ? true : Boolean(Number(o.search_enabled)),
    user_daily_search_cap: Number(o.user_daily_search_cap ?? 200),
    org_monthly_search_cap: Number(o.org_monthly_search_cap ?? 100_000)
  }
}

/** Best-effort cache fill: a lost race to write is not an error. */
async function cachePut(env: Env, key: string, value: unknown): Promise<void> {
  try {
    await env.CONFIG_KV.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
  } catch {
    // Another isolate refilled this key within the same second; its copy is
    // as good as ours. KV's per-key write limit must never surface as a 500.
  }
}

async function cacheGet(env: Env, key: string): Promise<Record<string, unknown> | null> {
  try {
    const v = await env.CONFIG_KV.get(key, { type: 'json', cacheTtl: EDGE_TTL_SECONDS })
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function getOrgConfig(env: Env): Promise<OrgConfig | null> {
  const cached = await cacheGet(env, 'org')
  if (cached) return normalizeOrg(cached)
  const row = await env.DB.prepare('SELECT * FROM org WHERE id = 1').first<Record<string, unknown>>()
  if (!row) return null
  const org = normalizeOrg(row)
  await cachePut(env, 'org', org)
  return org
}

function safeArray(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function getEffectivePolicy(env: Env, userId: string): Promise<EffectivePolicy> {
  const key = `policy:${userId}`
  const cached = await cacheGet(env, key)
  if (cached) {
    const p = cached as Omit<EffectivePolicy, 'dailySearchCap'> & { dailySearchCap?: number }
    if (typeof p.dailySearchCap === 'number') return p as EffectivePolicy
    const org = await getOrgConfig(env)
    return { ...p, dailySearchCap: org?.user_daily_search_cap ?? 0 }
  }

  const org = await getOrgConfig(env)
  const row = await env.DB.prepare(
    'SELECT allowed_models, daily_token_cap, daily_search_cap FROM model_policies WHERE user_id = ?1'
  )
    .bind(userId)
    .first<{
      allowed_models: string | null
      daily_token_cap: number | null
      daily_search_cap: number | null
    }>()

  const allowed =
    row?.allowed_models != null ? safeArray(row.allowed_models) : (org?.default_allowed_models ?? [])
  const policy: EffectivePolicy = {
    allowed,
    dailyCap: row?.daily_token_cap ?? org?.user_daily_token_cap ?? 0,
    dailySearchCap: row?.daily_search_cap ?? org?.user_daily_search_cap ?? 0
  }
  await cachePut(env, key, policy)
  return policy
}

export function modelAllowed(model: string, policy: EffectivePolicy, org: OrgConfig): boolean {
  if (policy.allowed.length > 0) return policy.allowed.includes(model)
  return model === org.default_model
}
