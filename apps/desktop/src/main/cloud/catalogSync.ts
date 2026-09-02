/**
 * Fetch side of the model catalog: pulls GET /v1/models through the cloud
 * session and primes the pure cache (cloud/catalog.ts). Called on session
 * ready and whenever the cached copy is stale; failures leave the last
 * good catalog in place — the runtime's heuristics cover a cold start.
 */
import { API_BASE } from '@main/cloud/api'
import { primeCatalog, catalogAgeMs, catalogModels, type CatalogModel } from '@main/cloud/catalog'
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

export async function refreshCatalog(): Promise<CatalogModel[]> {
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
  primeCatalog(models, json.default_model ?? null)
  return models
}

/** The catalog, refreshed when stale; stale-but-present survives errors. */
export async function getCatalog(): Promise<CatalogModel[]> {
  if (catalogAgeMs() > FRESH_MS) {
    try {
      return await refreshCatalog()
    } catch {
      // keep whatever we have
    }
  }
  return catalogModels()
}
