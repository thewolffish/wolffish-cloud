import { cloudSession } from '@/lib/cloud/session'
import { useSyncExternalStore } from 'react'

/**
 * What the signed-in person may do on the admin screens.
 *
 * Presentation only — the org re-checks the role on every request, so this
 * cannot grant anything. What it does is keep the app from drawing a control
 * that would come back 403, and keep the Admin row off the settings list for
 * the people it means nothing to.
 *
 * It follows the session rather than reading it once: a role change (or a
 * sign-out, or an admin revoking this phone) reaches every mounted screen at
 * the same moment the session store learns about it.
 */
export type AdminAccess = {
  canRead: boolean
  /** False for the support tier, which is read-only by design. */
  canWrite: boolean
  /** Only an owner may set roles, or act on another owner. */
  isOwner: boolean
  role: string | null
  /** This phone's own email — how a roster row recognises itself. */
  email: string | null
}

const ADMIN_ROLES = new Set(['owner', 'admin', 'support'])

const NO_ACCESS: AdminAccess = {
  canRead: false,
  canWrite: false,
  isOwner: false,
  role: null,
  email: null
}

/**
 * Recomputed only when the session actually changes, and returned by
 * reference — useSyncExternalStore compares snapshots with Object.is, so a
 * fresh object per read would re-render every subscriber on every tick.
 */
let cached: AdminAccess = NO_ACCESS
let cachedFrom: string | null = null

function snapshot(): AdminAccess {
  const user = cloudSession.current?.session.user ?? null
  const key = user ? `${user.email}:${user.role}` : null
  if (key === cachedFrom) return cached
  cachedFrom = key
  cached = user
    ? {
        canRead: ADMIN_ROLES.has(user.role),
        canWrite: user.role === 'owner' || user.role === 'admin',
        isOwner: user.role === 'owner',
        role: user.role,
        email: user.email
      }
    : NO_ACCESS
  return cached
}

export function useAdminAccess(): AdminAccess {
  return useSyncExternalStore(
    (onChange) => cloudSession.subscribe(() => onChange()),
    snapshot,
    () => NO_ACCESS
  )
}
