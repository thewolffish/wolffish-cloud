/**
 * The model upstream pool — where the org's model keys live.
 *
 * One JSON secret, MODEL_UPSTREAMS, lists every OpenAI-compatible host the
 * router may forward to:
 *
 *   [{ "id": "deepinfra",
 *      "base": "https://api.deepinfra.com/v1/openai",
 *      "key": "…",
 *      "models": { "deepseek-ai/DeepSeek-V4-Flash-0731": "deepseek-ai/DeepSeek-V4-Flash-0731" },
 *      "concurrency": 200,
 *      "weight": 1 }, …]
 *
 *   models       canonical id (what clients and policies name) → the id this
 *                host wants on the wire. An empty map, or a "*" key, means
 *                "serves every model under the same id" (a passthrough host).
 *   concurrency  streams this host may hold per model at once — the account's
 *                documented concurrent-request limit, minus headroom. The
 *                ModelGate never opens more than this; extra callers queue.
 *   weight       share of sticky routing this host gets (default 1).
 *
 * Without the secret, the historical single-host configuration applies:
 * DEEPINFRA_API_KEY (+ DEEPINFRA_BASE_URL, DEEPINFRA_CONCURRENCY) becomes a
 * one-entry pool — so an existing deployment keeps working unchanged.
 *
 * Keys never leave this file's callers: the gate receives ids and capacities
 * only (poolSummary), and the Worker resolves the key by id at forward time.
 */
import type { Env } from '@/index'

export const DEEPINFRA_DEFAULT_BASE = 'https://api.deepinfra.com/v1/openai'
/** DeepInfra's documented default: 200 concurrent requests per model per account. */
export const DEFAULT_CONCURRENCY = 200

export type Upstream = {
  id: string
  base: string
  key: string
  /** canonical model id → provider model id; empty/'*' = passthrough. */
  models: Record<string, string>
  concurrency: number
  weight: number
}

/** What the gate needs: everything but the key and base. */
export type PoolEntry = {
  id: string
  models: Record<string, string>
  concurrency: number
  weight: number
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function posInt(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

function parseModels(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const canonical = str(k)
    const wire = str(val)
    if (canonical && wire) out[canonical] = wire
  }
  return out
}

let cache: { raw: string; pool: Upstream[] } | null = null

/**
 * The configured pool. Invalid entries are dropped loudly (console.error)
 * rather than crashing the lane; an empty result means the router answers
 * model_unavailable until the secret is fixed. Parsed once per isolate per
 * distinct secret value.
 */
export function loadUpstreams(env: Env): Upstream[] {
  const raw = str(env.MODEL_UPSTREAMS)
  if (cache && cache.raw === raw) return cache.pool
  const pool: Upstream[] = []
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.error('MODEL_UPSTREAMS is not valid JSON', { message: (err as Error).message })
      parsed = []
    }
    const seen = new Set<string>()
    for (const [i, entry] of (Array.isArray(parsed) ? parsed : []).entries()) {
      const e = (entry ?? {}) as Record<string, unknown>
      const id = str(e.id)
      const base = str(e.base).replace(/\/$/, '')
      const key = str(e.key)
      if (!id || !/^https?:\/\//.test(base) || !key || seen.has(id)) {
        console.error('MODEL_UPSTREAMS entry skipped', { index: i, id, hasBase: Boolean(base), hasKey: Boolean(key) })
        continue
      }
      seen.add(id)
      pool.push({
        id,
        base,
        key,
        models: parseModels(e.models),
        concurrency: posInt(e.concurrency, DEFAULT_CONCURRENCY),
        weight: posInt(e.weight, 1)
      })
    }
  } else if (str(env.DEEPINFRA_API_KEY)) {
    pool.push({
      id: 'deepinfra',
      base: (str(env.DEEPINFRA_BASE_URL) || DEEPINFRA_DEFAULT_BASE).replace(/\/$/, ''),
      key: str(env.DEEPINFRA_API_KEY),
      models: {},
      concurrency: posInt(env.DEEPINFRA_CONCURRENCY, DEFAULT_CONCURRENCY),
      weight: 1
    })
  }
  cache = { raw, pool }
  return pool
}

export function poolSummary(pool: Upstream[]): PoolEntry[] {
  return pool.map((u) => ({ id: u.id, models: u.models, concurrency: u.concurrency, weight: u.weight }))
}

/** Does this host serve the canonical model, and under which wire id? */
export function wireModel(entry: PoolEntry, model: string): string | null {
  const keys = Object.keys(entry.models)
  if (keys.length === 0) return model
  if (entry.models[model]) return entry.models[model]!
  if (entry.models['*']) return entry.models['*'] === '*' ? model : entry.models['*']!
  return null
}
