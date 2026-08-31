/**
 * Model governance: effective allowlists and token quotas.
 *
 * D1 is the source of truth; CONFIG_KV holds short-TTL caches (admin
 * mutations delete the cached keys, so edits land within a minute even
 * before TTL expiry). Quota counters live in AUTH-adjacent KV too: they
 * are advisory speed bumps — the authoritative tally is the usage table,
 * and cron re-syncs counters from it.
 */
import type { Env } from '../index'

export type OrgConfig = {
  name: string
  default_model: string
  default_allowed_models: string[]
  user_daily_token_cap: number
  org_monthly_token_cap: number
}

export type EffectivePolicy = {
  allowed: string[] // empty means "org default model only"
  dailyCap: number
}

const ORG_TTL = 60
const POLICY_TTL = 60

export async function getOrgConfig(env: Env): Promise<OrgConfig | null> {
  const cached = await env.CONFIG_KV.get('org', 'json')
  if (cached) return cached as OrgConfig
  const row = await env.DB.prepare('SELECT * FROM org WHERE id = 1').first<{
    name: string
    default_model: string
    default_allowed_models: string
    user_daily_token_cap: number
    org_monthly_token_cap: number
  }>()
  if (!row) return null
  const org: OrgConfig = {
    name: row.name,
    default_model: row.default_model,
    default_allowed_models: safeArray(row.default_allowed_models),
    user_daily_token_cap: row.user_daily_token_cap,
    org_monthly_token_cap: row.org_monthly_token_cap
  }
  await env.CONFIG_KV.put('org', JSON.stringify(org), { expirationTtl: ORG_TTL })
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
  const cached = await env.CONFIG_KV.get(key, 'json')
  if (cached) return cached as EffectivePolicy

  const org = await getOrgConfig(env)
  const row = await env.DB.prepare(
    'SELECT allowed_models, daily_token_cap FROM model_policies WHERE user_id = ?1'
  )
    .bind(userId)
    .first<{ allowed_models: string | null; daily_token_cap: number | null }>()

  const allowed =
    row?.allowed_models != null ? safeArray(row.allowed_models) : (org?.default_allowed_models ?? [])
  const policy: EffectivePolicy = {
    allowed,
    dailyCap: row?.daily_token_cap ?? org?.user_daily_token_cap ?? 0
  }
  await env.CONFIG_KV.put(key, JSON.stringify(policy), { expirationTtl: POLICY_TTL })
  return policy
}

export function modelAllowed(model: string, policy: EffectivePolicy, org: OrgConfig): boolean {
  if (policy.allowed.length > 0) return policy.allowed.includes(model)
  return model === org.default_model
}

/** UTC period keys — reset happens by the key changing, cron just tidies. */
const dayKey = (userId: string) =>
  `q:d:${userId}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
const monthKey = () => `q:m:${new Date().toISOString().slice(0, 7).replace(/-/g, '')}`

export async function quotaStanding(
  env: Env,
  userId: string,
  policy: EffectivePolicy,
  org: OrgConfig
): Promise<{ ok: boolean; scope?: 'user_daily' | 'org_monthly'; used: number; cap: number }> {
  const [userUsed, orgUsed] = await Promise.all([
    env.CONFIG_KV.get(dayKey(userId)).then((v) => parseInt(v ?? '0', 10)),
    env.CONFIG_KV.get(monthKey()).then((v) => parseInt(v ?? '0', 10))
  ])
  if (policy.dailyCap > 0 && userUsed >= policy.dailyCap) {
    return { ok: false, scope: 'user_daily', used: userUsed, cap: policy.dailyCap }
  }
  if (org.org_monthly_token_cap > 0 && orgUsed >= org.org_monthly_token_cap) {
    return { ok: false, scope: 'org_monthly', used: orgUsed, cap: org.org_monthly_token_cap }
  }
  return { ok: true, used: userUsed, cap: policy.dailyCap }
}

/** Non-atomic KV bump: races undercount slightly; usage rows stay exact. */
export async function bumpQuota(env: Env, userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return
  const dk = dayKey(userId)
  const mk = monthKey()
  const [d, m] = await Promise.all([env.CONFIG_KV.get(dk), env.CONFIG_KV.get(mk)])
  await Promise.all([
    env.CONFIG_KV.put(dk, String(parseInt(d ?? '0', 10) + tokens), { expirationTtl: 2 * 86_400 }),
    env.CONFIG_KV.put(mk, String(parseInt(m ?? '0', 10) + tokens), { expirationTtl: 40 * 86_400 })
  ])
}
