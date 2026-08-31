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
   VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V3.1', '[]');`,
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
  body: { config: { theme: 'dark', model: 'deepseek-ai/DeepSeek-V3.1' } }
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

console.log(failures === 0 ? '\nSYNC SMOKE: ALL PASS' : `\nSYNC SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
