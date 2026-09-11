/**
 * Shared fixtures for the purge-cycle simulations — one source of truth for
 * what a "lived-in workspace" contains and for what a complete restore must
 * put back, so the fake-server test (purge-cycle.test.ts) and the real-API
 * test (purge-cycle-live.test.ts) can never drift apart in what they prove.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { providerLedgerLine } from '@main/runtime/usage'

export const sha256 = (buf: Buffer | string): string =>
  createHash('sha256').update(buf).digest('hex')
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function until(cond: () => Promise<boolean> | boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(100)
  }
  return cond()
}

// ── The lived-in workspace ───────────────────────────────────────────────

export const CONFIG_A = {
  version: 1,
  onboardingCompleted: true,
  theme: 'dark',
  locale: 'en',
  llm: { model: 'm-test' },
  variables: [{ name: 'SECRET', value: 'sk-live-999', sensitive: true }],
  mobile: { notifications: true, verbose: true }
}

export const ATTACHMENT_BYTES = Buffer.from('attachment-payload-' + 'x'.repeat(64))
export const VOICE_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 7, 7, 7])
export const SPEECH_BYTES = Buffer.from('ID3-tts-reply-' + 'y'.repeat(48))
export const DUP_CONTENT = 'identical-content-at-two-paths\n'

/** Per-run id tag so live runs against a PERSISTENT local D1 never collide
 *  with a previous run's (differently-owned) conversation ids. Production
 *  ids are timestamp+random, so collision is a test-only concern — and the
 *  first collision usefully proved the server's cross-user write refusal.
 *  Read lazily: orchestrators set it before the first use and children
 *  inherit it via env. */
const runTag = (): string => process.env.WFC_TEST_RUN ?? ''
export const convId = (n: number): string => `c${runTag()}n${n}`
/** Matches conversations.ts conversationDirName for our safe ids. */
export const convDir = (n: number): string => `conv-${convId(n)}`
export const BASE_TS = 1_756_000_000_000

/** Workspace files restored EAGERLY (config/transcripts/brain/deliverables
 *  world). Computed lazily — paths depend on the per-run id tag. */
export function eagerSeedFiles(): Array<[string, Buffer | string]> {
  return [
    ['files/report.md', '# Q3 report\nnumbers.\n'],
    ['files/dup-a.txt', DUP_CONTENT],
    ['brain/notes/dup-b.txt', DUP_CONTENT],
    ['files/empty.marker', ''],
    ['files/temp-note.txt', 'to be deleted\n'],
    ['brain/hippocampus/knowledge/fact.md', 'The user prefers dark mode.\n'],
    // Paths the BUNDLED DEFAULTS also ship. A fresh install's boot lays the
    // defaults down before restore can run; restore must still bring the
    // user's versions back — and never push the defaults over them.
    ['brain/identity/soul.md', '# Soul — customized\n\nDry humor, terse, cites sources.\n'],
    ['brain/brainstem/heartbeat.md', '# Heartbeat\n\n## Daily digest\n- schedule: 0 7 * * *\n'],
    ['brain/hippocampus/knowledge/preferences.md', '# Preferences\n\n- Dark mode.\n'],
    ['brain/channels/chats.json', '{"123":"c2"}'],
    ['brain/cerebellum/.local/creds.json', '{"secret":"device-local-keys"}'],
    ['logs/extension/c-trail.jsonl', '{"t":1,"kind":"navigate","url":"https://example.com"}\n']
  ]
}

/** The device-local LLM ledger a lived-in workspace carries. It is NOT a
 *  synced blob: after a purge the ledger is rebuilt from the org's usage
 *  table (USAGE_ROWS), so these are seeded but never expected back
 *  byte-for-byte. */
export function deviceLedgerSeedFiles(): Array<[string, string]> {
  return [
    [
      'usage/providers/cloud.md',
      '# Wolffish Cloud\n\n## 2026-09-01\n\n- 2026-09-01 10:00:00 | m-test | in:10 out:20 cw:5 cr:2 | $0.000123\n'
    ],
    [
      'usage/daily/2026-09-01.md',
      '# 2026-09-01\n\n- 10:00:00 | Wolffish Cloud | m-test | in:10 out:20 cw:5 cr:2 | $0.000123\n'
    ]
  ]
}

/** The org's usage rows for this user, as GET /v1/usage serves them: two
 *  spends from another device plus a denial that must never become a
 *  ledger line. Live tests insert exactly these into D1. */
export const USAGE_ROWS = [
  {
    device_id: 'dev_other',
    model: 'm-test',
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cached: 300,
    cost_microusd: 1234,
    decision: 'allowed',
    created_at: '2026-08-30T07:00:00.000Z'
  },
  {
    device_id: 'dev_other',
    model: 'm-test',
    tokens_in: 10,
    tokens_out: 20,
    tokens_cached: 0,
    cost_microusd: 123,
    decision: 'allowed',
    created_at: '2026-09-01T10:00:00.000Z'
  },
  {
    device_id: 'dev_other',
    model: 'm-test',
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    cost_microusd: 0,
    decision: 'denied_quota',
    created_at: '2026-09-01T11:00:00.000Z'
  }
]

/** The ledger a restore must rebuild from USAGE_ROWS — laid out exactly as
 *  the engine's rewriteLedger lays it out (one date section per day). */
export function expectedLedgerText(): string {
  const spend = USAGE_ROWS.filter((r) => r.decision === 'allowed' && r.tokens_in + r.tokens_out > 0)
  let text = '# Wolffish Cloud\n'
  let current: string | null = null
  for (const r of spend) {
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

/** Files that must NEVER sync: device-local by design (rotating app logs,
 *  device keys are covered separately via brain/cerebellum/.local). */
export function deviceOnlySeedFiles(): Array<[string, string]> {
  // A dated name the RUNNING engine will never write itself (wlog writes
  // logs/<today>.log) — existence after restore is then a valid probe.
  return [['logs/2020-01-01.log', 'rotating app log — device only\n']]
}

/** The variable the secrets-capability simulation appends OUT-OF-BAND
 *  (writing config.json directly, no hook) — the sync engine must still
 *  push it. */
export const OOB_VARIABLE = { name: 'OOB_SECRET', value: 'sk-oob-777', sensitive: true }

/** Conversation media — NOT restored eagerly; hydrates on conversation
 *  open with progress. data.bin and the voice note ride message
 *  attachments; the TTS reply is directory-discovered (no attachment). */
export function lazyMediaSeedFiles(): Array<[string, Buffer]> {
  return [
    [`uploads/${convDir(1)}/data.bin`, ATTACHMENT_BYTES],
    [`speech/${convDir(1)}/reply.mp3`, SPEECH_BYTES],
    [`voice/${convDir(2)}/note.webm`, VOICE_BYTES]
  ]
}

export function seedFiles(): Array<[string, Buffer | string]> {
  return [...eagerSeedFiles(), ...lazyMediaSeedFiles()]
}

/** Everything that must be back after restore + hydration: every seeded
 *  file except the deleted one and the excluded cerebellum dir. */
export function restoredFiles(): Array<[string, Buffer | string]> {
  return seedFiles().filter(
    ([name]) => name !== 'files/temp-note.txt' && !name.startsWith('brain/cerebellum/')
  )
}

export function seedConversation(n: number): Record<string, unknown> {
  const id = convId(n)
  const many = n === 1
  const count = many ? 6 : 2
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m_${id}_${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${id} message ${i + 1}`,
    timestamp: BASE_TS + n * 10_000 + i * 1000,
    ...(many && i === 0
      ? {
          attachments: [
            {
              type: 'other',
              filePath: `uploads/${convDir(1)}/data.bin`,
              originalName: 'data.bin',
              mimeType: 'application/octet-stream',
              sizeBytes: ATTACHMENT_BYTES.byteLength
            }
          ]
        }
      : {}),
    ...(n === 2 && i === 0
      ? {
          voicePrompt: true,
          attachments: [
            {
              type: 'audio',
              filePath: `voice/${convDir(2)}/note.webm`,
              originalName: 'note.webm',
              mimeType: 'audio/webm',
              sizeBytes: VOICE_BYTES.byteLength
            }
          ]
        }
      : {})
  }))
  return {
    id,
    title: `Conversation ${n}`,
    model: 'm-test',
    messages,
    createdAt: BASE_TS + n * 10_000,
    updatedAt: BASE_TS + n * 10_000 + count * 1000
  }
}

/** Materialize CONFIG_A + SEED_FILES into a workspace directory. */
export async function writeSeedWorkspace(workspace: string): Promise<void> {
  await fs.mkdir(path.join(workspace, 'brain', 'conversations'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'config.json'), JSON.stringify(CONFIG_A, null, 2))
  for (const [rel, content] of [
    ...seedFiles(),
    ...deviceOnlySeedFiles(),
    ...deviceLedgerSeedFiles()
  ]) {
    const abs = path.join(workspace, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
}

// ── What a complete restore must look like on disk ───────────────────────

export type Check = (label: string, cond: boolean, detail?: string) => void

/**
 * Assert the restored workspace against the seed, conversation by
 * conversation and byte by byte: config values, every surviving file,
 * every transcript (title, model, message ids, contents, order), the
 * attachment bytes — and that the DELETED conversation and file stayed
 * deleted, and the excluded cerebellum-local keys never came back.
 * `convCount` is the seeded total; conversation `convCount` is the deleted
 * one.
 */
export async function assertRestoredWorkspace(
  ok: Check,
  workspace: string,
  convCount: number,
  expectedConfig: Record<string, unknown> = CONFIG_A
): Promise<void> {
  const read = (rel: string): Promise<Buffer> => fs.readFile(path.join(workspace, rel))

  const restoredCfg = JSON.parse((await read('config.json')).toString()) as Record<string, unknown>
  ok(
    'config restored byte-for-byte (values)',
    isDeepStrictEqual(restoredCfg, expectedConfig),
    JSON.stringify(restoredCfg)
  )
  for (const [rel, content] of restoredFiles()) {
    const want = Buffer.isBuffer(content) ? content : Buffer.from(content)
    let got: Buffer | null = null
    try {
      got = await read(rel)
    } catch {
      got = null
    }
    ok(`file restored: ${rel}`, got !== null && got.equals(want))
  }
  ok('deleted file stayed deleted', !existsSync(path.join(workspace, 'files/temp-note.txt')))
  ok(
    'cerebellum-local keys NOT restored',
    !existsSync(path.join(workspace, 'brain/cerebellum/.local/creds.json'))
  )
  // The LLM ledger is the org's record: rebuilt from the usage table, not
  // restored from (or clobbered by) any device's blob.
  const ledger = await read('usage/providers/cloud.md').catch(() => null)
  ok(
    'usage ledger rebuilt from the org usage table',
    ledger !== null && ledger.toString() === expectedLedgerText(),
    ledger ? JSON.stringify(ledger.toString().slice(0, 240)) : 'absent'
  )
  ok(
    'usage ledger never uploaded as a blob',
    true // asserted server-side by each orchestrator (manifest has no usage/providers/cloud.md)
  )
  for (const [rel] of deviceOnlySeedFiles()) {
    ok(`device-only file NOT restored: ${rel}`, !existsSync(path.join(workspace, rel)))
  }

  const conversationsDir = path.join(workspace, 'brain', 'conversations')
  const convFiles = (await fs.readdir(conversationsDir)).filter((f) => f.endsWith('.json'))
  ok(
    `${convCount - 1} of ${convCount} conversations restored (deleted one stayed gone)`,
    convFiles.length === convCount - 1,
    String(convFiles.length)
  )
  ok(
    'deleted conversation not restored',
    !existsSync(path.join(conversationsDir, `conv-${convId(convCount)}.json`))
  )
  let transcriptsExact = 0
  for (let n = 1; n < convCount; n++) {
    try {
      const file = JSON.parse(
        (await read(`brain/conversations/conv-${convId(n)}.json`)).toString()
      ) as {
        title: string
        model: string | null
        messages: Array<{ id?: string; content: string; role: string }>
      }
      const want = seedConversation(n) as {
        title: string
        messages: Array<{ id: string; content: string; role: string }>
      }
      const messagesMatch =
        file.messages.length === want.messages.length &&
        want.messages.every(
          (m, i) =>
            file.messages[i]?.id === m.id &&
            file.messages[i]?.content === m.content &&
            file.messages[i]?.role === m.role
        )
      if (file.title === want.title && file.model === 'm-test' && messagesMatch) transcriptsExact++
      else
        console.error(
          `transcript mismatch ${convId(n)}: title=${file.title} model=${file.model} got=${JSON.stringify(
            file.messages.map((m) => m.id)
          )} want=${JSON.stringify(want.messages.map((m) => m.id))}`
        )
    } catch (err) {
      console.error(`transcript read failed ${convId(n)}:`, err)
    }
  }
  ok(
    'every restored transcript exact (title, model, ids, contents, order)',
    transcriptsExact === convCount - 1,
    String(transcriptsExact)
  )
  ok(
    'attachment bytes round-tripped',
    (await read(`uploads/${convDir(1)}/data.bin`).catch(() => Buffer.alloc(0))).equals(
      ATTACHMENT_BYTES
    )
  )
}

// ── On-open hydration: the shared in-phase verifier ──────────────────────

type HydrationEvent = {
  conversationId: string
  filesTotal: number
  filesDone: number
  totalBytes: number
  doneBytes: number
  failed: number
  done: boolean
}

/**
 * The lazy-media contract, verified from inside a phase process that has
 * the real sync module loaded (both the fake-server and live-API tests run
 * this identical block):
 *   1. after restore, NO conversation media is on disk;
 *   2. hydrating c1 downloads exactly its two files (attachment +
 *      directory-discovered TTS reply) with sane streamed progress —
 *      known totals, monotonic bytes, terminal done event;
 *   3. hydrating c1 again is a no-op (nothing to download);
 *   4. hydrating c2 lands the voice note;
 *   5. every media byte round-trips exactly.
 */
export async function verifyLazyHydration(opts: {
  hydrate: (conversationId: string) => Promise<HydrationEvent>
  events: HydrationEvent[]
  workspace: string
  fail: (msg: string) => never
}): Promise<void> {
  const { hydrate, events, workspace, fail } = opts
  const lazy = lazyMediaSeedFiles()

  for (const [rel] of lazy) {
    if (existsSync(path.join(workspace, rel))) {
      fail(`lazy media was predownloaded at restore: ${rel}`)
    }
  }

  const c1 = await hydrate(convId(1))
  const c1Bytes = ATTACHMENT_BYTES.byteLength + SPEECH_BYTES.byteLength
  if (!(c1.done && c1.failed === 0 && c1.filesTotal === 2 && c1.filesDone === 2)) {
    fail(`c1 hydration summary wrong: ${JSON.stringify(c1)}`)
  }
  if (c1.totalBytes !== c1Bytes || c1.doneBytes !== c1Bytes) {
    fail(`c1 hydration byte totals wrong: ${JSON.stringify(c1)} want ${c1Bytes}`)
  }
  const c1Events = events.filter((e) => e.conversationId === convId(1))
  if (c1Events.length < 3) fail(`too few c1 progress events: ${c1Events.length}`)
  let prevBytes = -1
  let prevFiles = -1
  for (const e of c1Events) {
    if (e.doneBytes < prevBytes || e.filesDone < prevFiles) {
      fail(`progress went backwards: ${JSON.stringify(c1Events)}`)
    }
    prevBytes = e.doneBytes
    prevFiles = e.filesDone
    if (e.totalBytes !== c1Bytes || e.filesTotal !== 2) {
      fail(`progress event lost its totals: ${JSON.stringify(e)}`)
    }
  }
  if (!c1Events[c1Events.length - 1]!.done) fail('no terminal done event for c1')

  const again = await hydrate(convId(1))
  if (!(again.done && again.filesTotal === 0 && again.doneBytes === 0)) {
    fail(`re-hydration was not a no-op: ${JSON.stringify(again)}`)
  }

  const c2 = await hydrate(convId(2))
  if (!(c2.done && c2.failed === 0 && c2.filesTotal === 1)) {
    fail(`c2 hydration summary wrong: ${JSON.stringify(c2)}`)
  }

  for (const [rel, content] of lazy) {
    const got = await fs.readFile(path.join(workspace, rel)).catch(() => null)
    if (!got || !got.equals(content)) fail(`hydrated media wrong or missing: ${rel}`)
  }
}
