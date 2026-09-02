/**
 * Capability sync engine, end to end against a real (local) registry:
 * fresh-install pull, no-op steady state, org update/removal, legacy
 * leftover cleanup, node_modules survival across swaps, user-scope
 * push/edit/pull/delete both ways, the runs-active deferral gate, and
 * download integrity (a lying server changes nothing on disk).
 *
 * The server speaks the same wire contract as api.wolffi.sh
 * (manifest/package/PUT/DELETE, sha256-addressed zips); the engine runs
 * unmodified with injected deps — no Electron, no mocks of its internals.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/capability-sync.test.ts
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { packCapability, sha256Hex } from '../capabilityPack'
import {
  initCapabilitySync,
  queueUserCapabilityDelete,
  syncCapabilitiesNow
} from '../capabilitySync'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ── The registry double ──────────────────────────────────────────────────

type Stored = { version: number; sha256: string; zip: Buffer; name: string }
const registry = { org: new Map<string, Stored>(), user: new Map<string, Stored>() }
/** When set, packages download as these bytes instead (integrity tests). */
let corruptPackages = false

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const send = (status: number, body: Buffer | string, type = 'application/json'): void => {
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }
  const entryJson = (slug: string, s: Stored): Record<string, unknown> => ({
    slug,
    name: s.name,
    description: '',
    version: s.version,
    sha256: s.sha256,
    size: s.zip.length,
    updated_at: new Date().toISOString()
  })

  if (req.method === 'GET' && url.pathname === '/v1/capabilities/manifest') {
    return send(
      200,
      JSON.stringify({
        org: [...registry.org.entries()].map(([slug, s]) => entryJson(slug, s)),
        user: [...registry.user.entries()].map(([slug, s]) => entryJson(slug, s))
      })
    )
  }
  const pkg = url.pathname.match(/^\/v1\/capabilities\/(org|user)\/([^/]+)\/package$/)
  if (req.method === 'GET' && pkg) {
    const stored = registry[pkg[1] as 'org' | 'user'].get(pkg[2]!)
    if (!stored) return send(404, JSON.stringify({ error: 'not_found' }))
    if (corruptPackages) return send(200, Buffer.from('corrupted-bytes'), 'application/zip')
    return send(200, stored.zip, 'application/zip')
  }
  const userCap = url.pathname.match(/^\/v1\/capabilities\/user\/([^/]+)$/)
  if (req.method === 'PUT' && userCap) {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const zip = Buffer.concat(chunks)
      const sha = createHash('sha256').update(zip).digest('hex')
      if (sha !== url.searchParams.get('sha256')) {
        return send(400, JSON.stringify({ error: 'hash_mismatch' }))
      }
      const slug = userCap[1]!
      const prev = registry.user.get(slug)
      const stored: Stored = {
        version: (prev?.version ?? 0) + 1,
        sha256: sha,
        zip,
        name: url.searchParams.get('name') ?? slug
      }
      registry.user.set(slug, stored)
      send(200, JSON.stringify({ ok: true, slug, version: stored.version, sha256: sha }))
    })
    return
  }
  if (req.method === 'DELETE' && userCap) {
    const had = registry.user.delete(userCap[1]!)
    return send(had ? 200 : 404, JSON.stringify(had ? { ok: true } : { error: 'not_found' }))
  }
  send(404, JSON.stringify({ error: 'not_found' }))
})

// ── Fixtures ─────────────────────────────────────────────────────────────

async function makeSourceCap(
  root: string,
  slug: string,
  body: string,
  extra?: Record<string, string>
): Promise<Buffer> {
  const dir = path.join(root, slug)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: test cap\n---\n${body}\n`
  )
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const p = path.join(dir, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content)
  }
  const zip = await packCapability(dir)
  if (!zip) throw new Error('pack produced nothing')
  return zip
}

function setOrg(slug: string, zip: Buffer): void {
  const prev = registry.org.get(slug)
  registry.org.set(slug, {
    version: (prev?.version ?? 0) + 1,
    sha256: sha256Hex(zip),
    zip,
    name: slug
  })
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-capsync-test-'))
  const sources = path.join(work, 'sources')
  const cerebellum = path.join(work, 'workspace', 'brain', 'cerebellum')
  await fs.mkdir(sources, { recursive: true })

  let runsActive = false
  let applied = 0
  initCapabilitySync({
    apiBase: `http://127.0.0.1:${port}`,
    withAccessToken: (fn) => fn('test-token'),
    cerebellumDir: () => cerebellum,
    runsActive: () => runsActive,
    onApplied: async () => {
      applied++
    }
  })

  console.log('\nfresh install pulls the whole org set')
  setOrg(
    'alpha',
    await makeSourceCap(sources, 'alpha', 'alpha v1', {
      'plugin/index.mjs': 'export default 1',
      'plugin/package.json': '{"dependencies":{}}'
    })
  )
  setOrg('beta', await makeSourceCap(sources, 'beta', 'beta v1'))
  let out = await syncCapabilitiesNow()
  ok('pass reports two pulls', out.ok && out.pulled === 2 && out.removed === 0, JSON.stringify(out))
  ok(
    'org caps land dot-prefixed',
    (await exists(path.join(cerebellum, '.alpha', 'SKILL.md'))) &&
      (await exists(path.join(cerebellum, '.beta', 'SKILL.md')))
  )
  ok('plugin files extracted', await exists(path.join(cerebellum, '.alpha', 'plugin', 'index.mjs')))
  ok('reload hook fired once', applied === 1, String(applied))

  console.log('\nsteady state is a no-op')
  out = await syncCapabilitiesNow()
  ok(
    'nothing pulled or removed',
    out.ok && out.pulled === 0 && out.removed === 0 && out.pushed === 0,
    JSON.stringify(out)
  )
  ok('reload hook not fired again', applied === 1)

  console.log('\nadmin update propagates')
  setOrg(
    'alpha',
    await makeSourceCap(sources, 'alpha', 'alpha v2 — updated', {
      'plugin/index.mjs': 'export default 2',
      'plugin/package.json': '{"dependencies":{}}'
    })
  )
  await fs.mkdir(path.join(cerebellum, '.alpha', 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(cerebellum, '.alpha', 'node_modules', 'marker.txt'), 'installed')
  out = await syncCapabilitiesNow()
  ok('update pulled', out.ok && out.pulled === 1, JSON.stringify(out))
  ok(
    'content updated',
    (await fs.readFile(path.join(cerebellum, '.alpha', 'SKILL.md'), 'utf8')).includes('alpha v2')
  )
  ok(
    'node_modules survived the swap',
    await exists(path.join(cerebellum, '.alpha', 'node_modules', 'marker.txt'))
  )

  console.log('\nadmin removal propagates, legacy leftovers retire')
  registry.org.delete('beta')
  await fs.mkdir(path.join(cerebellum, '.legacy-bundled'), { recursive: true })
  await fs.writeFile(
    path.join(cerebellum, '.legacy-bundled', 'SKILL.md'),
    '---\nname: legacy\n---\nold era\n'
  )
  out = await syncCapabilitiesNow()
  ok('removals reported', out.ok && out.removed === 2, JSON.stringify(out))
  ok('removed org cap gone', !(await exists(path.join(cerebellum, '.beta'))))
  ok('legacy bundled leftover gone', !(await exists(path.join(cerebellum, '.legacy-bundled'))))

  console.log('\nuser capability pushes on sight')
  await fs.mkdir(path.join(cerebellum, 'mynotes'), { recursive: true })
  await fs.writeFile(
    path.join(cerebellum, 'mynotes', 'SKILL.md'),
    '---\nname: mynotes\ndescription: my own\n---\nnotes v1\n'
  )
  out = await syncCapabilitiesNow()
  ok('push reported', out.ok && out.pushed === 1, JSON.stringify(out))
  ok('registry holds v1', registry.user.get('mynotes')?.version === 1)

  console.log('\nlocal edit pushes a new version')
  await fs.writeFile(
    path.join(cerebellum, 'mynotes', 'SKILL.md'),
    '---\nname: mynotes\ndescription: my own\n---\nnotes v2 — edited\n'
  )
  out = await syncCapabilitiesNow()
  ok(
    'edit pushed',
    out.ok && out.pushed === 1 && registry.user.get('mynotes')?.version === 2,
    JSON.stringify(out)
  )

  console.log('\nremote user update pulls (another device pushed)')
  const otherDevice = await makeSourceCap(sources, 'mynotes', 'notes v3 — from the laptop')
  const prevUser = registry.user.get('mynotes')!
  registry.user.set('mynotes', {
    version: prevUser.version + 1,
    sha256: sha256Hex(otherDevice),
    zip: otherDevice,
    name: 'mynotes'
  })
  out = await syncCapabilitiesNow()
  ok('remote edit pulled', out.ok && out.pulled === 1, JSON.stringify(out))
  ok(
    'local content updated',
    (await fs.readFile(path.join(cerebellum, 'mynotes', 'SKILL.md'), 'utf8')).includes(
      'from the laptop'
    )
  )

  console.log('\nremote user delete removes locally')
  registry.user.delete('mynotes')
  out = await syncCapabilitiesNow()
  ok(
    'remote delete removed local folder',
    out.ok && out.removed === 1 && !(await exists(path.join(cerebellum, 'mynotes'))),
    JSON.stringify(out)
  )

  console.log('\nlocal delete propagates and never resurrects')
  await fs.mkdir(path.join(cerebellum, 'todelete'), { recursive: true })
  await fs.writeFile(
    path.join(cerebellum, 'todelete', 'SKILL.md'),
    '---\nname: todelete\n---\nbye\n'
  )
  await syncCapabilitiesNow()
  ok('uploaded before delete', registry.user.has('todelete'))
  await fs.rm(path.join(cerebellum, 'todelete'), { recursive: true, force: true })
  await queueUserCapabilityDelete('todelete')
  out = await syncCapabilitiesNow()
  ok('registry entry deleted', !registry.user.has('todelete'))
  ok('folder not re-downloaded', !(await exists(path.join(cerebellum, 'todelete'))))

  console.log('\nswaps wait for quiet (runs-active gate)')
  setOrg('gamma', await makeSourceCap(sources, 'gamma', 'gamma v1'))
  runsActive = true
  out = await syncCapabilitiesNow()
  ok('pass deferred', out.ok && out.deferred === true, JSON.stringify(out))
  ok('nothing swapped while busy', !(await exists(path.join(cerebellum, '.gamma'))))
  runsActive = false
  out = await syncCapabilitiesNow()
  ok(
    'applied once quiet',
    out.ok && out.pulled === 1 && (await exists(path.join(cerebellum, '.gamma', 'SKILL.md'))),
    JSON.stringify(out)
  )

  console.log('\na lying server changes nothing on disk')
  setOrg('alpha', await makeSourceCap(sources, 'alpha', 'alpha v3 — never lands'))
  corruptPackages = true
  out = await syncCapabilitiesNow()
  ok('corrupt download not installed', out.ok && out.pulled === 0, JSON.stringify(out))
  ok(
    'old content intact',
    (await fs.readFile(path.join(cerebellum, '.alpha', 'SKILL.md'), 'utf8')).includes('alpha v2')
  )
  corruptPackages = false
  out = await syncCapabilitiesNow()
  ok(
    'recovers next pass',
    out.pulled === 1 &&
      (await fs.readFile(path.join(cerebellum, '.alpha', 'SKILL.md'), 'utf8')).includes('alpha v3')
  )

  console.log('\nstate survives and stays consistent')
  const state = JSON.parse(await fs.readFile(path.join(cerebellum, '.wfc-caps.json'), 'utf8'))
  ok(
    'state tracks org slugs',
    Boolean(state.org.alpha && state.org.gamma && !state.org.beta),
    JSON.stringify(state.org)
  )
  ok(
    'state carries no deleted user caps',
    !state.user.todelete && !state.user.mynotes,
    JSON.stringify(state.user)
  )
  ok('no pending deletes left', state.pendingDeletes.length === 0)

  server.close()
  await fs.rm(work, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
