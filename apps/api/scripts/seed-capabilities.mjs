#!/usr/bin/env node
/**
 * Publish the org-wide capability registry from the source tree — and
 * police the policy that <repo>/capabilities/ is where every org
 * capability change happens FIRST. Edit the folder, run this; the
 * registry mirrors git, never the other way around.
 *
 *   WFC_DEMO_PASSWORD=... node scripts/seed-capabilities.mjs
 *     --base   https://api.wolffi.sh     (default; API_BASE also works)
 *     --email  gate.keeper.50@demo.wolffi.sh  (an owner/admin account)
 *     --dir    <capability sources>      (default: <repo>/capabilities,
 *                                         falling back to the old bundled path)
 *     --only   slug1,slug2               (subset; default: every folder)
 *     --check  verify only: report drift between the folder and the live
 *              registry (changed / missing / pushed-outside-git), upload
 *              nothing, exit 1 on any drift — the CI guard for the policy
 *     --prune  also DELETE registry capabilities that have no source
 *              folder here, so a git removal propagates org-wide
 *              (ignored with --only; without it, extras only warn)
 *
 * Pure API — packages go through PUT /admin/capabilities/:slug exactly as
 * an admin client would send them, so every seed run also exercises the
 * real upload gate (sha256, structure, audit). Unchanged capabilities are
 * skipped by comparing the deterministic package hash against the live
 * manifest, so re-runs are cheap no-ops.
 *
 * The zip writer is deliberately deterministic (sorted entries, STORE
 * method, fixed timestamps): the same tree always produces the same bytes,
 * so sha256 equality means "nothing changed".
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildZip } from './lib/zip.mjs'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = argOf('--base', process.env.API_BASE ?? 'https://api.wolffi.sh')
const EMAIL = argOf('--email', 'gate.keeper.50@demo.wolffi.sh')
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish'
const ONLY = argOf('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const CHECK = args.includes('--check')
const PRUNE = args.includes('--prune') && ONLY.length === 0

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DIR =
  argOf('--dir', '') ||
  (await firstExisting([
    path.join(repoRoot, 'capabilities'),
    path.join(repoRoot, 'apps', 'desktop', 'src', 'defaults', 'workspace', 'brain', 'cerebellum')
  ]))

async function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if ((await fs.stat(p)).isDirectory()) return p
    } catch {}
  }
  throw new Error(`no capability source dir found (tried: ${candidates.join(', ')})`)
}

// ── Packaging one capability folder ──────────────────────────────────────

const JUNK = new Set(['node_modules', '.git', '.ds_store', '__macosx', '.wfc-installed', '.wfc-tested'])

async function collectFiles(root, rel = '', out = []) {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  for (const entry of entries) {
    if (JUNK.has(entry.name.toLowerCase())) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) await collectFiles(root, childRel, out)
    else if (entry.isFile()) out.push(childRel)
  }
  return out
}

async function packCapability(dir) {
  const rels = (await collectFiles(dir)).sort()
  const files = []
  for (const rel of rels) {
    files.push({ name: rel, data: await fs.readFile(path.join(dir, rel)) })
  }
  return buildZip(files)
}

function frontmatterField(skillMd, field) {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const line = m[1].split('\n').find((l) => l.startsWith(`${field}:`))
  return line ? line.slice(field.length + 1).trim() : null
}

// ── Drive the real API ───────────────────────────────────────────────────

const api = async (route, { token, body, method, raw, headers } = {}) => {
  const res = await fetch(`${BASE}${route}`, {
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
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {}
  return { status: res.status, json, buf }
}

console.log(
  `${CHECK ? 'Checking' : 'Seeding'} capabilities from ${DIR}\n            → ${BASE} as ${EMAIL}\n`
)

const login = await api('/auth/login', {
  body: { email: EMAIL, password: PASSWORD, device: { platform: 'sim', name: 'seed-capabilities' } }
})
if (login.status !== 200 || !login.json?.access_token) {
  console.error(`login failed (${login.status}): ${JSON.stringify(login.json)}`)
  process.exit(1)
}
const token = login.json.access_token

const live = await api('/v1/capabilities/manifest', { token })
const liveBySha = new Map((live.json?.org ?? []).map((e) => [e.slug, e.sha256]))

const entries = (await fs.readdir(DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => ONLY.length === 0 || ONLY.includes(name))
  .sort()

// Registry entries with no source folder here: someone pushed outside git,
// or a folder was removed without propagating. --check fails on them,
// --prune deletes them, a plain seed only warns (deleting is deliberate).
// A folder's mere presence protects its slug, even mid-edit without a
// SKILL.md yet.
const extras = ONLY.length > 0 ? [] : [...liveBySha.keys()].filter((s) => !entries.includes(s))

let uploaded = 0
let skipped = 0
let pruned = 0
let failed = 0
const drift = []
for (const slug of entries) {
  const dir = path.join(DIR, slug)
  let skillMd
  try {
    skillMd = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    console.log(`⚠️  ${slug}: no SKILL.md — skipped`)
    continue
  }
  const zip = await packCapability(dir)
  const sha = createHash('sha256').update(zip).digest('hex')
  if (liveBySha.get(slug) === sha) {
    skipped++
    if (!CHECK) console.log(`·  ${slug} unchanged (v stays, ${zip.length} B)`)
    continue
  }
  if (CHECK) {
    drift.push(`${slug} (${liveBySha.has(slug) ? 'changed here, not published' : 'not in the registry'})`)
    continue
  }
  const name = frontmatterField(skillMd, 'name') ?? slug
  const description = frontmatterField(skillMd, 'description') ?? ''
  const q = new URLSearchParams({ sha256: sha, name, description })
  const res = await api(`/admin/capabilities/${slug}?${q}`, { token, method: 'PUT', raw: zip })
  if (res.status === 200 && res.json?.ok) {
    uploaded++
    console.log(`✅ ${slug} → v${res.json.version} (${zip.length} B)`)
  } else {
    failed++
    console.error(`❌ ${slug} → ${res.status} ${JSON.stringify(res.json)}`)
  }
}

if (CHECK) {
  for (const slug of extras) drift.push(`${slug} (in the registry, no source folder — pushed outside git?)`)
  console.log(
    drift.length === 0
      ? `IN SYNC: all ${skipped} capabilities match the live registry`
      : `DRIFT (${drift.length}):\n${drift.map((d) => `  ❌ ${d}`).join('\n')}`
  )
  process.exit(drift.length === 0 ? 0 : 1)
}

for (const slug of extras) {
  if (!PRUNE) {
    console.log(`⚠️  ${slug} is in the registry but has no source folder here (use --prune to remove it)`)
    continue
  }
  const res = await api(`/admin/capabilities/${slug}`, { token, method: 'DELETE' })
  if (res.status === 200) {
    pruned++
    console.log(`🗑  ${slug} pruned from the registry`)
  } else {
    failed++
    console.error(`❌ prune ${slug} → ${res.status} ${JSON.stringify(res.json)}`)
  }
}

// Round-trip proof: manifest lists everything we sent, and one package
// downloads back byte-identical.
const after = await api('/v1/capabilities/manifest', { token })
const afterSlugs = new Set((after.json?.org ?? []).map((e) => e.slug))
const missing = entries.filter((s) => !afterSlugs.has(s))
if (entries.length > 0 && missing.length === 0) {
  const probe = entries[0]
  const pkg = await api(`/v1/capabilities/org/${probe}/package`, { token })
  const back = createHash('sha256').update(pkg.buf).digest('hex')
  const want = (after.json.org.find((e) => e.slug === probe) ?? {}).sha256
  console.log(
    pkg.status === 200 && back === want
      ? `\n🔁 round-trip verified: ${probe} downloads byte-identical (${pkg.buf.length} B)`
      : `\n❌ round-trip FAILED for ${probe}: status ${pkg.status}, sha ${back} vs ${want}`
  )
  if (pkg.status !== 200 || back !== want) failed++
}

console.log(
  `\n${uploaded} uploaded, ${skipped} unchanged, ${pruned} pruned, ${failed} failed — manifest now lists ${afterSlugs.size} org capabilities` +
    (missing.length ? `\n❌ missing from manifest: ${missing.join(', ')}` : '')
)
process.exit(failed === 0 && missing.length === 0 ? 0 : 1)
