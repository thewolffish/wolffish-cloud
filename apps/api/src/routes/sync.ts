/**
 * Sync — what makes the local folder a mere cache.
 *
 * The client drains a local outbox after each turn: conversations and
 * records and episodes come through /sync/batch (idempotent — every item
 * carries a client-generated id, replays are no-ops), files go through
 * content-addressed upload (dedupe by sha256). Restore is /sync/bootstrap
 * (one call: config + conversation index + file manifest) plus lazy pulls
 * of record pages and blobs. Config is last-write-wins on the one row.
 */
import { Hono } from 'hono'
import { newId, toHex } from '@/lib/crypto'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import type { Env } from '@/index'

const sync = new Hono<{ Bindings: Env; Variables: AuthVars }>()
const nowIso = () => new Date().toISOString()

sync.use('*', requireAuth)

// ── Config ───────────────────────────────────────────────────────────────

sync.get('/config', async (c) => {
  const auth = c.get('auth')
  const row = await c.env.DB.prepare('SELECT config, updated_at FROM settings WHERE user_id = ?1')
    .bind(auth.sub)
    .first<{ config: string; updated_at: string }>()
  return c.json({
    config: row ? JSON.parse(row.config) : {},
    updated_at: row?.updated_at ?? null
  })
})

sync.put('/config', async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json<{ config?: unknown }>().catch(() => null)
  if (!body || typeof body.config !== 'object' || body.config === null) {
    return c.json({ error: 'invalid_request', detail: 'config object required' }, 400)
  }
  const now = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  )
    .bind(auth.sub, JSON.stringify(body.config), now)
    .run()
  return c.json({ ok: true, updated_at: now })
})

// ── The outbox drain ─────────────────────────────────────────────────────

type BatchItem =
  | {
      type: 'conversation'
      id: string
      title?: string
      created_at: string
      updated_at: string
      device_id?: string
    }
  | {
      type: 'record'
      id: string
      conversation_id: string
      seq: number
      kind?: string
      content: unknown
      created_at: string
    }
  | { type: 'episode'; id: string; content: unknown; occurred_at: string }

sync.post('/sync/batch', async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json<{ items?: BatchItem[] }>().catch(() => null)
  const items = body?.items
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    return c.json({ error: 'invalid_request', detail: '1..500 items required' }, 400)
  }

  let accepted = 0
  let ignored = 0
  let rejected = 0
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id) {
      rejected++
      continue
    }
    try {
      if (item.type === 'conversation') {
        const res = await c.env.DB.prepare(
          `INSERT INTO conversations (id, user_id, device_id, title, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, updated_at = excluded.updated_at
           WHERE conversations.user_id = excluded.user_id
             AND excluded.updated_at > conversations.updated_at`
        )
          .bind(
            item.id,
            auth.sub,
            item.device_id ?? auth.dev,
            item.title ?? '',
            item.created_at,
            item.updated_at
          )
          .run()
        res.meta.changes > 0 ? accepted++ : ignored++
      } else if (item.type === 'record') {
        const owns = await c.env.DB.prepare(
          'SELECT user_id FROM conversations WHERE id = ?1'
        )
          .bind(item.conversation_id)
          .first<{ user_id: string }>()
        if (!owns || owns.user_id !== auth.sub) {
          rejected++
          continue
        }
        const res = await c.env.DB.prepare(
          `INSERT OR IGNORE INTO conversation_records
             (id, conversation_id, user_id, seq, kind, content, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
          .bind(
            item.id,
            item.conversation_id,
            auth.sub,
            item.seq,
            item.kind ?? 'message',
            JSON.stringify(item.content ?? null),
            item.created_at
          )
          .run()
        res.meta.changes > 0 ? accepted++ : ignored++
      } else if (item.type === 'episode') {
        const res = await c.env.DB.prepare(
          `INSERT OR IGNORE INTO episodes (id, user_id, content, occurred_at)
           VALUES (?1, ?2, ?3, ?4)`
        )
          .bind(item.id, auth.sub, JSON.stringify(item.content ?? null), item.occurred_at)
          .run()
        res.meta.changes > 0 ? accepted++ : ignored++
      } else {
        rejected++
      }
    } catch {
      rejected++
    }
  }
  return c.json({ ok: true, accepted, ignored, rejected })
})

// ── Lazy reads (restore path) ────────────────────────────────────────────

sync.get('/conversations', async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT id, title, device_id, created_at, updated_at FROM conversations
     WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`
  )
    .bind(auth.sub)
    .all()
  return c.json({ conversations: rows.results ?? [] })
})

sync.get('/conversations/:id/records', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const after = parseInt(c.req.query('after_seq') ?? '-1', 10)
  const owns = await c.env.DB.prepare('SELECT user_id FROM conversations WHERE id = ?1')
    .bind(id)
    .first<{ user_id: string }>()
  if (!owns || owns.user_id !== auth.sub) return c.json({ error: 'not_found' }, 404)
  const rows = await c.env.DB.prepare(
    `SELECT id, seq, kind, content, created_at FROM conversation_records
     WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT 200`
  )
    .bind(id, after)
    .all<{ id: string; seq: number; kind: string; content: string; created_at: string }>()
  const records = (rows.results ?? []).map((r) => ({ ...r, content: JSON.parse(r.content) }))
  return c.json({ records, next_after_seq: records.length ? records[records.length - 1]!.seq : after })
})

// ── Files (content-addressed blobs) ──────────────────────────────────────

sync.post('/files/upload', async (c) => {
  const auth = c.get('auth')
  const sha256 = (c.req.query('sha256') ?? '').toLowerCase()
  const name = c.req.query('name') ?? 'unnamed'
  const mime = c.req.query('mime') ?? 'application/octet-stream'
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return c.json({ error: 'invalid_request', detail: 'sha256 query param required' }, 400)
  }
  const bytes = await c.req.arrayBuffer()
  if (bytes.byteLength === 0) return c.json({ error: 'empty_body' }, 400)
  if (bytes.byteLength > 100 * 1024 * 1024) return c.json({ error: 'too_large' }, 413)

  // Integrity: the address must be the content's actual hash.
  const actual = toHex(await crypto.subtle.digest('SHA-256', bytes))
  if (actual !== sha256) return c.json({ error: 'hash_mismatch', actual }, 400)

  const key = `files/${sha256}`
  const existing = await c.env.BLOBS.head(key)
  if (!existing) await c.env.BLOBS.put(key, bytes)

  const fileId = newId('fil')
  await c.env.DB.prepare(
    `INSERT INTO files (id, user_id, sha256, name, mime, size, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(fileId, auth.sub, sha256, name, mime, bytes.byteLength, nowIso())
    .run()
  return c.json({ file_id: fileId, sha256, size: bytes.byteLength, deduped: Boolean(existing) })
})

sync.get('/files/manifest', async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT id, sha256, name, mime, size, created_at FROM files
     WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000`
  )
    .bind(auth.sub)
    .all()
  return c.json({ files: rows.results ?? [] })
})

sync.get('/files/:sha256', async (c) => {
  const auth = c.get('auth')
  const sha256 = c.req.param('sha256').toLowerCase()
  const owns = await c.env.DB.prepare(
    'SELECT id, mime, name FROM files WHERE user_id = ?1 AND sha256 = ?2 AND deleted_at IS NULL LIMIT 1'
  )
    .bind(auth.sub, sha256)
    .first<{ id: string; mime: string; name: string }>()
  if (!owns) return c.json({ error: 'not_found' }, 404)
  const obj = await c.env.BLOBS.get(`files/${sha256}`)
  if (!obj) return c.json({ error: 'blob_missing' }, 404)
  return new Response(obj.body, {
    headers: {
      'content-type': owns.mime,
      'content-length': String(obj.size),
      etag: sha256
    }
  })
})

// ── Restore: one call to rehydrate a fresh install ───────────────────────

sync.get('/sync/bootstrap', async (c) => {
  const auth = c.get('auth')
  const [settings, conversations, files] = await Promise.all([
    c.env.DB.prepare('SELECT config, updated_at FROM settings WHERE user_id = ?1')
      .bind(auth.sub)
      .first<{ config: string; updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM conversations
       WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`
    )
      .bind(auth.sub)
      .all(),
    c.env.DB.prepare(
      `SELECT id, sha256, name, mime, size FROM files
       WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000`
    )
      .bind(auth.sub)
      .all()
  ])
  return c.json({
    config: settings ? JSON.parse(settings.config) : {},
    config_updated_at: settings?.updated_at ?? null,
    conversations: conversations.results ?? [],
    files: files.results ?? []
  })
})

export default sync
