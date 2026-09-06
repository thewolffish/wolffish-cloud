/**
 * The org's overlay over every employee's config — the platform's only
 * control over what the agent DOES rather than what it spends.
 *
 * Shape: one JSON object of dot-path → value.
 *
 *   { "model.default": "deepseek-ai/DeepSeek-V4-Flash-0731",
 *     "channels.telegram.enabled": false,
 *     "browserExtension.port": 23152 }
 *
 * Paths present here are org-owned. There is no separate "locked keys" list
 * on purpose: a lock and the value it enforces would be two facts to keep in
 * step, and the day they disagree is the day an admin believes a setting is
 * enforced and it is not.
 *
 * Enforced at BOTH boundaries, which is what makes it a control rather than
 * a suggestion: `apply` runs on every read, so a client sees the org's value;
 * and it runs again on every write, so a client that ignores the lock — an
 * older build, a hand-rolled request, a config file edited on disk — cannot
 * store anything else. The employee keeps every path the org has not claimed.
 */
import type { Env } from '@/index'

export type OrgConfigOverlay = Record<string, unknown>

/** Same edge window the policy cache uses, for the same reason. */
const CACHE_TTL_SECONDS = 3600
const EDGE_TTL_SECONDS = 60
export const ORG_CONFIG_CACHE_KEY = 'orgconfig1'

/** Dot paths only: object traversal, never array indices. */
const PATH_RE = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/
/** A ceiling on how much policy one org can push into every config row. */
export const MAX_OVERLAY_BYTES = 65_536
export const MAX_OVERLAY_PATHS = 200

export function isConfigPath(path: string): boolean {
  return path.length > 0 && path.length <= 200 && PATH_RE.test(path)
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Set one dot path, creating the objects along the way. A segment that is
 * currently a non-object is replaced: the org said this path is theirs, and
 * a scalar sitting where the org needs a branch is not a reason to give up
 * enforcing it.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    if (!isPlain(node[key])) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[parts[parts.length - 1]!] = value
}

/**
 * The org's values over the employee's config. Returns a new object; the
 * input is never mutated, because callers hand us a parsed row they may also
 * be about to store.
 */
export function apply(
  config: Record<string, unknown>,
  overlay: OrgConfigOverlay
): Record<string, unknown> {
  const paths = Object.keys(overlay)
  if (paths.length === 0) return config
  const out = structuredClone(config) as Record<string, unknown>
  for (const path of paths) {
    if (!isConfigPath(path)) continue
    setPath(out, path, overlay[path])
  }
  return out
}

function parseOverlay(raw: unknown): OrgConfigOverlay {
  if (typeof raw !== 'string') return isPlain(raw) ? raw : {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlain(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The current overlay. Cached like the model policy and for the same reason
 * — this now sits on the config read path, which the desktop hits at every
 * launch and every two minutes thereafter. Admin writes delete the key, so
 * an edit lands within the edge window.
 */
export async function getOrgConfigOverlay(env: Env): Promise<OrgConfigOverlay> {
  try {
    const cached = await env.CONFIG_KV.get(ORG_CONFIG_CACHE_KEY, {
      type: 'json',
      cacheTtl: EDGE_TTL_SECONDS
    })
    if (isPlain(cached)) return cached
  } catch {
    // a cache miss is never a failure — fall through to D1
  }
  const row = await env.DB.prepare('SELECT overlay FROM org_config_policy WHERE id = 1').first<{
    overlay: string
  }>()
  const overlay = parseOverlay(row?.overlay)
  try {
    await env.CONFIG_KV.put(ORG_CONFIG_CACHE_KEY, JSON.stringify(overlay), {
      expirationTtl: CACHE_TTL_SECONDS
    })
  } catch {
    // another isolate refilled this key within the same second
  }
  return overlay
}

/** Read a stored config row and hand back what the caller should SEE. */
export async function withOverlay(
  env: Env,
  config: Record<string, unknown>
): Promise<{ config: Record<string, unknown>; locked_keys: string[] }> {
  const overlay = await getOrgConfigOverlay(env)
  return { config: apply(config, overlay), locked_keys: Object.keys(overlay).filter(isConfigPath) }
}
