/**
 * Sync — what makes the local folder a mere cache.
 *
 * The client drains a local outbox after each turn: conversations and
 * records come through /sync/batch (idempotent — every item carries a
 * client-generated id, replays are no-ops; the response names every item it
 * refused so the client can quarantine it), files go through
 * content-addressed upload (dedupe by sha256). Restore is /sync/bootstrap
 * (one call: config + conversation index + file manifest) plus lazy pulls
 * of record pages and blobs. Config is last-write-wins on the one row.
 */
import { Hono } from 'hono'
import type { z } from 'zod'
import { newId, toHex } from '@/lib/crypto'
import { readRecordsPage, RECORDS_PAGE_MAX } from '@/lib/records'
import { openConfig, sealConfig } from '@/lib/config-crypto'
import { apply as applyOverlay, getOrgConfigOverlay, withOverlay } from '@/lib/org-config'
import { BatchItemSchema, BatchSchema, ConfigPutSchema, FilesDeleteSchema } from '@/lib/schemas'
import { issuesOf, parseJson, parseValue } from '@/lib/validate'
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
  const stored = await openConfig(c.env, row?.config)
  if (stored === null) return c.json({ error: 'config_unreadable' }, 500)
  // The org's overlay is applied on the way out, and `locked_keys` names the
  // paths it owns so a settings screen can show them as the org's rather
  // than letting someone edit a value that will not survive the next write.
  const { config, locked_keys } = await withOverlay(c.env, stored)
  return c.json({ config, locked_keys, updated_at: row?.updated_at ?? null })
})

sync.put('/config', async (c) => {
  const auth = c.get('auth')
  const body = await parseJson(c, ConfigPutSchema)
  if (body instanceof Response) return body
  const now = nowIso()
  // Applied again on the way IN: a client that does not honour the lock —
  // an older build, a hand-rolled request, a config.json edited on disk —
  // must not be able to store anything else under an org-owned path.
  const overlay = await getOrgConfigOverlay(c.env)
  const enforced = applyOverlay(body.config, overlay)
  await c.env.DB.prepare(
    `INSERT INTO settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  )
    .bind(auth.sub, await sealConfig(c.env, enforced), now)
    .run()
  return c.json({
    ok: true,
    updated_at: now,
    locked_keys: Object.keys(overlay)
  })
})

// ── The outbox drain ─────────────────────────────────────────────────────

type BatchItem = z.infer<typeof BatchItemSchema>
type ConversationItem = Extract<BatchItem, { type: 'conversation' }>
type RecordItem = Extract<BatchItem, { type: 'record' }>

/** Statements per D1 batch() call and bound content bytes per call: a
 *  400-item drain becomes a handful of round trips instead of 800, without
 *  ever assembling an oversized transaction. */
const D1_BATCH_STATEMENTS = 50
const D1_BATCH_CONTENT_BYTES = 4 * 1024 * 1024
/** D1 caps bound parameters per statement at 100. */
const SQL_IN_CHUNK = 90
/** A batch body above this is refused outright: the client chunks at 8 MB,
 *  and the Worker parses the whole body in memory. */
const MAX_BATCH_BYTES = 32 * 1024 * 1024
/** Refused item ids named in the response, at most. */
const MAX_REJECTED_IDS = 200

type Planned = { stmt: D1PreparedStatement; bytes: number; silent?: boolean; id?: string }

/**
 * The LAST parser of the `<base_id>.<version_hash>` record-id convention.
 *
 * It exists only for clients that predate base_id/version_hash on the wire;
 * everything else — the message counts, the desktop's restore, the phone's
 * rebuild — now reads the columns. Keep it here and nowhere else: the whole
 * point of migration 0017 is that this string is parsed in one place, by
 * code, rather than in two SQL queries and two client regexes.
 */
export function splitRecordId(id: string): { baseId: string; versionHash: string | null } {
  const dot = id.length - 9
  if (dot > 0 && id[dot] === '.' && /^[0-9a-f]{8}$/.test(id.slice(dot + 1))) {
    return { baseId: id.slice(0, dot), versionHash: id.slice(dot + 1) }
  }
  return { baseId: id, versionHash: null }
}

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
 *   3. records. Message records are INSERT OR IGNORE (replays are no-ops).
 *      A `snapshot` record is the conversation's envelope: the
 *      client sends it under a stable id, the server keeps exactly ONE per
 *      conversation (upsert, newer seq wins) and retires every other snapshot
 *      row it supersedes — including the legacy hash-id rows — so the
 *      envelope history can never bloat a restore.
 */
sync.post('/sync/batch', async (c) => {
  const auth = c.get('auth')
  // The whole body is parsed in memory: bound here, chunked by the client.
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_BATCH_BYTES) {
    return c.json({ error: 'payload_too_large', max_bytes: MAX_BATCH_BYTES }, 413)
  }
  const text = await c.req.text()
  if (text.length > MAX_BATCH_BYTES) {
    return c.json({ error: 'payload_too_large', max_bytes: MAX_BATCH_BYTES }, 413)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  const parsed = parseValue(c, BatchSchema, raw)
  if (parsed instanceof Response) return parsed
  const db = c.env.DB

  let accepted = 0
  let ignored = 0
  let rejected = 0
  // Per-item tolerance, loudly: a malformed item never sinks the batch
  // (the outbox must keep draining), but its reasons come back in `issues`
  // and its id in `rejected_ids` — so the client can quarantine that item
  // instead of re-sending the whole conversation forever.
  const issues: { path: string; message: string }[] = []
  const rejectedIds: string[] = []
  const refuse = (id: unknown): void => {
    rejected++
    if (typeof id === 'string' && id && rejectedIds.length < MAX_REJECTED_IDS) rejectedIds.push(id)
  }
  const conversations: ConversationItem[] = []
  const records: RecordItem[] = []
  for (const [index, item] of parsed.items.entries()) {
    const itemIssues = issuesOf(BatchItemSchema, item)
    if (itemIssues) {
      refuse((item as { id?: unknown } | null)?.id)
      if (issues.length < 10) {
        issues.push(...itemIssues.map((i) => ({ ...i, path: `items.${index}.${i.path}` })))
      }
      continue
    }
    const typed = item as BatchItem
    if (typed.type === 'conversation') conversations.push(typed)
    else records.push(typed)
  }
  const tally = (planned: Planned[], changes: Array<number | null>): void => {
    changes.forEach((ch, i) => {
      if (planned[i]!.silent) return
      if (ch === null) refuse(planned[i]!.id)
      else if (ch > 0) accepted++
      else ignored++
    })
  }

  // 1 · Conversation rows.
  if (conversations.length) {
    const planned: Planned[] = conversations.map((item) => ({
      bytes: 0,
      id: item.id,
      stmt: db
        .prepare(
          `INSERT INTO conversations
             (id, user_id, device_id, title, channel, created_at, updated_at, synced_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, updated_at = excluded.updated_at,
             synced_at = excluded.synced_at,
             -- Provenance is write-once: a client that sends no channel (an
             -- older build, or a writer that never knew one) must not erase
             -- the one already recorded.
             channel = CASE WHEN excluded.channel != '' THEN excluded.channel
                            ELSE conversations.channel END
           WHERE conversations.user_id = excluded.user_id
             -- Deleted stays deleted: a device that has not yet heard about
             -- the tombstone must not bump the row's stamps and put it back
             -- through every other device's catch-up feed.
             AND conversations.deleted_at IS NULL
             AND excluded.updated_at > conversations.updated_at`
        )
        .bind(
          item.id,
          auth.sub,
          item.device_id ?? auth.dev,
          item.title ?? '',
          item.channel ?? '',
          item.created_at,
          item.updated_at,
          // The SERVER's stamp — the phone's "what changed since" cursor.
          nowIso()
        )
    }))
    tally(planned, await runPlanned(db, planned))
  }

  // 2 · Ownership, once per distinct conversation the records reference.
  // A TOMBSTONED conversation is not writable: another of this user's
  // devices still holding the deleted transcript would otherwise re-insert
  // its records on every launch, resurrecting in the master record exactly
  // what the nightly purge had removed. Its ids come back in `rejected_ids`,
  // which the client quarantines.
  const owned = new Set<string>()
  if (records.length) {
    const ids = [...new Set(records.map((r) => r.conversation_id))]
    for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
      const chunk = ids.slice(i, i + SQL_IN_CHUNK)
      const rows = await db
        .prepare(
          `SELECT id FROM conversations WHERE user_id = ?1 AND deleted_at IS NULL
           AND id IN (${chunk.map((_, k) => `?${k + 2}`).join(', ')})`
        )
        .bind(auth.sub, ...chunk)
        .all<{ id: string }>()
      for (const row of rows.results ?? []) owned.add(row.id)
    }
  }

  // 3 · Records. Several snapshots for one conversation in a single batch
  // collapse to the newest here (the others are superseded before they are
  // ever written), so compaction is order-independent.
  const planned: Planned[] = []
  const newestSnapshot = new Map<string, RecordItem>()
  for (const item of records) {
    if ((item.kind ?? 'message') !== 'snapshot' || !owned.has(item.conversation_id)) continue
    const current = newestSnapshot.get(item.conversation_id)
    if (!current || item.seq >= current.seq) newestSnapshot.set(item.conversation_id, item)
  }
  for (const item of records) {
    if (!owned.has(item.conversation_id)) {
      refuse(item.id)
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
        id: item.id,
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
      // Identity as columns, from the client when it sends them and from
      // the one surviving parser when it does not.
      const derived = splitRecordId(item.id)
      const baseId = item.base_id ?? derived.baseId
      const versionHash = item.version_hash ?? derived.versionHash
      planned.push({
        bytes: content.length,
        id: item.id,
        stmt: db
          .prepare(
            `INSERT OR IGNORE INTO conversation_records
               (id, conversation_id, user_id, seq, kind, content, created_at, base_id, version_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
          )
          .bind(
            item.id,
            item.conversation_id,
            auth.sub,
            item.seq,
            kind,
            content,
            item.created_at,
            baseId,
            versionHash
          )
      })
    }
  }
  if (planned.length) tally(planned, await runPlanned(db, planned))

  return c.json({
    ok: true,
    accepted,
    ignored,
    rejected,
    ...(rejectedIds.length ? { rejected_ids: rejectedIds } : {}),
    ...(issues.length ? { issues } : {})
  })
})

// ── Lazy reads (restore path) ────────────────────────────────────────────

// Page size the conversation index pages ride, here and in bootstrap.
const CONV_PAGE = 500

/**
 * The conversation index, two ways.
 *
 * `after` (rowid keyset, the desktop's restore): every live conversation,
 * completeness the contract — see the original notes below.
 *
 * `since` (the phone's catch-up): rows whose SERVER stamp moved past the
 * cursor — `synced_at` for writes, `deleted_at` for tombstones, which is
 * how a deletion the phone slept through reaches it without a full id
 * sweep. `include=meta` joins the envelope record so one page carries what
 * the phone's list draws (model, channel, icon, project, stats, summary)
 * and a message count, all without a body fetch. The cursor is
 * `<stamp>~~<rowid>` (echoed as `next`; null = done), so rows sharing a
 * stamp can never straddle a page boundary.
 */
const CURSOR_AT = `CASE WHEN c.deleted_at IS NOT NULL AND c.deleted_at > COALESCE(c.synced_at, '')
                        THEN c.deleted_at ELSE COALESCE(c.synced_at, c.updated_at) END`

function parseSinceCursor(raw: string | undefined): { at: string; rid: number } {
  if (!raw) return { at: '', rid: 0 }
  const idx = raw.lastIndexOf('~~')
  if (idx <= 0) return { at: raw, rid: 0 }
  const rid = parseInt(raw.slice(idx + 2), 10)
  return { at: raw.slice(0, idx), rid: Number.isFinite(rid) ? rid : 0 }
}

sync.get('/conversations', async (c) => {
  const auth = c.get('auth')
  const limitRaw = parseInt(c.req.query('limit') ?? String(CONV_PAGE), 10)
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : CONV_PAGE, 1), CONV_PAGE)

  if (c.req.query('since') !== undefined) {
    const cur = parseSinceCursor(c.req.query('since'))
    const meta = c.req.query('include') === 'meta'
    const metaColumns = meta
      ? `, json_extract(s.content, '$.model') AS model,
           json_extract(s.content, '$.channel') AS channel,
           json_extract(s.content, '$.icon') AS icon,
           json_extract(s.content, '$.projectId') AS project_id,
           json_extract(s.content, '$.sealed') AS sealed,
           json_extract(s.content, '$.summary') AS summary,
           json_extract(s.content, '$.stats') AS stats,
           COALESCE(json_extract(s.content, '$.messageCount'),
             (SELECT COUNT(DISTINCT COALESCE(r.base_id, r.id)) FROM conversation_records r
               WHERE r.conversation_id = c.id AND r.kind = 'message')) AS message_count`
      : ''
    const joinSnapshot = meta
      ? `LEFT JOIN conversation_records s ON s.conversation_id = c.id AND s.kind = 'snapshot'`
      : ''
    const rows = await c.env.DB.prepare(
      `SELECT c.rowid AS rid, c.id, c.title, c.device_id, c.created_at, c.updated_at, c.deleted_at,
         ${CURSOR_AT} AS cursor_at${metaColumns}
       FROM conversations c ${joinSnapshot}
       WHERE c.user_id = ?1
         AND (${CURSOR_AT} > ?2 OR (${CURSOR_AT} = ?2 AND c.rowid > ?3))
       ORDER BY cursor_at, c.rowid LIMIT ?4`
    )
      .bind(auth.sub, cur.at, cur.rid, limit)
      .all<{ rid: number; cursor_at: string; deleted_at: string | null } & Record<string, unknown>>()
    const results = rows.results ?? []
    const conversations = results.map(({ rid: _rid, cursor_at: _c, stats, ...rest }) => ({
      ...rest,
      ...(meta
        ? {
            stats: typeof stats === 'string' ? safeJson(stats) : (stats ?? null)
          }
        : {})
    }))
    const last = results[results.length - 1]
    return c.json({
      conversations,
      next: results.length === limit && last ? `${last.cursor_at}~~${last.rid}` : null,
      // The cursor to store even when the page was short: the newest stamp
      // seen, so the next catch-up starts exactly where this one ended.
      cursor: last ? `${last.cursor_at}~~${last.rid}` : c.req.query('since') || null
    })
  }

  const after = parseInt(c.req.query('after') ?? '0', 10)
  const cursor = Number.isFinite(after) && after > 0 ? after : 0
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

sync.get('/conversations/:id/records', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const owns = await c.env.DB.prepare(
    'SELECT user_id, archive_key, archived_at FROM conversations WHERE id = ?1'
  )
    .bind(id)
    .first<{ user_id: string; archive_key: string | null; archived_at: string | null }>()
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

  // `limit` lets the client pick a page size it can also use as its stop
  // condition (a short page = the last page). Clamped by the shared reader.
  const page = await readRecordsPage(c.env, id, owns, {
    after: parseInt(c.req.query('after') ?? '0', 10),
    limit: parseInt(c.req.query('limit') ?? String(RECORDS_PAGE_MAX), 10)
  })
  return c.json(page)
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
  const now = nowIso()
  // Chunked because D1 caps bound parameters at 100 per statement and the
  // schema accepts 500 names: a single statement over the whole list threw
  // at 99 names (2 fixed binds + 99), and the client's retry of an outbox
  // item that can never succeed never drains — which also means a sign-out
  // that waits for an empty outbox never purges the local cache.
  let deleted = 0
  for (let i = 0; i < body.names.length; i += SQL_IN_CHUNK) {
    const chunk = body.names.slice(i, i + SQL_IN_CHUNK)
    const res = await c.env.DB.prepare(
      `UPDATE files SET deleted_at = ?1
       WHERE user_id = ?2 AND deleted_at IS NULL
         AND name IN (${chunk.map((_, k) => `?${k + 3}`).join(', ')})`
    )
      .bind(now, auth.sub, ...chunk)
      .run()
    deleted += res.meta.changes ?? 0
  }
  return c.json({ ok: true, deleted })
})

/**
 * A workspace path's newest live blob — the phone's file cache resolves the
 * desktop's own relative paths (`files/report.pdf`, `screenshots/conv-…`)
 * without holding the manifest, and the HEAD form is the collision check a
 * phone upload runs before choosing a name.
 */
sync.on(['GET', 'HEAD'], '/files/path', async (c) => {
  const auth = c.get('auth')
  const name = (c.req.query('name') ?? '').slice(0, 500)
  if (!name) return c.json({ error: 'invalid_request', detail: 'name query param required' }, 400)
  const row = await c.env.DB.prepare(
    `SELECT sha256, mime, size FROM files WHERE user_id = ?1 AND name = ?2 AND deleted_at IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  )
    .bind(auth.sub, name)
    .first<{ sha256: string; mime: string; size: number }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { etag: row.sha256, 'content-type': row.mime, 'content-length': String(row.size) }
    })
  }
  const inm = c.req.header('if-none-match')
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1') === row.sha256)) {
    return new Response(null, { status: 304, headers: { etag: row.sha256 } })
  }
  const obj = await c.env.BLOBS.get(`files/${row.sha256}`)
  if (!obj) return c.json({ error: 'blob_missing' }, 404)
  return new Response(obj.body, {
    headers: {
      'content-type': row.mime,
      'content-length': String(obj.size),
      etag: row.sha256,
      'x-wfc-sha256': row.sha256
    }
  })
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

/**
 * The same ledger folded per (day × model × lane) — what the phone's Usage
 * screen draws, computed here once instead of the phone holding every raw
 * row. `tz` is the caller's UTC offset in minutes (JS `-getTimezoneOffset()`
 * sign: Riyadh = 180) so days fold on the caller's midnight, the way the
 * desktop's own ledger does. Denials are excluded: spend is what was served.
 */
sync.get('/usage/days', async (c) => {
  const auth = c.get('auth')
  const tzRaw = parseInt(c.req.query('tz') ?? '0', 10)
  const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, tzRaw)) : 0
  const shift = `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes`
  const rows = await c.env.DB.prepare(
    `SELECT substr(datetime(created_at, ?2), 1, 10) AS day, model, kind,
       SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
       SUM(tokens_cached) AS tokens_cached, SUM(cost_microusd) AS cost_microusd,
       COUNT(*) AS entries
     FROM usage WHERE user_id = ?1 AND decision = 'allowed'
     GROUP BY day, model, kind ORDER BY day`
  )
    .bind(auth.sub, shift)
    .all<{
      day: string
      model: string
      kind: string
      tokens_in: number
      tokens_out: number
      tokens_cached: number
      cost_microusd: number
      entries: number
    }>()
  return c.json({ days: rows.results ?? [], tz })
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
  const stored = await openConfig(c.env, settings?.config)
  if (stored === null) return c.json({ error: 'config_unreadable' }, 500)
  const { config, locked_keys } = await withOverlay(c.env, stored)
  return c.json({
    config,
    locked_keys,
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
