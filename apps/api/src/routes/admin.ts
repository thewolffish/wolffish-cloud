/**
 * Admin layer — the enterprise controls, as pure API. The admin UI lives
 * inside the admin's own desktop client; every endpoint here re-verifies
 * the role server-side, so the UI is presentation only.
 *
 * Reads: owner, admin, support (support is the view-only tier).
 * Mutations: owner, admin — and only an owner may touch an owner.
 * Every mutation writes an audit_log row.
 */
import { Hono, type Context } from 'hono'
import { deleteCapability, putCapability } from '@/lib/capabilities'
import { openConfig, sealConfig } from '@/lib/config-crypto'
import { hashPassword, newId, randomHex, tempPassword } from '@/lib/crypto'
import { ceilingsFor, normalizePlan, PLAN_CEILINGS, TOKEN_PLANS } from '@/lib/plans'
import { policyCacheKey } from '@/lib/policy'
import { readRecordsPage, RECORDS_PAGE_MAX } from '@/lib/records'
import {
  ClearPinSchema,
  ConfigPutSchema,
  InviteSchema,
  OrgPatchSchema,
  PlanPutSchema,
  PolicyPutSchema,
  UserPatchSchema
} from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { runNightly } from '@/lib/nightly'
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
  const plan = normalizePlan((policy as Record<string, unknown> | null)?.token_plan)
  return c.json({
    user,
    devices: devices.results ?? [],
    sessions: sessions.results ?? [],
    policy: policy ? { ...policy, token_plan: plan } : null,
    // Always present, even with no policy row: 'standard' is a real answer,
    // and a client that had to infer it from a null row would guess.
    token_plan: plan,
    ceilings: ceilingsFor(plan)
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

/**
 * Read a user's pending reset code. Admins already hold reset-password
 * (which mints a temp password outright), so this exposes no new power —
 * it exists so the release gate can prove the emailed-code flow live.
 */
admin.get('/users/:id/reset-code', async (c) => {
  const auth = c.get('auth')
  if (c.env.ADMIN_RESET_CODE_READ !== '1') return c.json({ error: 'not_found' }, 404)
  if (auth.role === 'support') return c.json({ error: 'forbidden' }, 403)
  const entry = await c.env.DB.prepare(
    'SELECT code, attempts FROM password_resets WHERE user_id = ?1 AND expires_at > ?2'
  )
    .bind(c.req.param('id'), nowIso())
    .first<{ code: string; attempts: number }>()
  if (!entry) return c.json({ error: 'not_found' }, 404)
  return c.json({ code: entry.code, attempts: entry.attempts })
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

  // `token_plan` absent means "leave it alone" — an admin editing only the
  // search cap must not silently reset someone off `high` — so the plan
  // column is written with COALESCE against a sentinel rather than the flat
  // overwrite the other columns take.
  const planWrite = body.token_plan === undefined ? undefined : (body.token_plan ?? null)
  await c.env.DB.prepare(
    `INSERT INTO model_policies (user_id, allowed_models, daily_token_cap, daily_search_cap, token_plan, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       allowed_models = excluded.allowed_models,
       daily_token_cap = excluded.daily_token_cap,
       daily_search_cap = excluded.daily_search_cap,
       token_plan = CASE WHEN ?7 = 1 THEN excluded.token_plan ELSE model_policies.token_plan END,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      body.allowed_models === undefined || body.allowed_models === null
        ? null
        : JSON.stringify(body.allowed_models),
      body.daily_token_cap ?? null,
      body.daily_search_cap ?? null,
      planWrite ?? null,
      nowIso(),
      planWrite === undefined ? 0 : 1
    )
    .run()
  // The router reads policy from CONFIG_KV; refresh the cached copy now.
  await c.env.CONFIG_KV.delete(policyCacheKey(id))
  await audit(c.env, auth.sub, 'policy.set', id, body)
  return c.json({ ok: true })
})

// ── User config (the synced settings blob) ───────────────────────────────

/**
 * Read a user's synced config verbatim — the support tool for "my app is
 * misbehaving", because this blob IS the user's desktop settings. It also
 * carries the user's stored integration secrets, so unlike the other reads
 * it stays above the support tier, an admin cannot open an owner's, and the
 * disclosure itself is audited (the one audited read in this file).
 */
admin.get('/users/:id/config', async (c) => {
  const auth = c.get('auth')
  if (auth.role === 'support') return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  if (!(await ownerGuard(c.env, auth.role, id))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can view an owner' }, 403)
  }
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)
  const row = await c.env.DB.prepare('SELECT config, updated_at FROM settings WHERE user_id = ?1')
    .bind(id)
    .first<{ config: string; updated_at: string }>()
  await audit(c.env, auth.sub, 'config.view', id)
  // null (never synced) is a different answer than {} (synced empty / reset).
  const config = row ? await openConfig(c.env, row.config) : null
  if (row && config === null) return c.json({ error: 'config_unreadable' }, 500)
  return c.json({ config, updated_at: row?.updated_at ?? null })
})

/**
 * Write — or reset, with `{config: {}}` — a user's synced config. The fresh
 * server stamp this write mints is what makes it land: the desktop adopts
 * any row stamped by someone else before it would re-push its own copy
 * (see apps/desktop cloud/sync.ts), so an admin's fix survives the user's
 * next launch instead of dying under the client's stale blob. Audited by
 * size only — the content is the user's secrets and stays out of the log.
 */
admin.put('/users/:id/config', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await parseJson(c, ConfigPutSchema)
  if (body instanceof Response) return body
  if (!(await ownerGuard(c.env, auth.role, id))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can modify an owner' }, 403)
  }
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)
  const serialized = JSON.stringify(body.config)
  const now = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  )
    .bind(id, await sealConfig(c.env, body.config), now)
    .run()
  await audit(c.env, auth.sub, 'config.set', id, {
    bytes: serialized.length,
    keys: Object.keys(body.config).length
  })
  return c.json({ ok: true, updated_at: now })
})


/**
 * The roster — every employee with the numbers a card shows at a glance,
 * in ONE round trip.
 *
 * The admin's people screen renders a card per employee with their spend,
 * their plan and how active they have been. Fetching that per card would be
 * five hundred requests to open one screen; every figure here therefore
 * comes from the per-day rollup joined onto users, never from a scan of raw
 * rows. Two windows, deliberately: `since` (a rolling 30 days by default)
 * is the activity glance, and the calendar month-to-date is what the plan
 * ceiling is measured against — a rolling window would show someone at 90%
 * of a ceiling that actually reset a week ago.
 */
admin.get('/roster', async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const monthStart = new Date().toISOString().slice(0, 7) + '-01'

  const rows = await c.env.DB.prepare(
    `SELECT
       u.id, u.email, u.name, u.role, u.status, u.must_change_password,
       u.created_at, u.last_login_at,
       COALESCE(p.token_plan, 'standard') AS token_plan,
       p.daily_token_cap, p.daily_search_cap,
       COALESCE(w.requests, 0) AS requests,
       COALESCE(w.denied, 0) AS denied,
       COALESCE(w.tokens_in, 0) AS tokens_in,
       COALESCE(w.tokens_out, 0) AS tokens_out,
       COALESCE(w.tokens_cached, 0) AS tokens_cached,
       COALESCE(w.cost_microusd, 0) AS cost_microusd,
       COALESCE(w.searches, 0) AS searches,
       COALESCE(w.days_active, 0) AS days_active,
       w.last_active_day,
       COALESCE(m.tokens_in, 0) AS month_tokens_in,
       COALESCE(m.tokens_out, 0) AS month_tokens_out,
       COALESCE(m.cost_microusd, 0) AS month_cost_microusd,
       COALESCE(m.searches, 0) AS month_searches,
       COALESCE(d.devices, 0) AS devices,
       COALESCE(d.phones, 0) AS phones,
       COALESCE(cv.conversations, 0) AS conversations
     FROM users u
     LEFT JOIN model_policies p ON p.user_id = u.id
     LEFT JOIN (
       SELECT user_id,
         SUM(requests) AS requests,
         SUM(denied) AS denied,
         SUM(tokens_in) AS tokens_in,
         SUM(tokens_out) AS tokens_out,
         SUM(tokens_cached) AS tokens_cached,
         SUM(cost_microusd) AS cost_microusd,
         SUM(CASE WHEN kind = 'search' THEN requests - denied ELSE 0 END) AS searches,
         COUNT(DISTINCT day) AS days_active,
         MAX(day) AS last_active_day
       FROM usage_daily WHERE day >= ?1 GROUP BY user_id
     ) w ON w.user_id = u.id
     LEFT JOIN (
       SELECT user_id,
         SUM(CASE WHEN kind = 'chat' THEN tokens_in ELSE 0 END) AS tokens_in,
         SUM(CASE WHEN kind = 'chat' THEN tokens_out ELSE 0 END) AS tokens_out,
         SUM(cost_microusd) AS cost_microusd,
         SUM(CASE WHEN kind = 'search' THEN requests - denied ELSE 0 END) AS searches
       FROM usage_daily WHERE day >= ?2 GROUP BY user_id
     ) m ON m.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS devices,
         SUM(CASE WHEN platform = 'mobile' THEN 1 ELSE 0 END) AS phones
       FROM devices WHERE status = 'active' GROUP BY user_id
     ) d ON d.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS conversations
       FROM conversations WHERE deleted_at IS NULL GROUP BY user_id
     ) cv ON cv.user_id = u.id
     ORDER BY u.name COLLATE NOCASE, u.email COLLATE NOCASE`
  )
    .bind(since, monthStart)
    .all<Record<string, unknown>>()

  // The ceilings ride along so the client can draw a plan meter without
  // knowing the pricing model, and so a ceiling changed in plans.ts moves
  // every client at the next deploy rather than at the next client release.
  const people = (rows.results ?? []).map((r) => {
    const plan = normalizePlan(r.token_plan)
    return { ...r, token_plan: plan, ceilings: ceilingsFor(plan) }
  })
  return c.json({
    since,
    days,
    month_start: monthStart,
    plans: PLAN_CEILINGS,
    people
  })
})

/**
 * One employee, in full — what an admin opens when they need to help
 * somebody or explain a bill. Everything is one round trip because the
 * screen shows it all at once: identity, the plan and what is left of it,
 * where the spend went (lane AND surface), the shape of the last N days,
 * their devices and sessions, and the most recent decisions the router
 * made for them.
 *
 * The plan meter reads the GATE, not the rollup: the gate's durable
 * counters are what the ceiling is actually enforced against, and a rollup
 * that lags by a write would show someone room they do not have.
 */
admin.get('/users/:id/overview', async (c) => {
  const id = c.req.param('id')
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const monthStart = new Date().toISOString().slice(0, 7) + '-01'

  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, status, must_change_password, phone, position, bio,
       created_at, updated_at, last_login_at, temp_password_expires_at
     FROM users WHERE id = ?1`
  )
    .bind(id)
    .first<Record<string, unknown>>()
  if (!user) return c.json({ error: 'not_found' }, 404)

  const modelGate = c.env.MODEL_GATE.get(c.env.MODEL_GATE.idFromName('org'))
  const searchGate = c.env.SEARCH_GATE.get(c.env.SEARCH_GATE.idFromName('org'))

  const [policyRow, lanes, surfaces, daily, devices, sessions, recent, counts, standing, searchStanding] =
    await Promise.all([
      c.env.DB.prepare('SELECT * FROM model_policies WHERE user_id = ?1').bind(id).first<Record<string, unknown>>(),
      c.env.DB.prepare(
        `SELECT kind,
           SUM(requests) AS requests, SUM(denied) AS denied,
           SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
           SUM(tokens_cached) AS tokens_cached, SUM(cost_microusd) AS cost_microusd,
           SUM(CASE WHEN day >= ?3 THEN requests ELSE 0 END) AS month_requests,
           SUM(CASE WHEN day >= ?3 THEN tokens_in ELSE 0 END) AS month_tokens_in,
           SUM(CASE WHEN day >= ?3 THEN tokens_out ELSE 0 END) AS month_tokens_out,
           SUM(CASE WHEN day >= ?3 THEN cost_microusd ELSE 0 END) AS month_cost_microusd
         FROM usage_daily WHERE user_id = ?1 AND day >= ?2 GROUP BY kind`
      )
        .bind(id, since, monthStart)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(
        `SELECT surface, kind,
           SUM(requests) AS requests, SUM(denied) AS denied,
           SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
           SUM(cost_microusd) AS cost_microusd
         FROM usage_daily WHERE user_id = ?1 AND day >= ?2
         GROUP BY surface, kind ORDER BY cost_microusd DESC`
      )
        .bind(id, since)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(
        `SELECT day,
           SUM(requests) AS requests,
           SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
           SUM(cost_microusd) AS cost_microusd,
           SUM(CASE WHEN kind = 'search' THEN requests - denied ELSE 0 END) AS searches
         FROM usage_daily WHERE user_id = ?1 AND day >= ?2 GROUP BY day ORDER BY day`
      )
        .bind(id, since)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY created_at').bind(id).all(),
      c.env.DB.prepare(
        `SELECT id, device_id, issued_at, refreshed_at, expires_at, revoked_at, revoked_by
         FROM device_sessions WHERE user_id = ?1 ORDER BY issued_at DESC LIMIT 20`
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT id, device_id, model, kind, surface, upstream, tokens_in, tokens_out, tokens_cached,
           cost_microusd, latency_ms, decision, error, created_at
         FROM usage WHERE user_id = ?1 ORDER BY id DESC LIMIT 50`
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE user_id = ?1 AND deleted_at IS NULL) AS conversations,
           (SELECT COUNT(*) FROM files WHERE user_id = ?1 AND deleted_at IS NULL) AS files,
           (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = ?1 AND deleted_at IS NULL) AS bytes`
      )
        .bind(id)
        .first<Record<string, unknown>>(),
      modelGate.standing(id).catch(() => null),
      searchGate.standing(id).catch(() => null)
    ])

  const plan = normalizePlan(policyRow?.token_plan)
  return c.json({
    user,
    window: { since, days, month_start: monthStart },
    policy: {
      ...(policyRow ?? {}),
      token_plan: plan,
      ceilings: ceilingsFor(plan)
    },
    plans: PLAN_CEILINGS,
    /** Live counters from the gates — what the ceilings are enforced against. */
    standing: { tokens: standing, searches: searchStanding },
    lanes: lanes.results ?? [],
    surfaces: surfaces.results ?? [],
    daily: daily.results ?? [],
    devices: devices.results ?? [],
    sessions: sessions.results ?? [],
    recent: recent.results ?? [],
    counts: counts ?? { conversations: 0, files: 0, bytes: 0 }
  })
})

/** Set an employee's token plan — the one control this screen exists for. */
admin.put('/users/:id/plan', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const body = await parseJson(c, PlanPutSchema)
  if (body instanceof Response) return body
  if (!(await ownerGuard(c.env, auth.role, id))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can modify an owner' }, 403)
  }
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)

  await c.env.DB.prepare(
    `INSERT INTO model_policies (user_id, token_plan, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET token_plan = excluded.token_plan, updated_at = excluded.updated_at`
  )
    .bind(id, body.token_plan, nowIso())
    .run()
  await c.env.CONFIG_KV.delete(policyCacheKey(id))
  await audit(c.env, auth.sub, 'plan.set', id, {
    token_plan: body.token_plan,
    ceilings: ceilingsFor(body.token_plan)
  })
  return c.json({ ok: true, token_plan: body.token_plan, ceilings: ceilingsFor(body.token_plan) })
})

/** The plan catalogue, so a client never hard-codes a ceiling. */
admin.get('/plans', (c) => c.json({ plans: TOKEN_PLANS, ceilings: PLAN_CEILINGS }))

/** Audit trail for one employee: what was done TO them and BY them. */
admin.get('/users/:id/audit', async (c) => {
  const id = c.req.param('id')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500)
  const rows = await c.env.DB.prepare(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.target = ?1 OR a.actor_user_id = ?1
     ORDER BY a.id DESC LIMIT ?2`
  )
    .bind(id, limit)
    .all()
  return c.json({ entries: rows.results ?? [] })
})

// ── Reading someone else's work ──────────────────────────────────────────
//
// A conversation is the employee's actual words and the actual commands the
// agent ran on their machine — the most sensitive thing this API holds, and
// far beyond what the roster's numbers expose. So these two reads carry the
// same guard the synced-config read does, for the same reason: support is
// the view-only tier for OPERATIONS, not a licence to read the company's
// conversations; an admin cannot read an owner's; and opening a transcript
// is itself audited, because a disclosure that leaves no trace is not a
// control anyone can point at.

type AdminContext = Context<{ Bindings: Env; Variables: AuthVars }>

async function readableUser(c: AdminContext, userId: string): Promise<Response | null> {
  const auth = c.get('auth')
  if (auth.role === 'support') {
    return c.json({ error: 'forbidden', detail: 'support cannot read conversations' }, 403)
  }
  if (!(await ownerGuard(c.env, auth.role, userId))) {
    return c.json({ error: 'forbidden', detail: 'only an owner can view an owner' }, 403)
  }
  return null
}

/**
 * One employee's conversations, newest first — the index behind the admin's
 * transcript list. Meta comes off the synced snapshot record the desktop
 * pushes with every conversation (its envelope minus the messages), so the
 * list already knows which SURFACE each conversation came from and how many
 * tool calls it ran, without opening any of them.
 */
admin.get('/users/:id/conversations', async (c) => {
  const id = c.req.param('id')
  const denied = await readableUser(c, id)
  if (denied) return denied
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first()
  if (!user) return c.json({ error: 'not_found' }, 404)

  const limitRaw = parseInt(c.req.query('limit') ?? '30', 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 1), 100)
  // Newest-first paging on (updated_at, rowid) — a cursor rather than an
  // offset, so a conversation that updates mid-scroll cannot make the next
  // page repeat or skip a row.
  const before = c.req.query('before') ?? ''
  const [beforeAt, beforeRid] = before.includes('~~')
    ? [before.slice(0, before.indexOf('~~')), parseInt(before.slice(before.indexOf('~~') + 2), 10) || 0]
    : ['￿', 0]

  const rows = await c.env.DB.prepare(
    `SELECT c.rowid AS rid, c.id, c.title, c.device_id, c.created_at, c.updated_at,
       c.archived_at,
       json_extract(s.content, '$.model') AS model,
       json_extract(s.content, '$.channel') AS channel,
       json_extract(s.content, '$.icon') AS icon,
       json_extract(s.content, '$.projectId') AS project_id,
       json_extract(s.content, '$.sealed') AS sealed,
       json_extract(s.content, '$.summary') AS summary,
       json_extract(s.content, '$.stats') AS stats,
       COALESCE(json_extract(s.content, '$.messageCount'),
         (SELECT COUNT(DISTINCT substr(r.id, 1, length(r.id) - 9)) FROM conversation_records r
           WHERE r.conversation_id = c.id AND r.kind = 'message')) AS message_count
     FROM conversations c
     LEFT JOIN conversation_records s ON s.conversation_id = c.id AND s.kind = 'snapshot'
     WHERE c.user_id = ?1 AND c.deleted_at IS NULL
       AND (c.updated_at < ?2 OR (c.updated_at = ?2 AND c.rowid < ?3))
     ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?4`
  )
    .bind(id, beforeAt, beforeRid || 2_147_483_647, limit)
    .all<{ rid: number; updated_at: string; stats: unknown } & Record<string, unknown>>()

  const results = rows.results ?? []
  const conversations = results.map(({ rid: _rid, stats, ...rest }) => ({
    ...rest,
    stats: typeof stats === 'string' ? safeJson(stats) : (stats ?? null)
  }))
  const last = results[results.length - 1]
  return c.json({
    conversations,
    next: results.length === limit && last ? `${last.updated_at}~~${last.rid}` : null
  })
})

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A conversation's records, exactly as the owner's own client receives them
 * (same shared reader, same archive merge, same cursor) — so an admin's
 * transcript is the employee's transcript, not a second rendering of it
 * that can disagree.
 *
 * The first page is audited; later pages are not, or scrolling a long
 * conversation would write a hundred identical rows and bury the fact that
 * it was opened at all.
 */
admin.get('/conversations/:id/records', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const conv = await c.env.DB.prepare(
    `SELECT c.user_id, c.title, c.created_at, c.updated_at, c.archive_key, c.archived_at,
       u.name AS user_name, u.email AS user_email
     FROM conversations c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = ?1 AND c.deleted_at IS NULL`
  )
    .bind(id)
    .first<{
      user_id: string
      title: string
      created_at: string
      updated_at: string
      archive_key: string | null
      archived_at: string | null
      user_name: string | null
      user_email: string | null
    }>()
  if (!conv) return c.json({ error: 'not_found' }, 404)
  const denied = await readableUser(c, conv.user_id)
  if (denied) return denied

  const after = parseInt(c.req.query('after') ?? '0', 10)
  const page = await readRecordsPage(c.env, id, conv, {
    after,
    limit: parseInt(c.req.query('limit') ?? String(RECORDS_PAGE_MAX), 10)
  })
  if (!(after > 0)) {
    await audit(c.env, auth.sub, 'conversation.view', id, {
      user_id: conv.user_id,
      title: conv.title
    })
  }
  return c.json({
    ...page,
    conversation: {
      id,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      user_id: conv.user_id,
      user_name: conv.user_name,
      user_email: conv.user_email
    }
  })
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
       search_enabled = COALESCE(?6, search_enabled),
       user_daily_search_cap = COALESCE(?7, user_daily_search_cap),
       org_monthly_search_cap = COALESCE(?8, org_monthly_search_cap),
       updated_at = ?9
     WHERE id = 1`
  )
    .bind(
      body.name ?? null,
      body.default_model ?? null,
      body.default_allowed_models ? JSON.stringify(body.default_allowed_models) : null,
      body.user_daily_token_cap ?? null,
      body.org_monthly_token_cap ?? null,
      body.search_enabled === undefined ? null : body.search_enabled ? 1 : 0,
      body.user_daily_search_cap ?? null,
      body.org_monthly_search_cap ?? null,
      nowIso()
    )
    .run()
  await c.env.CONFIG_KV.delete('org')
  await audit(c.env, auth.sub, 'org.update', 'org', body)
  return c.json({ ok: true })
})

// ── Org-wide capabilities ────────────────────────────────────────────────
// The official set every client mirrors. Mutations land on the whole org
// at each client's next sync pull, so both are audited; the shared
// putCapability gate (hash, size, structure) is the blast-radius control.

admin.get('/capabilities', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT slug, name, description, version, sha256, size, updated_by, created_at, updated_at, deleted_at
     FROM capabilities WHERE scope = 'org' ORDER BY slug`
  ).all()
  return c.json({ capabilities: rows.results ?? [] })
})

admin.put('/capabilities/:slug', async (c) => {
  const auth = c.get('auth')
  const slug = c.req.param('slug')
  const res = await putCapability(c, 'org', '', slug, auth.sub)
  if (res.status === 200) {
    await audit(c.env, auth.sub, 'capability.put', slug, { sha256: c.req.query('sha256') })
  }
  return res
})

admin.delete('/capabilities/:slug', async (c) => {
  const auth = c.get('auth')
  const slug = c.req.param('slug')
  const res = await deleteCapability(c, 'org', '', slug)
  if (res.status === 200) await audit(c.env, auth.sub, 'capability.delete', slug)
  return res
})

// ── Usage & audit ────────────────────────────────────────────────────────

admin.get('/usage', async (c) => {
  const since = c.req.query('since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
  const userId = c.req.query('user_id') ?? null
  // Totals come from the per-day rollup the meter keeps (one row per user,
  // day and lane), never from a scan of raw rows — a month of a 500-person
  // org is ~30k rollup rows against millions of raw ones, and the totals
  // survive the raw-row retention sweep. The recent list is raw.
  const [totals, recent, surfaces] = await Promise.all([
    c.env.DB.prepare(
      `SELECT user_id, SUM(requests) AS requests,
         SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(tokens_cached) AS tokens_cached,
         SUM(cost_microusd) AS cost_microusd,
         SUM(denied) AS denied,
         SUM(CASE WHEN kind = 'search' THEN requests - denied ELSE 0 END) AS searches
       FROM usage_daily WHERE day >= ?1 AND (?2 IS NULL OR user_id = ?2)
       GROUP BY user_id ORDER BY cost_microusd DESC`
    )
      .bind(since.slice(0, 10), userId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM usage WHERE created_at >= ?1 AND (?2 IS NULL OR user_id = ?2)
       ORDER BY id DESC LIMIT 100`
    )
      .bind(since, userId)
      .all(),
    // Where the spend happened — desktop, phone, extension, heartbeat. Also
    // from the rollup, so it survives the raw-row retention sweep.
    c.env.DB.prepare(
      `SELECT surface, kind, SUM(requests) AS requests, SUM(denied) AS denied,
         SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(cost_microusd) AS cost_microusd
       FROM usage_daily WHERE day >= ?1 AND (?2 IS NULL OR user_id = ?2)
       GROUP BY surface, kind ORDER BY cost_microusd DESC`
    )
      .bind(since.slice(0, 10), userId)
      .all()
  ])
  return c.json({
    since,
    totals: totals.results ?? [],
    surfaces: surfaces.results ?? [],
    recent: recent.results ?? []
  })
})

/**
 * The gates' live state — queue depth, in-flight per host, cooldowns, what
 * each host has served — the numbers an admin watches when the org grows.
 */
admin.get('/gates', async (c) => {
  const modelGate = c.env.MODEL_GATE.get(c.env.MODEL_GATE.idFromName('org'))
  const searchGate = c.env.SEARCH_GATE.get(c.env.SEARCH_GATE.idFromName('org'))
  const userId = c.req.query('user_id') ?? null
  const [model, search, tokens, searches] = await Promise.all([
    modelGate.stats().catch(() => null),
    searchGate.stats().catch(() => null),
    userId ? modelGate.standing(userId).catch(() => null) : null,
    userId ? searchGate.standing(userId).catch(() => null) : null
  ])
  return c.json({ model, search, ...(userId ? { standing: { user_id: userId, tokens, searches } } : {}) })
})

/**
 * Run the nightly maintenance now — the same bounded jobs the cron runs
 * (blob GC, purge of deleted conversations, archive of idle conversations,
 * raw usage retirement). For an operator draining a backlog on demand, and
 * for the simulations that prove the archive path. Audited.
 */
admin.post('/maintenance/run', async (c) => {
  const auth = c.get('auth')
  const report = await runNightly(c.env, Date.now())
  await audit(c.env, auth.sub, 'maintenance.run', 'nightly', report)
  return c.json({ ok: true, report })
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
