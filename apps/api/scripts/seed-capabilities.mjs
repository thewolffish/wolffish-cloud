#!/usr/bin/env node
/**
 * Publish the org-wide capability registry from the source tree — and
 * police the policy that <repo>/capabilities/ is where every org
 * capability change happens FIRST. The registry mirrors git, never the
 * other way around.
 *
 * CI is the normal caller: a green push to main runs this with --prune and
 * then again with --check (.github/workflows/ci.yml), so an ordinary
 * capability change needs nothing run by hand. What follows is for a local
 * `wrangler dev`, or for when the pipeline itself is what's broken.
 *
 *   WFC_PUBLISH_TOKEN=... node scripts/seed-capabilities.mjs
 *     --base   https://api.wolffi.sh     (default; API_BASE also works)
 *     --email  nasser.alowais@wolffi.sh  (only for the password fallback)
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
 * Two ways to authenticate, one code path behind them:
 *
 *   WFC_PUBLISH_TOKEN  the publish lane (/publish/*, routes/publish.ts) —
 *                      a key that can write org capabilities and nothing
 *                      else. This is what CI uses, and what a human should
 *                      prefer: nothing here needs an owner session.
 *   WFC_DEMO_PASSWORD  the fallback — log in as --email and drive
 *                      /admin/capabilities as a person. Kept because a
 *                      deployment with no PUBLISH_TOKEN set still needs a
 *                      way to publish (and it is how the lane was
 *                      bootstrapped).
 *
 * Pure API either way — packages go through the same PUT the desktop's own
 * admin client would send, so every seed run also exercises the real upload
 * gate (sha256, structure, audit). Unchanged capabilities are skipped by
 * comparing the deterministic package hash against the live manifest, so
 * re-runs are cheap no-ops.
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
const EMAIL = argOf('--email', 'nasser.alowais@wolffi.sh')
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish123'
const PUBLISH_TOKEN = process.env.WFC_PUBLISH_TOKEN ?? ''
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

// Mirror of the desktop's capabilityPack JUNK list — the two must agree or
// the same folder hashes differently on each side and re-uploads forever.
const JUNK = new Set([
  'node_modules',
  '.git',
  '.ds_store',
  '__macosx',
  '.wfc-installed',
  '.wfc-tested',
  'package-lock.json',
  'npm-shrinkwrap.json'
])

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

/**
 * The two doors, behind one route table so everything below is identical.
 *
 * The publish lane's manifest is the registry unfiltered; the client
 * manifest the password path has to use applies capability_grants, so a
 * capability granted away from the publishing account would read as
 * missing and be re-uploaded on every run. One more reason the token is
 * the better door.
 */
const LANES = {
  token: {
    who: 'the publish lane',
    manifest: '/publish/capabilities',
    put: (slug, q) => `/publish/capabilities/${slug}?${q}`,
    del: (slug) => `/publish/capabilities/${slug}`,
    pkg: (slug) => `/publish/capabilities/${slug}/package`
  },
  password: {
    who: EMAIL,
    manifest: '/v1/capabilities/manifest',
    put: (slug, q) => `/admin/capabilities/${slug}?${q}`,
    del: (slug) => `/admin/capabilities/${slug}`,
    pkg: (slug) => `/v1/capabilities/org/${slug}/package`
  }
}
const lane = PUBLISH_TOKEN ? LANES.token : LANES.password

console.log(
  `${CHECK ? 'Checking' : 'Seeding'} capabilities from ${DIR}\n            → ${BASE} via ${lane.who}\n`
)

let token = PUBLISH_TOKEN
if (!PUBLISH_TOKEN) {
  const login = await api('/auth/login', {
    body: {
      email: EMAIL,
      password: PASSWORD,
      device: { platform: 'sim', name: 'seed-capabilities' }
    }
  })
  if (login.status !== 200 || !login.json?.access_token) {
    console.error(`login failed (${login.status}): ${JSON.stringify(login.json)}`)
    process.exit(1)
  }
  token = login.json.access_token
}

const live = await api(lane.manifest, { token })
if (live.status !== 200) {
  console.error(
    `cannot read the registry (${live.status} from ${lane.manifest}): ${JSON.stringify(live.json)}` +
      (PUBLISH_TOKEN
        ? '\n            — a 404 here means this deployment has no PUBLISH_TOKEN set;' +
          '\n              a 401 means the one in WFC_PUBLISH_TOKEN is not the one it has.'
        : '')
  )
  process.exit(1)
}
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
  const res = await api(lane.put(slug, q), { token, method: 'PUT', raw: zip })
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
  const res = await api(lane.del(slug), { token, method: 'DELETE' })
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
const after = await api(lane.manifest, { token })
const afterSlugs = new Set((after.json?.org ?? []).map((e) => e.slug))
const missing = entries.filter((s) => !afterSlugs.has(s))
if (entries.length > 0 && missing.length === 0) {
  const probe = entries[0]
  const pkg = await api(lane.pkg(probe), { token })
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
