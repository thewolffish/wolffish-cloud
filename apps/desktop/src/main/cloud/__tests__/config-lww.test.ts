/**
 * Config LWW tests — pins the row-level last-write-wins contract between
 * the desktop and the settings row that admin-authored writes depend on:
 *
 *   1. an install with no sync stamp keeps the old behavior (launch pushes
 *      local config, and the push mints the stamp),
 *   2. a server row stamped by someone else (admin console, another device)
 *      is adopted at launch — local file replaced, stamp advanced, and NO
 *      echo push fired back over it,
 *   3. a local edit pushes and records the fresh server stamp.
 *
 * The cloud session and the network are fakes — cloud/session is shimmed
 * wholesale and fetch records every /v1 call. The real workspace module
 * runs against a sandboxed HOME.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/config-lww.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-config-lww-'))
process.env.HOME = SANDBOX

const WORKSPACE = path.join(SANDBOX, '.wfc', 'workspace')
const CONFIG = path.join(WORKSPACE, 'config.json')
const STAMP = path.join(WORKSPACE, '.sync-state.json')

// ── Fakes: electron, the cloud session, and the wire ─────────────────────

const stateListeners: Array<(state: unknown) => void> = []
const fakeSession = {
  getState: () => ({ status: 'ready' }),
  onState: (listener: (state: unknown) => void) => {
    stateListeners.push(listener)
    return () => {}
  },
  withAccessToken: async <T>(fn: (token: string) => Promise<T>): Promise<T> => fn('tok_test')
}

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
    }
  }
  if (args[0] === '@main/cloud/session') {
    return { cloudSession: fakeSession }
  }
  return origLoad.apply(this, args)
}

/** Every PUT /v1/config body lands here; puts[n] returns stamp `put-${n+1}`. */
const puts: Array<Record<string, unknown>> = []
/** What GET /v1/config serves — the test rewrites this between scenarios. */
let serverRow: { config: Record<string, unknown> | null; updated_at: string | null } = {
  config: null,
  updated_at: null
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const route = `${method} ${url.pathname}`
  if (route === 'GET /v1/config') return json(serverRow)
  if (route === 'PUT /v1/config') {
    puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return json({ ok: true, updated_at: `put-${puts.length}` })
  }
  if (route === 'GET /v1/sync/bootstrap') {
    return json({
      config: serverRow.config ?? {},
      config_updated_at: serverRow.updated_at,
      conversations: [],
      files: []
    })
  }
  if (route === 'GET /v1/files/manifest') return json({ files: [] })
  if (route === 'GET /v1/usage') return json({ rows: [], next: null })
  if (route === 'POST /v1/sync/batch')
    return json({ ok: true, accepted: 0, ignored: 0, rejected: 0 })
  return json({ error: `unexpected route ${route}` })
}) as typeof fetch

// ── Harness ──────────────────────────────────────────────────────────────

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

async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

const readJson = async (file: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
const stampOnDisk = async (): Promise<unknown> => (await readJson(STAMP)).config_updated_at
const themeOnDisk = async (): Promise<unknown> => (await readJson(CONFIG)).theme
const putTheme = (n: number): unknown => ((puts[n]?.config ?? {}) as Record<string, unknown>).theme

async function run(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE, 'brain', 'conversations'), { recursive: true })
  await fs.writeFile(CONFIG, JSON.stringify({ onboardingCompleted: true, theme: 'local-1' }))

  const sync = await import('@main/cloud/sync')
  sync.initCloudSync()
  // A "launch" re-establishes the session (loggedOut → ready): only that
  // edge runs the session flow — a bare repeated `ready` is a UI-only
  // transition (lock/unlock) and deliberately does nothing here.
  const fireReady = (): void => {
    stateListeners.forEach((l) => l({ status: 'loggedOut' }))
    stateListeners.forEach((l) => l({ status: 'ready' }))
  }

  // 1 · No stamp on disk: launch pushes local config (the pre-stamp
  // behavior), and the push mints the stamp.
  fireReady()
  ok('no-stamp launch pushes local', await until(async () => (await stampOnDisk()) === 'put-1'))
  ok('push carried the local blob', puts.length === 1 && putTheme(0) === 'local-1')
  ok('local file untouched by push', (await themeOnDisk()) === 'local-1')

  // 2 · Foreign stamp: the server row was written by someone else (the
  // admin console). Launch adopts it — file replaced, stamp advanced —
  // and fires no echo push back over it.
  serverRow = {
    config: { theme: 'admin-fixed', onboardingCompleted: true },
    updated_at: 'admin-1'
  }
  fireReady()
  ok(
    'foreign row adopted',
    await until(
      async () => (await stampOnDisk()) === 'admin-1' && (await themeOnDisk()) === 'admin-fixed'
    )
  )
  ok('adoption fired no echo push', puts.length === 1)

  // 3 · Local edit: pushes, and records the fresh server stamp.
  const { writeConfig } = await import('@main/workspace/workspace')
  const current = await readJson(CONFIG)
  await writeConfig({ ...current, theme: 'local-2' } as never)
  ok('local edit pushed', await until(async () => (await stampOnDisk()) === 'put-2'))
  ok('push carried the edit', puts.length === 2 && putTheme(1) === 'local-2')
  ok('adopted content not resurrected', (await themeOnDisk()) === 'local-2')

  console.log(`${passed} passed, ${failed} failed`)
  // initCloudSync starts a 120s re-arm interval; exit explicitly.
  process.exit(failed > 0 ? 1 : 0)
}

void run()
