/**
 * Admin layer — the enterprise controls, as pure API. The admin UI lives
 * inside the admin's own desktop client; every endpoint here re-verifies
 * the role server-side, so the UI is presentation only.
 *
 * Reads: owner, admin, support (support is the view-only tier).
 * Mutations: owner, admin — and only an owner may touch an owner.
 * Every mutation writes an audit_log row.
 */
import { Hono } from 'hono'
import { hashPassword, newId, randomHex, tempPassword } from '@/lib/crypto'
import {
  ClearPinSchema,
  InviteSchema,
  OrgPatchSchema,
  PolicyPutSchema,
  UserPatchSchema
} from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import {
  requireAuth,
  requireAdmin,
  requireRole,
  killKey,
  REFRESH_IDLE_DAYS,
  type AuthVars
} from '@/middleware/auth'
import type { Env } from '@/index'

const admin = new Hono<{ Bindings: Env; Variables: AuthVars }>()
const nowIso = () => new Date().toISOString()

admin.use('*', requireAuth)
admin.use('*', requireRole('owner', 'admin', 'support'))

// Mutations are admin-tier; support stays read-only.
admin.on(['POST', 'PATCH', 'PUT', 'DELETE'], '*', requireAdmin)

async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {}
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor_user_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)'
  )
    .bind(actor, action, target, JSON.stringify(detail))
    .run()
}

/** Only an owner may act on an owner (or mint one). */
async function ownerGuard(
  env: Env,
  actorRole: string,
  targetUserId: string | null,
  requestedRole?: string
): Promise<boolean> {
  if (actorRole === 'owner') return true
  if (requestedRole === 'owner') return false
  if (!targetUserId) return true
  const target = await env.DB.prepare('SELECT role FROM users WHERE id = ?1')
    .bind(targetUserId)
    .first<{ role: string }>()
  return target?.role !== 'owner'
}

async function revokeSessions(env: Env, sessionIds: string[], revokedBy: string): Promise<void> {
  for (const sid of sessionIds) {
    await env.DB.prepare(
      'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND revoked_at IS NULL'
    )
      .bind(nowIso(), revokedBy, sid)
      .run()
    await env.AUTH_KV.put(killKey(sid), '1', { expirationTtl: REFRESH_IDLE_DAYS * 86_400 })
  }
}

async function activeSessionIds(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT id FROM device_sessions WHERE user_id = ?1 AND revoked_at IS NULL'
  )
    .bind(userId)
    .all<{ id: string }>()
  return (rows.results ?? []).map((r) => r.id)
}

// ── Users ────────────────────────────────────────────────────────────────

admin.post('/users', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, InviteSchema)
  if (body instanceof Response) return body
  const email = body.email.trim().toLowerCase()
  const name = body.name.trim()
  const role = body.role
  if (!(await ownerGuard(c.env, auth.role, null, role))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can mint owners' }, 403)
  }

  const temp = tempPassword()
  const salt = randomHex(16)
  const hash = await hashPassword(temp, salt)
  const id = newId('usr')
  const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString()
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, role, status, password_hash, password_salt,
         must_change_password, temp_password_expires_at)
       VALUES (?1, ?2, ?3, ?4, 'invited', ?5, ?6, 1, ?7)`
    )
      .bind(id, email, name, role, hash, salt, expiry)
      .run()
  } catch {
    return c.json({ error: 'email_taken' }, 409)
  }
  await audit(c.env, auth.sub, 'user.invite', id, { email, role })
  // The temp password appears exactly once, here, for the admin to convey.
  return c.json({ user_id: id, email, role, temp_password: temp, temp_password_expires_at: expiry })
})

admin.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, must_change_password, created_at, last_login_at
     FROM users ORDER BY created_at`
  ).all()
  return c.json({ users: rows.results ?? [] })
})

admin.get('/users/:id', async (c) => {
  const id = c.req.param('id')
  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, must_change_password, created_at, updated_at, last_login_at
     FROM users WHERE id = ?1`
  )
    .bind(id)
    .first()
  if (!user) return c.json({ error: 'not_found' }, 404)
  const [devices, sessions, policy] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY created_at').bind(id).all(),
    c.env.DB.prepare(
      `SELECT id, device_id, issued_at, refreshed_at, expires_at, revoked_at
       FROM device_sessions WHERE user_id = ?1 ORDER BY issued_at DESC LIMIT 20`
    )
      .bind(id)
      .all(),
    c.env.DB.prepare('SELECT * FROM model_policies WHERE user_id = ?1').bind(id).first()
  ])
  return c.json({
    user,
    devices: devices.results ?? [],
    sessions: sessions.results ?? [],
    policy: policy ?? null
  })
})

admin.patch('/users/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await parseJson(c, UserPatchSchema)
  if (body instanceof Response) return body
  if (id === auth.sub && (body.role || body.status)) {
    return c.json({ error: 'forbidden', detail: 'cannot change own role or status' }, 403)
  }
  if (!(await ownerGuard(c.env, auth.role, id, body.role))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can modify an owner' }, 403)
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!existing) return c.json({ error: 'not_found' }, 404)

  await c.env.DB.prepare(
    `UPDATE users SET
       name = COALESCE(?1, name),
       role = COALESCE(?2, role),
       status = COALESCE(?3, status),
       updated_at = ?4
     WHERE id = ?5`
  )
    .bind(body.name ?? null, body.role ?? null, body.status ?? null, nowIso(), id)
    .run()

  // Suspension is a security event: kill every live session immediately.
  if (body.status === 'suspended') {
    await revokeSessions(c.env, await activeSessionIds(c.env, id), auth.sub)
  }
  await audit(c.env, auth.sub, 'user.update', id, body)
  return c.json({ ok: true })
})

admin.post('/users/:id/reset-password', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!(await ownerGuard(c.env, auth.role, id))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can modify an owner' }, 403)
  }
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)

  const temp = tempPassword()
  const salt = randomHex(16)
  const hash = await hashPassword(temp, salt)
  const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString()
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?1, password_salt = ?2, must_change_password = 1,
       temp_password_expires_at = ?3, updated_at = ?4 WHERE id = ?5`
  )
    .bind(hash, salt, expiry, nowIso(), id)
    .run()
  await revokeSessions(c.env, await activeSessionIds(c.env, id), auth.sub)
  await audit(c.env, auth.sub, 'user.reset_password', id)
  return c.json({ user_id: id, temp_password: temp, temp_password_expires_at: expiry })
})

admin.post('/users/:id/clear-pin', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await parseJson(c, ClearPinSchema)
  if (body instanceof Response) return body
  const result = await c.env.DB.prepare(
    body?.device_id
      ? 'UPDATE devices SET pin_clear_requested = 1 WHERE user_id = ?1 AND id = ?2'
      : 'UPDATE devices SET pin_clear_requested = 1 WHERE user_id = ?1'
  )
    .bind(...(body?.device_id ? [id, body.device_id] : [id]))
    .run()
  if ((result.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404)
  await audit(c.env, auth.sub, 'device.clear_pin', id, { device_id: body?.device_id ?? 'all' })
  return c.json({ ok: true })
})

admin.post('/users/:id/revoke-sessions', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!(await ownerGuard(c.env, auth.role, id))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can modify an owner' }, 403)
  }
  const sessions = await activeSessionIds(c.env, id)
  await revokeSessions(c.env, sessions, auth.sub)
  await audit(c.env, auth.sub, 'user.revoke_sessions', id, { count: sessions.length })
  return c.json({ ok: true, revoked: sessions.length })
})

// ── Model policy ─────────────────────────────────────────────────────────

admin.put('/users/:id/policy', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await parseJson(c, PolicyPutSchema)
  if (body instanceof Response) return body
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)

  await c.env.DB.prepare(
    `INSERT INTO model_policies (user_id, allowed_models, daily_token_cap, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       allowed_models = excluded.allowed_models,
       daily_token_cap = excluded.daily_token_cap,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      body.allowed_models === undefined || body.allowed_models === null
        ? null
        : JSON.stringify(body.allowed_models),
      body.daily_token_cap ?? null,
      nowIso()
    )
    .run()
  // The router reads policy from CONFIG_KV; refresh the cached copy now.
  await c.env.CONFIG_KV.delete(`policy:${id}`)
  await audit(c.env, auth.sub, 'policy.set', id, body)
  return c.json({ ok: true })
})

// ── Org settings ─────────────────────────────────────────────────────────

admin.get('/org', async (c) => {
  const org = await c.env.DB.prepare('SELECT * FROM org WHERE id = 1').first()
  return c.json({ org: org ?? null })
})

admin.patch('/org', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, OrgPatchSchema)
  if (body instanceof Response) return body

  // Semantic guard no schema can express: the resulting default model must
  // be inside the resulting allowlist, or every employee on org defaults
  // would be pointed at a model the router refuses.
  if (body.default_model !== undefined || body.default_allowed_models !== undefined) {
    const current = await c.env.DB.prepare(
      'SELECT default_model, default_allowed_models FROM org WHERE id = 1'
    ).first<{ default_model: string; default_allowed_models: string }>()
    if (current) {
      let currentList: string[] = []
      try {
        const parsed = JSON.parse(current.default_allowed_models)
        if (Array.isArray(parsed)) currentList = parsed
      } catch {}
      const resultingDefault = body.default_model ?? current.default_model
      const resultingList = body.default_allowed_models ?? currentList
      if (resultingList.length > 0 && !resultingList.includes(resultingDefault)) {
        return c.json(
          {
            error: 'invalid_request',
            issues: [
              {
                path: 'default_model',
                message: 'resulting default_model must be included in default_allowed_models'
              }
            ]
          },
          400
        )
      }
    }
  }

  await c.env.DB.prepare(
    `UPDATE org SET
       name = COALESCE(?1, name),
       default_model = COALESCE(?2, default_model),
       default_allowed_models = COALESCE(?3, default_allowed_models),
       user_daily_token_cap = COALESCE(?4, user_daily_token_cap),
       org_monthly_token_cap = COALESCE(?5, org_monthly_token_cap),
       updated_at = ?6
     WHERE id = 1`
  )
    .bind(
      body.name ?? null,
      body.default_model ?? null,
      body.default_allowed_models ? JSON.stringify(body.default_allowed_models) : null,
      body.user_daily_token_cap ?? null,
      body.org_monthly_token_cap ?? null,
      nowIso()
    )
    .run()
  await c.env.CONFIG_KV.delete('org')
  await audit(c.env, auth.sub, 'org.update', 'org', body)
  return c.json({ ok: true })
})

// ── Usage & audit ────────────────────────────────────────────────────────

admin.get('/usage', async (c) => {
  const since = c.req.query('since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
  const userId = c.req.query('user_id') ?? null
  const [totals, recent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT user_id, COUNT(*) AS requests,
         SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(cost_microusd) AS cost_microusd,
         SUM(CASE WHEN decision != 'allowed' THEN 1 ELSE 0 END) AS denied
       FROM usage WHERE created_at >= ?1 AND (?2 IS NULL OR user_id = ?2)
       GROUP BY user_id ORDER BY cost_microusd DESC`
    )
      .bind(since, userId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM usage WHERE created_at >= ?1 AND (?2 IS NULL OR user_id = ?2)
       ORDER BY id DESC LIMIT 100`
    )
      .bind(since, userId)
      .all()
  ])
  return c.json({ since, totals: totals.results ?? [], recent: recent.results ?? [] })
})

admin.get('/audit', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500)
  const rows = await c.env.DB.prepare(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1'
  )
    .bind(limit)
    .all()
  return c.json({ entries: rows.results ?? [] })
})

export default admin
