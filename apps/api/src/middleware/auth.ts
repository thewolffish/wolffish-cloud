/**
 * The one middleware chain: verify token → attach identity → role gates.
 *
 * Revocation model: the access JWT is stateless (≤15 min), so the only
 * per-request storage read is one KV lookup for the session kill marker.
 * Revoke writes that marker (visible globally within ~a minute) and D1 is
 * checked authoritatively on every refresh — so a revoked session dies at
 * the next request within KV propagation, and at absolute worst at access
 * token expiry.
 */
import { createMiddleware } from 'hono/factory'
import { verifyJwt, type AccessClaims } from '../lib/jwt'
import type { Env } from '../index'

export type AuthVars = {
  auth: AccessClaims
}

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_IDLE_DAYS = 30

export const killKey = (sessionId: string) => `kill:${sessionId}`

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return c.json({ error: 'unauthorized' }, 401)

    const claims = await verifyJwt(token, c.env.JWT_SECRET)
    if (!claims || claims.scope !== 'session') return c.json({ error: 'unauthorized' }, 401)

    const killed = await c.env.AUTH_KV.get(killKey(claims.sid))
    if (killed !== null) return c.json({ error: 'session_revoked' }, 401)

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
