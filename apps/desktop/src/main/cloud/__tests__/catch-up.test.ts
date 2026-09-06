/**
 * Two live desktops, one account — the catch-up pull's acceptance gate.
 *
 * Every other sync test in this repo is SEQUENTIAL: one device writes, the
 * workspace is purged, one device restores. That proves "sign in elsewhere
 * and everything moves" and it proved nothing about the case a real
 * deployment hits first — a laptop and an office machine signed in at the
 * same time. Before pullConversations() existed the desktop was push-only
 * after restore, so those two machines diverged permanently and silently.
 *
 * This runs both of them, alternating, against a real Worker:
 *
 *   a-seed      device A writes c1, c2, c3 and drains
 *   b-restore   device B signs in fresh and restores all three
 *   a-diverge   A appends to c1, DELETES c2, creates c4 — while B is idle
 *   b-catchup   B appends locally to c3 (unpushed), then drains once:
 *               A's work must arrive, c2 must go, and B's own edit must
 *               survive the merge rather than being overwritten by the org
 *   a-final     A drains: B's c3 edit must have reached it, so the loop
 *               closes in BOTH directions and the two disks agree
 *
 * Requires `wrangler dev` running for apps/api (npm run dev) with local
 * migrations applied. Run from apps/desktop:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/catch-up.test.ts
 * Env: WFC_API_URL (default :8787).
 */

import { execSync, spawn } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length) ?? null
const BASE = process.env.WFC_API_URL ?? 'http://localhost:8787'
const PW = 'catchup-pass-1'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(250)
  }
  return cond()
}

/**
 * Per-run ids. `conversations.id` is a GLOBAL primary key (client-generated,
 * not scoped per user), so a fixed id reused by a later run's throwaway user
 * hits the upsert's `user_id` guard, is silently ignored, and takes its
 * records down with it — the test would fail for a reason that has nothing
 * to do with what it is testing. The orchestrator mints the tag; phases
 * inherit it through the environment.
 */
const RUN = process.env.WFC_TEST_RUN ?? 'dev'
const C1 = `cu-${RUN}-one`
const C2 = `cu-${RUN}-two`
const C3 = `cu-${RUN}-three`
const C4 = `cu-${RUN}-four`

type Msg = { id: string; role: 'user' | 'assistant'; content: string; timestamp: number }
const msg = (id: string, content: string, at: number): Msg => ({
  id,
  role: 'user',
  content,
  timestamp: at
})
const conv = (id: string, title: string, messages: Msg[], at: number): Record<string, unknown> => ({
  id,
  title,
  model: 'm',
  messages,
  createdAt: at,
  updatedAt: at
})

/** Append one message to whatever is on disk, keeping every other field. */
const appended = (
  disk: unknown,
  message: Msg,
  at: number
): Record<string, unknown> & { messages: Msg[] } => {
  const current = (disk ?? {}) as Record<string, unknown> & { messages?: Msg[] }
  return { ...current, messages: [...(current.messages ?? []), message], updatedAt: at }
}

// ── The child phases (real sync module, real fetch, shimmed electron) ─────

async function phaseMain(): Promise<void> {
  const Module = (await import('node:module')).default as unknown as {
    _load: (...a: unknown[]) => unknown
  }
  const token = process.env.WFC_TEST_TOKEN!
  const userId = process.env.WFC_TEST_USER!
  const stateListeners: Array<(state: unknown) => void> = []
  const fakeSession = {
    getState: () => ({ status: 'ready' }),
    onState: (l: (state: unknown) => void) => {
      stateListeners.push(l)
      return () => {}
    },
    withAccessToken: async <T>(fn: (t: string) => Promise<T>): Promise<T> => fn(token),
    getUserId: () => userId
  }
  const appPath = process.cwd()
  const origLoad = Module._load
  Module._load = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => appPath,
          getPath: () => os.tmpdir(),
          getVersion: () => '0.1.0-sim',
          getName: () => 'wfc-desktop'
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (s: string) => Buffer.from(s),
          decryptString: (b: Buffer) => b.toString()
        }
      }
    }
    if (args[0] === '@main/cloud/session') return { cloudSession: fakeSession }
    return origLoad.apply(this, args)
  }

  // Bytes uploaded per route, so "B pulled a transcript" can be told apart
  // from "B re-pushed the transcript it was just handed".
  const sent = new Map<string, number>()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.startsWith(BASE)) {
      const route = `${method} ${new URL(url).pathname.replace(/\/(conv-[^/]+|[0-9a-f]{64})(\/|$)/g, '/:id$2')}`
      const body = init?.body
      const bytes = typeof body === 'string' ? Buffer.byteLength(body) : 0
      sent.set(route, (sent.get(route) ?? 0) + bytes)
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch

  const ws = await import('@main/workspace/workspace')
  await ws.ensureWorkspace()
  const conversations = await import('@main/conversations')

  const workspace = path.join(os.homedir(), '.wfc', 'workspace')
  const fail = (m: string): never => {
    console.error(`  PHASE ${PHASE} FAIL: ${m}`)
    process.exit(1)
  }
  const finish = (): never => {
    for (const [route, bytes] of [...sent].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      if (bytes > 0) console.log(`      ↑ ${route}  ${bytes} B`)
    }
    console.log(`  phase ${PHASE}: ok`)
    process.exit(0)
  }
  // The app's OWN reader, not a guess at its filename — the file on disk is
  // conv-<id>.json, and a test that re-derives that convention tests itself.
  const load = async (id: string): Promise<Record<string, unknown> | null> =>
    (await conversations.loadConversation(id)) as Record<string, unknown> | null
  const contents = async (id: string): Promise<string[]> => {
    const c = await load(id)
    return ((c?.messages ?? []) as Msg[]).map((m) => m.content)
  }
  const serverIds = async (): Promise<string[]> => {
    const res = await realFetch(`${BASE}/v1/conversations?after=0`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const json = (await res.json()) as { conversations?: Array<{ id: string }> }
    return (json.conversations ?? []).map((c) => c.id)
  }

  const sync = await import('@main/cloud/sync')

  // ── A · seed three conversations ───────────────────────────────────────
  if (PHASE === 'a-seed') {
    const t = Date.now()
    for (const [id, title] of [
      [C1, 'One'],
      [C2, 'Two'],
      [C3, 'Three']
    ] as const) {
      await conversations.saveConversation(
        conv(id, title, [msg(`${id}-m1`, `${title} from A`, t)], t) as never
      )
    }
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const ok = await until(async () => {
      const ids = await serverIds()
      return [C1, C2, C3].every((id) => ids.includes(id))
    }, 60_000)
    if (!ok)
      fail(`A's three conversations never reached the org (${(await serverIds()).join(', ')})`)
    console.log('  ✅ A pushed c1, c2, c3')
    finish()
  }

  // ── B · fresh device, restore ──────────────────────────────────────────
  if (PHASE === 'b-restore') {
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const ok = await until(async () => {
      const state = JSON.parse(
        await fs.readFile(path.join(workspace, '.sync-state.json'), 'utf8').catch(() => '{}')
      ) as { restore_done?: boolean }
      return state.restore_done === true
    }, 120_000)
    if (!ok) fail('restore never completed on device B')
    for (const id of [C1, C2, C3]) {
      if (!(await load(id))) fail(`B did not restore ${id}`)
    }
    console.log('  ✅ B restored c1, c2, c3')
    // The catch-up cursor must be recorded, or the next pass re-walks.
    const state = JSON.parse(
      await fs.readFile(path.join(workspace, '.sync-state.json'), 'utf8')
    ) as { conversations_cursor?: string | null }
    // The first drain's pull is what stores it; give it its debounce.
    await until(async () => {
      const s = JSON.parse(await fs.readFile(path.join(workspace, '.sync-state.json'), 'utf8')) as {
        conversations_cursor?: string | null
      }
      return typeof s.conversations_cursor === 'string' && s.conversations_cursor.length > 0
    }, 30_000)
    const after = JSON.parse(
      await fs.readFile(path.join(workspace, '.sync-state.json'), 'utf8')
    ) as { conversations_cursor?: string | null }
    if (!after.conversations_cursor) {
      fail(`B never recorded a catch-up cursor (was ${JSON.stringify(state.conversations_cursor)})`)
    }
    console.log('  ✅ B recorded a catch-up cursor')
    finish()
  }

  // ── A · diverge while B is idle ────────────────────────────────────────
  if (PHASE === 'a-diverge') {
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const t = Date.now()
    await conversations.updateConversation(
      C1,
      (disk) => appended(disk, msg(`${C1}-m2`, 'second from A', t), t) as never
    )
    await conversations.deleteConversation(C2)
    await conversations.saveConversation(
      conv(C4, 'Four', [msg(`${C4}-m1`, 'Four from A', t)], t) as never
    )
    const ok = await until(async () => {
      const ids = await serverIds()
      return ids.includes(C4) && !ids.includes(C2)
    }, 60_000)
    if (!ok) fail(`A's divergence never landed (${(await serverIds()).join(', ')})`)
    console.log('  ✅ A appended to c1, deleted c2, created c4')
    finish()
  }

  // ── B · one drain must converge — without losing B's own work ──────────
  if (PHASE === 'b-catchup') {
    // A local edit B has NOT pushed yet. The pull must merge around it.
    const t = Date.now()
    await conversations.updateConversation(
      C3,
      (disk) => appended(disk, msg(`${C3}-mB`, 'local edit on B', t), t) as never
    )
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))

    const converged = await until(async () => {
      const four = await load(C4)
      const two = await load(C2)
      const one = await contents(C1)
      return Boolean(four) && two === null && one.includes('second from A')
    }, 90_000)
    if (!converged) {
      fail(
        `B did not converge — c4=${Boolean(await load(C4))} c2Gone=${(await load(C2)) === null} ` +
          `c1=${JSON.stringify(await contents(C1))}`
      )
    }
    console.log('  ✅ c4 arrived from A')
    console.log('  ✅ c2 removed — the tombstone crossed')
    console.log("  ✅ c1 carries A's appended message")

    const three = await contents(C3)
    if (!three.includes('local edit on B')) {
      fail(`the pull clobbered B's own unpushed edit: ${JSON.stringify(three)}`)
    }
    if (!three.includes('Three from A'))
      fail(`B lost A's original c3 message: ${JSON.stringify(three)}`)
    console.log("  ✅ B's own unpushed edit survived the merge (union, not overwrite)")

    // B must not re-upload what it was just handed: the records it pulled
    // are acknowledged, so the only writes are its own c3 edit + envelopes.
    const batchBytes = sent.get('POST /v1/sync/batch') ?? 0
    if (batchBytes > 12_000) {
      fail(`B echoed the pulled transcripts back: ${batchBytes} B of /sync/batch`)
    }
    console.log(`  ✅ B did not echo what it pulled (${batchBytes} B pushed)`)

    // And a delete applied FROM the org must not be sent back as a delete.
    if (
      (sent.get('DELETE /v1/conversations/:id') ?? 0) > 0 ||
      sent.has('DELETE /v1/conversations/:id')
    ) {
      fail('B sent the tombstone back to the server it came from')
    }
    console.log('  ✅ B did not send the tombstone back')
    finish()
  }

  // ── A · the other direction ────────────────────────────────────────────
  if (PHASE === 'a-final') {
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const ok = await until(async () => (await contents(C3)).includes('local edit on B'), 90_000)
    if (!ok) fail(`A never caught up on B's c3 edit: ${JSON.stringify(await contents(C3))}`)
    console.log("  ✅ A caught up on B's edit — the loop closes both ways")
    const three = await contents(C3)
    if (!three.includes('Three from A')) fail(`A lost its own c3 message: ${JSON.stringify(three)}`)
    if (await load(C2)) fail('A still holds the conversation it deleted')
    console.log('  ✅ both disks agree')
    finish()
  }

  fail(`unknown phase ${PHASE}`)
}

// ── The orchestrator ─────────────────────────────────────────────────────

async function orchestrate(): Promise<void> {
  const stamp = Date.now().toString(36)
  const SANDBOX_A = mkdtempSync(path.join(os.tmpdir(), 'wolffish-catchup-A-'))
  const SANDBOX_B = mkdtempSync(path.join(os.tmpdir(), 'wolffish-catchup-B-'))

  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health?.ok) {
    console.error(`No worker at ${BASE}. Start it: (cd ../api && npm run dev)`)
    process.exit(1)
  }

  const userId = `usr_catchup_${stamp}`
  const email = `catchup-${stamp}@wolffi.sh`
  const salt = '00112233445566778899aabbccddeeff'
  const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
  const sqlFile = path.join(SANDBOX_A, 'seed.sql')
  writeFileSync(
    sqlFile,
    [
      `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models) VALUES (1, 'CatchUp', 'm', '["m"]');`,
      `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)`,
      `VALUES ('${userId}', '${email}', 'Catch Up', 'employee', 'active', '${hash}', '${salt}', 0);`
    ].join('\n')
  )
  execSync(`npx wrangler d1 execute wfc-master --local --file="${sqlFile}"`, {
    cwd: path.resolve(process.cwd(), '..', 'api'),
    stdio: 'pipe'
  })

  const tokenFor = async (deviceName: string): Promise<string> => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: PW,
        device: { platform: 'desktop', name: deviceName }
      })
    })
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error(`login failed for ${deviceName}`)
    return json.access_token
  }
  // Two devices means two device rows and two sessions — the real shape.
  const tokenA = await tokenFor('desk-A')
  const tokenB = await tokenFor('desk-B')

  const run = (phase: string, home: string, token: string): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1]!, `--phase=${phase}`],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            WFC_API_URL: BASE,
            WFC_TEST_TOKEN: token,
            WFC_TEST_USER: userId,
            WFC_TEST_RUN: stamp
          },
          stdio: 'inherit'
        }
      )
      const killer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000)
      child.on('error', () => {
        clearTimeout(killer)
        resolve(1)
      })
      child.on('exit', (c) => {
        clearTimeout(killer)
        resolve(c ?? 1)
      })
    })

  console.log(`== two live desktops, one account, against ${BASE} ==\n`)
  const steps: Array<[string, string, string]> = [
    ['a-seed', SANDBOX_A, tokenA],
    ['b-restore', SANDBOX_B, tokenB],
    ['a-diverge', SANDBOX_A, tokenA],
    ['b-catchup', SANDBOX_B, tokenB],
    ['a-final', SANDBOX_A, tokenA]
  ]
  let failed = 0
  for (const [phase, home, token] of steps) {
    console.log(`-- ${phase}  (${home === SANDBOX_A ? 'device A' : 'device B'})`)
    const code = await run(phase, home, token)
    if (code !== 0) {
      failed++
      console.error(`   phase ${phase} exited ${code}\n`)
      break
    }
    console.log('')
  }

  if (failed === 0) {
    console.log('CATCH-UP: ALL PHASES PASS — two live desktops converge in both directions')
  } else {
    console.log('CATCH-UP: FAILED')
  }
  console.log(`sandboxes: A=${SANDBOX_A}  B=${SANDBOX_B}`)
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  phaseMain().catch((err) => {
    console.error(`PHASE ${PHASE} crashed:`, err)
    process.exit(1)
  })
} else {
  orchestrate().catch((err) => {
    console.error('orchestrator crashed:', err)
    process.exit(1)
  })
}
