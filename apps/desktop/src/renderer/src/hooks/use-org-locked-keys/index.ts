import { useEffect, useState } from 'react'

/**
 * The config paths the ORGANIZATION owns, as dot paths
 * ("channels.telegram.enabled").
 *
 * The values themselves are already enforced: the API applies the org's
 * overlay on every config read and forces it again on every write, so a
 * locked setting is the org's on this machine whatever the client does. This
 * list exists purely so the UI can SAY so — without it an employee watches a
 * setting change with no explanation and no way to find out why, which is a
 * worse experience than not having the feature at all.
 *
 * Live: the main process broadcasts a new list whenever the org's overlay
 * changes, which the sync engine notices within its two-minute config pull.
 */
export function useOrgLockedKeys(): string[] {
  const [keys, setKeys] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void window.api.workspace
      .lockedConfigKeys()
      .then((next) => {
        if (alive) setKeys(next)
      })
      .catch(() => undefined)
    const off = window.api.workspace.onLockedConfigKeysChanged((next) => setKeys(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  return keys
}

/**
 * Whether one setting is the org's. Accepts the exact path or any ancestor,
 * so locking `channels.telegram` covers every control under it without the
 * admin having to enumerate them.
 */
export function useOrgOwns(path: string): boolean {
  const keys = useOrgLockedKeys()
  return keys.some((k) => k === path || path.startsWith(`${k}.`))
}
