/**
 * Authed session surface: who am I, what may I use, sign out.
 * `/v1/me` is the desktop's first call after login — it carries the role
 * that decides whether the client shows admin controls (server-verified
 * on every admin endpoint regardless).
 */
import { Hono } from 'hono'
import { requireAuth, killKey, REFRESH_IDLE_DAYS, type AuthVars } from '../middleware/auth'
import type { Env } from '../index'

const me = new Hono<{ Bindings: Env; Variables: AuthVars }>()

me.use('*', requireAuth)

me.get('/me', async (c) => {
  const auth = c.get('auth')
  const [user, org] = await Promise.all([
    c.env.DB.prepare('SELECT id, email, name, role, status, last_login_at FROM users WHERE id = ?1')
      .bind(auth.sub)
      .first<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT name, default_model FROM org WHERE id = 1').first<Record<string, unknown>>()
  ])
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ user, org: org ?? null, device_id: auth.dev, session_id: auth.sid })
})

me.post('/logout', async (c) => {
  const auth = c.get('auth')
  await c.env.DB.prepare(
    'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND revoked_at IS NULL'
  )
    .bind(new Date().toISOString(), auth.sub, auth.sid)
    .run()
  await c.env.AUTH_KV.put(killKey(auth.sid), '1', { expirationTtl: REFRESH_IDLE_DAYS * 86_400 })
  return c.json({ ok: true })
})

export default me
