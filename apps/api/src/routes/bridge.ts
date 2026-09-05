/**
 * The bridge's HTTP face: the WebSocket door for both devices and the
 * presence read the phone uses as its fast "is my desktop up" check.
 *
 * Auth is the ordinary session token. The upgrade also accepts it as an
 * `access_token` query parameter, because a browser-style WebSocket (and
 * Node's built-in one, which the release gate uses) cannot set a header —
 * it is the same 15-minute token either way, and the socket is authenticated
 * once, at open.
 */
import { Hono } from 'hono'
import { verifyJwt, type AccessClaims } from '@/lib/jwt'
import { killKey, requireAuth, type AuthVars } from '@/middleware/auth'
import type { Env } from '@/index'

const bridge = new Hono<{ Bindings: Env; Variables: AuthVars }>()

function stubFor(env: Env, userId: string): DurableObjectStub {
  return env.USER_BRIDGE.get(env.USER_BRIDGE.idFromName(userId))
}

/** Server-originated event into a user's bridge (a pairing claimed, …). */
export async function notifyBridge(
  env: Env,
  userId: string,
  to: 'desktop' | 'phone',
  topic: string,
  payload: unknown
): Promise<void> {
  try {
    await stubFor(env, userId).fetch('https://bridge/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, topic, payload })
    })
  } catch (err) {
    console.error('bridge event failed', { topic, message: (err as Error).message })
  }
}

/** Close a device's sockets and forget its push registration — the tail of
 *  every revocation, so a signed-out phone stops receiving at once. */
export async function closeBridgeDevice(env: Env, userId: string, deviceId: string): Promise<void> {
  try {
    await stubFor(env, userId).fetch(`https://bridge/close?device=${encodeURIComponent(deviceId)}`, {
      method: 'POST'
    })
  } catch (err) {
    console.error('bridge close failed', { deviceId, message: (err as Error).message })
  }
}

bridge.get('/bridge/ws', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected_websocket' }, 426)
  }
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : (c.req.query('access_token') ?? '')
  const claims: AccessClaims | null = token ? await verifyJwt(token, c.env.JWT_SECRET) : null
  if (!claims || claims.scope !== 'session') return c.json({ error: 'unauthorized' }, 401)
  if ((await c.env.AUTH_KV.get(killKey(claims.sid))) !== null) {
    return c.json({ error: 'session_revoked' }, 401)
  }
  const role = c.req.query('role') === 'desktop' ? 'desktop' : 'phone'
  const device = await c.env.DB.prepare(
    'SELECT platform, name, app_version, model, os, os_version, status FROM devices WHERE id = ?1'
  )
    .bind(claims.dev)
    .first<{
      platform: string
      name: string
      app_version: string
      model: string
      os: string
      os_version: string
      status: string
    }>()
  if (!device || device.status !== 'active') return c.json({ error: 'unauthorized' }, 401)
  // What the device says about itself on the way in. Every connect is a
  // chance to correct the stored row (a renamed phone, an OS upgrade), so
  // these ride the socket and the object writes them back.
  const headers = new Headers({
    upgrade: 'websocket',
    'x-wfc-role': role,
    'x-wfc-user': claims.sub,
    'x-wfc-device': claims.dev,
    'x-wfc-session': claims.sid,
    'x-wfc-name': (c.req.query('name') ?? device.name ?? '').slice(0, 120),
    'x-wfc-platform': (c.req.query('platform') ?? device.platform ?? '').slice(0, 32),
    'x-wfc-version': (c.req.query('version') ?? device.app_version ?? '').slice(0, 64),
    'x-wfc-model': (c.req.query('model') ?? device.model ?? '').slice(0, 120),
    'x-wfc-os': (c.req.query('os') ?? device.os ?? '').slice(0, 32),
    'x-wfc-os-version': (c.req.query('os_version') ?? device.os_version ?? '').slice(0, 60)
  })
  return stubFor(c.env, claims.sub).fetch('https://bridge/ws', { headers })
})

bridge.use('/bridge/status', requireAuth)
bridge.get('/bridge/status', async (c) => {
  const auth = c.get('auth')
  const res = await stubFor(c.env, auth.sub).fetch('https://bridge/status')
  const presence = (await res.json()) as Record<string, unknown>
  return c.json({ ...presence, at: new Date().toISOString() })
})

export default bridge
