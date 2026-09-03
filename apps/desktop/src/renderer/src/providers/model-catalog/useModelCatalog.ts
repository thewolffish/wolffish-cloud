import { createContext, useContext } from 'react'
import type { CatalogModelEntry } from '@preload/index'

export type ModelCatalogContextValue = {
  /** The org catalog (GET /v1/models), mirrored from main's cache from launch on. */
  models: CatalogModelEntry[]
  /** False until main's first answer lands; never flips back. */
  ready: boolean
  /**
   * Nudge main to revalidate a stale copy. Answers from cache, so nothing
   * waits on it; a changed list arrives through the push.
   */
  revalidate: () => void
}

export const ModelCatalogContext = createContext<ModelCatalogContextValue | null>(null)

export function useModelCatalog(): ModelCatalogContextValue {
  const ctx = useContext(ModelCatalogContext)
  if (!ctx) throw new Error('useModelCatalog must be used within a ModelCatalogProvider')
  return ctx
}
