/**
 * The one middleware chain: verify token → attach identity → role gates.
 *
 * Revocation model: the access JWT is stateless (≤15 min), so every
 * authenticated request asks D1 whether its session is still alive —
 * `device_sessions.revoked_at`, the row every revoke path already writes.
 * D1 rather than KV for the same reason the reset codes gave it up: a
 * signed-out token must be dead at once, everywhere, and KV is eventually
 * consistent. KV caches negative lookups too, so a session that had been
 * reading `kill:<sid>` at one location kept being told "not revoked" there
 * for the 60 s minimum cache lifetime after logout wrote the marker — which
 * is exactly the state a real signed-in client leaves behind. One indexed
 * point lookup on the primary key is the price of "sign out" meaning now.
 */
import { createMiddleware } from 'hono/factory'
import { verifyJwt, type AccessClaims } from '@/lib/jwt'
import type { Env } from '@/index'

export type AuthVars = {
  auth: AccessClaims
}

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_IDLE_DAYS = 30

/**
 * The authority on whether a session may still act. A missing row counts as
 * revoked: the nightly sweep only deletes sessions 30 days past their idle
 * expiry, by which point any access token naming one died 15 minutes in —
 * so the only way here is a token for a session that no longer exists, and
 * the safe reading of that is "no".
 *
 * This is a plain read, which is read-your-writes only because the database
 * has a single primary (no read replication). Turning replication on would
 * quietly reopen the very window this replaced — a replica can answer with
 * the pre-revoke row — so this query must move to the Sessions API with a
 * bookmark if that ever happens.
 */
export const sessionRevoked = async (env: Env, sessionId: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT revoked_at FROM device_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<{ revoked_at: string | null }>()
  return !row || row.revoked_at !== null
}

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return c.json({ error: 'unauthorized' }, 401)

    const claims = await verifyJwt(token, c.env.JWT_SECRET)
    if (!claims || claims.scope !== 'session') return c.json({ error: 'unauthorized' }, 401)

    if (await sessionRevoked(c.env, claims.sid)) return c.json({ error: 'session_revoked' }, 401)

    c.set('auth', claims)
    await next()
  }
)

/** Route-group gate. Roles are a fixed hierarchy for the POC. */
export const requireRole = (...roles: AccessClaims['role'][]) =>
  createMiddleware<{ Bindings: Env; Variables: AuthVars }>(async (c, next) => {
    const auth = c.get('auth')
    if (!auth || !roles.includes(auth.role)) return c.json({ error: 'forbidden' }, 403)
    await next()
  })

/** Admin tier = owner or admin. Support is read/assist-only where granted. */
export const requireAdmin = requireRole('owner', 'admin')
