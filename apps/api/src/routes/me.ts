/**
 * Authed session surface: who am I, what may I use, sign out.
 * `/v1/me` is the desktop's first call after login — it carries the role
 * that decides whether the client shows admin controls (server-verified
 * on every admin endpoint regardless).
 */
import { Hono } from 'hono'
import { toHex } from '@/lib/crypto'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import { getEffectivePolicy, getOrgConfig } from '@/lib/policy'
import { modelMeta } from '@/lib/models'
import { DevicePinSchema, ProfilePatchSchema } from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { closeBridgeDevice, notifyBridge } from '@/routes/bridge'
import type { Env } from '@/index'

const me = new Hono<{ Bindings: Env; Variables: AuthVars }>()

me.use('*', requireAuth)

/**
 * The server-driven model catalog: exactly what this user's picker shows.
 * Admin edits the policy → this list changes → the client re-renders.
 */
me.get('/models', async (c) => {
  const auth = c.get('auth')
  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  const policy = await getEffectivePolicy(c.env, auth.sub)
  const ids = policy.allowed.length > 0 ? policy.allowed : [org.default_model]
  return c.json({
    default_model: org.default_model,
    models: ids.map((id) => {
      const meta = modelMeta(id)
      return {
        id,
        name: meta.name,
        reasoning: meta.reasoning,
        vision: meta.vision,
        context_window: meta.contextWindow,
        in_per_mtok_microusd: meta.inPerM,
        out_per_mtok_microusd: meta.outPerM,
        default: id === org.default_model
      }
    })
  })
})

me.get('/me', async (c) => {
  const auth = c.get('auth')
  const [user, org, device] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, email, name, phone, position, bio, avatar_key, role, status, last_login_at FROM users WHERE id = ?1'
    )
      .bind(auth.sub)
      .first<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT name, default_model FROM org WHERE id = 1').first<Record<string, unknown>>(),
    c.env.DB.prepare(
      'SELECT id, platform, name, pin_set, pin_clear_requested FROM devices WHERE id = ?1'
    )
      .bind(auth.dev)
      .first<Record<string, unknown>>()
  ])
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ user, org: org ?? null, device: device ?? null, session_id: auth.sid })
})

/**
 * The device reports its local PIN state. Setting pin_set also clears any
 * pending admin clear-request — the client calls this to acknowledge the
 * clear after wiping its local lock (the PIN itself never reaches us).
 */
// ── Profile photo ────────────────────────────────────────────────────────
// Content-addressed like every blob here: bytes live once at
// files/<sha256> in R2, the user row points at them. Replacing or removing
// garbage-collects the old blob only when nothing else references it.

const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

async function gcBlob(env: Env, sha256: string): Promise<void> {
  const [asAvatar, asFile] = await Promise.all([
    env.DB.prepare('SELECT 1 FROM users WHERE avatar_key = ?1 LIMIT 1').bind(sha256).first(),
    env.DB.prepare('SELECT 1 FROM files WHERE sha256 = ?1 AND deleted_at IS NULL LIMIT 1')
      .bind(sha256)
      .first()
  ])
  if (!asAvatar && !asFile) await env.BLOBS.delete(`files/${sha256}`)
}

me.put('/profile/avatar', async (c) => {
  const auth = c.get('auth')
  const mime = ((c.req.header('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (!AVATAR_MIMES.has(mime)) {
    return c.json({ error: 'invalid_request', detail: 'content-type must be png, jpeg or webp' }, 400)
  }
  const bytes = await c.req.arrayBuffer()
  if (bytes.byteLength === 0) return c.json({ error: 'empty_body' }, 400)
  if (bytes.byteLength > AVATAR_MAX_BYTES) return c.json({ error: 'too_large' }, 413)

  const sha256 = toHex(await crypto.subtle.digest('SHA-256', bytes))
  const key = `files/${sha256}`
  if (!(await c.env.BLOBS.head(key))) await c.env.BLOBS.put(key, bytes)

  const prev = await c.env.DB.prepare('SELECT avatar_key FROM users WHERE id = ?1')
    .bind(auth.sub)
    .first<{ avatar_key: string | null }>()
  await c.env.DB.prepare(
    'UPDATE users SET avatar_key = ?1, avatar_mime = ?2, updated_at = ?3 WHERE id = ?4'
  )
    .bind(sha256, mime, new Date().toISOString(), auth.sub)
    .run()
  if (prev?.avatar_key && prev.avatar_key !== sha256) await gcBlob(c.env, prev.avatar_key)
  return c.json({ ok: true, sha256, size: bytes.byteLength })
})

me.get('/profile/avatar', async (c) => {
  const auth = c.get('auth')
  const row = await c.env.DB.prepare('SELECT avatar_key, avatar_mime FROM users WHERE id = ?1')
    .bind(auth.sub)
    .first<{ avatar_key: string | null; avatar_mime: string | null }>()
  if (!row?.avatar_key) return c.json({ error: 'not_found' }, 404)
  // Conditional GET: the etag is the content hash, so a match means the
  // client's cached copy is current — no R2 read, no body.
  const inm = c.req.header('if-none-match')
  if (inm) {
    const tags = inm.split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'))
    if (tags.includes('*') || tags.includes(row.avatar_key)) {
      return new Response(null, { status: 304, headers: { etag: row.avatar_key } })
    }
  }
  const obj = await c.env.BLOBS.get(`files/${row.avatar_key}`)
  if (!obj) return c.json({ error: 'blob_missing' }, 404)
  return new Response(obj.body, {
    headers: {
      'content-type': row.avatar_mime ?? 'application/octet-stream',
      'content-length': String(obj.size),
      etag: row.avatar_key
    }
  })
})

me.delete('/profile/avatar', async (c) => {
  const auth = c.get('auth')
  const prev = await c.env.DB.prepare('SELECT avatar_key FROM users WHERE id = ?1')
    .bind(auth.sub)
    .first<{ avatar_key: string | null }>()
  if (prev?.avatar_key) {
    await c.env.DB.prepare(
      'UPDATE users SET avatar_key = NULL, avatar_mime = NULL, updated_at = ?1 WHERE id = ?2'
    )
      .bind(new Date().toISOString(), auth.sub)
      .run()
    await gcBlob(c.env, prev.avatar_key)
  }
  return c.json({ ok: true })
})

me.post('/device/pin', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, DevicePinSchema)
  if (body instanceof Response) return body
  await c.env.DB.prepare(
    'UPDATE devices SET pin_set = ?1, pin_clear_requested = 0 WHERE id = ?2 AND user_id = ?3'
  )
    .bind(body.pin_set ? 1 : 0, auth.dev, auth.sub)
    .run()
  return c.json({ ok: true })
})

/**
 * Self-service profile: name and phone only — email, role and status are
 * the admin's to change. Returns the fresh user row the client re-renders.
 */
me.patch('/profile', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, ProfilePatchSchema)
  if (body instanceof Response) return body
  await c.env.DB.prepare(
    `UPDATE users SET
       name = COALESCE(?1, name),
       phone = COALESCE(?2, phone),
       position = COALESCE(?3, position),
       bio = COALESCE(?4, bio),
       updated_at = ?5
     WHERE id = ?6`
  )
    .bind(
      body.name ?? null,
      body.phone ?? null,
      body.position ?? null,
      body.bio ?? null,
      new Date().toISOString(),
      auth.sub
    )
    .run()
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, phone, position, bio, role, status FROM users WHERE id = ?1'
  )
    .bind(auth.sub)
    .first()
  return c.json({ ok: true, user })
})

me.post('/logout', async (c) => {
  const auth = c.get('auth')
  await c.env.DB.prepare(
    'UPDATE device_sessions SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND revoked_at IS NULL'
  )
    .bind(new Date().toISOString(), auth.sub, auth.sid)
    .run()
  // The device's live link and push registration go with the session: a
  // signed-out phone must stop receiving the moment it signs out — and the
  // desktop is told, so its paired-phone list does not keep a phone that
  // signed itself out until the next claim or unpair happens to re-list.
  await closeBridgeDevice(c.env, auth.sub, auth.dev)
  await notifyBridge(c.env, auth.sub, 'desktop', 'device.revoked', { deviceId: auth.dev })
  return c.json({ ok: true })
})

export default me
