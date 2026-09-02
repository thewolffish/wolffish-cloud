/**
 * Live check of capability sync against the real org API — the exact
 * engine the app runs (cloud/capabilitySync.ts), pointed at a throwaway
 * workspace, walked through the full journey: fresh-install pull of the
 * org set, steady-state no-op, user-scope push, cross-checking the
 * registry over the wire, delete propagation, and a second "device"
 * restoring from scratch.
 *
 *   WFC_DEMO_PASSWORD=... npx tsx --tsconfig tsconfig.node.json scripts/live-capability-sync-check.ts
 *   (API_BASE overrides https://api.wolffi.sh)
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  initCapabilitySync,
  queueUserCapabilityDelete,
  syncCapabilitiesNow
} from '../src/main/cloud/capabilitySync'

const BASE = process.env.API_BASE ?? 'https://api.wolffi.sh'
const PASSWORD = process.env.WFC_DEMO_PASSWORD ?? 'wolffish'
const EMAIL = process.env.WFC_DEMO_EMAIL ?? 'gate.keeper.50@demo.wolffi.sh'
const stamp = Date.now().toString(36)

let failures = 0
const check = (name: string, cond: unknown, extra = ''): void => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      device: { platform: 'sim', name: 'capability-sync-check' }
    })
  })
  const login = (await loginRes.json()) as { access_token?: string }
  if (!login.access_token) {
    console.error(`login failed (${loginRes.status})`)
    process.exit(1)
  }
  const token = login.access_token

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-capsync-live-'))
  const deviceDir = (n: number): string => path.join(work, `device${n}`, 'brain', 'cerebellum')

  const wire = (dir: string): void =>
    initCapabilitySync({
      apiBase: BASE,
      withAccessToken: (fn) => fn(token),
      cerebellumDir: () => dir,
      runsActive: () => false,
      onApplied: async () => {}
    })

  // ── Device 1: fresh install ────────────────────────────────────────────
  wire(deviceDir(1))
  const pull = await syncCapabilitiesNow()
  check('fresh install pulls the org set', pull.ok && pull.pulled >= 39, JSON.stringify(pull))
  check(
    'official capabilities materialize dot-prefixed',
    (await exists(path.join(deviceDir(1), '.shell', 'SKILL.md'))) &&
      (await exists(path.join(deviceDir(1), '.shell', 'plugin', 'index.mjs'))) &&
      (await exists(path.join(deviceDir(1), '.git', 'SKILL.md')))
  )
  const again = await syncCapabilitiesNow()
  check('second pass is a no-op', again.ok && again.pulled === 0 && again.pushed === 0 && again.removed === 0, JSON.stringify(again))

  // ── User scope: import → push → visible in the registry ────────────────
  const slug = `livecheck-${stamp}`
  await fs.mkdir(path.join(deviceDir(1), slug), { recursive: true })
  await fs.writeFile(
    path.join(deviceDir(1), slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: live sync check\n---\nA throwaway capability.\n`
  )
  const push = await syncCapabilitiesNow()
  check('local import pushed', push.ok && push.pushed === 1, JSON.stringify(push))
  const man = (await (
    await fetch(`${BASE}/v1/capabilities/manifest`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { user: Array<{ slug: string; version: number }> }
  check(
    'registry lists it user-scoped at v1',
    man.user.some((e) => e.slug === slug && e.version === 1),
    JSON.stringify(man.user)
  )

  // ── Device 2: a fresh machine restores everything ──────────────────────
  wire(deviceDir(2))
  const restore = await syncCapabilitiesNow()
  check('second device restores org + user caps', restore.ok && restore.pulled >= 40, JSON.stringify(restore))
  check(
    'user capability lands as a plain folder',
    (await fs.readFile(path.join(deviceDir(2), slug, 'SKILL.md'), 'utf8')).includes('live sync check')
  )

  // ── Delete propagates ──────────────────────────────────────────────────
  await fs.rm(path.join(deviceDir(2), slug), { recursive: true, force: true })
  await queueUserCapabilityDelete(slug)
  await syncCapabilitiesNow()
  const man2 = (await (
    await fetch(`${BASE}/v1/capabilities/manifest`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { user: Array<{ slug: string }> }
  check('delete propagated to the registry', !man2.user.some((e) => e.slug === slug))

  wire(deviceDir(1))
  const sweep = await syncCapabilitiesNow()
  check(
    'device 1 removes it on next pass',
    sweep.ok && sweep.removed === 1 && !(await exists(path.join(deviceDir(1), slug))),
    JSON.stringify(sweep)
  )

  await fs.rm(work, { recursive: true, force: true })
  console.log(failures === 0 ? '\nLIVE CAPABILITY SYNC: ALL CHECKS PASS' : `\nLIVE CAPABILITY SYNC: ${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
