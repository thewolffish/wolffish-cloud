/**
 * Pairing — how a phone becomes a signed-in device of the same user.
 *
 * The desktop (already signed in) OFFERS a pairing: a short code to type and
 * a longer token the QR carries. The phone CLAIMS it with whichever it saw
 * and receives an ordinary device session — the same shape a password login
 * issues — so from then on it talks to this API like any other client:
 * config, conversations, files, usage over REST, the live desktop link over
 * the bridge. No relay, no key exchange, nothing to pin: the org's session
 * IS the trust.
 *
 * Offers live three minutes and are single-use. D1 rather than KV so a
 * claimed offer is dead everywhere at once (KV's eventual consistency could
 * let one code mint two sessions for up to a minute). Only hashes are stored.
 */
import { Hono } from 'hono'
import { newId, randomBytes, sha256Hex, toHex } from '@/lib/crypto'
import { ACCESS_TTL_SECONDS, REFRESH_IDLE_DAYS, requireAuth, type AuthVars } from '@/middleware/auth'
import { signJwt } from '@/lib/jwt'
import { PairClaimSchema } from '@/lib/schemas'
import { parseJson } from '@/lib/validate'
import { notifyBridge } from '@/routes/bridge'
import type { Env } from '@/index'

/** Crockford base32: no I, L, O or U, so a code survives being read aloud.
 *  Mirrored on the phone (normalizeCode) — keep the two identical. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 8
export const PAIR_TTL_SECONDS = 180
/** What the QR encodes: base64url JSON behind this prefix. v2 = org API. */
export const PAIRING_PREFIX = 'wolffish-pair:v2:'

const nowIso = () => new Date().toISOString()

function generateCode(): string {
  const bytes = randomBytes(CODE_CHARS)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Accepts what a human actually types: lower case, missing or extra dashes,
 *  spaces, and the classic look-alike substitutions. Null when it cannot be
 *  a code at all. */
export function normalizeCode(input: string): string | null {
  const folded = String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (folded.length !== CODE_CHARS) return null
  for (const ch of folded) if (!ALPHABET.includes(ch)) return null
  return folded
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const codeHash = (normalized: string): Promise<string> => sha256Hex(`wfc-pair-code:${normalized}`)
const tokenHash = (token: string): Promise<string> => sha256Hex(`wfc-pair-token:${token}`)

type PairingRow = {
  id: string
  user_id: string
  desktop_device_id: string
  attempts: number
  expires_at: string
  claimed_at: string | null
  claimed_device_id: string | null
}

// ── Authed: the desktop's side ───────────────────────────────────────────

const pair = new Hono<{ Bindings: Env; Variables: AuthVars }>()
pair.use('*', requireAuth)

/**
 * Open an offer. Answers the code (for typing), the QR payload (carrying the
 * token and this API's base, so a fork's phone dials the fork's API) and the
 * expiry. Older unclaimed offers by this desktop are retired: one live offer
 * per desktop keeps "new code" honest.
 */
pair.post('/pair/offer', async (c) => {
  const auth = c.get('auth')
  const code = generateCode()
  const normalized = normalizeCode(code)!
  const token = b64url(randomBytes(32))
  const id = newId('pair')
  const expiresAt = new Date(Date.now() + PAIR_TTL_SECONDS * 1000).toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE pairings SET expires_at = ?1 WHERE user_id = ?2 AND desktop_device_id = ?3
         AND claimed_at IS NULL AND expires_at > ?1`
    ).bind(nowIso(), auth.sub, auth.dev),
    c.env.DB.prepare(
      `INSERT INTO pairings (id, user_id, desktop_device_id, code_hash, token_hash, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(id, auth.sub, auth.dev, await codeHash(normalized), await tokenHash(token), expiresAt)
  ])
  const apiBase = new URL(c.req.url).origin
  const qr = PAIRING_PREFIX + b64url(new TextEncoder().encode(JSON.stringify({ v: 2, api: apiBase, token })))
  return c.json({ id, code, qr, expires_at: expiresAt, expires_in: PAIR_TTL_SECONDS })
})

/** Has anyone claimed it yet? The desktop polls this (and hears it live over
 *  the bridge) to turn its offer card into a paired-phone card. */
pair.get('/pair/offer/:id', async (c) => {
  const auth = c.get('auth')
  const row = await c.env.DB.prepare(
    'SELECT id, expires_at, claimed_at, claimed_device_id FROM pairings WHERE id = ?1 AND user_id = ?2'
  )
    .bind(c.req.param('id'), auth.sub)
    .first<Pick<PairingRow, 'id' | 'expires_at' | 'claimed_at' | 'claimed_device_id'>>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  const status = row.claimed_at ? 'claimed' : row.expires_at <= nowIso() ? 'expired' : 'pending'
  let device: Record<string, unknown> | null = null
  if (row.claimed_device_id) {
    device =
      (await c.env.DB.prepare(
        'SELECT id, platform, name, app_version, created_at, last_seen_at FROM devices WHERE id = ?1'
      )
        .bind(row.claimed_device_id)
        .first<Record<string, unknown>>()) ?? null
  }
  return c.json({ id: row.id, status, expires_at: row.expires_at, claimed_at: row.claimed_at, device })
})

/** Withdraw an offer before anyone claims it. */
pair.delete('/pair/offer/:id', async (c) => {
  const auth = c.get('auth')
  const res = await c.env.DB.prepare(
    'UPDATE pairings SET expires_at = ?1 WHERE id = ?2 AND user_id = ?3 AND claimed_at IS NULL'
  )
    .bind(nowIso(), c.req.param('id'), auth.sub)
    .run()
  return c.json({ ok: true, withdrawn: (res.meta.changes ?? 0) > 0 })
})

export default pair

// ── Unauthed: the phone's side ───────────────────────────────────────────

export const pairClaim = new Hono<{ Bindings: Env }>()

async function bumpRateLimit(kv: KVNamespace, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const current = parseInt((await kv.get(key)) ?? '0', 10)
  if (current >= limit) return false
  try {
    await kv.put(key, String(current + 1), { expirationTtl: windowSeconds })
  } catch {
    // a concurrent claim already bumped this key within the second
  }
  return true
}

/**
 * Claim an offer with the typed code or the scanned token. A hit mints the
 * phone's device row and session atomically with the claim: the UPDATE that
 * marks the row claimed is the single-use guard, and it only ever succeeds
 * once. Rate limited per IP — an 8-character code is 40 bits behind a
 * three-minute window, and this is the only door that takes one.
 */
pairClaim.post('/pair/claim', async (c) => {
  const body = await parseJson(c, PairClaimSchema)
  if (body instanceof Response) return body
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  if (!(await bumpRateLimit(c.env.AUTH_KV, `rl:pair:${ip}`, 30, 900))) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  let lookup: { column: 'code_hash' | 'token_hash'; hash: string } | null = null
  if (body.token) lookup = { column: 'token_hash', hash: await tokenHash(body.token) }
  else if (body.code) {
    const normalized = normalizeCode(body.code)
    if (!normalized) return c.json({ error: 'invalid_code' }, 400)
    lookup = { column: 'code_hash', hash: await codeHash(normalized) }
  }
  if (!lookup) return c.json({ error: 'invalid_request', detail: 'code or token required' }, 400)

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, desktop_device_id, attempts, expires_at, claimed_at, claimed_device_id
     FROM pairings WHERE ${lookup.column} = ?1 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(lookup.hash)
    .first<PairingRow>()
  if (!row || row.claimed_at || row.expires_at <= nowIso()) {
    return c.json({ error: 'pairing_not_found' }, 404)
  }

  const user = await c.env.DB.prepare('SELECT id, email, name, role, status FROM users WHERE id = ?1')
    .bind(row.user_id)
    .first<{ id: string; email: string; name: string; role: 'owner' | 'admin' | 'support' | 'employee'; status: string }>()
  if (!user || user.status !== 'active') return c.json({ error: 'account_disabled' }, 403)

  // The phone's device row. A phone re-pairing after an unpair presents its
  // old id; that row was revoked, so a fresh one is minted — the old
  // device's history stays attributable to it.
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
      `INSERT INTO devices (id, user_id, platform, name, app_version) VALUES (?1, ?2, 'mobile', ?3, ?4)`
    )
      .bind(deviceId, user.id, d.name ?? '', d.app_version ?? '')
      .run()
  }

  // Single use, enforced by the row: whoever's UPDATE lands first owns it.
  const claimed = await c.env.DB.prepare(
    'UPDATE pairings SET claimed_at = ?1, claimed_device_id = ?2 WHERE id = ?3 AND claimed_at IS NULL AND expires_at > ?1'
  )
    .bind(nowIso(), deviceId, row.id)
    .run()
  if ((claimed.meta.changes ?? 0) === 0) return c.json({ error: 'pairing_not_found' }, 404)

  await c.env.DB.prepare('UPDATE devices SET last_seen_at = ?1, app_version = ?2 WHERE id = ?3')
    .bind(nowIso(), d.app_version ?? '', deviceId)
    .run()

  const sessionId = newId('ses')
  const secret = toHex(randomBytes(32))
  await c.env.DB.prepare(
    `INSERT INTO device_sessions (id, user_id, device_id, refresh_hash, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(sessionId, user.id, deviceId, await sha256Hex(secret), new Date(Date.now() + REFRESH_IDLE_DAYS * 86_400_000).toISOString())
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

  const desktop = await c.env.DB.prepare('SELECT id, name, platform, app_version FROM devices WHERE id = ?1')
    .bind(row.desktop_device_id)
    .first<Record<string, unknown>>()
  const org = await c.env.DB.prepare('SELECT name FROM org WHERE id = 1').first<{ name: string }>()

  // The desktop hears the claim live — its offer card becomes a phone card
  // without polling.
  c.executionCtx.waitUntil(
    notifyBridge(c.env, user.id, 'desktop', 'pair.claimed', {
      pairingId: row.id,
      device: { id: deviceId, name: d.name ?? '', platform: 'mobile', app_version: d.app_version ?? '' }
    })
  )

  return c.json({
    access_token: access,
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: `${sessionId}.${secret}`,
    session_id: sessionId,
    device_id: deviceId,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    org: org ? { name: org.name } : null,
    desktop: desktop ?? null,
    api: new URL(c.req.url).origin
  })
})
