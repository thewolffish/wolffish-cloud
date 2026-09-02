/**
 * Second-device restore test — pins the "sign in elsewhere and everything
 * moves" contract end to end through the real sync module:
 *
 *   a virgin workspace (default config, onboarding never completed, no
 *   conversations) + session ready → /v1/sync/bootstrap rehydrates the
 *   config — variables, secrets and all — the conversation index and
 *   records rebuild each transcript, the restore stamps the config row
 *   so the launch sweep pushes the RESTORED blob back (idempotent), and
 *   never a default one over it.
 *
 * The cloud session and network are fakes (fetch serves device A's world);
 * workspace, conversations and sync are the real modules against a
 * sandboxed HOME.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/restore-second-device.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-second-device-'))
process.env.HOME = SANDBOX

const WORKSPACE = path.join(SANDBOX, '.wfc', 'workspace')
const CONFIG = path.join(WORKSPACE, 'config.json')
const STAMP = path.join(WORKSPACE, '.sync-state.json')

// ── Fakes: electron, the cloud session, and device A's world ─────────────

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

const DEVICE_A_CONFIG = {
  onboardingCompleted: true,
  theme: 'from-device-a',
  variables: [{ name: 'API_KEY', value: 'sk-live-secret', sensitive: true }]
}

const CONV = { id: 'cnv_a1', title: 'From device A' }
const nowIso = new Date().toISOString()
const RECORDS = [
  {
    id: 'snap.0123456789abcdef',
    seq: 3000,
    kind: 'snapshot',
    content: { id: CONV.id, title: CONV.title, model: 'test-model' },
    created_at: nowIso
  },
  {
    id: 'm_1.aaaaaaaa',
    seq: 1000,
    kind: 'message',
    content: { id: 'm_1', timestamp: 1000, content: 'hello from device A' },
    created_at: nowIso
  },
  {
    id: 'm_2.bbbbbbbb',
    seq: 2000,
    kind: 'message',
    content: { id: 'm_2', timestamp: 2000, content: 'hi back' },
    created_at: nowIso
  }
]

const puts: Array<Record<string, unknown>> = []
/** The one settings row, mirrored the way the real server keeps it: a PUT
 *  replaces the blob and mints the stamp the next GET serves. */
let settingsRow = { config: DEVICE_A_CONFIG as Record<string, unknown>, updated_at: 'srv-cfg-1' }

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const route = `${method} ${url.pathname}`
  if (route === 'GET /v1/sync/bootstrap') {
    return json({
      config: settingsRow.config,
      config_updated_at: settingsRow.updated_at,
      conversations: [{ ...CONV, created_at: nowIso, updated_at: nowIso }],
      files: []
    })
  }
  if (route === `GET /v1/conversations/${CONV.id}/records`) {
    return json({ records: RECORDS, next_after: RECORDS.length })
  }
  if (route === 'GET /v1/config') return json(settingsRow)
  if (route === 'PUT /v1/config') {
    const body = JSON.parse(String(init?.body)) as { config: Record<string, unknown> }
    puts.push(body)
    settingsRow = { config: body.config, updated_at: `put-${puts.length}` }
    return json({ ok: true, updated_at: settingsRow.updated_at })
  }
  if (route === 'GET /v1/files/manifest') return json({ files: [] })
  if (route === 'GET /v1/usage') return json({ rows: [], next: null })
  if (route === 'GET /v1/conversations')
    return json({
      conversations: [{ ...CONV, created_at: nowIso, updated_at: nowIso }],
      next: null
    })
  if (route === 'POST /v1/sync/batch')
    return json({ ok: true, accepted: 0, ignored: 3, rejected: 0 })
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

async function until(cond: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
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

async function run(): Promise<void> {
  // Device B as first boot leaves it: default config, onboarding never
  // completed, no conversations — the auth gate means sign-in happens
  // exactly in this state.
  await fs.mkdir(path.join(WORKSPACE, 'brain', 'conversations'), { recursive: true })
  await fs.writeFile(CONFIG, JSON.stringify({ onboardingCompleted: false, theme: 'system' }))

  const sync = await import('@main/cloud/sync')
  const { restoreFromCloud, initCloudSync } = sync
  initCloudSync()
  stateListeners.forEach((l) => l({ status: 'ready' }))

  // Config — variables included — walked back from the org.
  const restored = await until(async () => {
    const cfg = await readJson(CONFIG)
    const vars = cfg.variables as Array<Record<string, unknown>> | undefined
    return cfg.onboardingCompleted === true && vars?.[0]?.value === 'sk-live-secret'
  })
  ok('config restored with variables', restored)
  ok(
    'restore stamped the config row',
    await until(async () => (await readJson(STAMP)).config_updated_at === 'srv-cfg-1')
  )

  // The transcript rebuilt from records, envelope fields intact.
  const { loadConversation, listConversations } = await import('@main/conversations')
  ok(
    'conversation index restored',
    await until(async () => (await listConversations()).some((m) => m.id === CONV.id))
  )
  const conv = await loadConversation(CONV.id)
  ok('transcript rebuilt', conv?.messages.length === 2, `got ${conv?.messages.length}`)
  ok('messages in order', conv?.messages[0]?.content === 'hello from device A')
  ok('envelope survived', conv?.title === CONV.title && conv?.model === 'test-model')

  // The launch sweep pushed the RESTORED blob (stamps matched, so push,
  // and the body is device A's config — never device B's defaults).
  ok(
    'sweep pushed restored config, not defaults',
    await until(async () => {
      const cfg = (puts[0]?.config ?? {}) as Record<string, unknown>
      const vars = cfg.variables as Array<Record<string, unknown>> | undefined
      return puts.length >= 1 && vars?.[0]?.value === 'sk-live-secret'
    })
  )
  ok(
    'no default config ever pushed',
    !puts.some((p) => {
      const cfg = (p.config ?? {}) as Record<string, unknown>
      return cfg.onboardingCompleted !== true
    })
  )

  // A relaunch (the session is re-established: loggedOut → ready) adopts
  // nothing and re-pushes idempotently: stamps still match. A bare second
  // `ready` in the SAME session would be a UI-only transition and push
  // nothing — that is the point of the auth-edge gating.
  const putCountBefore = puts.length
  stateListeners.forEach((l) => l({ status: 'loggedOut' }))
  stateListeners.forEach((l) => l({ status: 'ready' }))
  await until(async () => puts.length > putCountBefore)
  ok('relaunch re-pushes same blob', puts.length > putCountBefore)
  const lastCfg = (puts[puts.length - 1]?.config ?? {}) as Record<string, unknown>
  ok(
    'relaunch push still carries variables',
    (lastCfg.variables as Array<Record<string, unknown>> | undefined)?.[0]?.value ===
      'sk-live-secret'
  )
  void restoreFromCloud // exported surface exercised via the ready flow above

  console.log(`${passed} passed, ${failed} failed`)
  // initCloudSync starts a 120s re-arm interval; exit explicitly.
  process.exit(failed > 0 ? 1 : 0)
}

void run()
