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
import type { z } from 'zod'
import { newId, toHex } from '@/lib/crypto'
import { BatchItemSchema, BatchSchema, ConfigPutSchema, FilesDeleteSchema } from '@/lib/schemas'
import { issuesOf, parseJson } from '@/lib/validate'
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
  const body = await parseJson(c, ConfigPutSchema)
  if (body instanceof Response) return body
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

type BatchItem = z.infer<typeof BatchItemSchema>
type ConversationItem = Extract<BatchItem, { type: 'conversation' }>
type RecordItem = Extract<BatchItem, { type: 'record' }>
type EpisodeItem = Extract<BatchItem, { type: 'episode' }>

/** Statements per D1 batch() call and bound content bytes per call: a
 *  400-item drain becomes a handful of round trips instead of 800, without
 *  ever assembling an oversized transaction. */
const D1_BATCH_STATEMENTS = 50
const D1_BATCH_CONTENT_BYTES = 4 * 1024 * 1024
/** D1 caps bound parameters per statement at 100. */
const SQL_IN_CHUNK = 90

type Planned = { stmt: D1PreparedStatement; bytes: number; silent?: boolean }

/**
 * Run planned statements through D1 batches — one round trip per chunk,
 * each chunk atomic. Returns per-statement `changes` (null = failed). A chunk
 * that fails as a whole (an unexpected constraint) degrades to statement-by-
 * statement execution, so one bad item still can't sink its neighbours.
 */
async function runPlanned(db: D1Database, planned: Planned[]): Promise<Array<number | null>> {
  const changes: Array<number | null> = new Array(planned.length).fill(null)
  let start = 0
  while (start < planned.length) {
    let end = start
    let bytes = 0
    while (
      end < planned.length &&
      end - start < D1_BATCH_STATEMENTS &&
      (end === start || bytes + planned[end]!.bytes <= D1_BATCH_CONTENT_BYTES)
    ) {
      bytes += planned[end]!.bytes
      end++
    }
    const chunk = planned.slice(start, end)
    try {
      const results = await db.batch(chunk.map((p) => p.stmt))
      results.forEach((r, i) => {
        changes[start + i] = r.meta.changes ?? 0
      })
    } catch {
      for (const [i, p] of chunk.entries()) {
        try {
          const r = await p.stmt.run()
          changes[start + i] = r.meta.changes ?? 0
        } catch {
          changes[start + i] = null
        }
      }
    }
    start = end
  }
  return changes
}

/**
 * The outbox drain, in three phases so a whole batch costs a few D1 round
 * trips instead of two per record:
 *   1. conversation rows (LWW upsert), so records in the same batch can
 *      reference conversations it just created;
 *   2. ONE ownership lookup per distinct conversation the records name —
 *      a record for someone else's conversation is rejected, never inserted;
 *   3. records + episodes. Message records are INSERT OR IGNORE (replays are
 *      no-ops). A `snapshot` record is the conversation's envelope: the
 *      client sends it under a stable id, the server keeps exactly ONE per
 *      conversation (upsert, newer seq wins) and retires every other snapshot
 *      row it supersedes — including the legacy hash-id rows — so the
 *      envelope history can never bloat a restore.
 */
sync.post('/sync/batch', async (c) => {
  const auth = c.get('auth')
  const parsed = await parseJson(c, BatchSchema)
  if (parsed instanceof Response) return parsed
  const db = c.env.DB

  let accepted = 0
  let ignored = 0
  let rejected = 0
  // Per-item tolerance, loudly: a malformed item never sinks the batch
  // (the outbox must keep draining), but its reasons come back in `issues`.
  const issues: { path: string; message: string }[] = []
  const conversations: ConversationItem[] = []
  const records: RecordItem[] = []
  const episodes: EpisodeItem[] = []
  for (const [index, raw] of parsed.items.entries()) {
    const itemIssues = issuesOf(BatchItemSchema, raw)
    if (itemIssues) {
      rejected++
      if (issues.length < 10) {
        issues.push(...itemIssues.map((i) => ({ ...i, path: `items.${index}.${i.path}` })))
      }
      continue
    }
    const item = raw as BatchItem
    if (item.type === 'conversation') conversations.push(item)
    else if (item.type === 'record') records.push(item)
    else episodes.push(item)
  }
  const tally = (planned: Planned[], changes: Array<number | null>): void => {
    changes.forEach((ch, i) => {
      if (planned[i]!.silent) return
      if (ch === null) rejected++
      else if (ch > 0) accepted++
      else ignored++
    })
  }

  // 1 · Conversation rows.
  if (conversations.length) {
    const planned: Planned[] = conversations.map((item) => ({
      bytes: 0,
      stmt: db
        .prepare(
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
    }))
    tally(planned, await runPlanned(db, planned))
  }

  // 2 · Ownership, once per distinct conversation the records reference.
  const owned = new Set<string>()
  if (records.length) {
    const ids = [...new Set(records.map((r) => r.conversation_id))]
    for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
      const chunk = ids.slice(i, i + SQL_IN_CHUNK)
      const rows = await db
        .prepare(
          `SELECT id FROM conversations WHERE user_id = ?1
           AND id IN (${chunk.map((_, k) => `?${k + 2}`).join(', ')})`
        )
        .bind(auth.sub, ...chunk)
        .all<{ id: string }>()
      for (const row of rows.results ?? []) owned.add(row.id)
    }
  }

  // 3 · Records and episodes. Several snapshots for one conversation in a
  // single batch collapse to the newest here (the others are superseded
  // before they are ever written), so compaction is order-independent.
  const planned: Planned[] = []
  const newestSnapshot = new Map<string, RecordItem>()
  for (const item of records) {
    if ((item.kind ?? 'message') !== 'snapshot' || !owned.has(item.conversation_id)) continue
    const current = newestSnapshot.get(item.conversation_id)
    if (!current || item.seq >= current.seq) newestSnapshot.set(item.conversation_id, item)
  }
  for (const item of records) {
    if (!owned.has(item.conversation_id)) {
      rejected++
      continue
    }
    const content = JSON.stringify(item.content ?? null)
    const kind = item.kind ?? 'message'
    if (kind === 'snapshot') {
      if (newestSnapshot.get(item.conversation_id) !== item) {
        ignored++
        continue
      }
      planned.push({
        bytes: content.length,
        stmt: db
          .prepare(
            `INSERT INTO conversation_records
               (id, conversation_id, user_id, seq, kind, content, created_at)
             VALUES (?1, ?2, ?3, ?4, 'snapshot', ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               seq = excluded.seq, content = excluded.content, created_at = excluded.created_at
             WHERE conversation_records.conversation_id = excluded.conversation_id
               AND excluded.seq >= conversation_records.seq`
          )
          .bind(item.id, item.conversation_id, auth.sub, item.seq, content, item.created_at)
      })
      planned.push({
        bytes: 0,
        silent: true,
        stmt: db
          .prepare(
            `DELETE FROM conversation_records
             WHERE conversation_id = ?1 AND kind = 'snapshot' AND id != ?2 AND seq <= ?3`
          )
          .bind(item.conversation_id, item.id, item.seq)
      })
    } else {
      planned.push({
        bytes: content.length,
        stmt: db
          .prepare(
            `INSERT OR IGNORE INTO conversation_records
               (id, conversation_id, user_id, seq, kind, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          )
          .bind(item.id, item.conversation_id, auth.sub, item.seq, kind, content, item.created_at)
      })
    }
  }
  for (const item of episodes) {
    const content = JSON.stringify(item.content ?? null)
    planned.push({
      bytes: content.length,
      stmt: db
        .prepare(
          `INSERT OR IGNORE INTO episodes (id, user_id, content, occurred_at)
           VALUES (?1, ?2, ?3, ?4)`
        )
        .bind(item.id, auth.sub, content, item.occurred_at)
    })
  }
  if (planned.length) tally(planned, await runPlanned(db, planned))

  return c.json({ ok: true, accepted, ignored, rejected, ...(issues.length ? { issues } : {}) })
})

// ── Lazy reads (restore path) ────────────────────────────────────────────

// Page size the conversation index pages ride, here and in bootstrap.
const CONV_PAGE = 500

/**
 * The full conversation index, paged — no cap. Keyset on rowid ascending
 * (`after` = last rowid seen, echoed back as `next`; `next: null` means
 * done), so restore walks EVERY conversation no matter how many automations
 * have piled up. Order is irrelevant to restore — completeness is the
 * contract.
 */
sync.get('/conversations', async (c) => {
  const auth = c.get('auth')
  const after = parseInt(c.req.query('after') ?? '0', 10)
  const cursor = Number.isFinite(after) && after > 0 ? after : 0
  const limitRaw = parseInt(c.req.query('limit') ?? String(CONV_PAGE), 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : CONV_PAGE, 1), CONV_PAGE)
  const rows = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, title, device_id, created_at, updated_at FROM conversations
     WHERE user_id = ?1 AND deleted_at IS NULL AND rowid > ?2 ORDER BY rowid LIMIT ?3`
  )
    .bind(auth.sub, cursor, limit)
    .all<{ rid: number } & Record<string, unknown>>()
  const results = rows.results ?? []
  const conversations = results.map(({ rid: _rid, ...rest }) => rest)
  return c.json({
    conversations,
    next: results.length === limit ? results[results.length - 1]!.rid : null
  })
})

sync.get('/conversations/:id/records', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const owns = await c.env.DB.prepare('SELECT user_id FROM conversations WHERE id = ?1')
    .bind(id)
    .first<{ user_id: string }>()
  if (!owns || owns.user_id !== auth.sub) return c.json({ error: 'not_found' }, 404)

  // Message versions share a seq (the id carries the content hash, the seq the
  // message timestamp), so pages ride the insert-order cursor: `after` is the
  // last rowid seen, `next_after` the one to send back. A seq cursor would
  // drop the rest of an equal-seq run split across the 200-row boundary. The
  // legacy `after_seq` form stays honored for clients mid-flight, with rowid
  // as the tie-break so equal seqs at least page in a stable order.
  const legacySeq = c.req.query('after_seq')
  if (c.req.query('after') === undefined && legacySeq !== undefined) {
    const after = parseInt(legacySeq, 10)
    const rows = await c.env.DB.prepare(
      `SELECT id, seq, kind, content, created_at FROM conversation_records
       WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq, rowid LIMIT 200`
    )
      .bind(id, Number.isFinite(after) ? after : -1)
      .all<{ id: string; seq: number; kind: string; content: string; created_at: string }>()
    const records = (rows.results ?? []).map((r) => ({ ...r, content: JSON.parse(r.content) }))
    return c.json({
      records,
      next_after_seq: records.length ? records[records.length - 1]!.seq : after
    })
  }

  const after = parseInt(c.req.query('after') ?? '0', 10)
  const cursor = Number.isFinite(after) ? after : 0
  // `limit` lets the client pick a page size it can also use as its stop
  // condition (a short page = the last page). Clamped to the old fixed 200.
  const limitRaw = parseInt(c.req.query('limit') ?? '200', 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 200)
  const rows = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, seq, kind, content, created_at FROM conversation_records
     WHERE conversation_id = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3`
  )
    .bind(id, cursor, limit)
    .all<{ rid: number; id: string; seq: number; kind: string; content: string; created_at: string }>()
  const results = rows.results ?? []
  const records = results.map((r) => ({
    id: r.id,
    seq: r.seq,
    kind: r.kind,
    content: JSON.parse(r.content),
    created_at: r.created_at
  }))
  // `next_after: null` = this was the last page. The explicit terminator is
  // the contract (not "a short page"), so the client stays correct even if
  // the server's max page size ever shrinks below what was requested.
  return c.json({
    records,
    next_after: results.length === limit ? results[results.length - 1]!.rid : null
  })
})

sync.delete('/conversations/:id', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    'UPDATE conversations SET deleted_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL'
  )
    .bind(nowIso(), id, auth.sub)
    .run()
  return c.json({ ok: true, deleted: res.meta.changes > 0 })
})

// ── Files (content-addressed blobs) ──────────────────────────────────────

/** SHA-256 of zero bytes — the one hash an empty body is allowed to claim. */
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

sync.post('/files/upload', async (c) => {
  const auth = c.get('auth')
  const sha256 = (c.req.query('sha256') ?? '').toLowerCase()
  const name = (c.req.query('name') ?? 'unnamed').slice(0, 500)
  const mime = (c.req.query('mime') ?? 'application/octet-stream').slice(0, 100)
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return c.json({ error: 'invalid_request', detail: 'sha256 query param required' }, 400)
  }
  const bytes = await c.req.arrayBuffer()
  // Empty files are real content (marker files, cleared logs): allowed, but
  // only under the one hash empty bytes actually have.
  if (bytes.byteLength === 0 && sha256 !== EMPTY_SHA) return c.json({ error: 'empty_body' }, 400)
  if (bytes.byteLength > 100 * 1024 * 1024) return c.json({ error: 'too_large' }, 413)

  // Integrity: the address must be the content's actual hash.
  const actual = toHex(await crypto.subtle.digest('SHA-256', bytes))
  if (actual !== sha256) return c.json({ error: 'hash_mismatch', actual }, 400)

  const key = `files/${sha256}`
  const existing = await c.env.BLOBS.head(key)
  if (!existing) await c.env.BLOBS.put(key, bytes)

  // Upsert on (user, sha, name): a re-upload of the same path+content bumps
  // created_at (so "newest row per path" tracks reality — a reverted file
  // restores as reverted) and clears any tombstone (a re-created file is
  // alive again). Distinct paths sharing content get their own rows, so a
  // duplicate-content file restores at BOTH paths. Then the rows this
  // content SUPERSEDES — same path, older content — are retired in the same
  // round trip, so the manifest holds one live row per path no matter how
  // often a file changes; their blobs are collected by the nightly sweep
  // once nothing live references them.
  const fileId = newId('fil')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO files (id, user_id, sha256, name, mime, size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, sha256, name) DO UPDATE SET
         created_at = excluded.created_at, mime = excluded.mime,
         size = excluded.size, deleted_at = NULL`
    ).bind(fileId, auth.sub, sha256, name, mime, bytes.byteLength, now),
    c.env.DB.prepare(
      `UPDATE files SET deleted_at = ?1
       WHERE user_id = ?2 AND name = ?3 AND sha256 != ?4 AND deleted_at IS NULL`
    ).bind(now, auth.sub, name, sha256)
  ])
  return c.json({ file_id: fileId, sha256, size: bytes.byteLength, deduped: Boolean(existing) })
})

// Page size the file manifest pages ride, here and in bootstrap.
const FILES_PAGE = 1000

/** `${created_at}~~${rowid}` keyset cursor for the newest-first file pages. */
const filesCursor = (row: { created_at: string; rid: number }): string =>
  `${row.created_at}~~${row.rid}`

function parseFilesCursor(raw: string | undefined): { at: string; rid: number } | null {
  if (!raw) return null
  const idx = raw.lastIndexOf('~~')
  if (idx <= 0) return null
  const rid = parseInt(raw.slice(idx + 2), 10)
  const at = raw.slice(0, idx)
  return Number.isFinite(rid) && at ? { at, rid } : null
}

/**
 * The full file manifest, paged newest-first — no cap. Keyset on
 * (created_at, rowid) descending so "first occurrence of a path across the
 * pages" is that path's newest row, which is what restore materializes.
 * `before` continues from a previous page's `next`; `next: null` means done.
 */
sync.get('/files/manifest', async (c) => {
  const auth = c.get('auth')
  const cur = parseFilesCursor(c.req.query('before'))
  const limitRaw = parseInt(c.req.query('limit') ?? String(FILES_PAGE), 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : FILES_PAGE, 1), FILES_PAGE)
  const stmt = cur
    ? c.env.DB.prepare(
        `SELECT rowid AS rid, id, sha256, name, mime, size, created_at FROM files
         WHERE user_id = ?1 AND deleted_at IS NULL
           AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
         ORDER BY created_at DESC, rowid DESC LIMIT ?4`
      ).bind(auth.sub, cur.at, cur.rid, limit)
    : c.env.DB.prepare(
        `SELECT rowid AS rid, id, sha256, name, mime, size, created_at FROM files
         WHERE user_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT ?2`
      ).bind(auth.sub, limit)
  const rows = await stmt.all<{ rid: number; created_at: string } & Record<string, unknown>>()
  const results = rows.results ?? []
  const files = results.map(({ rid: _rid, ...rest }) => rest)
  return c.json({
    files,
    next: results.length === limit ? filesCursor(results[results.length - 1]!) : null
  })
})

/**
 * Tombstone file rows by workspace-relative name — the delete half of the
 * blob sweep, so a file the user deleted stays deleted after a purge+restore
 * instead of resurrecting. Blobs stay in R2 (content-addressed, possibly
 * shared); only this user's rows are tombstoned, and a later re-upload of
 * the same path revives them (upload clears deleted_at).
 */
sync.post('/files/delete', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, FilesDeleteSchema)
  if (body instanceof Response) return body
  const placeholders = body.names.map((_, i) => `?${i + 3}`).join(', ')
  const res = await c.env.DB.prepare(
    `UPDATE files SET deleted_at = ?1
     WHERE user_id = ?2 AND deleted_at IS NULL AND name IN (${placeholders})`
  )
    .bind(nowIso(), auth.sub, ...body.names)
    .run()
  return c.json({ ok: true, deleted: res.meta.changes })
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

// ── Usage (the authoritative ledger, per user) ───────────────────────────

const USAGE_PAGE = 1000

/**
 * This user's metered calls, keyset-paged on the row id (`after` = last id
 * seen, `next: null` = done). The desktop rebuilds its usage ledger from
 * these rows after a purge and folds in what its OTHER devices spent, so the
 * usage panel is the org's record, not one machine's scratch file. Every
 * decision is served (denials included) — the client decides what to show.
 */
sync.get('/usage', async (c) => {
  const auth = c.get('auth')
  const after = parseInt(c.req.query('after') ?? '0', 10)
  const cursor = Number.isFinite(after) && after > 0 ? after : 0
  const limitRaw = parseInt(c.req.query('limit') ?? String(USAGE_PAGE), 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : USAGE_PAGE, 1), USAGE_PAGE)
  const rows = await c.env.DB.prepare(
    `SELECT id, device_id, model, kind, tokens_in, tokens_out, tokens_cached, cost_microusd,
       decision, created_at
     FROM usage WHERE user_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`
  )
    .bind(auth.sub, cursor, limit)
    .all<{ id: number } & Record<string, unknown>>()
  const results = rows.results ?? []
  return c.json({
    rows: results,
    next: results.length === limit ? results[results.length - 1]!.id : null
  })
})

// ── Restore: one call to rehydrate a fresh install ───────────────────────

/**
 * One call to START rehydrating a fresh install: config plus the FIRST page
 * of the conversation index and the file manifest. Neither list is capped —
 * `conversations_next` / `files_next` carry keyset cursors the client feeds
 * to GET /conversations and GET /files/manifest until each returns
 * `next: null`. Small accounts still restore in this one round-trip.
 */
sync.get('/sync/bootstrap', async (c) => {
  const auth = c.get('auth')
  const [settings, conversations, files] = await Promise.all([
    c.env.DB.prepare('SELECT config, updated_at FROM settings WHERE user_id = ?1')
      .bind(auth.sub)
      .first<{ config: string; updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT rowid AS rid, id, title, created_at, updated_at FROM conversations
       WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY rowid LIMIT ?2`
    )
      .bind(auth.sub, CONV_PAGE)
      .all<{ rid: number } & Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT rowid AS rid, id, sha256, name, mime, size, created_at FROM files
       WHERE user_id = ?1 AND deleted_at IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?2`
    )
      .bind(auth.sub, FILES_PAGE)
      .all<{ rid: number; created_at: string } & Record<string, unknown>>()
  ])
  const convRows = conversations.results ?? []
  const fileRows = files.results ?? []
  return c.json({
    config: settings ? JSON.parse(settings.config) : {},
    config_updated_at: settings?.updated_at ?? null,
    conversations: convRows.map(({ rid: _rid, ...rest }) => rest),
    conversations_next:
      convRows.length === CONV_PAGE ? convRows[convRows.length - 1]!.rid : null,
    files: fileRows.map(({ rid: _rid, ...rest }) => rest),
    files_next:
      fileRows.length === FILES_PAGE ? filesCursor(fileRows[fileRows.length - 1]!) : null
  })
})

/**
 * Wipe this user's synced record: tombstone every conversation and every
 * file row. The desktop's factory reset calls this so "wipe my data" means
 * the org copy too, not just the local cache — without it, the next
 * purge+sign-in would resurrect everything the user believed erased.
 * Settings are deliberately kept (factory reset preserves preferences).
 */
sync.post('/sync/wipe', async (c) => {
  const auth = c.get('auth')
  const now = nowIso()
  const [convs, files] = await Promise.all([
    c.env.DB.prepare(
      'UPDATE conversations SET deleted_at = ?1 WHERE user_id = ?2 AND deleted_at IS NULL'
    )
      .bind(now, auth.sub)
      .run(),
    c.env.DB.prepare('UPDATE files SET deleted_at = ?1 WHERE user_id = ?2 AND deleted_at IS NULL')
      .bind(now, auth.sub)
      .run()
  ])
  return c.json({ ok: true, conversations: convs.meta.changes, files: files.meta.changes })
})

export default sync
