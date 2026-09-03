/**
 * A user's own devices: what the desktop's Mobile panel lists as "paired
 * phones", and the unpair action behind it. A device is PAIRED while it has
 * a live session; revoking those sessions (and the device row) is what
 * unpairing means — the phone's next request fails, its bridge socket is
 * closed on the spot, and its push registration is dropped.
 */
import { Hono } from 'hono'
import { killKey, REFRESH_IDLE_DAYS, requireAuth, type AuthVars } from '@/middleware/auth'
import { closeBridgeDevice, notifyBridge } from '@/routes/bridge'
import type { Env } from '@/index'

const devices = new Hono<{ Bindings: Env; Variables: AuthVars }>()
devices.use('*', requireAuth)

const nowIso = () => new Date().toISOString()

type DeviceRow = {
  id: string
  platform: string
  name: string
  app_version: string
  status: string
  created_at: string
  last_seen_at: string | null
  sessions: number
}

devices.get('/devices', async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.platform, d.name, d.app_version, d.status, d.created_at, d.last_seen_at,
       (SELECT COUNT(*) FROM device_sessions s
         WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?2) AS sessions
     FROM devices d WHERE d.user_id = ?1 AND d.status = 'active'
     ORDER BY d.created_at`
  )
    .bind(auth.sub, nowIso())
    .all<DeviceRow>()
  return c.json({
    devices: (rows.results ?? []).map((d) => ({
      id: d.id,
      platform: d.platform,
      name: d.name,
      app_version: d.app_version,
      created_at: d.created_at,
      last_seen_at: d.last_seen_at,
      paired: d.sessions > 0,
      current: d.id === auth.dev
    }))
  })
})

/**
 * Revoke one of the caller's devices — every session it holds, the row
 * itself, its bridge socket and push registration. Refuses the caller's own
 * device: signing out is /v1/logout, and a client must not be able to saw
 * off the branch it is sitting on by accident.
 */
devices.delete('/devices/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (id === auth.dev)
    return c.json({ error: 'invalid_request', detail: 'use /v1/logout for this device' }, 400)
  const device = await c.env.DB.prepare('SELECT id FROM devices WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.sub)
    .first<{ id: string }>()
  if (!device) return c.json({ error: 'not_found' }, 404)
  const sessions = await c.env.DB.prepare(
    'SELECT id FROM device_sessions WHERE device_id = ?1 AND revoked_at IS NULL'
  )
    .bind(id)
    .all<{ id: string }>()
  const now = nowIso()
  const statements = [
    c.env.DB.prepare('UPDATE devices SET status = ?1 WHERE id = ?2').bind('revoked', id),
    c.env.DB.prepare(
      'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE device_id = ?3 AND revoked_at IS NULL'
    ).bind(now, auth.sub, id)
  ]
  await c.env.DB.batch(statements)
  for (const row of sessions.results ?? []) {
    await c.env.AUTH_KV.put(killKey(row.id), '1', {
      expirationTtl: REFRESH_IDLE_DAYS * 86_400
    })
  }
  await closeBridgeDevice(c.env, auth.sub, id)
  // Every desktop of the user re-lists — the one that unpaired already
  // does, but another signed-in desktop would otherwise keep the phone.
  await notifyBridge(c.env, auth.sub, 'desktop', 'device.revoked', {
    deviceId: id
  })
  return c.json({ ok: true, revoked: (sessions.results ?? []).length })
})

export default devices
