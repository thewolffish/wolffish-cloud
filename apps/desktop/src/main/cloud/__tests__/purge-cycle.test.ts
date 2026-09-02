/**
 * Purge-cycle simulation — the "is ~/.wfc really just a cache?" test, end
 * to end through the REAL sync engine and REAL process boundaries:
 *
 *   phase seed          device A: a lived-in workspace (config with
 *                       secrets, 13 conversations — one with 6 messages
 *                       and an attachment — deliverables, brain files, a
 *                       voice note, duplicate-content files at two paths,
 *                       an empty marker file, WhatsApp state) syncs up.
 *                       Then the user deletes a conversation and a file,
 *                       and the tombstones land.
 *   PURGE               rm -rf of the whole ~/.wfc, process dead.
 *   phase restore-flaky a fresh install signs in; the FIRST bootstrap
 *                       call fails (injected 500). The old bugs would
 *                       have (a) pushed the default config over the real
 *                       one and (b) never restored. Asserted instead:
 *                       the stampless guard ADOPTS the server config,
 *                       the server row is never clobbered, and the next
 *                       session flow completes the restore fully.
 *   disk assertions     every conversation, file, config byte is back —
 *                       and the DELETED conversation and file stayed
 *                       deleted. whatsapp/auth (device keys) did not
 *                       sync. Pagination was actually exercised (the
 *                       fake serves pages of 5/4/3).
 *   phase foreign       a different user signs in over the restored
 *                       workspace: the ownership guard fires and NOT ONE
 *                       write reaches the server under their token.
 *
 * The server is an in-process fake implementing the v1 sync contract
 * (paged bootstrap/index/manifest/records, content-addressed upsert
 * uploads, tombstones); each phase is a separate child process with the
 * usual electron/session shims, real fetch over localhost, and the REAL
 * sync/conversations/workspace modules.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/purge-cycle.test.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  CONFIG_A,
  OOB_VARIABLE,
  USAGE_ROWS,
  assertRestoredWorkspace,
  convId,
  deviceOnlySeedFiles,
  eagerSeedFiles,
  lazyMediaSeedFiles,
  seedConversation,
  sha256,
  sleep,
  until,
  verifyLazyHydration,
  writeSeedWorkspace
} from './purge-fixtures'

const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length) ?? null

const CONV_COUNT = 13

// ── The fake server (orchestrator process) ───────────────────────────────

const CONV_PAGE = 5
const FILES_PAGE = 4
const REC_PAGE = 3

type FileRow = {
  sha256: string
  name: string
  mime: string
  size: number
  seq: number
  deleted_at: string | null
}

type ServerState = {
  config: unknown
  configStamp: string | null
  stampSeq: number
  conversations: Map<
    string,
    {
      id: string
      title: string
      created_at: string
      updated_at: string
      deleted_at: string | null
      rowid: number
    }
  >
  convSeq: number
  records: Map<
    string,
    Array<{
      rowid: number
      id: string
      seq: number
      kind: string
      content: unknown
      created_at: string
    }>
  >
  recSeq: number
  files: Map<string, FileRow>
  fileSeq: number
  blobs: Map<string, Buffer>
  failBootstrap: number
  tokens: { batch: string[]; upload: string[]; configPut: string[]; wipe: string[] }
  calls: {
    bootstrap: number
    convPages: number
    manifestPages: number
    recordPages: number
    usagePages: number
  }
}

function newServerState(): ServerState {
  return {
    config: null,
    configStamp: null,
    stampSeq: 0,
    conversations: new Map(),
    convSeq: 0,
    records: new Map(),
    recSeq: 0,
    files: new Map(),
    fileSeq: 0,
    blobs: new Map(),
    failBootstrap: 0,
    tokens: { batch: [], upload: [], configPut: [], wipe: [] },
    calls: { bootstrap: 0, convPages: 0, manifestPages: 0, recordPages: 0, usagePages: 0 }
  }
}

function liveConversations(
  s: ServerState
): Array<{ id: string; title: string; created_at: string; updated_at: string; rowid: number }> {
  return [...s.conversations.values()]
    .filter((c) => !c.deleted_at)
    .sort((a, b) => a.rowid - b.rowid)
    .map((c) => ({
      id: c.id,
      title: c.title,
      created_at: c.created_at,
      updated_at: c.updated_at,
      rowid: c.rowid
    }))
}

function liveFiles(s: ServerState): FileRow[] {
  return [...s.files.values()].filter((f) => !f.deleted_at).sort((a, b) => b.seq - a.seq)
}

function startServer(state: ServerState): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://x')
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const send = (status: number, payload: unknown): void => {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
        res.writeHead(status, {
          'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json'
        })
        res.end(buf)
      }
      const route = `${req.method} ${url.pathname}`
      const nowIso = new Date().toISOString()
      try {
        if (route === 'GET /__state') {
          return send(200, {
            configStamp: state.configStamp,
            config: state.config,
            conversationCount: liveConversations(state).length,
            tombstoned: [...state.conversations.values()]
              .filter((c) => c.deleted_at)
              .map((c) => c.id),
            fileNames: liveFiles(state).map((f) => f.name),
            deletedFiles: [...state.files.values()].filter((f) => f.deleted_at).map((f) => f.name),
            recordCounts: Object.fromEntries(
              [...state.records.entries()].map(([k, v]) => [k, v.length])
            ),
            tokens: state.tokens,
            calls: state.calls
          })
        }
        if (route === 'GET /v1/sync/bootstrap') {
          state.calls.bootstrap++
          if (state.failBootstrap > 0) {
            state.failBootstrap--
            return send(500, { error: 'injected_bootstrap_failure' })
          }
          const convs = liveConversations(state)
          const convPage = convs.slice(0, CONV_PAGE)
          const files = liveFiles(state)
          const filePage = files.slice(0, FILES_PAGE)
          return send(200, {
            config: state.config ?? {},
            config_updated_at: state.configStamp,
            conversations: convPage.map((c) => ({
              id: c.id,
              title: c.title,
              created_at: c.created_at,
              updated_at: c.updated_at
            })),
            conversations_next:
              convs.length > convPage.length ? convPage[convPage.length - 1]!.rowid : null,
            files: filePage.map((f) => ({
              sha256: f.sha256,
              name: f.name,
              mime: f.mime,
              size: f.size
            })),
            files_next:
              files.length > filePage.length ? String(filePage[filePage.length - 1]!.seq) : null
          })
        }
        if (route === 'GET /v1/conversations') {
          state.calls.convPages++
          const after = parseInt(url.searchParams.get('after') ?? '0', 10) || 0
          const all = liveConversations(state).filter((c) => c.rowid > after)
          const page = all.slice(0, CONV_PAGE)
          return send(200, {
            conversations: page.map((c) => ({
              id: c.id,
              title: c.title,
              created_at: c.created_at,
              updated_at: c.updated_at
            })),
            next: all.length > page.length ? page[page.length - 1]!.rowid : null
          })
        }
        const recordsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/records$/)
        if (req.method === 'GET' && recordsMatch) {
          state.calls.recordPages++
          const after = parseInt(url.searchParams.get('after') ?? '0', 10) || 0
          const rows = (state.records.get(decodeURIComponent(recordsMatch[1]!)) ?? []).filter(
            (r) => r.rowid > after
          )
          const page = rows.slice(0, REC_PAGE)
          return send(200, {
            records: page.map((r) => ({
              id: r.id,
              seq: r.seq,
              kind: r.kind,
              content: r.content,
              created_at: r.created_at
            })),
            next_after: rows.length > page.length ? page[page.length - 1]!.rowid : null
          })
        }
        const delMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/)
        if (req.method === 'DELETE' && delMatch) {
          const row = state.conversations.get(decodeURIComponent(delMatch[1]!))
          if (row && !row.deleted_at) row.deleted_at = nowIso
          return send(200, { ok: true, deleted: Boolean(row) })
        }
        if (route === 'GET /v1/config') {
          return send(200, { config: state.config, updated_at: state.configStamp })
        }
        if (route === 'PUT /v1/config') {
          state.tokens.configPut.push(token)
          state.config = (JSON.parse(body.toString()) as { config: unknown }).config
          state.configStamp = `srv-${++state.stampSeq}`
          return send(200, { ok: true, updated_at: state.configStamp })
        }
        if (route === 'POST /v1/sync/batch') {
          state.tokens.batch.push(token)
          const items = (JSON.parse(body.toString()) as { items: Array<Record<string, unknown>> })
            .items
          let accepted = 0
          let ignored = 0
          for (const item of items) {
            if (item.type === 'conversation') {
              const id = String(item.id)
              const prev = state.conversations.get(id)
              if (!prev) {
                state.conversations.set(id, {
                  id,
                  title: String(item.title ?? ''),
                  created_at: String(item.created_at),
                  updated_at: String(item.updated_at),
                  deleted_at: null,
                  rowid: ++state.convSeq
                })
                accepted++
              } else if (String(item.updated_at) > prev.updated_at) {
                prev.title = String(item.title ?? '')
                prev.updated_at = String(item.updated_at)
                accepted++
              } else ignored++
            } else if (item.type === 'record') {
              const convId2 = String(item.conversation_id)
              const rows = state.records.get(convId2) ?? []
              const kind = String(item.kind ?? 'message')
              if (kind === 'snapshot') {
                // Mirror the server: one envelope per conversation — upsert
                // by id (newer seq wins), retire every other snapshot row.
                const existing = rows.find((r) => r.id === item.id)
                if (existing) {
                  if (Number(item.seq) >= existing.seq) {
                    existing.seq = Number(item.seq)
                    existing.content = item.content
                    existing.created_at = String(item.created_at)
                    accepted++
                  } else ignored++
                } else {
                  rows.push({
                    rowid: ++state.recSeq,
                    id: String(item.id),
                    seq: Number(item.seq),
                    kind,
                    content: item.content,
                    created_at: String(item.created_at)
                  })
                  accepted++
                }
                state.records.set(
                  convId2,
                  rows.filter(
                    (r) => !(r.kind === 'snapshot' && r.id !== item.id && r.seq <= Number(item.seq))
                  )
                )
              } else if (rows.some((r) => r.id === item.id)) ignored++
              else {
                rows.push({
                  rowid: ++state.recSeq,
                  id: String(item.id),
                  seq: Number(item.seq),
                  kind,
                  content: item.content,
                  created_at: String(item.created_at)
                })
                state.records.set(convId2, rows)
                accepted++
              }
            } else ignored++
          }
          return send(200, { ok: true, accepted, ignored, rejected: 0 })
        }
        if (route === 'GET /v1/usage') {
          state.calls.usagePages++
          const after = parseInt(url.searchParams.get('after') ?? '0', 10) || 0
          const rows = USAGE_ROWS.map((r, i) => ({ id: i + 1, ...r })).filter((r) => r.id > after)
          return send(200, { rows, next: null })
        }
        if (route === 'POST /v1/files/upload') {
          state.tokens.upload.push(token)
          const sha = (url.searchParams.get('sha256') ?? '').toLowerCase()
          const name = url.searchParams.get('name') ?? 'unnamed'
          if (sha256(body) !== sha) return send(400, { error: 'hash_mismatch' })
          state.blobs.set(sha, body)
          const key = `${sha}|${name}`
          state.files.set(key, {
            sha256: sha,
            name,
            mime: url.searchParams.get('mime') ?? 'application/octet-stream',
            size: body.byteLength,
            seq: ++state.fileSeq,
            deleted_at: null
          })
          // Mirror the server: this content supersedes the path's older rows.
          for (const [k, row] of state.files) {
            if (k !== key && row.name === name && !row.deleted_at) row.deleted_at = nowIso
          }
          return send(200, {
            file_id: `fil_${state.fileSeq}`,
            sha256: sha,
            size: body.byteLength,
            deduped: false
          })
        }
        if (route === 'GET /v1/files/manifest') {
          state.calls.manifestPages++
          const before = parseInt(url.searchParams.get('before') ?? '', 10)
          const all = liveFiles(state).filter((f) =>
            Number.isFinite(before) ? f.seq < before : true
          )
          const page = all.slice(0, FILES_PAGE)
          return send(200, {
            files: page.map((f) => ({
              sha256: f.sha256,
              name: f.name,
              mime: f.mime,
              size: f.size
            })),
            next: all.length > page.length ? String(page[page.length - 1]!.seq) : null
          })
        }
        if (route === 'POST /v1/files/delete') {
          const names = new Set((JSON.parse(body.toString()) as { names: string[] }).names)
          let deleted = 0
          for (const row of state.files.values()) {
            if (!row.deleted_at && names.has(row.name)) {
              row.deleted_at = nowIso
              deleted++
            }
          }
          return send(200, { ok: true, deleted })
        }
        const blobMatch = url.pathname.match(/^\/v1\/files\/([0-9a-f]{64})$/)
        if (req.method === 'GET' && blobMatch) {
          const blob = state.blobs.get(blobMatch[1]!)
          if (!blob) return send(404, { error: 'not_found' })
          return send(200, blob)
        }
        if (route === 'POST /v1/sync/wipe') {
          state.tokens.wipe.push(token)
          let conversations = 0
          let files = 0
          for (const c of state.conversations.values()) {
            if (!c.deleted_at) {
              c.deleted_at = nowIso
              conversations++
            }
          }
          for (const f of state.files.values()) {
            if (!f.deleted_at) {
              f.deleted_at = nowIso
              files++
            }
          }
          return send(200, { ok: true, conversations, files })
        }
        return send(404, { error: `no fake for ${route}` })
      } catch (err) {
        return send(500, { error: String(err) })
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

// ── Child-phase plumbing ─────────────────────────────────────────────────

async function phaseMain(): Promise<void> {
  // HOME is the sandbox; must be set (by the orchestrator) before any
  // @main import reads os.homedir().
  const Module = (await import('node:module')).default as unknown as {
    _load: (...a: unknown[]) => unknown
  }
  const token = process.env.WFC_TEST_TOKEN ?? 'tok_a'
  const userId = process.env.WFC_TEST_USER ?? 'usr_a'
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
  const syncStateFile = path.join(workspace, '.sync-state.json')
  const readState = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await fs.readFile(syncStateFile, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const serverState = async (): Promise<Record<string, unknown>> => {
    const res = await fetch(`${process.env.WFC_API_URL}/__state`)
    return (await res.json()) as Record<string, unknown>
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
      const s = await serverState()
      const names = (s.fileNames as string[]) ?? []
      const recs = (s.recordCounts as Record<string, number>) ?? {}
      return (
        s.conversationCount === CONV_COUNT &&
        s.configStamp !== null &&
        names.includes('files/dup-a.txt') &&
        names.includes('brain/notes/dup-b.txt') &&
        names.includes('files/empty.marker') &&
        lazyMediaSeedFiles().every(([rel]) => names.includes(rel)) &&
        names.includes('whatsapp/chats.json') &&
        (recs[convId(1)] ?? 0) >= 7
      )
    }, 60_000)
    if (!pushed) fail(`initial push incomplete: ${JSON.stringify(await serverState())}`)

    const local = await readState()
    if (local.owner_user_id !== userId) fail(`owner not claimed: ${JSON.stringify(local)}`)

    // The user deletes a conversation and a file; both must tombstone.
    await conversations.deleteConversation(convId(CONV_COUNT))
    await fs.rm(path.join(workspace, 'files/temp-note.txt'))
    sync.scheduleConversationPush(convId(1)) // any push arms the sweep

    const tombstoned = await until(async () => {
      const s = await serverState()
      return (
        ((s.tombstoned as string[]) ?? []).includes(convId(CONV_COUNT)) &&
        ((s.deletedFiles as string[]) ?? []).includes('files/temp-note.txt')
      )
    }, 60_000)
    if (!tombstoned) fail(`tombstones missing: ${JSON.stringify(await serverState())}`)
    console.log('phase seed: ok')
    process.exit(0)
  }

  if (PHASE === 'restore-flaky') {
    // THE REAL fresh-install boot: the bundled defaults tree and the default
    // config land BEFORE restore can run — exactly what app.whenReady does.
    const ws = await import('@main/workspace/workspace')
    await ws.ensureWorkspace()
    const sync = await import('@main/cloud/sync')
    let restoredSummary: Record<string, unknown> | null = null
    const hydrationEvents: import('@main/cloud/sync').HydrationProgress[] = []
    sync.initCloudSync({
      getUserId: () => userId,
      onRestored: (summary) => {
        restoredSummary = summary as unknown as Record<string, unknown>
      },
      onHydrationProgress: (progress) => {
        hydrationEvents.push(progress)
      }
    })
    // First session flow: bootstrap fails (injected), restore stays
    // pending — and the stampless config guard ADOPTS the server row
    // instead of clobbering it with the defaults on disk.
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const adopted = await until(async () => {
      const local = await readState()
      if (typeof local.config_updated_at !== 'string') return false
      const cfg = JSON.parse(
        await fs.readFile(path.join(workspace, 'config.json'), 'utf8')
      ) as Record<string, unknown>
      return cfg.theme === 'dark' && local.restore_done !== true
    }, 30_000)
    if (!adopted) fail(`stampless adoption did not happen: ${JSON.stringify(await readState())}`)
    const srv = await serverState()
    const srvCfg = srv.config as Record<string, unknown>
    if (srvCfg?.theme !== 'dark') fail(`server config clobbered: ${JSON.stringify(srvCfg)}`)

    // The retry path: a second `ready` in the same session is a UI-only
    // transition (it only drains the outbox), so restore completes on the
    // engine's own backoff timer (15 s), exactly as the app would.
    stateListeners.forEach((l) => l({ status: 'ready' }))
    const done = await until(async () => (await readState()).restore_done === true, 60_000)
    if (!done) fail(`restore never completed: ${JSON.stringify(await readState())}`)
    if (!restoredSummary) fail('onRestored hook never fired')

    // On-open hydration: media was NOT predownloaded; opening c1/c2
    // downloads exactly their files with sane streamed progress.
    await verifyLazyHydration({
      hydrate: (id) => sync.hydrateConversationFiles(id),
      events: hydrationEvents,
      workspace,
      fail
    })

    // The secrets-capability case: a plugin process writes config.json
    // DIRECTLY (its own tmp+rename, no hook). The engine must notice the
    // out-of-band change and push it — a pasted API key can never sit
    // unsynced until the next launch.
    const cfgPath = path.join(workspace, 'config.json')
    const cfgNow = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>
    cfgNow.variables = [...((cfgNow.variables as unknown[]) ?? []), OOB_VARIABLE]
    await fs.writeFile(cfgPath, JSON.stringify(cfgNow, null, 2))

    // Tombstone safety: a full sweep AFTER hydration must not tombstone
    // the not-yet-hydrated media of every OTHER conversation. Prove a
    // sweep completed (a fresh file reaches the server), then let the
    // orchestrator assert the lazy rows are still live.
    await fs.writeFile(path.join(workspace, 'files/after-restore.txt'), 'sweep-marker')
    sync.scheduleConversationPush(convId(3))
    const swept = await until(async () => {
      const srvNow = await serverState()
      return ((srvNow.fileNames as string[]) ?? []).includes('files/after-restore.txt')
    }, 60_000)
    if (!swept) fail('post-hydration sweep never completed')
    const oobSynced = await until(async () => {
      const srvNow = await serverState()
      const vars =
        ((srvNow.config as Record<string, unknown>)?.variables as
          | Array<Record<string, unknown>>
          | undefined) ?? []
      return vars.some((v) => v.name === OOB_VARIABLE.name && v.value === OOB_VARIABLE.value)
    }, 30_000)
    if (!oobSynced) fail('out-of-band config write never reached the server')
    console.log('phase restore-flaky: ok')
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
    if (firedWith !== 'usr_a') fail(`wrong owner reported: ${firedWith}`)
    // Give any (wrongly) queued work a chance to drain, then let the
    // orchestrator prove the server never saw this token.
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
  const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-purge-cycle-'))
  const WORKSPACE = path.join(SANDBOX, '.wfc', 'workspace')
  const state = newServerState()
  const { port, close } = await startServer(state)

  // Children must not go through `npx` — with HOME pointed at the sandbox,
  // npx loses its cache and tries to reinstall tsx. This process IS node
  // running with tsx's loader in execArgv; reuse exactly that (plus the
  // inherited TSX_TSCONFIG_PATH) for a HOME-independent child. And the
  // child must run ASYNC: the fake server lives in THIS process, so a
  // spawnSync would block the event loop and deadlock the child's polls.
  const runPhase = (phase: string, env: Record<string, string>): Promise<number> => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, `--phase=${phase}`],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: SANDBOX,
          WFC_API_URL: `http://127.0.0.1:${port}`,
          ...env
        },
        stdio: 'inherit'
      }
    )
    return new Promise((resolve) => {
      const killer = setTimeout(() => {
        console.error(`phase ${phase} timed out — killing`)
        child.kill('SIGKILL')
      }, 180_000)
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

  // 1 · Device A seeds a lived-in workspace and deletes some of it.
  ok(
    'phase seed exits clean',
    (await runPhase('seed', { WFC_TEST_TOKEN: 'tok_a', WFC_TEST_USER: 'usr_a' })) === 0
  )
  const liveNames = new Set(liveFiles(state).map((f) => f.name))
  ok(
    'duplicate content registered at BOTH paths',
    liveNames.has('files/dup-a.txt') && liveNames.has('brain/notes/dup-b.txt')
  )
  ok('empty file registered', liveNames.has('files/empty.marker'))
  ok(
    'conversation media pushed too',
    lazyMediaSeedFiles().every(([rel]) => liveNames.has(rel))
  )
  ok(
    'whatsapp auth NEVER uploaded',
    ![...state.files.values()].some((f) => f.name.startsWith('whatsapp/auth/'))
  )
  ok(
    'deleted file tombstoned',
    state.files.get(`${sha256('to be deleted\n')}|files/temp-note.txt`)?.deleted_at != null
  )
  ok(
    'deleted conversation tombstoned',
    state.conversations.get(convId(CONV_COUNT))?.deleted_at != null
  )
  ok('server config is device A config', isDeepStrictEqual(state.config, CONFIG_A))
  const configPutsAfterSeed = state.tokens.configPut.length
  const batchesAfterSeed = state.tokens.batch.length

  // 2 · THE PURGE — the entire ~/.wfc dies with its process.
  await fs.rm(path.join(SANDBOX, '.wfc'), { recursive: true, force: true })
  ok('purge really happened', !existsSync(WORKSPACE))

  // 3 · Fresh install, flaky first bootstrap: adopt-not-clobber, then a
  // complete restore.
  state.failBootstrap = 1
  ok(
    'phase restore-flaky exits clean',
    (await runPhase('restore-flaky', { WFC_TEST_TOKEN: 'tok_a', WFC_TEST_USER: 'usr_a' })) === 0
  )
  // The launch sweep may legitimately re-push the ADOPTED blob, and the
  // phase appended one variable OUT-OF-BAND (the secrets-capability case) —
  // the server row must be exactly device A's config plus that variable.
  void configPutsAfterSeed
  const expectedConfig = {
    ...CONFIG_A,
    variables: [...CONFIG_A.variables, OOB_VARIABLE]
  }
  ok(
    'server config = device A config + out-of-band secret (adopt, never clobber)',
    isDeepStrictEqual(state.config, expectedConfig),
    JSON.stringify(state.config)
  )
  ok(
    'no DEFAULT config ever reached the server',
    (state.config as Record<string, unknown>).theme === 'dark' &&
      (state.config as Record<string, unknown>).onboardingCompleted === true
  )

  // Disk: the workspace walked back out of the org — the SHARED assertion
  // block, identical to the live-API test's (config additionally carries
  // the out-of-band secret the phase appended).
  await assertRestoredWorkspace(ok, WORKSPACE, CONV_COUNT, expectedConfig)
  ok(
    'device-only app log never uploaded',
    !deviceOnlySeedFiles().some(([rel]) => [...state.files.values()].some((f) => f.name === rel))
  )

  // Pagination was genuinely exercised (server pages are 5/4/3 wide).
  ok('conversation index paged', state.calls.convPages >= 2, String(state.calls.convPages))
  ok('records paged', state.calls.recordPages >= 3, String(state.calls.recordPages))
  ok('usage table read for the ledger rebuild', state.calls.usagePages >= 1)
  ok(
    'usage ledger never uploaded as a blob',
    ![...state.files.values()].some((f) => f.name.startsWith('usage/providers/cloud.md'))
  )
  ok(
    "bundled defaults never pushed over the user's brain files",
    ['brain/identity/soul.md', 'brain/brainstem/heartbeat.md'].every((rel) => {
      const live = liveFiles(state).find((f) => f.name === rel)
      return live?.sha256 === sha256(eagerSeedFiles().find(([r]) => r === rel)![1])
    })
  )
  ok(
    'one live manifest row per path (superseding)',
    (() => {
      const live = liveFiles(state)
      return new Set(live.map((f) => f.name)).size === live.length
    })()
  )
  ok(
    'one envelope row per conversation (snapshot compaction)',
    [...state.records.values()].every(
      (rows) => rows.filter((r) => r.kind === 'snapshot').length <= 1
    )
  )
  // The launch sweep after restore had nothing to push: restored transcripts
  // are memoized as already on the server.
  const batchesAfterRestore = state.tokens.batch.length
  ok(
    'launch sweep after restore pushed no transcripts',
    batchesAfterRestore - batchesAfterSeed <= 1,
    `${batchesAfterRestore - batchesAfterSeed} batch POSTs after restore`
  )

  // The lazy-media rows survived the post-hydration sweep: not-yet-opened
  // conversations' media must NEVER be tombstoned as "deleted locally".
  const liveAfter = new Set(liveFiles(state).map((f) => f.name))
  ok(
    'lazy media rows still live after hydration + sweep',
    lazyMediaSeedFiles().every(([rel]) => liveAfter.has(rel)),
    JSON.stringify([...liveAfter].filter((n) => /conv-/.test(n)))
  )

  // 4 · A different user signs in over this workspace: guard fires, and
  // not one write reaches the server under their token.
  ok(
    'phase foreign exits clean',
    (await runPhase('foreign', { WFC_TEST_TOKEN: 'tok_b', WFC_TEST_USER: 'usr_b' })) === 0
  )
  ok('no batch pushes as foreign user', !state.tokens.batch.includes('tok_b'))
  ok('no uploads as foreign user', !state.tokens.upload.includes('tok_b'))
  ok('no config writes as foreign user', !state.tokens.configPut.includes('tok_b'))

  close()
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
