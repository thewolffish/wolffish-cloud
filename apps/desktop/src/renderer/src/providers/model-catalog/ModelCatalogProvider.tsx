import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CatalogModelEntry } from '@preload/index'
import { ModelCatalogContext } from '@providers/model-catalog/useModelCatalog'

/**
 * The org model catalog, held once for the whole app so the composer's
 * picker and the Models panel render their rows synchronously. Each used
 * to fetch on open, which painted the lone selected model first and the
 * rows a round trip later — a visible load for a two-row list. One fetch
 * at launch seeds this; every change after that (session ready, a
 * stale-copy revalidation, an admin policy edit) is pushed by main.
 */
export function ModelCatalogProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [models, setModels] = useState<CatalogModelEntry[]>([])
  const [ready, setReady] = useState(false)
  // A push that lands while the seed fetch is in flight is the newer list;
  // the fetch's answer must not roll it back.
  const pushed = useRef(false)

  useEffect(() => {
    let cancelled = false
    const off = window.api.model.onCatalogChanged(({ models: next }) => {
      pushed.current = true
      setModels(next)
      setReady(true)
    })
    void window.api.model
      .catalog()
      .then((r) => {
        if (!cancelled && !pushed.current) setModels(r.models)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Main answers from cache and refreshes a stale copy behind the answer.
  // The answer is the list already held here, so only the push matters.
  const revalidate = useCallback(() => {
    void window.api.model.catalog().catch(() => {})
  }, [])

  const value = useMemo(() => ({ models, ready, revalidate }), [models, ready, revalidate])
  return <ModelCatalogContext.Provider value={value}>{children}</ModelCatalogContext.Provider>
}
