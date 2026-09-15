#!/usr/bin/env node
/**
 * The publish lane, against `wrangler dev` (:8787) — the door CI pushes
 * `capabilities/` through on every commit to main (src/routes/publish.ts).
 *
 * Two claims carry the whole design, and both are asserted here rather
 * than argued in a comment:
 *
 *  1. The key is NARROW. It publishes org capabilities and does nothing
 *     else: an admin route refuses it, and the lane refuses a real owner
 *     session in return. If that ever stops being true, a leaked CI secret
 *     becomes an owner account.
 *  2. The lane's manifest is the registry AS IT IS. The client manifest
 *     filters by capability_grants — correct for a device, wrong for a
 *     publisher: a capability granted away from the publisher would read
 *     as absent, so every run would re-upload it and --check would report
 *     drift that isn't there. The grant case below is that regression
 *     test; it is why the lane has its own manifest at all.
 *
 * Needs PUBLISH_TOKEN in .dev.vars — the same value this script reads from
 * WFC_PUBLISH_TOKEN (default 'dev-publish-token'):
 *   echo 'PUBLISH_TOKEN="dev-publish-token"' >> apps/api/.dev.vars
 */
import { execSync } from 'node:child_process'
import { createHash, pbkdf2Sync } from 'node:crypto'
import { buildZip } from './lib/zip.mjs'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const TOKEN = process.env.WFC_PUBLISH_TOKEN ?? 'dev-publish-token'
const stamp = Date.now().toString(36)
const slug = `smoke-pub-${stamp}`

// An owner to test the other side of the wall with (and to write a grant).
const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync('publish-pw-1', Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const email = `publish-${stamp}@wolffi.sh`
execSync(
  `npx wrangler d1 execute wfc-master --local --command "INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password) VALUES ('usr_pub_${stamp}', '${email}', 'Publisher', 'owner', 'active', '${hash}', '${salt}', 0);"`,
  { stdio: 'pipe' }
)

const api = async (path, { token, body, method, raw, headers } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined && raw === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch {}
  return { status: res.status, json, buf, headers: res.headers }
}

let failures = 0
const check = (n, c, extra = '') => {
  console.log(`${c ? '✅' : '❌'} ${n}${c || !extra ? '' : ` — ${extra}`}`)
  if (!c) failures++
}

const pack = (files) => buildZip(files.map(([name, text]) => ({ name, data: Buffer.from(text) })))
const shaOf = (buf) => createHash('sha256').update(buf).digest('hex')
const put = (s, zip, { sha, name = 'Smoke', description = 'd', token = TOKEN } = {}) =>
  api(`/publish/capabilities/${s}?${new URLSearchParams({ sha256: sha ?? shaOf(zip), name, description })}`,
    { token, method: 'PUT', raw: zip })

const login = await api('/auth/login', {
  body: { email, password: 'publish-pw-1', device: { platform: 'sim' } }
})
const session = login.json?.access_token
check('owner session for the cross-checks', Boolean(session), `HTTP ${login.status}`)

const v1 = pack([['SKILL.md', `---\nname: smoke\ndescription: one\n---\nbody v1\n`]])

// ── 1. The wall ──────────────────────────────────────────────────────────
check('no credential is refused', (await api('/publish/capabilities')).status === 401)
check('a wrong token is refused', (await api('/publish/capabilities', { token: 'nope' })).status === 401)
check(
  'an OWNER SESSION cannot publish (the lane is token-only)',
  (await put(slug, v1, { token: session })).status === 401
)
const bleed = await api('/admin/users', { token: TOKEN })
check('the publish token cannot reach /admin', bleed.status === 401, `HTTP ${bleed.status}`)

// ── 2. Publish, version, round-trip ─────────────────────────────────────
const first = await put(slug, v1)
check('publish accepted', first.status === 200 && first.json?.version === 1, JSON.stringify(first.json))

const listed = await api('/publish/capabilities', { token: TOKEN })
const entry = (listed.json?.org ?? []).find((e) => e.slug === slug)
check('manifest lists it with the package hash', entry?.sha256 === shaOf(v1), JSON.stringify(entry))

const back = await api(`/publish/capabilities/${slug}/package`, { token: TOKEN })
check('package downloads byte-identical', shaOf(back.buf) === shaOf(v1), `${back.buf.length} B`)
check('download carries the version header', back.headers.get('x-capability-version') === '1')

const v2 = pack([['SKILL.md', `---\nname: smoke\ndescription: two\n---\nbody v2\n`], ['extra.md', 'more']])
const second = await put(slug, v2, { description: 'two' })
check('a changed package bumps the version', second.json?.version === 2, JSON.stringify(second.json))

// ── 3. The upload gate still applies ────────────────────────────────────
check('a hash that does not match the bytes is refused',
  (await put(slug, v2, { sha: shaOf(v1) })).status === 400)
check('a package with no root SKILL.md is refused',
  (await put(slug, pack([['plugin/index.js', 'x']]))).status === 400)
check('an invalid slug is refused', (await put('Not A Slug', v1)).status === 400)
check('an empty body is refused', (await put(slug, Buffer.alloc(0))).status === 400)

// ── 4. Grants hide a capability from DEVICES, never from the publisher ──
// (the drift bug this lane exists to avoid)
await api(`/admin/capabilities/${slug}/grants`, {
  token: session,
  method: 'PUT',
  body: { grants: [{ kind: 'team', subject: 'nobody-here' }] }
})
const clientView = await api('/v1/capabilities/manifest', { token: session })
check(
  'a grant hides it from the client manifest',
  !(clientView.json?.org ?? []).some((e) => e.slug === slug)
)
const publisherView = await api('/publish/capabilities', { token: TOKEN })
check(
  'the publish manifest still lists it (no false drift)',
  (publisherView.json?.org ?? []).some((e) => e.slug === slug)
)

// ── 5. Audit attributes the push to the pipeline, not to a person ───────
const audit = await api('/admin/audit?limit=200', { token: session })
const row = (audit.json?.entries ?? []).find((e) => e.action === 'capability.put' && e.target === slug)
check('the push is audited as ci:publish', row?.actor_user_id === 'ci:publish', JSON.stringify(row))

// ── 6. Removal propagates (what --prune does on a deleted folder) ───────
check('delete accepted', (await api(`/publish/capabilities/${slug}`, { token: TOKEN, method: 'DELETE' })).status === 200)
const afterDelete = await api('/publish/capabilities', { token: TOKEN })
check('manifest drops it', !(afterDelete.json?.org ?? []).some((e) => e.slug === slug))
check('deleting twice is a 404',
  (await api(`/publish/capabilities/${slug}`, { token: TOKEN, method: 'DELETE' })).status === 404)

console.log(failures === 0 ? '\nPUBLISH: ALL PASS' : `\nPUBLISH: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
