/**
 * Auth: password login, forced first-login reset, refresh rotation, logout.
 *
 * Sessions: access JWT (15 min) + rotating refresh token `<sid>.<secret>`
 * whose secret is stored only as a SHA-256 hash. A presented refresh
 * secret that doesn't match the current hash is treated as reuse (possible
 * theft) and kills the session. Revocation = D1 truth + KV kill marker.
 */
import { Hono } from 'hono'
import {
  hashPassword,
  newId,
  randomHex,
  sha256Hex,
  timingSafeEqualHex
} from '@/lib/crypto'
import { signJwt, verifyJwt, type AccessClaims } from '@/lib/jwt'
import { LoginSchema, PasswordChangeSchema, RefreshSchema } from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { ACCESS_TTL_SECONDS, REFRESH_IDLE_DAYS, killKey } from '@/middleware/auth'
import type { Env } from '@/index'

type UserRow = {
  id: string
  email: string
  name: string
  role: AccessClaims['role']
  status: 'invited' | 'active' | 'suspended' | 'removed'
  password_hash: string
  password_salt: string
  must_change_password: number
  temp_password_expires_at: string | null
}

const auth = new Hono<{ Bindings: Env }>()

const nowIso = () => new Date().toISOString()
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function bumpRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const current = parseInt((await kv.get(key)) ?? '0', 10)
  if (current >= limit) return false
  // Non-atomic by design: KV races undercount slightly, which only makes
  // the limit marginally looser. Good enough for a login throttle.
  await kv.put(key, String(current + 1), { expirationTtl: windowSeconds })
  return true
}

async function issueSession(
  c: { env: Env },
  user: UserRow,
  deviceId: string
): Promise<{ access_token: string; expires_in: number; refresh_token: string; session_id: string }> {
  const sessionId = newId('ses')
  const secret = randomHex(32)
  const refreshHash = await sha256Hex(secret)
  await c.env.DB.prepare(
    `INSERT INTO device_sessions (id, user_id, device_id, refresh_hash, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(sessionId, user.id, deviceId, refreshHash, addDays(REFRESH_IDLE_DAYS))
    .run()

  const now = Math.floor(Date.now() / 1000)
  const access = await signJwt(
    {
      iss: 'wfc-api',
      sub: user.id,
      dev: deviceId,
      sid: sessionId,
      role: user.role,
      scope: 'session',
      iat: now,
      exp: now + ACCESS_TTL_SECONDS
    },
    c.env.JWT_SECRET
  )
  return {
    access_token: access,
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: `${sessionId}.${secret}`,
    session_id: sessionId
  }
}

auth.post('/login', async (c) => {
  const body = await parseJson(c, LoginSchema)
  if (body instanceof Response) return body

  const email = body.email.trim().toLowerCase()
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:login:${email}`, 10, 900)) ||
    // Per-email is the brute-force guard; the IP cap only blunts sprays and
    // must clear a whole office (or the 50-agent simulator) behind one NAT.
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:ip:${ip}`, 200, 900))
  ) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  if (!user) return c.json({ error: 'invalid_credentials' }, 401)
  if (user.status === 'suspended' || user.status === 'removed') {
    return c.json({ error: 'account_disabled' }, 403)
  }

  const hash = await hashPassword(body.password, user.password_salt)
  if (!timingSafeEqualHex(hash, user.password_hash)) {
    return c.json({ error: 'invalid_credentials' }, 401)
  }

  if (user.must_change_password) {
    if (user.temp_password_expires_at && user.temp_password_expires_at < nowIso()) {
      return c.json({ error: 'temp_password_expired' }, 403)
    }
    const now = Math.floor(Date.now() / 1000)
    const changeToken = await signJwt(
      {
        iss: 'wfc-api',
        sub: user.id,
        dev: '',
        sid: '',
        role: user.role,
        scope: 'password_change',
        iat: now,
        exp: now + 600
      },
      c.env.JWT_SECRET
    )
    return c.json({ must_change_password: true, change_token: changeToken })
  }

  // Reuse the caller's device row when it really is theirs; else create one.
  const d = body.device ?? {}
  let deviceId = ''
  if (d.id) {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM devices WHERE id = ?1 AND user_id = ?2 AND status = ?3'
    )
      .bind(d.id, user.id, 'active')
      .first<{ id: string }>()
    if (existing) deviceId = existing.id
  }
  if (!deviceId) {
    deviceId = newId('dev')
    await c.env.DB.prepare(
      `INSERT INTO devices (id, user_id, platform, name, app_version)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(deviceId, user.id, d.platform ?? 'desktop', d.name ?? '', d.app_version ?? '')
      .run()
  }
  await c.env.DB.prepare(
    'UPDATE devices SET last_seen_at = ?1, app_version = ?2 WHERE id = ?3'
  )
    .bind(nowIso(), d.app_version ?? '', deviceId)
    .run()
  await c.env.DB.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2')
    .bind(nowIso(), user.id)
    .run()

  const session = await issueSession(c, user, deviceId)
  return c.json({
    ...session,
    device_id: deviceId,
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  })
})

auth.post('/password', async (c) => {
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const claims = await verifyJwt(token, c.env.JWT_SECRET)
  if (!claims || (claims.scope !== 'password_change' && claims.scope !== 'session')) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const body = await parseJson(c, PasswordChangeSchema)
  if (body instanceof Response) return body

  const salt = randomHex(16)
  const hash = await hashPassword(body.new_password, salt)
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?1, password_salt = ?2, must_change_password = 0,
       temp_password_expires_at = NULL,
       status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
       updated_at = ?3
     WHERE id = ?4`
  )
    .bind(hash, salt, nowIso(), claims.sub)
    .run()
  return c.json({ ok: true })
})

auth.post('/refresh', async (c) => {
  const body = await parseJson(c, RefreshSchema)
  if (body instanceof Response) return body
  const raw = body.refresh_token
  const dot = raw.indexOf('.')
  if (dot <= 0) return c.json({ error: 'invalid_refresh' }, 401)
  const sessionId = raw.slice(0, dot)
  const secret = raw.slice(dot + 1)

  const session = await c.env.DB.prepare('SELECT * FROM device_sessions WHERE id = ?1')
    .bind(sessionId)
    .first<{
      id: string
      user_id: string
      device_id: string
      refresh_hash: string
      refresh_generation: number
      expires_at: string
      revoked_at: string | null
    }>()
  if (!session || session.revoked_at || session.expires_at < nowIso()) {
    return c.json({ error: 'invalid_refresh' }, 401)
  }

  const presentedHash = await sha256Hex(secret)
  if (!timingSafeEqualHex(presentedHash, session.refresh_hash)) {
    // Reuse of a rotated-out secret: assume compromise, kill the session.
    await c.env.DB.prepare(
      'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3'
    )
      .bind(nowIso(), 'reuse_detection', sessionId)
      .run()
    await c.env.AUTH_KV.put(killKey(sessionId), '1', {
      expirationTtl: REFRESH_IDLE_DAYS * 86_400
    })
    return c.json({ error: 'refresh_reuse_detected' }, 401)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(session.user_id)
    .first<UserRow>()
  if (!user || user.status !== 'active') return c.json({ error: 'account_disabled' }, 403)

  const newSecret = randomHex(32)
  await c.env.DB.prepare(
    `UPDATE device_sessions SET refresh_hash = ?1, refresh_generation = refresh_generation + 1,
       refreshed_at = ?2, expires_at = ?3 WHERE id = ?4`
  )
    .bind(await sha256Hex(newSecret), nowIso(), addDays(REFRESH_IDLE_DAYS), sessionId)
    .run()

  const now = Math.floor(Date.now() / 1000)
  const access = await signJwt(
    {
      iss: 'wfc-api',
      sub: user.id,
      dev: session.device_id,
      sid: sessionId,
      role: user.role,
      scope: 'session',
      iat: now,
      exp: now + ACCESS_TTL_SECONDS
    },
    c.env.JWT_SECRET
  )
  return c.json({
    access_token: access,
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: `${sessionId}.${newSecret}`,
    session_id: sessionId
  })
})

export default auth
