#!/usr/bin/env node
/**
 * Sync smoke test against `wrangler dev` (:8787). Proves the cloud is the
 * master and the folder is a cache:
 *
 *   config put/get LWW → outbox batch (conversations/records/episodes) →
 *   exact replay is a no-op → cross-user hijack rejected → lazy record
 *   pages → content-addressed file upload (hash verified, deduped) →
 *   download round-trips bytes → bootstrap rehydrates a "fresh install".
 */
import { execSync } from 'node:child_process'
import { createHash, pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const PW = 'sync-user-pass-1'
const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')

const mkUser = (tag) =>
  `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
   VALUES ('usr_${tag}_${stamp}', '${tag}-${stamp}@wolffi.sh', '${tag}', 'employee', 'active', '${hash}', '${salt}', 0);`
const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4-Flash-0731', '[]');`,
  mkUser('synca'),
  mkUser('syncb')
].join(' ')
execSync(`npx wrangler d1 execute wfc-master --local --command "${sql.replace(/"/g, '\\"')}"`, {
  stdio: 'pipe'
})

let failures = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
const api = async (path, { token, body, method, raw } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined && raw === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  })
  let json = null
  const buf = Buffer.from(await res.arrayBuffer())
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {}
  return { status: res.status, json, buf }
}
const login = async (tag) =>
  (
    await api('/auth/login', {
      body: { email: `${tag}-${stamp}@wolffi.sh`, password: PW, device: { platform: 'sim' } }
    })
  ).json

const a = await login('synca')
const b = await login('syncb')
check('two employees logged in', a?.access_token && b?.access_token)

// Config round-trip
const put1 = await api('/v1/config', {
  token: a.access_token,
  method: 'PUT',
  body: { config: { theme: 'dark', model: 'deepseek-ai/DeepSeek-V4-Flash-0731' } }
})
check('config put', put1.status === 200 && put1.json?.updated_at)
const got = await api('/v1/config', { token: a.access_token })
check('config get round-trips', got.json?.config?.theme === 'dark')
await api('/v1/config', { token: a.access_token, method: 'PUT', body: { config: { theme: 'light' } } })
const got2 = await api('/v1/config', { token: a.access_token })
check('config LWW overwrites', got2.json?.config?.theme === 'light')
check('config isolated per user', (await api('/v1/config', { token: b.access_token })).json?.config?.theme === undefined)

// Outbox batch
const convId = `cnv_${stamp}`
const now = new Date().toISOString()
const items = [
  { type: 'conversation', id: convId, title: 'First chat', created_at: now, updated_at: now },
  ...[0, 1, 2].map((seq) => ({
    type: 'record',
    id: `rec_${stamp}_${seq}`,
    conversation_id: convId,
    seq,
    kind: 'message',
    content: { role: seq % 2 ? 'assistant' : 'user', text: `turn ${seq}` },
    created_at: now
  })),
  { type: 'episode', id: `epi_${stamp}`, content: { note: 'learned something' }, occurred_at: now }
]
const batch1 = await api('/v1/sync/batch', { token: a.access_token, body: { items } })
check('batch accepted', batch1.json?.accepted === 5 && batch1.json?.rejected === 0, JSON.stringify(batch1.json))
const batch2 = await api('/v1/sync/batch', { token: a.access_token, body: { items } })
check('exact replay is a no-op', batch2.json?.accepted === 0 && batch2.json?.ignored === 5, JSON.stringify(batch2.json))

// LWW title update via newer conversation item
const later = new Date(Date.now() + 1000).toISOString()
const upd = await api('/v1/sync/batch', {
  token: a.access_token,
  body: { items: [{ type: 'conversation', id: convId, title: 'Renamed chat', created_at: now, updated_at: later }] }
})
check('newer conversation update accepted', upd.json?.accepted === 1)

// Cross-user hijack: B replays A's conversation/record ids
const hijack = await api('/v1/sync/batch', {
  token: b.access_token,
  body: {
    items: [
      { type: 'conversation', id: convId, title: 'stolen', created_at: now, updated_at: new Date(Date.now() + 5000).toISOString() },
      { type: 'record', id: `rec_evil_${stamp}`, conversation_id: convId, seq: 99, content: { x: 1 }, created_at: now }
    ]
  }
})
check('cross-user writes rejected/ignored', (hijack.json?.accepted ?? 99) === 0, JSON.stringify(hijack.json))
const aConvs = await api('/v1/conversations', { token: a.access_token })
check('A keeps own title', aConvs.json?.conversations?.[0]?.title === 'Renamed chat')
check('B sees no conversations', (await api('/v1/conversations', { token: b.access_token })).json?.conversations?.length === 0)

// Lazy record pages
const page = await api(`/v1/conversations/${convId}/records`, { token: a.access_token })
check('records page', page.json?.records?.length === 3 && page.json.records[0].content.text === 'turn 0')
const page2 = await api(`/v1/conversations/${convId}/records?after_seq=1`, { token: a.access_token })
check('after_seq pagination', page2.json?.records?.length === 1 && page2.json.records[0].seq === 2)
check('B cannot read A records', (await api(`/v1/conversations/${convId}/records`, { token: b.access_token })).status === 404)

// Files: content-addressed upload
const content = Buffer.from(`hello wolffish cloud ${stamp}`)
const sha = createHash('sha256').update(content).digest('hex')
const up1 = await api(`/v1/files/upload?sha256=${sha}&name=note.txt&mime=text/plain`, {
  token: a.access_token,
  raw: content
})
check('file upload', up1.status === 200 && up1.json?.deduped === false, JSON.stringify(up1.json))
const up2 = await api(`/v1/files/upload?sha256=${sha}&name=note-copy.txt&mime=text/plain`, {
  token: a.access_token,
  raw: content
})
check('re-upload dedupes blob', up2.json?.deduped === true)
const wrong = await api(`/v1/files/upload?sha256=${'0'.repeat(64)}&name=x&mime=text/plain`, {
  token: a.access_token,
  raw: content
})
check('hash mismatch rejected', wrong.status === 400 && wrong.json?.error === 'hash_mismatch')

const man = await api('/v1/files/manifest', { token: a.access_token })
check('manifest lists both names', (man.json?.files ?? []).length === 2)
const dl = await api(`/v1/files/${sha}`, { token: a.access_token })
check('download round-trips bytes', dl.status === 200 && dl.buf.equals(content))
check('B cannot fetch A blob', (await api(`/v1/files/${sha}`, { token: b.access_token })).status === 404)

// Bootstrap: the fresh-install rehydration
const boot = await api('/v1/sync/bootstrap', { token: a.access_token })
check(
  'bootstrap rehydrates',
  boot.json?.config?.theme === 'light' &&
    boot.json?.conversations?.length === 1 &&
    boot.json?.files?.length === 2,
  JSON.stringify(boot.json).slice(0, 200)
)

check(
  'bootstrap carries pagination cursors',
  boot.json?.conversations_next === null && boot.json?.files_next === null,
  JSON.stringify({ c: boot.json?.conversations_next, f: boot.json?.files_next })
)

// ── The no-caps contract: everything pages, nothing truncates ────────────

// Records: the terminator is next_after === null, NOT a short page.
const rp1 = await api(`/v1/conversations/${convId}/records?after=0&limit=2`, { token: a.access_token })
check('records limit honored', rp1.json?.records?.length === 2 && typeof rp1.json?.next_after === 'number')
const rp2 = await api(`/v1/conversations/${convId}/records?after=${rp1.json.next_after}&limit=2`, {
  token: a.access_token
})
check('records last page terminates with null', rp2.json?.records?.length === 1 && rp2.json?.next_after === null, JSON.stringify(rp2.json))

// Conversation index: keyset pages walk EVERY conversation.
const moreConvs = Array.from({ length: 7 }, (_, i) => ({
  type: 'conversation',
  id: `cnv_${stamp}_p${i}`,
  title: `Paged ${i}`,
  created_at: now,
  updated_at: now
}))
await api('/v1/sync/batch', { token: a.access_token, body: { items: moreConvs } })
const walked = []
let convCursor = 0
for (let i = 0; i < 10; i++) {
  const pageRes = await api(`/v1/conversations?after=${convCursor}&limit=3`, { token: a.access_token })
  walked.push(...(pageRes.json?.conversations ?? []))
  if (pageRes.json?.next == null) break
  convCursor = pageRes.json.next
}
check('conversation index fully paged (8 across pages of 3)', walked.length === 8, String(walked.length))

// File rows upsert on (user, sha, name): a re-upload must not grow the table.
await api(`/v1/files/upload?sha256=${sha}&name=note.txt&mime=text/plain`, { token: a.access_token, raw: content })
const manAfterReupload = await api('/v1/files/manifest', { token: a.access_token })
check('re-upload of same (sha,name) does not add a row', (manAfterReupload.json?.files ?? []).length === 2, String((manAfterReupload.json?.files ?? []).length))

// Manifest keyset pagination walks every row.
const manWalk = []
let manCursor = null
for (let i = 0; i < 10; i++) {
  const q = manCursor ? `?limit=1&before=${encodeURIComponent(manCursor)}` : '?limit=1'
  const pageRes = await api(`/v1/files/manifest${q}`, { token: a.access_token })
  manWalk.push(...(pageRes.json?.files ?? []))
  if (pageRes.json?.next == null) break
  manCursor = pageRes.json.next
}
check('manifest fully paged (2 across pages of 1)', manWalk.length === 2, String(manWalk.length))

// Empty files are real content under the one hash empty bytes have.
const EMPTY_SHA = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
const emptyUp = await api(`/v1/files/upload?sha256=${EMPTY_SHA}&name=empty.marker&mime=text/plain`, {
  token: a.access_token,
  raw: Buffer.alloc(0)
})
check('empty file upload accepted', emptyUp.status === 200, JSON.stringify(emptyUp.json))
const emptyDl = await api(`/v1/files/${EMPTY_SHA}`, { token: a.access_token })
check('empty file round-trips', emptyDl.status === 200 && emptyDl.buf.length === 0)

// Tombstones: delete by name, gone from the manifest, revived by re-upload.
const del = await api('/v1/files/delete', { token: a.access_token, body: { names: ['note-copy.txt'] } })
check('file tombstone', del.json?.deleted === 1, JSON.stringify(del.json))
const manAfterDelete = await api('/v1/files/manifest', { token: a.access_token })
check(
  'tombstoned name gone from manifest',
  !(manAfterDelete.json?.files ?? []).some((f) => f.name === 'note-copy.txt')
)
await api(`/v1/files/upload?sha256=${sha}&name=note-copy.txt&mime=text/plain`, { token: a.access_token, raw: content })
const manAfterRevive = await api('/v1/files/manifest', { token: a.access_token })
check(
  're-upload revives the tombstoned row',
  (manAfterRevive.json?.files ?? []).some((f) => f.name === 'note-copy.txt')
)

// Wipe (factory reset): tombstones B's whole record, touches nothing of A's.
await api('/v1/sync/batch', {
  token: b.access_token,
  body: {
    items: [
      { type: 'conversation', id: `cnv_${stamp}_b`, title: 'B chat', created_at: now, updated_at: now }
    ]
  }
})
await api(`/v1/files/upload?sha256=${sha}&name=b-note.txt&mime=text/plain`, { token: b.access_token, raw: content })
const wipe = await api('/v1/sync/wipe', { token: b.access_token, method: 'POST', body: {} })
check('wipe tombstones own record', wipe.json?.conversations === 1 && wipe.json?.files === 1, JSON.stringify(wipe.json))
const bBoot = await api('/v1/sync/bootstrap', { token: b.access_token })
check('B bootstrap empty after wipe', bBoot.json?.conversations?.length === 0 && bBoot.json?.files?.length === 0)
const aBoot = await api('/v1/sync/bootstrap', { token: a.access_token })
check('A untouched by B wipe', aBoot.json?.conversations?.length === 8 && (aBoot.json?.files?.length ?? 0) >= 3)

// ── 1.3.0: superseding, envelope compaction, batched phases, usage ──────

// Newer content at the same path retires the older row (one live row per path).
const v2 = Buffer.from(`hello wolffish cloud v2 ${stamp}`)
const sha2 = createHash('sha256').update(v2).digest('hex')
await api(`/v1/files/upload?sha256=${sha2}&name=note.txt&mime=text/plain`, { token: a.access_token, raw: v2 })
const manSup = await api('/v1/files/manifest', { token: a.access_token })
const noteRows = (manSup.json?.files ?? []).filter((f) => f.name === 'note.txt')
check('new content supersedes the older row for the same path', noteRows.length === 1 && noteRows[0].sha256 === sha2, JSON.stringify(noteRows))
check('superseded blob still serves while another path references it', (await api(`/v1/files/${sha}`, { token: a.access_token })).status === 200)

// One envelope per conversation: the stable snapshot id upserts (newer seq wins), older rows retire.
const snapConv = `cnv_${stamp}_snap`
const snapItems = (seq, title) => [
  { type: 'conversation', id: snapConv, title, created_at: now, updated_at: new Date(seq).toISOString() },
  { type: 'record', id: `snap.${snapConv}`, conversation_id: snapConv, seq, kind: 'snapshot', content: { title }, created_at: now },
  { type: 'record', id: `snap.legacy_${stamp}`, conversation_id: snapConv, seq: seq - 1, kind: 'snapshot', content: { title: 'legacy' }, created_at: now }
]
await api('/v1/sync/batch', { token: a.access_token, body: { items: snapItems(1_000, 'v1') } })
const snap2 = await api('/v1/sync/batch', { token: a.access_token, body: { items: snapItems(2_000, 'v2') } })
check('newer envelope accepted', snap2.json?.accepted >= 2, JSON.stringify(snap2.json))
const snapStale = await api('/v1/sync/batch', {
  token: a.access_token,
  body: { items: [{ type: 'record', id: `snap.${snapConv}`, conversation_id: snapConv, seq: 500, kind: 'snapshot', content: { title: 'stale' }, created_at: now }] }
})
check('stale envelope ignored', snapStale.json?.ignored === 1, JSON.stringify(snapStale.json))
const snapRecs = await api(`/v1/conversations/${snapConv}/records`, { token: a.access_token })
const snaps = (snapRecs.json?.records ?? []).filter((r) => r.kind === 'snapshot')
check('exactly one snapshot row per conversation, the newest (legacy rows retired)', snaps.length === 1 && snaps[0].content.title === 'v2', JSON.stringify(snaps))

// Records may reference a conversation created in the SAME batch (phase order).
const sameConv = `cnv_${stamp}_same`
const same = await api('/v1/sync/batch', {
  token: a.access_token,
  body: {
    items: [
      { type: 'record', id: `rec_${stamp}_same`, conversation_id: sameConv, seq: 0, content: { x: 1 }, created_at: now },
      { type: 'conversation', id: sameConv, title: 'same batch', created_at: now, updated_at: now }
    ]
  }
})
check('record may reference a conversation created in the same batch', same.json?.accepted === 2 && same.json?.rejected === 0, JSON.stringify(same.json))
const hijack2 = await api('/v1/sync/batch', {
  token: b.access_token,
  body: { items: [{ type: 'record', id: `rec_evil2_${stamp}`, conversation_id: sameConv, seq: 1, content: { x: 2 }, created_at: now }] }
})
check('cross-user record rejected in the batched path', hijack2.json?.rejected === 1 && hijack2.json?.accepted === 0, JSON.stringify(hijack2.json))
const big = await api('/v1/sync/batch', {
  token: a.access_token,
  body: {
    items: Array.from({ length: 400 }, (_, k) => ({ type: 'record', id: `rec_${stamp}_bulk_${k}`, conversation_id: sameConv, seq: k + 10, content: { k }, created_at: now }))
  }
})
check('400-record batch lands in full', big.json?.accepted === 400 && big.json?.rejected === 0, JSON.stringify(big.json))

// The org's usage table, per user: what a purged install rebuilds its ledger from.
const usage0 = await api('/v1/usage?after=0', { token: a.access_token })
check('usage read is per user and keyset-paged', usage0.status === 200 && Array.isArray(usage0.json?.rows) && usage0.json?.next === null, JSON.stringify(usage0.json))

console.log(failures === 0 ? '\nSYNC SMOKE: ALL PASS' : `\nSYNC SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
