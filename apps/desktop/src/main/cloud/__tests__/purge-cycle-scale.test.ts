/**
 * Purge-cycle SCALE simulation — 700 conversations, every one with a
 * different file footprint, through the REAL sync engine against the REAL
 * Worker (wrangler dev, local D1 + R2), with the REAL fresh-install boot
 * (`ensureWorkspace()` lays the bundled defaults down BEFORE restore runs,
 * exactly as the app does), and per-route request/byte/latency tallies so
 * the cost of a restore and of a launch sweep is measured, not guessed.
 *
 *   phase seed     device A: config, a customized brain (soul, user,
 *                  agents, heartbeat automations, knowledge), a 300-line
 *                  usage ledger, 700 conversations (2..18 messages each;
 *                  images / PDFs / voice notes / TTS replies / generated
 *                  downloads / deliverables / screenshots / a 1.5 MB upload /
 *                  an over-size message, distributed by residue classes).
 *                  Everything drains to the worker. Then one conversation
 *                  and one file are deleted, and six "turns" run on c1 so
 *                  record and manifest growth per turn can be counted.
 *   PURGE          rm -rf ~/.wfc.
 *   phase restore  fresh install, same account: the real ensureWorkspace()
 *                  boots the workspace, then restore walks every page back
 *                  out of D1/R2 until restore_done; the convergence sweep
 *                  runs; a sample of conversations hydrates on open; then a
 *                  SECOND session-ready (lock/unlock, profile save) fires so
 *                  its re-push cost is measured too.
 *   assertions     every surviving transcript exact, every eager file
 *                  byte-exact, tombstones honored, lazy media not
 *                  predownloaded then hydrated exact — PLUS the two things
 *                  the smaller sims never looked at: do files the bundled
 *                  defaults pre-seed (soul.md, heartbeat.md, knowledge,
 *                  usage ledger) come back, and what does the server hold
 *                  for them after the sweep?
 *
 * Requires `wrangler dev` running for apps/api (npm run dev) with local
 * migrations applied. Run from apps/desktop:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/purge-cycle-scale.test.ts
 * Env: WFC_SCALE_CONVS (default 700), WFC_API_URL (default :8787).
 */

import { execSync, spawn } from 'node:child_process'
import { createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { providerLedgerLine } from '@main/runtime/usage'

const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length) ?? null
const BASE = process.env.WFC_API_URL ?? 'http://localhost:8787'
const CONV_COUNT = Number(process.env.WFC_SCALE_CONVS ?? 700)
const TURNS_ON_C1 = 6

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(
  cond: () => Promise<boolean> | boolean,
  ms: number,
  every = 250
): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(every)
  }
  return cond()
}

// ── The seeded world (deterministic, id-tagged per run) ──────────────────

const runTag = (): string => process.env.WFC_TEST_RUN ?? ''
const convId = (n: number): string => `s${runTag()}n${n}`
const convDir = (n: number): string => `conv-${convId(n)}`
const BASE_TS = 1_756_000_000_000
/** The engine's slim threshold for one message record (sync.ts). */
const MAX_RECORD_BYTES = 300_000

/** Deterministic filler bytes: distinct per seed, fast to generate. */
function blob(seed: string, size: number): Buffer {
  const b = Buffer.alloc(size, `<${seed}>`)
  // Make the head unique too (some seeds are prefixes of others).
  b.write(sha256(seed).slice(0, Math.min(32, size)), 0, 'latin1')
  return b
}

type SeedFile = { rel: string; bytes: Buffer; lazy: boolean }
type SeedAttachment = {
  type: 'audio' | 'video' | 'image' | 'pdf' | 'other'
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

/** The file footprint of conversation n — different for every n. */
function filesFor(n: number): Array<SeedFile & { attach?: SeedAttachment; voice?: boolean }> {
  const dir = convDir(n)
  const out: Array<SeedFile & { attach?: SeedAttachment; voice?: boolean }> = []
  const push = (
    rel: string,
    size: number,
    lazy: boolean,
    attach?: Omit<SeedAttachment, 'sizeBytes' | 'filePath' | 'originalName'>,
    voice = false
  ): void => {
    const bytes = blob(rel, size)
    out.push({
      rel,
      bytes,
      lazy,
      attach: attach
        ? {
            ...attach,
            filePath: rel,
            originalName: path.basename(rel),
            sizeBytes: bytes.byteLength
          }
        : undefined,
      voice
    })
  }
  if (n % 5 === 0)
    push(`uploads/${dir}/photo-${n}.png`, 5_000 + (n % 37) * 1_000, true, {
      type: 'image',
      mimeType: 'image/png'
    })
  if (n % 7 === 0)
    push(`uploads/${dir}/doc-${n}.pdf`, 20_000 + (n % 23) * 5_000, true, {
      type: 'pdf',
      mimeType: 'application/pdf'
    })
  if (n % 11 === 0)
    push(
      `voice/${dir}/note.webm`,
      10_000 + (n % 5) * 500,
      true,
      { type: 'audio', mimeType: 'audio/webm' },
      true
    )
  if (n % 13 === 0) push(`speech/${dir}/reply.mp3`, 30_000 + (n % 7) * 1_000, true)
  if (n % 19 === 0) push(`downloads/${dir}/clip.mp4`, 200_000 + (n % 3) * 10_000, true)
  if (n % 50 === 0)
    push(`uploads/${dir}/big-${n}.bin`, 1_500_000, true, {
      type: 'other',
      mimeType: 'application/octet-stream'
    })
  if (n % 3 === 0)
    out.push({
      rel: `files/report-${n}.md`,
      bytes: Buffer.from(`# Report ${n}\n\n${'numbers. '.repeat(20 + (n % 50))}\n`),
      lazy: false
    })
  if (n % 17 === 0) push(`screenshots/${dir}/shot-${n}.png`, 40_000 + (n % 4) * 2_000, true)
  return out
}

/** Every eager (non-conversation-media) file device A carries. */
function brainSeedFiles(): Array<[string, string]> {
  const ledger = ['# Wolffish Cloud', '']
  for (let d = 1; d <= 30; d++) {
    const day = `2026-08-${String(d).padStart(2, '0')}`
    ledger.push(`## ${day}`, '')
    for (let k = 0; k < 10; k++) {
      ledger.push(
        `- ${day} ${String(8 + k).padStart(2, '0')}:00:00 | deepseek-ai/DeepSeek-V4-Flash-0731 | in:${1000 + k * 37} out:${200 + k * 11} cw:0 cr:${k * 50} | $0.00${(k + 1) * 11}`
      )
    }
    ledger.push('')
  }
  return [
    [
      'brain/identity/soul.md',
      "# Soul — customized by the user\n\nI am Younes's agent. Dry humor, terse.\n"
    ],
    [
      'brain/identity/user.md',
      '# User — customized\n\nName: Younes. Timezone: Riyadh. Prefers Arabic replies after 9pm.\n'
    ],
    [
      'brain/prefrontal/agents.md',
      '# Custom agent instructions\n\nAlways cite sources. Never send emails without asking.\n'
    ],
    [
      'brain/brainstem/heartbeat.md',
      '# Heartbeat\n\n## Daily digest\n- schedule: 0 7 * * *\n- prompt: summarize yesterday\n'
    ],
    [
      'brain/hippocampus/knowledge/preferences.md',
      '# Preferences (learned)\n\n- Dark mode.\n- Conventional commits.\n'
    ],
    ['brain/hippocampus/knowledge/people.md', '# People\n\n- Sara — PM at Wolffish.\n'],
    [
      'brain/hippocampus/episodes/2026-08-30.md',
      '# 2026-08-30\n\n- 10:12 shipped the sync engine.\n'
    ],
    ['brain/projects.json', JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Q3' }] })],
    ['brain/procedures.json', JSON.stringify({ version: 1, procedures: [] })],
    ['usage/providers/cloud.md', ledger.join('\n') + '\n'],
    [
      'usage/daily/2026-08-30.md',
      '# 2026-08-30\n\n- 10:00:00 | Wolffish Cloud | deepseek-ai/DeepSeek-V4-Flash-0731 | in:10 out:20 | $0.000123\n'
    ],
    [
      `logs/extension/${convId(3)}.jsonl`,
      '{"t":1,"kind":"navigate","url":"https://example.com"}\n'
    ],
    ['brain/channels/chats.json', '{"123":"' + convId(2) + '"}'],
    ['brain/cerebellum/.local/creds.json', '{"secret":"device-local-keys"}'],
    ['files/temp-note.txt', 'to be deleted\n']
  ]
}
/** Paths the bundled defaults ALSO ship — the ones a fresh boot pre-seeds. */
const DEFAULT_COLLIDING = [
  'brain/identity/soul.md',
  'brain/identity/user.md',
  'brain/prefrontal/agents.md',
  'brain/brainstem/heartbeat.md',
  'brain/hippocampus/knowledge/preferences.md',
  'brain/hippocampus/knowledge/people.md'
]
const DEVICE_ONLY: Array<[string, string]> = [
  ['logs/2020-01-01.log', 'rotating app log — device only\n']
]
/** The org's metered history for this user (seeded into D1): the ledger a
 *  purged install must rebuild — every device's spend, denials excluded. */
const USAGE_ROWS = [
  {
    device_id: 'dev_old_laptop',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tokens_in: 1200,
    tokens_out: 300,
    tokens_cached: 400,
    cost_microusd: 15_000,
    decision: 'allowed',
    created_at: '2026-08-28T06:30:00.000Z'
  },
  {
    device_id: 'dev_phone',
    model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    tokens_in: 800,
    tokens_out: 150,
    tokens_cached: 0,
    cost_microusd: 42_000,
    decision: 'allowed',
    created_at: '2026-08-31T18:05:00.000Z'
  },
  {
    device_id: 'dev_old_laptop',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    cost_microusd: 0,
    decision: 'denied_quota',
    created_at: '2026-08-31T19:00:00.000Z'
  }
]
function expectedLedgerText(): string {
  let text = '# Wolffish Cloud\n'
  let current: string | null = null
  for (const r of USAGE_ROWS.filter(
    (r) => r.decision === 'allowed' && r.tokens_in + r.tokens_out > 0
  )) {
    const line = providerLedgerLine({
      at: new Date(r.created_at),
      model: r.model,
      inputTokens: r.tokens_in,
      outputTokens: r.tokens_out,
      cacheReadTokens: r.tokens_cached > 0 ? r.tokens_cached : undefined,
      cost: r.cost_microusd / 1_000_000
    })
    const date = line.slice(2, 12)
    if (date !== current) {
      text += `\n## ${date}\n\n`
      current = date
    }
    text += line
  }
  return text
}

const CONFIG_A = {
  version: 1,
  onboardingCompleted: true,
  theme: 'dark',
  locale: 'en',
  llm: { model: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
  variables: [{ name: 'SECRET', value: 'sk-live-999', sensitive: true }],
  mobile: { notifications: true, verbose: true, runCards: false }
}

function seedConversation(n: number): Record<string, unknown> {
  const id = convId(n)
  const count = 2 + (n % 9) * 2
  const files = filesFor(n)
  const attachments = files.filter((f) => f.attach).map((f) => f.attach!)
  const voice = files.some((f) => f.voice)
  const deliverable = files.find((f) => f.rel.startsWith('files/'))
  const messages = Array.from({ length: count }, (_, i) => {
    let content = `${id} message ${i + 1} ${'x'.repeat((n * 7 + i * 13) % 400)}`
    // One over-size message (n=82) past the engine's slim threshold; one
    // large-but-whole (n=41) under it.
    if (n === 41 && i === 1) content = `${id} large ` + 'L'.repeat(250_000)
    if (n === 82 && i === 1) content = `${id} oversize ` + 'O'.repeat(350_000)
    if (deliverable && i === 1) content += `\n\nDelivered ${path.basename(deliverable.rel)}.`
    return {
      id: `m_${id}_${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content,
      timestamp: BASE_TS + n * 100_000 + i * 1000,
      ...(i === 0 && attachments.length ? { attachments } : {}),
      ...(i === 0 && voice ? { voicePrompt: true } : {}),
      ...(i === 1 ? { segments: [{ kind: 'text', text: content }] } : {})
    }
  })
  return {
    id,
    title: `Conversation ${n}`,
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    messages,
    createdAt: BASE_TS + n * 100_000,
    updatedAt: BASE_TS + n * 100_000 + count * 1000,
    ...(n % 4 === 0 ? { channel: 'mobile' } : {}),
    stats: { allTime: { turns: count / 2, cost: n / 1000 } }
  }
}

function expectedEagerNames(): string[] {
  const names = new Set<string>()
  for (const [rel] of brainSeedFiles())
    if (!rel.startsWith('brain/cerebellum/') && !rel.startsWith('usage/')) names.add(rel)
  for (let n = 1; n <= CONV_COUNT; n++) for (const f of filesFor(n)) if (!f.lazy) names.add(f.rel)
  return [...names]
}
function expectedLazyNames(): string[] {
  const names: string[] = []
  for (let n = 1; n <= CONV_COUNT; n++) for (const f of filesFor(n)) if (f.lazy) names.push(f.rel)
  return names
}

// ── Minimal authorized API client (orchestrator + phase polling) ─────────

const rawFetch = globalThis.fetch
async function api(
  route: string,
  opts: { token?: string; method?: string; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await rawFetch(`${BASE}${route}`, {
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
    // non-JSON
  }
  return { status: res.status, json }
}

async function walkConversationIds(token: string): Promise<string[]> {
  const ids: string[] = []
  let after = 0
  for (let i = 0; i < 100; i++) {
    const res = await api(`/v1/conversations?after=${after}`, { token })
    const page = (res.json?.conversations as Array<{ id: string }>) ?? []
    ids.push(...page.map((c) => c.id))
    const next = res.json?.next
    if (typeof next !== 'number' || next <= after) break
    after = next
  }
  return ids
}

/** Every live manifest ROW (name + sha), newest first, across pages. */
async function walkManifest(token: string): Promise<Array<{ name: string; sha256: string }>> {
  const rows: Array<{ name: string; sha256: string }> = []
  let before: string | null = null
  for (let i = 0; i < 200; i++) {
    const q = before ? `?before=${encodeURIComponent(before)}` : ''
    const res = await api(`/v1/files/manifest${q}`, { token })
    const page = (res.json?.files as Array<{ name: string; sha256: string }>) ?? []
    rows.push(...page)
    const next = res.json?.next
    if (typeof next !== 'string' || next === before) break
    before = next
  }
  return rows
}

async function walkRecords(
  token: string,
  id: string
): Promise<Array<{ kind: string; id: string }>> {
  const out: Array<{ kind: string; id: string }> = []
  let after = 0
  for (let i = 0; i < 100; i++) {
    const res = await api(
      `/v1/conversations/${encodeURIComponent(id)}/records?after=${after}&limit=200`,
      { token }
    )
    const page = (res.json?.records as Array<{ kind: string; id: string }>) ?? []
    out.push(...page)
    const next = res.json?.next_after
    if (typeof next !== 'number' || next <= after) break
    after = next
  }
  return out
}

// ── Per-route tally of everything the ENGINE sends (phase processes) ─────

type RouteStat = {
  count: number
  ms: number
  maxMs: number
  bytesOut: number
  bytesIn: number
  non2xx: number
}
type Metrics = {
  routes: Record<string, RouteStat>
  timers: Record<string, number>
  notes: Record<string, unknown>
}
const metrics: Metrics = { routes: {}, timers: {}, notes: {} }

function normalizeRoute(method: string, pathname: string): string {
  const p = pathname
    .replace(/^\/v1\/conversations\/[^/]+\/records$/, '/v1/conversations/:id/records')
    .replace(/^\/v1\/conversations\/[^/]+$/, '/v1/conversations/:id')
    .replace(/^\/v1\/files\/[0-9a-f]{64}$/, '/v1/files/:sha')
  return `${method} ${p}`
}

function installFetchTally(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = normalizeRoute(method, url.pathname)
    const body = init?.body
    const bytesOut =
      typeof body === 'string'
        ? Buffer.byteLength(body)
        : body instanceof Uint8Array
          ? body.byteLength
          : 0
    const t = performance.now()
    const res = await rawFetch(input, init)
    const ms = performance.now() - t
    let bytesIn = Number(res.headers.get('content-length') ?? 0)
    if (!bytesIn) {
      try {
        bytesIn = (await res.clone().arrayBuffer()).byteLength
      } catch {
        bytesIn = 0
      }
    }
    const stat = (metrics.routes[key] ??= {
      count: 0,
      ms: 0,
      maxMs: 0,
      bytesOut: 0,
      bytesIn: 0,
      non2xx: 0
    })
    stat.count++
    stat.ms += ms
    stat.maxMs = Math.max(stat.maxMs, ms)
    stat.bytesOut += bytesOut
    stat.bytesIn += bytesIn
    if (!res.ok) stat.non2xx++
    return res
  }) as typeof fetch
}

function snapshotRoutes(): Record<string, RouteStat> {
  return JSON.parse(JSON.stringify(metrics.routes)) as Record<string, RouteStat>
}
function diffRoutes(before: Record<string, RouteStat>): Record<string, RouteStat> {
  const out: Record<string, RouteStat> = {}
  for (const [k, v] of Object.entries(metrics.routes)) {
    const b = before[k]
    const d: RouteStat = {
      count: v.count - (b?.count ?? 0),
      ms: v.ms - (b?.ms ?? 0),
      maxMs: v.maxMs,
      bytesOut: v.bytesOut - (b?.bytesOut ?? 0),
      bytesIn: v.bytesIn - (b?.bytesIn ?? 0),
      non2xx: v.non2xx - (b?.non2xx ?? 0)
    }
    if (d.count > 0) out[k] = d
  }
  return out
}
const totalCount = (r: Record<string, RouteStat>): number =>
  Object.values(r).reduce((s, v) => s + v.count, 0)

/** Wait until the engine has been network-quiet for `quietMs`. */
async function untilQuiet(quietMs: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs
  let last = totalCount(metrics.routes)
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    await sleep(500)
    const now = totalCount(metrics.routes)
    if (now !== last) {
      last = now
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) return
  }
}

// ── Child phases (real fetch, real tokens; only electron/session shimmed) ─

async function phaseMain(): Promise<void> {
  const Module = (await import('node:module')).default as unknown as {
    _load: (...a: unknown[]) => unknown
  }
  const token = process.env.WFC_TEST_TOKEN!
  const userId = process.env.WFC_TEST_USER!
  const metricsPath = process.env.WFC_METRICS_PATH!
  const stateListeners: Array<(state: unknown) => void> = []
  const fakeSession = {
    getState: () => ({ status: 'ready' }),
    onState: (listener: (state: unknown) => void) => {
      stateListeners.push(listener)
      return () => {}
    },
    withAccessToken: async <T>(fn: (t: string) => Promise<T>): Promise<T> => fn(token),
    getUserId: () => userId
  }
  const appPath = process.cwd() // apps/desktop — where src/defaults lives
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
  installFetchTally()

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
  const fail = (msg: string): never => {
    console.error(`PHASE ${PHASE} FAIL: ${msg}`)
    void fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2)).finally(() => process.exit(1))
    return undefined as never
  }
  const finish = async (): Promise<never> => {
    await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2))
    console.log(`phase ${PHASE}: ok`)
    process.exit(0)
  }
  const writeRel = async (rel: string, content: Buffer | string): Promise<void> => {
    const abs = path.join(workspace, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }

  if (PHASE === 'seed') {
    await fs.mkdir(path.join(workspace, 'brain', 'conversations'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'config.json'), JSON.stringify(CONFIG_A, null, 2))
    for (const [rel, content] of [...brainSeedFiles(), ...DEVICE_ONLY]) await writeRel(rel, content)
    let fileCount = 0
    let fileBytes = 0
    for (let n = 1; n <= CONV_COUNT; n++) {
      for (const f of filesFor(n)) {
        await writeRel(f.rel, f.bytes)
        fileCount++
        fileBytes += f.bytes.byteLength
      }
    }
    metrics.notes.seedFiles = { count: fileCount, bytes: fileBytes }
    const conversations = await import('@main/conversations')
    const t0 = performance.now()
    for (let n = 1; n <= CONV_COUNT; n++)
      await conversations.saveConversation(seedConversation(n) as never)
    metrics.timers.seedSaveConversationsMs = performance.now() - t0

    const sync = await import('@main/cloud/sync')
    sync.initCloudSync({ getUserId: () => userId })
    const tPush = performance.now()
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const wantEager = new Set(expectedEagerNames())
    const wantLazy = new Set(expectedLazyNames())
    const pushed = await until(
      async () => {
        const ids = await walkConversationIds(token)
        if (ids.length < CONV_COUNT) return false
        const names = new Set((await walkManifest(token)).map((r) => r.name))
        for (const n of wantEager) if (!names.has(n)) return false
        for (const n of wantLazy) if (!names.has(n)) return false
        return true
      },
      20 * 60_000,
      2_000
    )
    metrics.timers.initialPushMs = performance.now() - tPush
    if (!pushed) {
      const ids = await walkConversationIds(token)
      const names = new Set((await walkManifest(token)).map((r) => r.name))
      const missing = [...wantEager, ...wantLazy].filter((n) => !names.has(n))
      fail(
        `initial push incomplete: ${ids.length} conversations, ${missing.length} files missing (${missing.slice(0, 5).join(', ')})`
      )
    }
    metrics.notes.afterInitialPush = snapshotRoutes()

    // Delete one conversation (with media) and one file; tombstones must land.
    await conversations.deleteConversation(convId(CONV_COUNT))
    await fs.rm(path.join(workspace, 'files/temp-note.txt'))
    sync.scheduleConversationPush(convId(1))
    const tombstoned = await until(
      async () => {
        const ids = await walkConversationIds(token)
        if (ids.includes(convId(CONV_COUNT))) return false
        const names = new Set((await walkManifest(token)).map((r) => r.name))
        return (
          !names.has('files/temp-note.txt') && !filesFor(CONV_COUNT).some((f) => names.has(f.rel))
        )
      },
      3 * 60_000,
      1_000
    )
    if (!tombstoned) fail('tombstones missing on the worker')

    // Six "turns" on c1: each appends a message, bumps stats/updatedAt (a
    // new envelope), and appends a usage-ledger line — then drains.
    const before = snapshotRoutes()
    const tTurns = performance.now()
    for (let k = 1; k <= TURNS_ON_C1; k++) {
      const recordsBefore = (await walkRecords(token, convId(1))).length
      await conversations.updateConversation(convId(1), (disk) =>
        disk
          ? {
              ...disk,
              messages: [
                ...disk.messages,
                {
                  id: `m_${convId(1)}_turn${k}`,
                  role: k % 2 ? ('user' as const) : ('assistant' as const),
                  content: `turn ${k}`,
                  timestamp: Date.now()
                }
              ],
              updatedAt: Date.now(),
              // A new envelope every turn — the shape the renderer's
              // end-of-turn save writes (stats change, updatedAt moves).
              stats: {
                allTime: { turns: k, cost: k * 0.001 }
              } as unknown as import('@main/conversations').ConversationFile['stats']
            }
          : disk
      )
      await fs.appendFile(
        path.join(workspace, 'usage/providers/cloud.md'),
        `- 2026-09-01 1${k}:00:00 | deepseek-ai/DeepSeek-V4-Flash-0731 | in:${100 * k} out:${20 * k} | $0.0000${k}\n`
      )
      const landed = await until(
        async () => (await walkRecords(token, convId(1))).length > recordsBefore,
        60_000,
        500
      )
      if (!landed) fail(`turn ${k} never drained`)
    }
    await untilQuiet(4_000, 60_000)
    metrics.timers.sixTurnsMs = performance.now() - tTurns
    metrics.notes.sixTurnsRoutes = diffRoutes(before)
    await finish()
  }

  if (PHASE === 'restore') {
    // THE REAL FRESH-INSTALL BOOT: ensureWorkspace() lays the bundled
    // defaults tree + default config down, exactly as app.whenReady does
    // before the session ever becomes ready.
    let bootPath = 'ensureWorkspace()'
    try {
      const ws = await import('@main/workspace/workspace')
      await ws.ensureWorkspace()
    } catch (err) {
      bootPath = `manual defaults copy (ensureWorkspace threw: ${String(err).slice(0, 120)})`
      await fs.cp(path.join(appPath, 'src', 'defaults', 'workspace'), workspace, {
        recursive: true,
        force: false
      })
      await fs.writeFile(
        path.join(workspace, 'config.json'),
        JSON.stringify({
          version: 1,
          onboardingCompleted: false,
          theme: 'system',
          locale: 'en',
          llm: { model: null }
        })
      )
    }
    metrics.notes.bootPath = bootPath
    const preSeeded: Record<string, string> = {}
    for (const rel of DEFAULT_COLLIDING) {
      try {
        preSeeded[rel] = sha256(await fs.readFile(path.join(workspace, rel)))
      } catch {
        preSeeded[rel] = 'absent'
      }
    }
    metrics.notes.preSeededByBoot = preSeeded

    const sync = await import('@main/cloud/sync')
    let restoredSummary: unknown = null
    const hydrationEvents: import('@main/cloud/sync').HydrationProgress[] = []
    sync.initCloudSync({
      getUserId: () => userId,
      onRestored: (summary) => {
        restoredSummary = summary
      },
      onHydrationProgress: (p) => hydrationEvents.push(p)
    })
    const tRestore = performance.now()
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const done = await until(
      async () => (await readState()).restore_done === true,
      20 * 60_000,
      1_000
    )
    metrics.timers.restoreMs = performance.now() - tRestore
    metrics.notes.restoreRoutes = snapshotRoutes()
    if (!done) fail(`restore never completed: ${JSON.stringify(await readState())}`)
    metrics.notes.restoredSummary = restoredSummary

    // What the fresh install holds for the default-colliding paths now.
    const afterRestore: Record<string, string> = {}
    for (const rel of DEFAULT_COLLIDING) {
      try {
        afterRestore[rel] = sha256(await fs.readFile(path.join(workspace, rel)))
      } catch {
        afterRestore[rel] = 'absent'
      }
    }
    metrics.notes.afterRestore = afterRestore

    // The convergence sweep that follows restore (this launch's re-push).
    const sweepBefore = metrics.notes.restoreRoutes as Record<string, RouteStat>
    const tSweep = performance.now()
    await untilQuiet(5_000, 15 * 60_000)
    metrics.timers.launchSweepMs = performance.now() - tSweep
    metrics.notes.launchSweepRoutes = diffRoutes(sweepBefore)

    // Lazy media must NOT have been predownloaded.
    const predownloaded = expectedLazyNames().filter((rel) => existsSync(path.join(workspace, rel)))
    metrics.notes.predownloadedLazy = predownloaded.length
    if (predownloaded.length)
      fail(`lazy media predownloaded at restore: ${predownloaded.slice(0, 3).join(', ')}`)

    // Open a sample of conversations: every media byte must round-trip.
    const sample = [5, 7, 11, 13, 19, 50, 55, 65, 77, 91, 100, 385, 650].filter(
      (n) => n < CONV_COUNT
    )
    const hydBefore = snapshotRoutes()
    const tHyd = performance.now()
    let hydratedFiles = 0
    let hydratedBytes = 0
    for (const n of sample) {
      const p = await sync.hydrateConversationFiles(convId(n))
      if (!p.done || p.failed > 0) fail(`hydration of c${n} failed: ${JSON.stringify(p)}`)
      const want = filesFor(n).filter((f) => f.lazy)
      if (p.filesTotal !== want.length)
        fail(`c${n} hydrated ${p.filesTotal} files, want ${want.length}`)
      for (const f of want) {
        const got = await fs.readFile(path.join(workspace, f.rel)).catch(() => null)
        if (!got || !got.equals(f.bytes)) fail(`hydrated media wrong: ${f.rel}`)
        hydratedFiles++
        hydratedBytes += f.bytes.byteLength
      }
      const again = await sync.hydrateConversationFiles(convId(n))
      if (again.filesTotal !== 0) fail(`re-hydration of c${n} not a no-op`)
    }
    metrics.timers.hydrateSampleMs = performance.now() - tHyd
    metrics.notes.hydration = {
      conversations: sample.length,
      files: hydratedFiles,
      bytes: hydratedBytes,
      events: hydrationEvents.length,
      routes: diffRoutes(hydBefore)
    }

    // A SECOND session-ready in the same process (lock → unlock, a profile
    // save, a watchdog org-name change all fire onState): what does it cost?
    await untilQuiet(3_000, 60_000)
    const secondBefore = snapshotRoutes()
    const tSecond = performance.now()
    stateListeners.forEach((l) => l({ status: 'ready' }))
    await sleep(3_000)
    await untilQuiet(5_000, 15 * 60_000)
    metrics.timers.secondReadyMs = performance.now() - tSecond
    metrics.notes.secondReadyRoutes = diffRoutes(secondBefore)

    // Prove a sweep completes after hydration (marker reaches the manifest)
    await fs.writeFile(path.join(workspace, 'files/after-restore.txt'), 'sweep-marker')
    sync.scheduleConversationPush(convId(3))
    const swept = await until(
      async () => (await walkManifest(token)).some((r) => r.name === 'files/after-restore.txt'),
      120_000,
      1_000
    )
    if (!swept) fail('post-hydration sweep never completed')
    await finish()
  }

  fail(`unknown phase ${PHASE}`)
}

// ── Orchestrator ─────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const findings: string[] = []
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
    return
  }
  failed++
  console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`)
}
function finding(text: string): void {
  findings.push(text)
  console.log(`  NOTE ${text}`)
}
const fmtBytes = (b: number): string =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`
function printRoutes(title: string, routes: Record<string, RouteStat>): void {
  console.log(`\n  ${title}`)
  const rows = Object.entries(routes).sort((a, b) => b[1].count - a[1].count)
  let c = 0
  let out = 0
  let inn = 0
  let ms = 0
  for (const [k, v] of rows) {
    c += v.count
    out += v.bytesOut
    inn += v.bytesIn
    ms += v.ms
    console.log(
      `    ${k.padEnd(38)} ${String(v.count).padStart(6)} req  avg ${(v.ms / v.count).toFixed(0).padStart(5)} ms  max ${v.maxMs.toFixed(0).padStart(5)} ms  out ${fmtBytes(v.bytesOut).padStart(9)}  in ${fmtBytes(v.bytesIn).padStart(9)}${v.non2xx ? `  non-2xx ${v.non2xx}` : ''}`
    )
  }
  console.log(
    `    ${'TOTAL'.padEnd(38)} ${String(c).padStart(6)} req  sum ${(ms / 1000).toFixed(1)} s   out ${fmtBytes(out)}  in ${fmtBytes(inn)}`
  )
}

async function orchestrate(): Promise<void> {
  process.env.WFC_TEST_RUN = Date.now().toString(36)
  try {
    await rawFetch(BASE)
  } catch {
    console.error(
      `Cannot reach ${BASE}. Start the worker first:\n  cd apps/api && npm run db:migrate:local && npm run dev`
    )
    process.exit(1)
  }
  const apiDir = path.resolve(process.cwd(), '..', 'api')
  const stamp = Date.now().toString(36)
  const PW = 'purge-scale-pass-1'
  const salt = '00112233445566778899aabbccddeeff'
  const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
  const mkUser = (tag: string): string =>
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
     VALUES ('usr_${tag}_${stamp}', '${tag}-${stamp}@wolffi.sh', '${tag}', 'employee', 'active', '${hash}', '${salt}', 0);`
  const sql = [
    `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
     VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4-Flash-0731', '[]');`,
    mkUser('scalea'),
    ...USAGE_ROWS.map(
      (r) =>
        `INSERT INTO usage (user_id, device_id, model, tokens_in, tokens_out, tokens_cached,
           cost_microusd, latency_ms, decision, created_at)
         VALUES ('usr_scalea_${stamp}', '${r.device_id}', '${r.model}', ${r.tokens_in}, ${r.tokens_out},
           ${r.tokens_cached}, ${r.cost_microusd}, 1, '${r.decision}', '${r.created_at}');`
    )
  ].join(' ')
  execSync(`npx wrangler d1 execute wfc-master --local --command "${sql.replace(/"/g, '\\"')}"`, {
    cwd: apiDir,
    stdio: 'pipe'
  })
  const login = await api('/auth/login', {
    body: { email: `scalea-${stamp}@wolffi.sh`, password: PW, device: { platform: 'sim' } }
  })
  const token = login.json?.access_token as string
  const userId = (login.json?.user as { id: string } | undefined)?.id
  if (!token || !userId) {
    console.error('login failed:', login.status, JSON.stringify(login.json))
    process.exit(1)
  }

  const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-purge-scale-'))
  const WORKSPACE = path.join(SANDBOX, '.wfc', 'workspace')
  const runPhase = async (phase: string): Promise<{ code: number; metrics: Metrics | null }> => {
    const metricsPath = path.join(SANDBOX, `metrics-${phase}.json`)
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, `--phase=${phase}`],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: SANDBOX,
          WFC_API_URL: BASE,
          WFC_TEST_TOKEN: token,
          WFC_TEST_USER: userId,
          WFC_METRICS_PATH: metricsPath
        },
        stdio: 'inherit'
      }
    )
    const code = await new Promise<number>((resolve) => {
      const killer = setTimeout(() => {
        console.error(`phase ${phase} timed out — killing`)
        child.kill('SIGKILL')
      }, 45 * 60_000)
      child.on('error', () => {
        clearTimeout(killer)
        resolve(1)
      })
      child.on('exit', (c) => {
        clearTimeout(killer)
        resolve(c ?? 1)
      })
    })
    let m: Metrics | null = null
    try {
      m = JSON.parse(await fs.readFile(metricsPath, 'utf8')) as Metrics
    } catch {
      m = null
    }
    return { code, metrics: m }
  }

  console.log(`\n== purge-cycle SCALE: ${CONV_COUNT} conversations against ${BASE} ==\n`)
  // 1 · Seed.
  console.log('-- phase seed')
  const seed = await runPhase('seed')
  ok('phase seed exits clean', seed.code === 0)
  const seedM = seed.metrics
  if (seedM) {
    console.log(
      `  seed files: ${(seedM.notes.seedFiles as { count: number; bytes: number }).count} files, ${fmtBytes((seedM.notes.seedFiles as { bytes: number }).bytes)}`
    )
    console.log(
      `  save ${CONV_COUNT} conversations to disk: ${(seedM.timers.seedSaveConversationsMs / 1000).toFixed(1)} s`
    )
    console.log(
      `  initial push (everything to the worker): ${(seedM.timers.initialPushMs / 1000).toFixed(1)} s`
    )
    printRoutes('routes — whole seed phase', seedM.routes)
    printRoutes(
      `routes — six turns on c1 (${(seedM.timers.sixTurnsMs / 1000).toFixed(1)} s)`,
      seedM.notes.sixTurnsRoutes as Record<string, RouteStat>
    )
  }
  const idsAfterSeed = await walkConversationIds(token)
  ok(
    `${CONV_COUNT - 1} live conversations on the worker`,
    idsAfterSeed.length === CONV_COUNT - 1,
    String(idsAfterSeed.length)
  )
  const manifestAfterSeed = await walkManifest(token)
  ok(
    'cerebellum-local keys NEVER uploaded',
    !manifestAfterSeed.some((r) => r.name.startsWith('brain/cerebellum/'))
  )
  ok(
    'device-only log NEVER uploaded',
    !manifestAfterSeed.some((r) => r.name === 'logs/2020-01-01.log')
  )
  ok(
    'deleted file gone from manifest',
    !manifestAfterSeed.some((r) => r.name === 'files/temp-note.txt')
  )
  ok(
    'deleted conversation media tombstoned',
    !filesFor(CONV_COUNT).some((f) => manifestAfterSeed.some((r) => r.name === f.rel))
  )
  const c1Records = await walkRecords(token, convId(1))
  const c1Snapshots = c1Records.filter((r) => r.kind === 'snapshot').length
  const c1Messages = c1Records.filter((r) => r.kind === 'message').length
  ok(
    `c1 after ${TURNS_ON_C1} turns carries ONE envelope row (snapshot compaction) + ${c1Messages} message rows`,
    c1Snapshots === 1 &&
      c1Messages === (seedConversation(1) as { messages: unknown[] }).messages.length + TURNS_ON_C1,
    `${c1Records.length} records: ${c1Snapshots} snapshots, ${c1Messages} messages`
  )
  const ledgerRows = manifestAfterSeed.filter((r) => r.name === 'usage/providers/cloud.md').length
  ok('usage ledger never uploaded as a blob', ledgerRows === 0, `${ledgerRows} rows`)
  const totalRows = manifestAfterSeed.length
  const distinctNames = new Set(manifestAfterSeed.map((r) => r.name)).size
  ok(
    `one live manifest row per path (superseding): ${totalRows} rows for ${distinctNames} paths`,
    totalRows === distinctNames
  )
  const turnBatches = (seedM?.notes.sixTurnsRoutes as Record<string, RouteStat> | undefined)?.[
    'POST /v1/sync/batch'
  ]
  if (turnBatches)
    finding(
      `six turns on c1 cost ${turnBatches.count} batch POSTs / ${fmtBytes(turnBatches.bytesOut)} total — incremental (new message + envelope), not the whole transcript each time`
    )

  // 2 · PURGE.
  await fs.rm(path.join(SANDBOX, '.wfc'), { recursive: true, force: true })
  ok('purge really happened', !existsSync(WORKSPACE))

  // 3 · Restore on a fresh install (real boot), then assertions.
  console.log('\n-- phase restore')
  const restore = await runPhase('restore')
  ok('phase restore exits clean', restore.code === 0)
  const rm = restore.metrics
  if (rm) {
    console.log(`  boot path: ${String(rm.notes.bootPath)}`)
    console.log(`  restore (ready → restore_done): ${(rm.timers.restoreMs / 1000).toFixed(1)} s`)
    console.log(`  restored summary: ${JSON.stringify(rm.notes.restoredSummary)}`)
    printRoutes(
      'routes — restore (bootstrap + pages + records + eager blobs)',
      rm.notes.restoreRoutes as Record<string, RouteStat>
    )
    console.log(`  launch sweep after restore: ${(rm.timers.launchSweepMs / 1000).toFixed(1)} s`)
    printRoutes(
      'routes — the launch convergence sweep (same process, right after restore)',
      rm.notes.launchSweepRoutes as Record<string, RouteStat>
    )
    const hyd = rm.notes.hydration as {
      conversations: number
      files: number
      bytes: number
      events: number
      routes: Record<string, RouteStat>
    }
    console.log(
      `  on-open hydration sample: ${hyd.conversations} conversations, ${hyd.files} files, ${fmtBytes(hyd.bytes)}, ${hyd.events} progress events, ${(rm.timers.hydrateSampleMs / 1000).toFixed(1)} s`
    )
    printRoutes('routes — hydration sample', hyd.routes)
    console.log(
      `  second session-ready (lock/unlock): ${(rm.timers.secondReadyMs / 1000).toFixed(1)} s`
    )
    printRoutes(
      'routes — second session-ready in the same process',
      rm.notes.secondReadyRoutes as Record<string, RouteStat>
    )
    const sweepBatches = (rm.notes.launchSweepRoutes as Record<string, RouteStat>)[
      'POST /v1/sync/batch'
    ]
    const secondBatches = (rm.notes.secondReadyRoutes as Record<string, RouteStat>)[
      'POST /v1/sync/batch'
    ]
    ok(
      'launch sweep after restore pushed no transcripts (restored ones are memoized as on the server)',
      !sweepBatches || sweepBatches.count === 0,
      sweepBatches
        ? `${sweepBatches.count} batches / ${fmtBytes(sweepBatches.bytesOut)}`
        : undefined
    )
    ok(
      'a second session-ready (lock→unlock) pushed nothing',
      !secondBatches,
      secondBatches
        ? `${secondBatches.count} batches / ${fmtBytes(secondBatches.bytesOut)}`
        : undefined
    )
    const recGet = (rm.notes.restoreRoutes as Record<string, RouteStat>)[
      'GET /v1/conversations/:id/records'
    ]
    if (recGet)
      finding(
        `restore pulled ${recGet.count} record pages concurrently in ${(rm.timers.restoreMs / 1000).toFixed(1)} s locally (avg ${(recGet.ms / recGet.count).toFixed(0)} ms each)`
      )
  }

  const read = (rel: string): Promise<Buffer> => fs.readFile(path.join(WORKSPACE, rel))
  const cfg = JSON.parse((await read('config.json')).toString()) as Record<string, unknown>
  ok(
    'config restored (variables, mobile prefs, model, theme)',
    cfg.theme === 'dark' &&
      (cfg.variables as Array<{ value: string }>)?.[0]?.value === 'sk-live-999' &&
      (cfg.mobile as { verbose: boolean })?.verbose === true &&
      cfg.onboardingCompleted === true
  )

  // The LLM ledger is the org's record — rebuilt from the seeded usage rows,
  // never restored from (or clobbered by) a device's blob.
  const ledger = await read('usage/providers/cloud.md').catch(() => null)
  ok(
    'usage ledger rebuilt from the org usage table (every device, denials excluded)',
    ledger !== null && ledger.toString() === expectedLedgerText(),
    ledger ? JSON.stringify(ledger.toString().slice(0, 240)) : 'absent'
  )

  // Eager files: everything not lazy, minus the deleted one, auth keys and
  // the device-local ledger.
  let eagerOk = 0
  const eagerMissing: string[] = []
  const eagerWrong: string[] = []
  const eagerWant = new Map<string, Buffer>()
  for (const [rel, content] of brainSeedFiles())
    if (
      rel !== 'files/temp-note.txt' &&
      !rel.startsWith('brain/cerebellum/') &&
      !rel.startsWith('usage/')
    )
      eagerWant.set(rel, Buffer.from(content))
  for (let n = 1; n < CONV_COUNT; n++)
    for (const f of filesFor(n)) if (!f.lazy) eagerWant.set(f.rel, f.bytes)
  for (const [rel, want] of eagerWant) {
    if (DEFAULT_COLLIDING.includes(rel)) continue // asserted separately below
    let got: Buffer | null = null
    try {
      got = await read(rel)
    } catch {
      got = null
    }
    if (!got) eagerMissing.push(rel)
    else if (!got.equals(want)) eagerWrong.push(rel)
    else eagerOk++
  }
  ok(
    `every non-colliding eager file restored byte-exact (${eagerOk}/${eagerWant.size - DEFAULT_COLLIDING.length})`,
    eagerMissing.length === 0 && eagerWrong.length === 0,
    `missing ${eagerMissing.length} (${eagerMissing.slice(0, 3).join(', ')}) wrong ${eagerWrong.length} (${eagerWrong.slice(0, 3).join(', ')})`
  )
  ok('deleted file stayed deleted', !existsSync(path.join(WORKSPACE, 'files/temp-note.txt')))
  ok(
    'cerebellum-local keys NOT restored',
    !existsSync(path.join(WORKSPACE, 'brain/cerebellum/.local/creds.json'))
  )
  ok('device-only log NOT restored', !existsSync(path.join(WORKSPACE, 'logs/2020-01-01.log')))

  // The default-colliding paths: did the USER's versions come back, and what
  // does the server hold for them after the launch sweep?
  const manifestAfterRestore = await walkManifest(token)
  const newestSha = (name: string): string | null =>
    manifestAfterRestore.find((r) => r.name === name)?.sha256 ?? null
  const seedByRel = new Map(brainSeedFiles())
  for (const rel of DEFAULT_COLLIDING) {
    const want = sha256(seedByRel.get(rel)!)
    let gotSha = 'absent'
    try {
      gotSha = sha256(await read(rel))
    } catch {
      gotSha = 'absent'
    }
    const localBack = gotSha === want
    ok(
      `user's ${rel} restored on disk`,
      localBack,
      `disk holds ${gotSha === 'absent' ? 'nothing' : gotSha === (rm?.notes.preSeededByBoot as Record<string, string>)?.[rel] ? 'the BUNDLED DEFAULT the boot pre-seeded' : 'other content'}`
    )
    const serverSha = newestSha(rel)
    ok(
      `server's newest row for ${rel} is still the user's version`,
      serverSha === want,
      serverSha === (rm?.notes.preSeededByBoot as Record<string, string>)?.[rel]
        ? 'the launch sweep pushed the BUNDLED DEFAULT over it'
        : String(serverSha)
    )
  }

  // Transcripts: all surviving conversations exact (n=82 is lossy by design).
  const convDirPath = path.join(WORKSPACE, 'brain', 'conversations')
  const convFiles = (await fs.readdir(convDirPath)).filter((f) => f.endsWith('.json'))
  ok(
    `${CONV_COUNT - 1} of ${CONV_COUNT} conversations restored`,
    convFiles.length === CONV_COUNT - 1,
    String(convFiles.length)
  )
  ok(
    'deleted conversation not restored',
    !existsSync(path.join(convDirPath, `${convDir(CONV_COUNT)}.json`))
  )
  let exact = 0
  const mismatches: string[] = []
  let overflowNote: string | null = null
  for (let n = 1; n < CONV_COUNT; n++) {
    try {
      const file = JSON.parse(
        (await read(`brain/conversations/${convDir(n)}.json`)).toString()
      ) as {
        title: string
        model: string | null
        channel?: string
        messages: Array<{
          id?: string
          content: string
          role: string
          attachments?: Array<{ filePath: string; sha256?: string }>
          voicePrompt?: boolean
        }>
      }
      const want = seedConversation(n) as {
        title: string
        channel?: string
        messages: Array<{
          id: string
          content: string
          role: string
          attachments?: SeedAttachment[]
          voicePrompt?: boolean
        }>
      }
      const extra = n === 1 ? TURNS_ON_C1 : 0
      let good =
        file.title === want.title &&
        file.model === 'deepseek-ai/DeepSeek-V4-Flash-0731' &&
        file.channel === want.channel &&
        file.messages.length === want.messages.length + extra
      for (let i = 0; good && i < want.messages.length; i++) {
        const g = file.messages[i]
        const w = want.messages[i]
        if (n === 82 && i === 1) {
          // Over the record ceiling: the engine SPILLS the whole message to a
          // content-addressed blob and the record carries a pointer, so a
          // restore gets every character back. It used to ship half the text
          // plus a marker — the one lossy path in the sync engine, and the
          // reason this branch exists at all.
          const gm = g as
            | (typeof g & { syncTruncated?: boolean; syncOverflow?: unknown })
            | undefined
          if (!gm || gm.content !== w.content || gm.syncTruncated === true) good = false
          // And the pointer is gone once the body is back — a restored
          // message must not still claim it lives somewhere else.
          if (gm?.syncOverflow !== undefined) good = false
          overflowNote =
            `c82 message 2 (${w.content.length.toLocaleString('en-US')} chars, past the ${MAX_RECORD_BYTES.toLocaleString('en-US')}-byte record ceiling) ` +
            `spilled to a blob and restored ${gm?.content === w.content ? 'byte-exact' : 'WRONG'}`
          continue
        }
        if (g?.id !== w.id || g?.content !== w.content || g?.role !== w.role) good = false
        if ((w.attachments?.length ?? 0) !== (g?.attachments?.length ?? 0)) good = false
        for (const [j, a] of (w.attachments ?? []).entries()) {
          if (g?.attachments?.[j]?.filePath !== a.filePath || !g?.attachments?.[j]?.sha256)
            good = false
        }
        if (Boolean(w.voicePrompt) !== Boolean(g?.voicePrompt)) good = false
      }
      if (good) exact++
      else mismatches.push(convId(n))
    } catch (err) {
      mismatches.push(`${convId(n)} (${String(err).slice(0, 60)})`)
    }
  }
  ok(
    `every restored transcript exact — title, model, channel, ids, contents, order, attachment paths + shas, voice flags (${exact}/${CONV_COUNT - 1})`,
    exact === CONV_COUNT - 1,
    mismatches.slice(0, 5).join(', ')
  )
  if (overflowNote) finding(overflowNote)
  const c1 = JSON.parse((await read(`brain/conversations/${convDir(1)}.json`)).toString()) as {
    messages: Array<{ id?: string }>
    stats?: { allTime?: { turns?: number } }
  }
  ok(
    'c1 carries the six appended turns and the newest envelope',
    c1.messages.slice(-TURNS_ON_C1).every((m, i) => m.id === `m_${convId(1)}_turn${i + 1}`) &&
      c1.stats?.allTime?.turns === TURNS_ON_C1
  )
  ok(
    'lazy media rows still live after hydration + sweeps',
    expectedLazyNames()
      .filter((rel) => !filesFor(CONV_COUNT).some((f) => f.rel === rel))
      .every((rel) => manifestAfterRestore.some((r) => r.name === rel))
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (findings.length) {
    console.log('\nfindings:')
    for (const f of findings) console.log(`  - ${f}`)
  }
  console.log(`\nsandbox kept at ${SANDBOX}`)
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
