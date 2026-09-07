/**
 * Auth: password login, account activation, forced first-login reset,
 * refresh rotation, logout.
 *
 * Sessions: access JWT (15 min) + rotating refresh token `<sid>.<secret>`
 * whose secret is stored only as a SHA-256 hash. A presented refresh
 * secret that doesn't match the current hash is treated as reuse (possible
 * theft) and kills the session. Revocation is D1 alone: every path here
 * writes `device_sessions.revoked_at`, and that row is what the auth
 * middleware reads on each request (see middleware/auth.ts).
 */
import { Hono } from 'hono'
import {
  hashPassword,
  newId,
  randomHex,
  sha256Hex,
  sixDigitCode,
  timingSafeEqualHex
} from '@/lib/crypto'
import { signJwt, verifyJwt, type AccessClaims } from '@/lib/jwt'
import {
  ACTIVATION_MAX_ATTEMPTS,
  dropActivation,
  issueActivation,
  sendActivationEmail
} from '@/lib/activation'
import { sendSystemEmail } from '@/lib/email'
import { getOrgConfig } from '@/lib/policy'
import {
  ActivateConfirmSchema,
  ActivateRequestSchema,
  LoginSchema,
  PasswordChangeSchema,
  RefreshSchema,
  ResetConfirmSchema,
  ResetRequestSchema
} from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { ACCESS_TTL_SECONDS, REFRESH_IDLE_DAYS } from '@/middleware/auth'
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
  // the limit marginally looser. Good enough for a login throttle. KV also
  // allows one write per key per second and throws a 429 above it — an
  // office signing in together writes the same IP key many times a second,
  // and a throttle's bookkeeping must never fail the login itself.
  try {
    await kv.put(key, String(current + 1), { expirationTtl: windowSeconds })
  } catch {
    // A concurrent login already bumped this key within the second.
  }
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
    // must clear a whole 500-employee office (or the 500-agent load
    // simulation) signing in behind one NAT within the window.
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:ip:${ip}`, 2000, 900))
  ) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  // Internal tool by design: precise failure codes beat enumeration-proofing.
  if (!user) return c.json({ error: 'email_not_found' }, 401)
  if (user.status === 'suspended' || user.status === 'removed') {
    return c.json({ error: 'account_disabled' }, 403)
  }

  const hash = await hashPassword(body.password, user.password_salt)
  if (!timingSafeEqualHex(hash, user.password_hash)) {
    return c.json({ error: 'wrong_password' }, 401)
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

  // A voluntary change (normal session) must prove the current password;
  // the forced first-login flow's change token already proved it at login.
  if (claims.scope === 'session') {
    const row = await c.env.DB.prepare(
      'SELECT password_hash, password_salt FROM users WHERE id = ?1'
    )
      .bind(claims.sub)
      .first<{ password_hash: string; password_salt: string }>()
    if (!row) return c.json({ error: 'unauthorized' }, 401)
    const current = body.current_password ?? ''
    const currentHash = current ? await hashPassword(current, row.password_salt) : ''
    if (!current || !timingSafeEqualHex(currentHash, row.password_hash)) {
      return c.json({ error: 'wrong_password' }, 401)
    }
  }

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
  await dropActivation(c.env, claims.sub)
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
    return c.json({ error: 'refresh_reuse_detected' }, 401)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(session.user_id)
    .first<UserRow>()
  if (!user || user.status !== 'active') return c.json({ error: 'account_disabled' }, 403)

  const newSecret = randomHex(32)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE device_sessions SET refresh_hash = ?1, refresh_generation = refresh_generation + 1,
         refreshed_at = ?2, expires_at = ?3 WHERE id = ?4`
    ).bind(await sha256Hex(newSecret), nowIso(), addDays(REFRESH_IDLE_DAYS), sessionId),
    // A rotating refresh is the device saying "still here" — the paired-
    // devices list reads last_seen_at, so it moves on every one.
    c.env.DB.prepare('UPDATE devices SET last_seen_at = ?1 WHERE id = ?2').bind(
      nowIso(),
      session.device_id
    )
  ])

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


// ── Password reset: emailed 6-digit code, then a new password ────────────
// The code lives in D1 (one row per user) for 10 minutes with 5 tries,
// stored plain: it is short-lived, single-purpose, and admins already hold
// a stronger reset power — which is also what lets the release gate read it
// to prove the flow end to end. D1 rather than KV because a used code must
// be dead at once, everywhere: KV's eventual consistency let a code be
// replayed with a different password for up to a minute after use.

export const RESET_TTL_SECONDS = 600

auth.post('/reset/request', async (c) => {
  const body = await parseJson(c, ResetRequestSchema)
  if (body instanceof Response) return body
  const email = body.email.trim().toLowerCase()
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:reset:${email}`, 3, 900)) ||
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:resetip:${ip}`, 30, 900))
  ) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  if (!user) return c.json({ error: 'email_not_found' }, 401)
  if (user.status === 'suspended' || user.status === 'removed') {
    return c.json({ error: 'account_disabled' }, 403)
  }

  const code = sixDigitCode()
  await c.env.DB.prepare(
    `INSERT INTO password_resets (user_id, code, attempts, expires_at) VALUES (?1, ?2, 0, ?3)
     ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, attempts = 0,
       expires_at = excluded.expires_at, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  )
    .bind(user.id, code, new Date(Date.now() + RESET_TTL_SECONDS * 1000).toISOString())
    .run()
  const sent = await sendSystemEmail(c.env, {
    to: user.email,
    subject: `${code} is your Wolffish Cloud reset code`,
    heading: 'Reset your password',
    lines: [
      `Hi ${user.name.split(' ')[0] ?? ''}, use this code to reset your Wolffish Cloud password. It expires in 10 minutes.`,
      'If you did not ask for a reset, you can ignore this email — your password is unchanged.'
    ],
    code
  })
  if (!sent.ok) {
    return c.json({ error: sent.code, detail: sent.detail }, 502)
  }
  return c.json({ ok: true, expires_in: RESET_TTL_SECONDS })
})

auth.post('/reset/confirm', async (c) => {
  const body = await parseJson(c, ResetConfirmSchema)
  if (body instanceof Response) return body
  const email = body.email.trim().toLowerCase()
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (!(await bumpRateLimit(c.env.AUTH_KV, `rl:resetc:${ip}`, 60, 900))) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  if (!user) return c.json({ error: 'email_not_found' }, 401)

  const entry = await c.env.DB.prepare(
    'SELECT code, attempts, expires_at FROM password_resets WHERE user_id = ?1'
  )
    .bind(user.id)
    .first<{ code: string; attempts: number; expires_at: string }>()
  const dropEntry = () =>
    c.env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?1').bind(user.id).run()
  if (!entry) return c.json({ error: 'code_expired' }, 401)
  if (entry.expires_at < nowIso() || entry.attempts >= 5) {
    await dropEntry()
    return c.json({ error: 'code_expired' }, 401)
  }
  if (!timingSafeEqualHex(entry.code, body.code)) {
    await c.env.DB.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?1')
      .bind(user.id)
      .run()
    return c.json({ error: 'invalid_code' }, 401)
  }
  // Single-use, enforced by a consistent store: the row is gone before the
  // new password is usable anywhere, so the same code can never be replayed.
  const consumed = await dropEntry()
  if ((consumed.meta.changes ?? 0) === 0) return c.json({ error: 'code_expired' }, 401)

  const salt = randomHex(16)
  const hash = await hashPassword(body.new_password, salt)
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?1, password_salt = ?2, must_change_password = 0,
       temp_password_expires_at = NULL,
       status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
       updated_at = ?3
     WHERE id = ?4`
  )
    .bind(hash, salt, nowIso(), user.id)
    .run()
  await dropActivation(c.env, user.id)

  // A reset is a "someone else may know my password" event: every existing
  // session dies with it.
  const sessions = await c.env.DB.prepare(
    'SELECT id FROM device_sessions WHERE user_id = ?1 AND revoked_at IS NULL'
  )
    .bind(user.id)
    .all<{ id: string }>()
  for (const row of sessions.results ?? []) {
    await c.env.DB.prepare(
      'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3'
    )
      .bind(nowIso(), 'password_reset', row.id)
      .run()
  }
  return c.json({ ok: true })
})

// ── Account activation: the emailed invite code, then a password ─────────
// An invited account has no password anyone holds — the code IS the only
// way in, and entering it is what proves the address belongs to the person.
// Mechanically identical to the reset flow (D1 row, single use, attempt
// capped) with one extra precondition: the account must still be 'invited'.
// A longer window (7 days) and a looser attempt cap live in lib/activation.

auth.post('/activate/request', async (c) => {
  const body = await parseJson(c, ActivateRequestSchema)
  if (body instanceof Response) return body
  const email = body.email.trim().toLowerCase()
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:activate:${email}`, 3, 900)) ||
    !(await bumpRateLimit(c.env.AUTH_KV, `rl:activateip:${ip}`, 30, 900))
  ) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  if (!user) return c.json({ error: 'email_not_found' }, 401)
  if (user.status === 'suspended' || user.status === 'removed') {
    return c.json({ error: 'account_disabled' }, 403)
  }
  // Nothing to activate — this account already has a password, so the way
  // back in is a reset. Saying so beats a code that would never work.
  if (user.status !== 'invited') return c.json({ error: 'already_active' }, 409)

  const { code } = await issueActivation(c.env, user.id)
  const org = await getOrgConfig(c.env)
  const sent = await sendActivationEmail(
    c.env,
    { email: user.email, name: user.name },
    code,
    org?.name || 'Wolffish Cloud'
  )
  if (!sent.ok) return c.json({ error: sent.code, detail: sent.detail }, 502)
  return c.json({ ok: true })
})

auth.post('/activate/confirm', async (c) => {
  const body = await parseJson(c, ActivateConfirmSchema)
  if (body instanceof Response) return body
  const email = body.email.trim().toLowerCase()
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (!(await bumpRateLimit(c.env.AUTH_KV, `rl:activatec:${ip}`, 60, 900))) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?1')
    .bind(email)
    .first<UserRow>()
  if (!user) return c.json({ error: 'email_not_found' }, 401)
  if (user.status === 'suspended' || user.status === 'removed') {
    return c.json({ error: 'account_disabled' }, 403)
  }
  if (user.status !== 'invited') return c.json({ error: 'already_active' }, 409)

  const entry = await c.env.DB.prepare(
    'SELECT code, attempts, expires_at FROM account_activations WHERE user_id = ?1'
  )
    .bind(user.id)
    .first<{ code: string; attempts: number; expires_at: string }>()
  if (!entry) return c.json({ error: 'code_expired' }, 401)
  if (entry.expires_at < nowIso() || entry.attempts >= ACTIVATION_MAX_ATTEMPTS) {
    await dropActivation(c.env, user.id)
    return c.json({ error: 'code_expired' }, 401)
  }
  if (!timingSafeEqualHex(entry.code, body.code)) {
    await c.env.DB.prepare(
      'UPDATE account_activations SET attempts = attempts + 1 WHERE user_id = ?1'
    )
      .bind(user.id)
      .run()
    return c.json({ error: 'invalid_code' }, 401)
  }
  // Single use, enforced by a consistent store: the row is gone before the
  // password exists, so the same code can never mint a second one.
  const consumed = await c.env.DB.prepare(
    'DELETE FROM account_activations WHERE user_id = ?1'
  )
    .bind(user.id)
    .run()
  if ((consumed.meta.changes ?? 0) === 0) return c.json({ error: 'code_expired' }, 401)

  const salt = randomHex(16)
  const hash = await hashPassword(body.new_password, salt)
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?1, password_salt = ?2, must_change_password = 0,
       temp_password_expires_at = NULL, status = 'active', updated_at = ?3
     WHERE id = ?4`
  )
    .bind(hash, salt, nowIso(), user.id)
    .run()
  return c.json({ ok: true, email: user.email, name: user.name })
})

export default auth
