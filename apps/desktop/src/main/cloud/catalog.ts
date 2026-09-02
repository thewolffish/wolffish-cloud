/**
 * The org model catalog — the API's answer to GET /v1/models, cached in
 * main-process memory. This module is a PURE cache with no imports, so
 * runtime modules (thalamus, vision, usage) can consult it without
 * dragging electron into their import graph; cloud/catalogSync.ts owns
 * fetching and calls primeCatalog(). Every accessor answers null when the
 * catalog hasn't landed yet — callers keep their heuristic fallbacks.
 */

export type CatalogModel = {
  id: string
  name: string
  reasoning: boolean
  vision: boolean
  contextWindow: number
  /** microUSD per 1M tokens, straight off the wire. */
  inPerMtokMicroUsd: number
  outPerMtokMicroUsd: number
  default: boolean
}

let models: CatalogModel[] = []
let defaultModelId: string | null = null
let fetchedAt = 0

export function primeCatalog(next: CatalogModel[], defaultModel: string | null): void {
  models = next
  defaultModelId = defaultModel
  fetchedAt = Date.now()
}

export function catalogModels(): CatalogModel[] {
  return models
}

export function catalogDefaultModel(): string | null {
  return defaultModelId
}

export function catalogAgeMs(): number {
  return fetchedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - fetchedAt
}

export function catalogModel(id: string): CatalogModel | null {
  return models.find((m) => m.id === id) ?? null
}

export function catalogVision(id: string): boolean | null {
  return catalogModel(id)?.vision ?? null
}

export function catalogContextWindow(id: string): number | null {
  const w = catalogModel(id)?.contextWindow
  return typeof w === 'number' && w > 0 ? w : null
}

/** USD per single token (input, output), or null when unpriced/unknown. */
export function catalogPricing(id: string): { input: number; output: number } | null {
  const m = catalogModel(id)
  if (!m || (m.inPerMtokMicroUsd === 0 && m.outPerMtokMicroUsd === 0)) return null
  return {
    input: m.inPerMtokMicroUsd / 1e6 / 1e6,
    output: m.outPerMtokMicroUsd / 1e6 / 1e6
  }
}
