/**
 * Fetch side of the model catalog: pulls GET /v1/models through the cloud
 * session and primes the pure cache (cloud/catalog.ts). Called on session
 * ready and whenever the cached copy is stale; failures leave the last
 * good catalog in place — the runtime's heuristics cover a cold start.
 *
 * Readers never wait behind the network once a copy exists: getCatalog
 * answers the cached list and revalidates a stale one behind the answer,
 * and a refresh that lands a different list tells onCatalogChanged
 * listeners. That push is how the renderer, which holds the list from
 * launch instead of fetching on every picker open, learns about an admin
 * policy edit.
 */
import { API_BASE } from '@main/cloud/api'
import {
  catalogAgeMs,
  catalogModels,
  primeCatalog,
  sameCatalog,
  type CatalogModel
} from '@main/cloud/catalog'
import { cloudSession } from '@main/cloud/session'

const FRESH_MS = 5 * 60_000

type WireModel = {
  id: string
  name: string
  reasoning: boolean
  vision?: boolean
  context_window?: number
  in_per_mtok_microusd?: number
  out_per_mtok_microusd?: number
  default?: boolean
}

type CatalogListener = (models: CatalogModel[]) => void
const listeners = new Set<CatalogListener>()

/** Fires after a refresh lands a catalog that differs from the cached one. */
export function onCatalogChanged(listener: CatalogListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let inflight: Promise<CatalogModel[]> | null = null

/** Fetch now; concurrent callers share the one request in flight. */
export function refreshCatalog(): Promise<CatalogModel[]> {
  if (!inflight) {
    inflight = fetchCatalog().finally(() => {
      inflight = null
    })
  }
  return inflight
}

async function fetchCatalog(): Promise<CatalogModel[]> {
  const json = await cloudSession.withAccessToken(async (token) => {
    const res = await fetch(`${API_BASE}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: catalog fetch failed`)
    return (await res.json()) as { default_model?: string; models?: WireModel[] }
  })
  const models: CatalogModel[] = (json.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: Boolean(m.reasoning),
    vision: Boolean(m.vision),
    contextWindow: m.context_window ?? 0,
    inPerMtokMicroUsd: m.in_per_mtok_microusd ?? 0,
    outPerMtokMicroUsd: m.out_per_mtok_microusd ?? 0,
    default: Boolean(m.default)
  }))
  const changed = !sameCatalog(catalogModels(), models)
  primeCatalog(models, json.default_model ?? null)
  if (changed) for (const listener of listeners) listener(models)
  return models
}

/**
 * The catalog, refreshed when stale. A cold cache waits for the fetch (and
 * answers empty when it fails); a stale one answers at once and refreshes
 * behind the caller, the change — if any — arriving via onCatalogChanged.
 */
export async function getCatalog(): Promise<CatalogModel[]> {
  const age = catalogAgeMs()
  if (age <= FRESH_MS) return catalogModels()
  const refresh = refreshCatalog().catch(() => catalogModels())
  if (age === Number.POSITIVE_INFINITY) return refresh
  void refresh
  return catalogModels()
}
