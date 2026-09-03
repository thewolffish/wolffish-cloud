/**
 * Purge-cycle LIVE simulation — the same purge/restore story as
 * purge-cycle.test.ts, but with ZERO fakes on the wire: the REAL sync
 * engine talks to the REAL Worker (wrangler dev, local D1 + R2) through
 * real auth tokens, and the workspace is seeded with 501 conversations —
 * one more than the old bootstrap cap — so "no conversation cap, ever" is
 * proven against the actual SQL, cursors and zod validation in
 * apps/api/src/routes/sync.ts.
 *
 *   phase seed     device A: config with secrets, 501 conversations (c1
 *                  has 6 messages + an attachment), the full fixture file
 *                  set. Pushes drain to the worker; then one conversation
 *                  and one file are deleted and the tombstones land.
 *   PURGE          rm -rf ~/.wfc.
 *   phase restore  fresh install, same account: restore walks every page
 *                  back out of D1/R2 until restore_done.
 *   assertions     the SHARED disk-assertion block (identical to the fake
 *                  test's) over all 500 surviving conversations, plus
 *                  API-side checks. Then phase foreign proves the
 *                  ownership guard against a second real user.
 *
 * Requires `wrangler dev` running for apps/api (npm run dev) with local
 * migrations applied (npm run db:migrate:local). Users are seeded
 * directly into local D1 via wrangler, exactly like scripts/smoke-sync.mjs.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/purge-cycle-live.test.ts
 */

import { execSync, spawn } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  USAGE_ROWS,
  assertRestoredWorkspace,
  convId,
  lazyMediaSeedFiles,
  seedConversation,
  sleep,
  until,
  verifyLazyHydration,
  writeSeedWorkspace
} from './purge-fixtures'

const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length) ?? null
const BASE = process.env.WFC_API_URL ?? 'http://localhost:8787'
/** One past the old bootstrap cap — the no-cap proof. */
const CONV_COUNT = 501

// ── Minimal authorized API client (orchestrator + phase polling) ─────────

async function api(
  route: string,
  opts: { token?: string; method?: string; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}${route}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // non-JSON body
  }
  return { status: res.status, json }
}

/** Every live conversation id, walked through the keyset pages. */
async function walkConversationIds(token: string): Promise<string[]> {
  const ids: string[] = []
  let after = 0
  for (let i = 0; i < 50; i++) {
    const res = await api(`/v1/conversations?after=${after}`, { token })
    const page = (res.json?.conversations as Array<{ id: string }>) ?? []
    ids.push(...page.map((c) => c.id))
    const next = res.json?.next
    if (typeof next !== 'number' || next <= after) break
    after = next
  }
  return ids
}

/** Every live manifest name, walked through the keyset pages. */
async function walkManifestNames(token: string): Promise<string[]> {
  const names: string[] = []
  let before: string | null = null
  for (let i = 0; i < 50; i++) {
    const q = before ? `?before=${encodeURIComponent(before)}` : ''
    const res = await api(`/v1/files/manifest${q}`, { token })
    const page = (res.json?.files as Array<{ name: string }>) ?? []
    names.push(...page.map((f) => f.name))
    const next = res.json?.next
    if (typeof next !== 'string' || next === before) break
    before = next
  }
  return names
}

// ── Child phases (real fetch, real tokens; only electron/session shimmed) ─

async function phaseMain(): Promise<void> {
  const Module = (await import('node:module')).default as unknown as {
    _load: (...a: unknown[]) => unknown
  }
  const token = process.env.WFC_TEST_TOKEN!
  const userId = process.env.WFC_TEST_USER!
  const stateListeners: Array<(state: unknown) => void> = []
  const fakeSession = {
    getState: () => ({ status: 'ready' }),
    onState: (listener: (state: unknown) => void) => {
      stateListeners.push(listener)
      return () => {}
    },
    withAccessToken: async <T>(fn: (t: string) => Promise<T>): Promise<T> => fn(token)
  }
  const origLoad = Module._load
  Module._load = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
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

  const workspace = path.join(os.homedir(), '.wfc', 'workspace')
  const readState = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(workspace, '.sync-state.json'), 'utf8')
      ) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  await fs.mkdir(path.join(workspace, 'brain', 'conversations'), { recursive: true })
  const fail = (msg: string): never => {
    console.error(`PHASE ${PHASE} FAIL: ${msg}`)
    process.exit(1)
  }

  if (PHASE === 'seed') {
    await writeSeedWorkspace(workspace)
    const conversations = await import('@main/conversations')
    for (let n = 1; n <= CONV_COUNT; n++) {
      await conversations.saveConversation(seedConversation(n) as never)
    }
    const sync = await import('@main/cloud/sync')
    sync.initCloudSync({ getUserId: () => userId })
    stateListeners.forEach((l) => l({ status: 'ready' }))

    const pushed = await until(async () => {
      const ids = await walkConversationIds(token)
      if (ids.length < CONV_COUNT) return false
      const names = await walkManifestNames(token)
      return (
        names.includes('files/dup-a.txt') &&
        names.includes('brain/notes/dup-b.txt') &&
        names.includes('files/empty.marker') &&
        lazyMediaSeedFiles().every(([rel]) => names.includes(rel)) &&
        names.includes('brain/channels/chats.json')
      )
    }, 240_000)
    if (!pushed) {
      fail(`initial push incomplete: ${(await walkConversationIds(token)).length} conversations`)
    }

    await conversations.deleteConversation(convId(CONV_COUNT))
    await fs.rm(path.join(workspace, 'files/temp-note.txt'))
    sync.scheduleConversationPush(convId(1)) // any push arms the sweep

    const tombstoned = await until(async () => {
      const ids = await walkConversationIds(token)
      if (ids.includes(convId(CONV_COUNT))) return false
      const names = await walkManifestNames(token)
      return !names.includes('files/temp-note.txt')
    }, 120_000)
    if (!tombstoned) fail('tombstones missing on the live worker')
    console.log('phase seed: ok')
    process.exit(0)
  }

  if (PHASE === 'restore') {
    // THE REAL fresh-install boot: the bundled defaults tree and the default
    // config land BEFORE restore can run — exactly what app.whenReady does.
    const ws = await import('@main/workspace/workspace')
    await ws.ensureWorkspace()
    const sync = await import('@main/cloud/sync')
    let restoredConversations = 0
    const hydrationEvents: import('@main/cloud/sync').HydrationProgress[] = []
    sync.initCloudSync({
      getUserId: () => userId,
      onRestored: (summary) => {
        restoredConversations = summary.conversations
      },
      onHydrationProgress: (progress) => {
        hydrationEvents.push(progress)
      }
    })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const done = await until(async () => (await readState()).restore_done === true, 240_000)
    if (!done) fail(`restore never completed: ${JSON.stringify(await readState())}`)
    if (restoredConversations !== CONV_COUNT - 1) {
      fail(`expected ${CONV_COUNT - 1} restored conversations, got ${restoredConversations}`)
    }

    // On-open hydration against the REAL worker: nothing predownloaded,
    // then c1/c2 hydrate on open with streamed progress.
    await verifyLazyHydration({
      hydrate: (id) => sync.hydrateConversationFiles(id),
      events: hydrationEvents,
      workspace,
      fail
    })

    // Tombstone safety on the real worker: a sweep after hydration must
    // not tombstone unopened conversations' media. Prove a sweep completed
    // (a fresh marker file reaches the manifest), then the orchestrator
    // asserts the media rows are still live.
    await fs.writeFile(path.join(workspace, 'files/after-restore.txt'), 'sweep-marker')
    sync.scheduleConversationPush(convId(3))
    const swept = await until(
      async () => (await walkManifestNames(token)).includes('files/after-restore.txt'),
      120_000
    )
    if (!swept) fail('post-hydration sweep never completed')
    console.log('phase restore: ok')
    process.exit(0)
  }

  if (PHASE === 'foreign') {
    const sync = await import('@main/cloud/sync')
    let firedWith: string | null = null
    sync.initCloudSync({
      getUserId: () => userId,
      onForeignWorkspace: (owner) => {
        firedWith = owner
      }
    })
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const fired = await until(() => firedWith !== null, 15_000)
    if (!fired) fail('onForeignWorkspace never fired')
    if (firedWith !== process.env.WFC_OWNER_USER) fail(`wrong owner reported: ${firedWith}`)
    await sleep(3_500)
    console.log('phase foreign: ok')
    process.exit(0)
  }

  fail(`unknown phase ${PHASE}`)
}

// ── Orchestrator ─────────────────────────────────────────────────────────

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function orchestrate(): Promise<void> {
  process.env.WFC_TEST_RUN = Date.now().toString(36)
  try {
    await fetch(BASE)
  } catch {
    console.error(
      `Cannot reach ${BASE}. Start the worker first:\n` +
        `  cd apps/api && npm run db:migrate:local && npm run dev`
    )
    process.exit(1)
  }

  // Seed two real users into local D1 — the same mechanism smoke-sync uses.
  const apiDir = path.resolve(process.cwd(), '..', 'api')
  const stamp = Date.now().toString(36)
  const PW = 'purge-cycle-pass-1'
  const salt = '00112233445566778899aabbccddeeff'
  const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
  const mkUser = (tag: string): string =>
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
     VALUES ('usr_${tag}_${stamp}', '${tag}-${stamp}@wolffi.sh', '${tag}', 'employee', 'active', '${hash}', '${salt}', 0);`
  // User A's metered history — what the purged install must rebuild its
  // usage ledger from.
  const usageRows = USAGE_ROWS.map(
    (r) =>
      `INSERT INTO usage (user_id, device_id, model, tokens_in, tokens_out, tokens_cached,
         cost_microusd, latency_ms, decision, created_at)
       VALUES ('usr_purgea_${stamp}', '${r.device_id}', '${r.model}', ${r.tokens_in}, ${r.tokens_out},
         ${r.tokens_cached}, ${r.cost_microusd}, 1, '${r.decision}', '${r.created_at}');`
  )
  const sql = [
    `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
     VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4-Flash-0731', '[]');`,
    mkUser('purgea'),
    mkUser('purgeb'),
    ...usageRows
  ].join(' ')
  execSync(`npx wrangler d1 execute wfc-master --local --command "${sql.replace(/"/g, '\\"')}"`, {
    cwd: apiDir,
    stdio: 'pipe'
  })

  const login = async (tag: string): Promise<{ token: string; userId: string }> => {
    const res = await api('/auth/login', {
      body: { email: `${tag}-${stamp}@wolffi.sh`, password: PW, device: { platform: 'sim' } }
    })
    const token = res.json?.access_token as string
    const user = res.json?.user as { id: string } | undefined
    if (!token || !user?.id) {
      console.error('login failed:', res.status, JSON.stringify(res.json))
      process.exit(1)
    }
    return { token, userId: user.id }
  }
  const a = await login('purgea')
  const b = await login('purgeb')
  ok('two real users logged in', Boolean(a.token && b.token && a.userId !== b.userId))

  const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-purge-live-'))
  const WORKSPACE = path.join(SANDBOX, '.wfc', 'workspace')
  const runPhase = (phase: string, env: Record<string, string>): Promise<number> => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, `--phase=${phase}`],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: SANDBOX, WFC_API_URL: BASE, ...env },
        stdio: 'inherit'
      }
    )
    return new Promise((resolve) => {
      const killer = setTimeout(() => {
        console.error(`phase ${phase} timed out — killing`)
        child.kill('SIGKILL')
      }, 360_000)
      child.on('error', (err) => {
        clearTimeout(killer)
        console.error(`phase ${phase} spawn error:`, err)
        resolve(1)
      })
      child.on('exit', (code) => {
        clearTimeout(killer)
        resolve(code ?? 1)
      })
    })
  }

  // 1 · Seed 501 conversations + the fixture files; delete one of each.
  ok(
    'phase seed exits clean',
    (await runPhase('seed', { WFC_TEST_TOKEN: a.token, WFC_TEST_USER: a.userId })) === 0
  )
  const namesAfterSeed = await walkManifestNames(a.token)
  ok(
    'cerebellum-local keys NEVER uploaded',
    !namesAfterSeed.some((n) => n.startsWith('brain/cerebellum/'))
  )
  ok('deleted file gone from live manifest', !namesAfterSeed.includes('files/temp-note.txt'))
  const idsAfterSeed = await walkConversationIds(a.token)
  ok(
    `${CONV_COUNT - 1} live conversations on the worker`,
    idsAfterSeed.length === CONV_COUNT - 1,
    String(idsAfterSeed.length)
  )

  // 2 · THE PURGE.
  await fs.rm(path.join(SANDBOX, '.wfc'), { recursive: true, force: true })
  ok('purge really happened', !existsSync(WORKSPACE))

  // 3 · Restore on a fresh install, then the SHARED disk assertions.
  ok(
    'phase restore exits clean',
    (await runPhase('restore', { WFC_TEST_TOKEN: a.token, WFC_TEST_USER: a.userId })) === 0
  )
  await assertRestoredWorkspace(ok, WORKSPACE, CONV_COUNT)
  const namesAfterHydration = await walkManifestNames(a.token)
  ok(
    'lazy media rows still live after hydration + sweep (real worker)',
    lazyMediaSeedFiles().every(([rel]) => namesAfterHydration.includes(rel))
  )
  ok(
    'usage ledger never uploaded as a blob (real worker)',
    !namesAfterHydration.includes('usage/providers/cloud.md')
  )
  ok(
    'one live manifest row per path (superseding, real worker)',
    new Set(namesAfterHydration).size === namesAfterHydration.length
  )

  // 4 · The ownership guard against a second REAL user.
  ok(
    'phase foreign exits clean',
    (await runPhase('foreign', {
      WFC_TEST_TOKEN: b.token,
      WFC_TEST_USER: b.userId,
      WFC_OWNER_USER: a.userId
    })) === 0
  )
  const bIds = await walkConversationIds(b.token)
  const bNames = await walkManifestNames(b.token)
  const bConfig = await api('/v1/config', { token: b.token })
  ok('foreign user got NONE of the data', bIds.length === 0 && bNames.length === 0)
  ok('foreign user config untouched', bConfig.json?.updated_at === null)

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
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
