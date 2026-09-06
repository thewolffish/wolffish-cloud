/**
 * Cloud sync — what makes ~/.wfc a mere cache.
 *
 * Push: every conversation write and config write schedules a debounced
 * drain. A drain uploads any message attachments (content-addressed, R2
 * dedupes), then POSTs /v1/sync/batch with the conversation row, one
 * `snapshot` record carrying the file's envelope (title, model, project,
 * working folders — everything but messages), and one `message` record
 * per message. Record ids embed a content hash, so replays are no-ops and
 * an edited message lands as a new row that restore prefers by seq.
 * Deletes tombstone server-side, and the delete outbox is DURABLE — it
 * rides `.sync-state.json`, so a delete followed by a quit (or made
 * offline) still reaches the server on a later launch instead of the
 * conversation resurrecting at the next restore.
 *
 * Config is one LWW blob at PUT /v1/config — LWW at the row, decided by
 * the server stamp: `.sync-state.json` remembers the updated_at of the
 * last row THIS client wrote or adopted, and a differing server stamp
 * means someone else wrote (the admin console fixing this user's
 * settings, another of their devices) — that row is pulled and adopted
 * instead of being buried under a blind re-push. A client with NO stamp
 * (a purged install, a pre-stamp install) NEVER pushes blind: it reads
 * the server row first and adopts it when one exists — pushing only into
 * a genuinely empty row. That rule is what makes it impossible for a
 * fresh install's default config to overwrite the user's real one.
 *
 * Workspace files sweep as path-named blobs, and the sweep also carries
 * DELETIONS: `.sync-state.json` remembers every path known to be on the
 * server, and a remembered path that is no longer on disk is tombstoned
 * (POST /v1/files/delete) so a purge+restore honors what the user deleted.
 * The usage ledger is NOT a blob: the org meters every call, so the ledger
 * is rebuilt from GET /v1/usage after a purge and reconciled on a running
 * app (the user's other devices' calls fold in) — see reconcileUsage.
 *
 * Pushes are INCREMENTAL. `.sync-state.json` remembers the digest of each
 * conversation file as last pushed, so a launch or a lock/unlock re-pushes
 * only what changed (nothing, in the steady state), and within a process
 * the engine remembers which record ids the server has acknowledged, so a
 * turn on a 200-message conversation sends the new messages and the
 * envelope — not the whole transcript again. The envelope rides a STABLE
 * record id (`snap.<conversation id>`) the server upserts, so the envelope
 * history never accumulates.
 *
 * Pull: restore is a durable, retryable step keyed on `.sync-state.json`'s
 * `restore_done` flag — NOT on inferences about onboarding. On session
 * ready with restore pending, paged /v1/sync/bootstrap (+ paged
 * /v1/conversations and /v1/files/manifest continuations — NO caps)
 * rehydrates config and every conversation (record pages pulled a few
 * conversations at a time), records pages rebuild each transcript (merged
 * onto whatever is already on disk, so a retry or a concurrent turn can
 * never lose messages), and the WORKING-SETUP blobs (brain, deliverables,
 * channel maps) land back on their paths. A fresh install's boot lays the
 * BUNDLED DEFAULTS down before restore can run (soul.md, heartbeat.md, the
 * knowledge stubs): a virgin restore replaces a file that still equals its
 * bundled default with the org's copy, and keeps anything else the user
 * already produced. A failed attempt retries on a backoff until it
 * completes; only a fully clean pass marks restore done. Purge the folder,
 * sign in, and the workspace walks back out of the org.
 *
 * Conversation MEDIA (uploads/voice/speech/generated media under conv-*
 * directories) is deliberately NOT predownloaded: it hydrates when its
 * conversation is OPENED — hydrateConversationFiles streams each missing
 * blob to disk with throttled byte-level progress (onHydrationProgress →
 * the chat's download banner and per-card downloading states), exactly
 * like the phone. Flights dedupe per conversation, a hydrated
 * conversation costs one stat pass, and per-file failures retry on the
 * next open. Not-yet-hydrated paths stay OUT of synced_paths, so the
 * sweep's deletion propagation can never tombstone media the user simply
 * hasn't opened yet.
 *
 * The workspace is bound to the account that produced it: the owner's user
 * id is recorded on first sync, and a session belonging to someone else
 * triggers the injected onForeignWorkspace hook (which resets the cache)
 * instead of ever cross-pushing one user's data into another's account.
 *
 * A session flow (ownership check, restore, the digest sweep, the usage
 * reconcile) runs when a session BECOMES authenticated — never on the
 * UI-only transitions between ready and locked, or on a profile save — and
 * its steady-state cost is a handful of small reads.
 */
import { API_BASE } from '@main/cloud/api'
import {
  rebuildConversation,
  type WireConversationMeta,
  type WireRecord
} from '@main/cloud/restore'
import { cloudSession } from '@main/cloud/session'
import {
  conversationDirName,
  deleteConversation,
  listConversationDigests,
  loadConversation,
  loadConversationWithDigest,
  mergeConversationOnto,
  setConversationSyncHook,
  updateConversation,
  type ConversationMessage
} from '@main/conversations'
import {
  appendBraveLedgerRow,
  appendLedgerRow,
  rewriteBraveLedger,
  rewriteLedger,
  type BraveLedgerRow,
  type LedgerRow
} from '@main/runtime/usage'
import { wlog } from '@main/workspace/logger'
import { workspaceRoot } from '@main/workspace/root'
import {
  defaultsWorkspacePath,
  readConfig,
  setConfigSyncHook,
  writeConfig,
  type WorkspaceConfig
} from '@main/workspace/workspace'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEBOUNCE_MS = 2_500
/** Above this serialized size a message record sheds segment detail. The
 *  server accepts 400 KB record content, so 300 KB always fits whole. */
const MAX_RECORD_BYTES = 300_000
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const RECORDS_PAGE = 200
/** Restore retry backoff, capped — a transient bootstrap failure must never
 *  cost the user their restore. */
const RESTORE_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000]
/** Conversations whose record pages restore concurrently, and eager blobs
 *  downloading concurrently — restore is bound by round trips, not bytes. */
const RESTORE_CONCURRENCY = 6
const BLOB_CONCURRENCY = 4
/** How often a running app folds the org's usage table into the ledger. */
const USAGE_PULL_MS = 120_000
/** How often a running app catches up on conversations written elsewhere. */
const CONV_PULL_MS = 120_000
/** Index rows per catch-up page (the server's own ceiling for this route). */
const CONV_PULL_PAGE = 500
/**
 * Attempts a single restore item (one conversation, one blob) gets before
 * it is quarantined and stops holding `restore_done` unset. Generous: the
 * retry ladder already spans minutes, so reaching this means the item is
 * genuinely unreadable, not merely unlucky.
 */
const RESTORE_MAX_ATTEMPTS = 3

export type CloudSyncDeps = {
  /** Current signed-in user id, for the workspace ownership check. */
  getUserId?: () => string | null
  /** This device's server id: its own metered calls are already in the
   *  local ledger (recorded at turn end), so the usage reconcile folds in
   *  only the OTHER devices' rows. */
  getDeviceId?: () => string | null
  /** The usage ledger on disk changed under the host (rebuilt after a
   *  restore, or other devices' calls appended) — re-read it. */
  onUsageLedgerChanged?: () => void
  /** The session's workspace belongs to a different user — the host must
   *  reset the cache (purge + relaunch). Sync stops until it does. */
  onForeignWorkspace?: (ownerUserId: string) => void
  /** A restore into a fresh workspace delivered real content — the host
   *  should relaunch so boot-read config (channels, MCP, theme, model)
   *  actually applies. restore_done is already persisted when this fires. */
  onRestored?: (summary: RestoreSummary) => void
  /** A server config row was adopted over the local file (restore, launch
   *  reconciliation, or the steady-state pull) — the host applies what it
   *  can live and tells the renderer. */
  onConfigAdopted?: (config: WorkspaceConfig) => void
  /** Streamed progress of a conversation's on-open media hydration —
   *  throttled; the host relays it to the renderer for the download UI. */
  onHydrationProgress?: (progress: HydrationProgress) => void
  /**
   * A conversation's records just landed in the org (a push completed).
   * The mobile channel forwards it to the phone as `conversation.synced`
   * — the one moment a phone may fetch that body from the API and expect
   * the turn it just watched to be in it.
   */
  onConversationPushed?: (conversationId: string, updatedAt: number) => void
  /**
   * The catch-up pull applied conversations written on another machine —
   * merged onto disk, or removed because the org says they are gone. The
   * host tells the renderer so an open list (or the open chat itself)
   * re-reads instead of showing a transcript the org no longer has.
   */
  onConversationsPulled?: (change: { changed: string[]; removed: string[] }) => void
}

/** Live progress of one conversation's media hydration. `files` lists only
 *  the files that actually need downloading (already-on-disk media never
 *  appears); `done` flips on the final event. */
export type HydrationProgress = {
  conversationId: string
  /** Files that needed downloading. */
  filesTotal: number
  filesDone: number
  /** Bytes across all needed files (server-known sizes; 0 when unknown). */
  totalBytes: number
  doneBytes: number
  /** Workspace-relative path currently downloading, null between files. */
  current: string | null
  /** Workspace-relative paths still waiting (or mid-download) this pass —
   *  what lets a file card render "downloading" instead of "deleted". */
  pending: string[]
  /** Per-file terminal failures this pass (missing blob, network). */
  failed: number
  done: boolean
}

export type RestoreSummary = {
  attempted: boolean
  /** Every step finished cleanly; restore_done is persisted. */
  completed: boolean
  /** The workspace was virgin (default config, onboarding never finished)
   *  when the attempt began — the purge/second-device case. */
  virgin: boolean
  configAdopted: boolean
  conversations: number
  files: number
  /** Items that failed but still have attempts left — what holds `completed` back. */
  failures: number
  /** Items given up on after RESTORE_MAX_ATTEMPTS; named in the log. */
  quarantined: number
}

let deps: CloudSyncDeps = {}

const pendingConversations = new Set<string>()
const pendingDeletes = new Set<string>()
const pendingFileDeletes = new Set<string>()
let configDirty = false
let timer: NodeJS.Timeout | null = null
let draining = false
let restoring = false
let sessionFlowActive = false
let restoreRetryTimer: NodeJS.Timeout | null = null
let restoreRetryCount = 0
/** True only inside adoptServerConfig's writeConfig — suppresses the config
 *  hook's echo push without muting conversation traffic the way `restoring`
 *  would. */
let adoptingConfig = false
let lastConfigPullMs = 0
/** sha of config.json as of the last drain that reconciled it — a later
 *  mismatch with configDirty unset means a FOREIGN-PROCESS write (the
 *  secrets capability's plugin, a hand edit) bypassed the config hook and
 *  must sync like any other edit. null = not yet observed. */
let lastConfigFileSha: string | null = null
const CONFIG_PULL_MS = 120_000
/** path → newest {sha, size} the server holds for it (seeded from manifest
 *  pages, grown by uploads and restores). THE dedupe: a file uploads only
 *  when its content differs from the server's newest row for that path — so
 *  two paths with identical content each get their own row (both restore),
 *  and a reverted file re-registers as newest. Sizes feed the hydration
 *  progress totals. */
const serverFiles = new Map<string, { sha: string; size: number }>()
/** In-memory mirror of syncState.synced_paths. */
const syncedPaths = new Set<string>()
/** conversation id → digest of the file as last pushed (mirror of
 *  syncState.pushed). A conversation whose file digest still matches is
 *  already on the server in full — the launch sweep skips it. */
const pushedDigests = new Map<string, string>()
/** conversation id → record ids the server has acknowledged this process
 *  (accepted or already-there). The next push of that conversation sends
 *  only the records outside this set. Per process by design: the first
 *  push after a launch re-sends a changed conversation whole (idempotent),
 *  and from then on every turn is incremental. */
const ackedRecords = new Map<string, Set<string>>()
/** conversation id → hash of the envelope as last acknowledged. */
const ackedSnapshots = new Map<string, string>()
/** conversation id → the file's updatedAt as of its last completed push,
 *  for the onConversationPushed hook. */
const lastPushedUpdatedAt = new Map<string, number>()
/** conversation id → record ids the server REFUSED by id (malformed, or a
 *  conversation it does not own). Skipped on later pushes of the same
 *  content; a changed message mints a new record id and gets its retry. */
const refusedRecords = new Map<string, Set<string>>()
/** conversation id → message base id → {hash of the raw message, the record
 *  id its wire form produced}: a message that hasn't changed skips
 *  wireMessage entirely (no re-reading and re-hashing its attachments). */
const wireMemo = new Map<string, Map<string, { rawHash: string; recordId: string }>>()
let lastUsagePullMs = 0
/** Whether the session currently holds live tokens, as last observed by the
 *  state listener — a session flow runs on the false→true edge only. */
let sessionAuthenticated = false

const iso = (ms: number): string => new Date(ms).toISOString()
const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

class SyncHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

async function apiJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  return cloudSession.withAccessToken(async (token) => {
    const res = await fetch(`${API_BASE}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new SyncHttpError(res.status, `HTTP ${res.status}: sync ${method} ${route}`)
    return (await res.json()) as T
  })
}

// ── Durable sync state (.sync-state.json) ────────────────────────────────
//
// One dot-file (so the blob sweep's every-dot-entry exclusion skips it)
// holding everything sync must remember across launches: the config LWW
// stamp, the workspace's owning user, whether restore has completed, the
// delete outboxes, and the set of paths known to exist server-side.

type SyncState = {
  config_updated_at: string | null
  owner_user_id: string | null
  restore_done: boolean
  /** Decided ONCE, at the first restore attempt: was this workspace virgin
   *  (never lived in) when restore began? Persisted so a failed attempt —
   *  or a config adoption that lands between attempts — can't demote the
   *  retry to a lived-in restore and skip materializing the blob tree.
   *  null = not yet decided. */
  restore_fresh: boolean | null
  pending_deletes: string[]
  pending_file_deletes: string[]
  synced_paths: string[]
  /** conversation id → digest of its file as last fully pushed. */
  pushed: Record<string, string>
  /** Last usage row id folded into the ledger; null = never reconciled
   *  (the first reconcile walks the whole table). */
  usage_after: number | null
  /**
   * The catch-up cursor for the conversation index (see pullConversations).
   * null = never pulled: the next pull walks the index from the beginning,
   * which costs a couple of pages and no record fetches for anything this
   * device is already level on — and heals an install that diverged before
   * this build existed.
   */
  conversations_cursor: string | null
  /**
   * Restore attempts that failed, per item (`conv:<id>` / `blob:<path>`).
   * An item that keeps failing is quarantined at RESTORE_MAX_ATTEMPTS so a
   * single unreadable record page cannot hold `restore_done` unset forever
   * — which used to mean a full bootstrap walk on every launch, and the
   * push memo never persisting.
   */
  restore_failures: Record<string, number>
}

const syncStatePath = (): string => path.join(workspaceRoot(), '.sync-state.json')

const emptySyncState = (): SyncState => ({
  config_updated_at: null,
  owner_user_id: null,
  restore_done: false,
  restore_fresh: null,
  pending_deletes: [],
  pending_file_deletes: [],
  synced_paths: [],
  pushed: {},
  usage_after: null,
  conversations_cursor: null,
  restore_failures: {}
})

let syncStateMemo: SyncState | undefined
// Serializes every state read-modify-write; single-threaded JS queues FIFO.
let syncStateMutex: Promise<unknown> = Promise.resolve()

async function loadSyncState(): Promise<SyncState> {
  if (syncStateMemo) return syncStateMemo
  const state = emptySyncState()
  try {
    const raw = JSON.parse(await fs.readFile(syncStatePath(), 'utf8')) as Partial<SyncState>
    if (typeof raw.config_updated_at === 'string') state.config_updated_at = raw.config_updated_at
    if (typeof raw.owner_user_id === 'string') state.owner_user_id = raw.owner_user_id
    state.restore_done = raw.restore_done === true
    if (typeof raw.restore_fresh === 'boolean') state.restore_fresh = raw.restore_fresh
    for (const key of ['pending_deletes', 'pending_file_deletes', 'synced_paths'] as const) {
      const list = raw[key]
      if (Array.isArray(list)) state[key] = list.filter((v): v is string => typeof v === 'string')
    }
    if (raw.pushed && typeof raw.pushed === 'object' && !Array.isArray(raw.pushed)) {
      for (const [id, digest] of Object.entries(raw.pushed)) {
        if (typeof digest === 'string') state.pushed[id] = digest
      }
    }
    if (typeof raw.usage_after === 'number' && Number.isFinite(raw.usage_after)) {
      state.usage_after = raw.usage_after
    }
    if (typeof raw.conversations_cursor === 'string') {
      state.conversations_cursor = raw.conversations_cursor
    }
    if (
      raw.restore_failures &&
      typeof raw.restore_failures === 'object' &&
      !Array.isArray(raw.restore_failures)
    ) {
      for (const [key, count] of Object.entries(raw.restore_failures)) {
        if (typeof count === 'number' && Number.isFinite(count)) state.restore_failures[key] = count
      }
    }
  } catch {
    // absent or unreadable — a purge, a first boot, or a torn write; every
    // field degrades to its safe default (restore pending, no stamp).
  }
  syncStateMemo = state
  return state
}

async function mutateSyncState(fn: (state: SyncState) => void): Promise<SyncState> {
  const run = syncStateMutex.then(async () => {
    const state = await loadSyncState()
    const before = JSON.stringify(state)
    fn(state)
    const after = JSON.stringify(state)
    if (after !== before) {
      try {
        await fs.writeFile(syncStatePath(), after)
      } catch (err) {
        // Best-effort: a lost write only means the next launch redoes work
        // (re-pushes config, retries restore) — never data loss.
        wlog.warn('sync', 'sync-state write failed:', err)
      }
    }
    return state
  })
  syncStateMutex = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function readConfigStamp(): Promise<string | null> {
  return (await loadSyncState()).config_updated_at
}

async function writeConfigStamp(stamp: string): Promise<void> {
  await mutateSyncState((s) => {
    s.config_updated_at = stamp
  })
}

/** Rehydrate the in-memory outboxes from the durable state (once per boot). */
let outboxHydrated = false
async function hydrateOutbox(): Promise<void> {
  if (outboxHydrated) return
  outboxHydrated = true
  const state = await loadSyncState()
  for (const id of state.pending_deletes) pendingDeletes.add(id)
  for (const name of state.pending_file_deletes) pendingFileDeletes.add(name)
  for (const name of state.synced_paths) syncedPaths.add(name)
  for (const [id, digest] of Object.entries(state.pushed)) pushedDigests.set(id, digest)
}

async function persistOutbox(): Promise<void> {
  await mutateSyncState((s) => {
    s.pending_deletes = [...pendingDeletes]
    s.pending_file_deletes = [...pendingFileDeletes]
    s.synced_paths = [...syncedPaths]
    s.pushed = Object.fromEntries(pushedDigests)
  })
}

// ── Config adoption (row-level LWW) ──────────────────────────────────────

/**
 * A config row stamped by someone else replaces the local copy wholesale —
 * row-level LWW, the mirror of the push. Sparse or empty blobs (an admin
 * reset) are healed by migrateConfig's default-merge at next boot, and
 * consumers read through fallbacks meanwhile.
 */
async function adoptServerConfig(config: Record<string, unknown>, stamp: string): Promise<void> {
  adoptingConfig = true
  try {
    await writeConfig(config as unknown as WorkspaceConfig)
  } finally {
    adoptingConfig = false
  }
  await writeConfigStamp(stamp)
  lastConfigFileSha = await configFileSha()
  wlog.info('sync', `adopted server config (${stamp})`)
  try {
    deps.onConfigAdopted?.(config as unknown as WorkspaceConfig)
  } catch (err) {
    wlog.warn('sync', 'onConfigAdopted hook failed:', err)
  }
}

/**
 * Pull half of the config LWW: adopt the server row iff its stamp was
 * minted by someone else. 'none' means nothing foreign — either stamps
 * match, no row exists, or this client has no stamp yet (that case is
 * resolved at push time: see the stampless guard in drain()).
 */
async function pullForeignConfig(): Promise<'adopted' | 'none'> {
  const stamp = await readConfigStamp()
  if (!stamp) return 'none'
  const remote = await apiJson<{
    config: Record<string, unknown> | null
    updated_at: string | null
  }>('GET', '/v1/config')
  if (remote.updated_at && remote.updated_at !== stamp) {
    await adoptServerConfig(remote.config ?? {}, remote.updated_at)
    return 'adopted'
  }
  return 'none'
}

/**
 * Push the local config — but NEVER blind from a stampless client. A client
 * with no stamp has not established provenance over the server row: it
 * reads the row first and, when one exists, ADOPTS it (the row is the
 * user's real config — this client is a purged install, a second device,
 * or a pre-stamp install whose own launch pushes kept that row current).
 * Only a genuinely empty row is claimed by pushing local. This is the rule
 * that makes "fresh install overwrites the user's cloud config with
 * defaults" structurally impossible.
 */
async function pushConfig(): Promise<void> {
  const stamp = await readConfigStamp()
  if (!stamp) {
    const remote = await apiJson<{
      config: Record<string, unknown> | null
      updated_at: string | null
    }>('GET', '/v1/config')
    if (remote.updated_at) {
      await adoptServerConfig(remote.config ?? {}, remote.updated_at)
      return
    }
  }
  const cfg = await readConfig()
  if (!cfg) return
  const res = await apiJson<{ ok: boolean; updated_at: string }>('PUT', '/v1/config', {
    config: cfg
  })
  await writeConfigStamp(res.updated_at)
}

// ── Scheduling ───────────────────────────────────────────────────────────

function arm(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void drain()
  }, DEBOUNCE_MS)
  timer.unref?.()
}

// The schedule* entry points QUEUE during a restore instead of dropping —
// drain() defers until the restore ends, and the digest memo makes the
// restore's own writes (which fire the conversation hook too) free to
// process. A delete or a config edit made while a fresh install is still
// restoring must reach the server like any other.

export function scheduleConversationPush(id: string): void {
  pendingConversations.add(id)
  arm()
}

export function scheduleConversationDelete(id: string): void {
  pendingConversations.delete(id)
  pendingDeletes.add(id)
  pushedDigests.delete(id)
  ackedRecords.delete(id)
  ackedSnapshots.delete(id)
  refusedRecords.delete(id)
  wireMemo.delete(id)
  // Its media goes with it — including media this device never hydrated
  // (absent from synced_paths, so the sweep's deletion propagation would
  // never see it). The server's newest rows under the conversation's media
  // directories are tombstoned by name.
  const prefixes = lazyMediaPrefixes(conversationDirName(id))
  for (const rel of [...serverFiles.keys()]) {
    if (prefixes.some((prefix) => rel.startsWith(prefix))) queueFileDelete(rel)
  }
  // Durable: the tombstone must survive a quit inside the debounce window,
  // or the "deleted" conversation resurrects at the next restore.
  void persistOutbox()
  arm()
}

export function scheduleConfigPush(): void {
  if (adoptingConfig) return
  configDirty = true
  arm()
}

function queueFileDelete(rel: string): void {
  pendingFileDeletes.add(rel)
  syncedPaths.delete(rel)
  serverFiles.delete(rel)
}

async function configFileSha(): Promise<string | null> {
  try {
    return sha256(await fs.readFile(path.join(workspaceRoot(), 'config.json')))
  } catch {
    return null
  }
}

async function drain(): Promise<void> {
  if (draining) {
    arm()
    return
  }
  // Never interleave pushes with a restore in flight — re-check shortly.
  if (restoring) {
    arm()
    return
  }
  const status = cloudSession.getState().status
  // Locked is authenticated: the lock screen is UI-only and must never
  // stall the outbox.
  if (status !== 'ready' && status !== 'locked') return
  draining = true
  const retryConversations: string[] = []
  let retryConfig = false
  let outboxChanged = false
  try {
    await hydrateOutbox()
    // A workspace owned by another user never drains under this session —
    // neither its outbox (their data) nor this user's usage into their
    // ledger. The host resets the cache; until then, nothing moves.
    const uid = deps.getUserId?.() ?? null
    const owner = (await loadSyncState()).owner_user_id
    if (uid && owner && owner !== uid) return
    // Out-of-band config writes: writeConfigAtomic fires the hook, but the
    // secrets capability's plugin process writes config.json itself (its
    // own tmp+rename), and a user can hand-edit it. Any content change the
    // hook did not report is picked up here — the file a user just pasted
    // an API key into must never sit unsynced until the next launch.
    const cfgShaNow = await configFileSha()
    if (cfgShaNow && lastConfigFileSha && cfgShaNow !== lastConfigFileSha && !configDirty) {
      wlog.info('sync', 'config changed out-of-band — queueing push')
      configDirty = true
    }
    if (configDirty) {
      configDirty = false
      try {
        await pushConfig()
      } catch (err) {
        if (
          err instanceof SyncHttpError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 401 &&
          err.status !== 408 &&
          err.status !== 429
        ) {
          // The server REJECTED this payload (e.g. over the size bound).
          // Retrying the identical blob forever is noise, not sync — keep
          // local, log loudly, and the next real config edit re-attempts.
          wlog.error('sync', 'config push rejected by server — config NOT synced:', err)
        } else {
          wlog.warn('sync', 'config push failed — will retry:', err)
          retryConfig = true
        }
      }
      lastConfigFileSha = await configFileSha()
    } else if (Date.now() - lastConfigPullMs >= CONFIG_PULL_MS) {
      // Steady-state pull: an admin-authored fix lands on a RUNNING app
      // within ~two minutes instead of waiting for the next launch. One
      // row read per interval; local edits always outrank it (the dirty
      // branch above pushes without looking).
      lastConfigPullMs = Date.now()
      try {
        await pullForeignConfig()
      } catch (err) {
        wlog.debug('sync', 'steady-state config pull failed — next interval retries:', err)
      }
      lastConfigFileSha = await configFileSha()
    } else if (lastConfigFileSha === null) {
      // First observation — baseline without dirtying.
      lastConfigFileSha = cfgShaNow
    }
    // The org's usage table: fold in what the user's other devices spent
    // (one small keyset read per interval; empty in the steady state).
    if (Date.now() - lastUsagePullMs >= USAGE_PULL_MS) {
      lastUsagePullMs = Date.now()
      try {
        await reconcileUsage('incremental')
      } catch (err) {
        wlog.debug('sync', 'usage reconcile failed — next interval retries:', err)
      }
    }
    // Conversations written on another machine — the catch-up half of sync.
    // BEFORE the pushes below: a conversation changed on both sides merges
    // first, so the push that follows sends the union rather than this
    // device's half of it. Only after restore, and never during one.
    if ((await loadSyncState()).restore_done && Date.now() - lastConvPullMs >= CONV_PULL_MS) {
      lastConvPullMs = Date.now()
      try {
        const pulled = await pullConversations()
        if (pulled.changed.length || pulled.removed.length) {
          wlog.info(
            'sync',
            `catch-up: ${pulled.changed.length} changed, ${pulled.removed.length} removed elsewhere`
          )
          try {
            deps.onConversationsPulled?.(pulled)
          } catch (err) {
            wlog.warn('sync', 'onConversationsPulled hook failed:', err)
          }
        }
      } catch (err) {
        wlog.debug('sync', 'conversation catch-up failed — next interval retries:', err)
      }
    }
    for (const id of [...pendingDeletes]) {
      try {
        await apiJson('DELETE', `/v1/conversations/${encodeURIComponent(id)}`)
        pendingDeletes.delete(id)
        outboxChanged = true
      } catch (err) {
        wlog.warn('sync', `delete of ${id} failed — will retry:`, err)
      }
    }
    const fileDeletes = [...pendingFileDeletes]
    for (let i = 0; i < fileDeletes.length; i += 200) {
      const chunk = fileDeletes.slice(i, i + 200)
      try {
        await apiJson('POST', '/v1/files/delete', { names: chunk })
        for (const name of chunk) pendingFileDeletes.delete(name)
        outboxChanged = true
      } catch (err) {
        wlog.warn('sync', `file tombstones failed (${chunk.length}) — will retry:`, err)
      }
    }
    const ids = [...pendingConversations]
    pendingConversations.clear()
    for (const id of ids) {
      try {
        if (await pushConversation(id)) {
          outboxChanged = true
          try {
            deps.onConversationPushed?.(id, lastPushedUpdatedAt.get(id) ?? Date.now())
          } catch (err) {
            wlog.warn('sync', 'onConversationPushed hook failed:', err)
          }
        }
      } catch (err) {
        wlog.warn('sync', `push of ${id} failed — will retry:`, err)
        retryConversations.push(id)
      }
    }
    try {
      if (await pushWorkspaceFiles()) outboxChanged = true
    } catch (err) {
      wlog.warn('sync', 'workspace file sweep failed — next drain sweeps again:', err)
    }
  } finally {
    if (outboxChanged) await persistOutbox().catch(() => undefined)
    draining = false
    for (const id of retryConversations) pendingConversations.add(id)
    if (retryConfig) configDirty = true
    if (
      pendingConversations.size ||
      pendingDeletes.size ||
      pendingFileDeletes.size ||
      configDirty
    ) {
      arm()
    }
  }
}

// ── Push ─────────────────────────────────────────────────────────────────

type BatchItem = Record<string, unknown>

/**
 * Upload one workspace file (message attachment or sweep blob), content-
 * addressed. Skips only when the server's newest row for this exact path
 * already carries this exact content — so duplicate-content paths and
 * reverted files both register correctly. Returns the sha (uploaded or
 * already current), or null when the file can't be sent (too large,
 * unreadable).
 */
export async function ensureFileUploaded(relPath: string, mime: string): Promise<string | null> {
  try {
    const abs = path.join(workspaceRoot(), relPath)
    const buf = await fs.readFile(abs)
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      wlog.warn('sync', `file too large to sync (${relPath}): ${buf.byteLength} bytes`)
      return null
    }
    const sha = sha256(buf)
    if (serverFiles.get(relPath)?.sha === sha) return sha
    await cloudSession.withAccessToken(async (token) => {
      const name = encodeURIComponent(relPath.slice(0, 500))
      const res = await fetch(
        `${API_BASE}/v1/files/upload?sha256=${sha}&name=${name}&mime=${encodeURIComponent(mime)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: new Uint8Array(buf),
          signal: AbortSignal.timeout(120_000)
        }
      )
      if (!res.ok) throw new SyncHttpError(res.status, `HTTP ${res.status}: attachment upload`)
    })
    serverFiles.set(relPath, { sha, size: buf.byteLength })
    if (syncablePath(relPath) && underSyncRoots(relPath)) syncedPaths.add(relPath)
    return sha
  } catch (err) {
    wlog.warn('sync', `attachment upload skipped (${relPath}):`, err)
    return null
  }
}

/** Message copy bound for the wire: attachments carry their blob sha, and
 *  a transcript too big for one record sheds its segment detail. */
async function wireMessage(msg: ConversationMessage): Promise<Record<string, unknown>> {
  const copy = JSON.parse(JSON.stringify(msg)) as ConversationMessage & {
    attachments?: Array<Record<string, unknown>>
  }
  if (copy.attachments) {
    for (const att of copy.attachments) {
      const sha = await ensureFileUploaded(
        String(att.filePath ?? ''),
        String(att.mimeType ?? 'application/octet-stream')
      )
      if (sha) att.sha256 = sha
    }
  }
  let json = JSON.stringify(copy)
  if (json.length > MAX_RECORD_BYTES) {
    const slim = { ...copy } as Record<string, unknown>
    slim.segments = [{ kind: 'text', text: '[segment detail elided for sync — too large]' }]
    json = JSON.stringify(slim)
    if (json.length > MAX_RECORD_BYTES) {
      // Never silently: the restored transcript says what was cut and how
      // much, and carries a flag a UI can render.
      const full = String(slim.content ?? '')
      slim.content =
        full.slice(0, MAX_RECORD_BYTES / 2) +
        `\n\n[… truncated for cloud sync: ${full.length.toLocaleString('en-US')} characters in the original message]`
      slim.syncTruncated = true
    }
    return slim
  }
  return copy as unknown as Record<string, unknown>
}

/** path → last seen {mtimeMs,size}, so unchanged files cost one stat. */
const fileSweepMemo = new Map<string, { mtimeMs: number; size: number }>()

/**
 * Workspace state that syncs as path-named blobs — everything a fresh
 * sign-in must materialize beyond conversations (which travel as records)
 * and config (its own LWW row):
 *   files/        deliverables the engine wrote (PDFs, charts, exports)
 *   uploads/      message/project/procedure attachments
 *   brain/        the durable mind: projects.json, procedures.json,
 *                 automations (brainstem), identity, memory (hippocampus),
 *                 agent behavior (prefrontal), reflection state
 *   voice/        recorded voice notes (referenced by transcripts)
 *   speech/       generated TTS replies (referenced by transcripts)
 *   screenshots/  tool screenshots referenced by transcripts
 *   downloads/    files tools fetched (browser downloads, page PDFs)
 * Excluded on purpose: brain/conversations (record-synced), cortex.db
 * (derived index, rebuilt at boot), brain/corpus (local event diagnostics),
 * brain/cerebellum (capabilities travel as versioned packages through the
 * capability registry — see cloud/capabilitySync.ts), every dot-entry, and the brainstem
 * tick/meta files — pure runtime state rewritten every heartbeat (the same
 * trio the cortex watcher ignores), worthless to restore and a new
 * content-addressed blob per minute if swept.
 */
const SYNC_ROOTS = [
  'files',
  'uploads',
  'brain',
  'voice',
  'speech',
  'screenshots',
  'downloads',
  // usage/: no file under it travels as a blob any more — every ledger
  // (providers/cloud.md + daily/ for model calls, providers/brave.md for web
  // searches) is excluded below because the org meters every call and every
  // search, so each is rebuilt from GET /v1/usage after a purge and
  // reconciled across devices instead of being one device's last-write-wins
  // blob that changes (and re-uploads) on every turn. The root stays listed
  // so anything else a future ledger writes here syncs by default.
  'usage',
  // logs/ carries ONE user-visible record: the per-conversation browser
  // trail the extension side panel renders (logs/extension/<conv>.jsonl).
  // The rotating app logs are excluded below — syncing them would
  // self-trigger the sweep (every sync log line would change the file).
  'logs'
]
const SYNC_EXCLUDES = [
  /^brain\/conversations(\/|$)/,
  /^brain\/corpus(\/|$)/,
  /^brain\/cortex\.db(-|$)/,
  /^brain\/cerebellum(\/|$)/,
  /^brain\/brainstem\/(heartbeat-state|heartbeat-meta|compaction-meta)\.json$/,
  // App-managed prompt files, rewritten from the bundle on every launch —
  // identical on every device by construction, nothing to restore.
  /^brain\/prefrontal\/agents\.core\.md$/,
  /^brain\/identity\/workflow(-agent)?\.md$/,
  // The usage ledgers — served by the org (see 'usage' above).
  /^usage\/providers\/cloud\.md$/,
  /^usage\/providers\/brave\.md$/,
  /^usage\/daily(\/|$)/,
  // Rotating app/diagnostic logs — device-local by design (see 'logs' above).
  /^logs\/[^/]+\.log$/
]

function syncablePath(rel: string): boolean {
  if (rel.split('/').some((part) => part.startsWith('.'))) return false
  return !SYNC_EXCLUDES.some((re) => re.test(rel))
}

function underSyncRoots(rel: string): boolean {
  return SYNC_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`))
}

/**
 * Conversation-scoped media — the bulk of a workspace: message uploads,
 * voice notes, TTS replies, generated videos, all keyed by their
 * conversation directory. NOT materialized during restore: it hydrates on
 * conversation open (hydrateConversationFiles) with streamed progress,
 * exactly like the phone. Everything else (config, transcripts, brain,
 * deliverables, channel maps) stays eager — the agent needs it to work.
 */
function isLazyMediaPath(rel: string): boolean {
  return /^(uploads|voice|speech|screenshots|downloads)\/conv-[^/]+\//.test(rel)
}

/** The lazy-media directory prefixes belonging to one conversation
 *  (screenshots: the browser-extension and computer-use tools write theirs
 *  under screenshots/conv-<id>/ — transcript-referenced, hydrated on open). */
function lazyMediaPrefixes(conversationDir: string): string[] {
  return [
    `uploads/${conversationDir}/`,
    `voice/${conversationDir}/`,
    `speech/${conversationDir}/`,
    `screenshots/${conversationDir}/`,
    `downloads/${conversationDir}/`
  ]
}

async function walkFiles(absDir: string, relDir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (!syncablePath(rel)) continue
    if (entry.isDirectory()) await walkFiles(path.join(absDir, entry.name), rel, out)
    else if (entry.isFile()) out.push(rel)
  }
}

/** Returns true when the durable state (synced/deleted paths) changed. */
async function pushWorkspaceFiles(): Promise<boolean> {
  const root = workspaceRoot()
  const rels: string[] = []
  for (const base of SYNC_ROOTS) {
    await walkFiles(path.join(root, base), base, rels)
  }
  const present = new Set(rels)
  let changed = false
  for (const rel of rels) {
    try {
      const st = await fs.stat(path.join(root, rel))
      if (!st.isFile() || st.size > MAX_ATTACHMENT_BYTES) continue
      const memo = fileSweepMemo.get(rel)
      if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) continue
      const sha = await ensureFileUploaded(rel, mimeFor(rel))
      if (sha) {
        fileSweepMemo.set(rel, { mtimeMs: st.mtimeMs, size: st.size })
        changed = true
      }
    } catch {
      // one unreadable file never stops the sweep
    }
  }
  // Deletion propagation: a path the server knows that is no longer on disk
  // was deleted locally — tombstone it, or the next restore resurrects it.
  for (const rel of [...syncedPaths]) {
    if (!present.has(rel)) {
      queueFileDelete(rel)
      changed = true
    }
  }
  return changed
}

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** The stable record id of a conversation's envelope (the server upserts it). */
const snapshotRecordId = (conversationId: string): string => `snap.${conversationId}`

/** Items per batch request and JSON bytes per request: the server refuses a
 *  body above 32 MB, and one request should never carry more than a
 *  fraction of that. */
const BATCH_MAX_ITEMS = 400
const BATCH_MAX_BYTES = 8 * 1024 * 1024

/** Split the outbox items into requests bounded by count AND serialized size
 *  (an item larger than the byte bound travels alone). */
function chunkItems(items: BatchItem[]): BatchItem[][] {
  const chunks: BatchItem[][] = []
  let current: BatchItem[] = []
  let bytes = 0
  for (const item of items) {
    const size = JSON.stringify(item).length
    if (
      current.length > 0 &&
      (current.length >= BATCH_MAX_ITEMS || bytes + size > BATCH_MAX_BYTES)
    ) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Push one conversation, incrementally. Returns true when the durable push
 * memo changed (the caller persists it with the outbox). Skips outright
 * when the file's digest matches what was last pushed; otherwise sends the
 * conversation row, the envelope (only if it changed), and every message
 * record the server has not acknowledged in this process.
 */
async function pushConversation(id: string): Promise<boolean> {
  const loaded = await loadConversationWithDigest(id)
  if (!loaded) return false
  const { conv, digest } = loaded
  if (pushedDigests.get(id) === digest) return false

  const items: BatchItem[] = [
    {
      type: 'conversation',
      id: conv.id,
      title: (conv.title ?? '').slice(0, 500),
      // Provenance on the ROW, not only inside the envelope below: the org
      // leaderboard counts the two autonomous channels (heartbeat,
      // procedure) as agentic tasks, and a count that has to open a JSON
      // blob per conversation is a count nobody can afford to read.
      channel: conv.channel ?? '',
      created_at: iso(conv.createdAt || Date.now()),
      updated_at: iso(conv.updatedAt || Date.now())
    }
  ]

  const envelope = { ...conv, messages: undefined } as Record<string, unknown>
  delete envelope.messages
  // The phone's conversation index reads the count off the envelope (one
  // JOIN per page) instead of counting records per row.
  envelope.messageCount = conv.messages.length
  const envJson = JSON.stringify(envelope)
  const envHash = sha256(envJson)
  if (ackedSnapshots.get(id) !== envHash) {
    items.push({
      type: 'record',
      id: snapshotRecordId(conv.id),
      conversation_id: conv.id,
      seq: conv.updatedAt || Date.now(),
      kind: 'snapshot',
      content: JSON.parse(envJson),
      created_at: iso(Date.now())
    })
  }

  const acked = ackedRecords.get(id) ?? new Set<string>()
  const refused = refusedRecords.get(id) ?? new Set<string>()
  const memo = wireMemo.get(id) ?? new Map<string, { rawHash: string; recordId: string }>()
  const sentRecordIds: string[] = []
  for (const msg of conv.messages) {
    // A message without a usable timestamp (a record another writer shaped
    // differently, a hand-edited file) still gets a finite seq and a real
    // created_at — the server refuses NaN, and a refused record used to make
    // this conversation re-send itself on every launch.
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : conv.updatedAt || Date.now()
    const baseId = msg.id ?? `m_${Math.round(ts)}`
    const rawHash = sha256(JSON.stringify(msg))
    const known = memo.get(baseId)
    // Unchanged since the server acknowledged it: nothing to send, and no
    // attachment re-read either.
    if (
      known &&
      known.rawHash === rawHash &&
      (acked.has(known.recordId) || refused.has(known.recordId))
    )
      continue
    const content = await wireMessage(msg)
    const recordId = `${baseId}.${sha256(JSON.stringify(content)).slice(0, 8)}`
    memo.set(baseId, { rawHash, recordId })
    if (acked.has(recordId) || refused.has(recordId)) continue
    sentRecordIds.push(recordId)
    items.push({
      type: 'record',
      id: recordId,
      conversation_id: conv.id,
      seq: Math.max(0, Math.round(ts)),
      kind: 'message',
      content,
      created_at: iso(ts)
    })
  }
  wireMemo.set(id, memo)

  let accepted = 0
  let ignored = 0
  let rejected = 0
  const rejectedIds = new Set<string>()
  for (const chunk of chunkItems(items)) {
    const res = await apiJson<{
      accepted: number
      ignored: number
      rejected: number
      rejected_ids?: string[]
    }>('POST', '/v1/sync/batch', { items: chunk })
    accepted += res.accepted
    ignored += res.ignored
    rejected += res.rejected
    for (const rid of res.rejected_ids ?? []) rejectedIds.add(rid)
  }
  if (rejected > 0 && rejectedIds.size === 0) {
    // An older server that does not name what it refused — acknowledge
    // nothing, so the next change re-sends the whole conversation.
    wlog.error('sync', `${rejected} items rejected for ${id} — will resend on next change`)
    return false
  }
  if (rejectedIds.size > 0) {
    // Named refusals are quarantined: their content is wrong for the wire
    // (the message would need to change to earn a retry), and everything
    // else in the push stands. Loud, once per process, with the ids.
    wlog.error(
      'sync',
      `${rejectedIds.size} record(s) refused by the org for ${id} — quarantined: ${[...rejectedIds].join(', ')}`
    )
    for (const rid of rejectedIds) refused.add(rid)
    refusedRecords.set(id, refused)
  }
  for (const recordId of sentRecordIds) if (!rejectedIds.has(recordId)) acked.add(recordId)
  ackedRecords.set(id, acked)
  if (!rejectedIds.has(snapshotRecordId(conv.id))) ackedSnapshots.set(id, envHash)
  pushedDigests.set(id, digest)
  lastPushedUpdatedAt.set(id, conv.updatedAt || Date.now())
  wlog.info(
    'sync',
    `pushed ${id}: ${items.length} items (${accepted} new, ${ignored} already there)`
  )
  return true
}

// ── Pull (restore) ───────────────────────────────────────────────────────

type WireFileRow = { sha256: string; name?: string; size?: number }

async function pullRecords(conversationId: string): Promise<WireRecord[]> {
  // Pages on the server's insert-order cursor (`after`/`next_after`), not on
  // seq: message versions share a seq, and a seq cursor would drop the rows
  // of a tie split across a page boundary. rebuildConversation re-sorts by
  // seq itself and keeps the later-inserted row of every message — which is
  // why the pages must arrive, and be concatenated, in insert order.
  // No page-count ceiling. The terminator is `next_after: null` from the
  // server — NOT "a short page", so a server paging smaller than requested
  // can never silently truncate a transcript — and the cursor must advance
  // (a stalled or replayed cursor can never loop forever).
  const all: WireRecord[] = []
  let after = 0
  for (;;) {
    const res = await apiJson<{ records: WireRecord[]; next_after: number | null }>(
      'GET',
      `/v1/conversations/${encodeURIComponent(conversationId)}/records?after=${after}&limit=${RECORDS_PAGE}`
    )
    all.push(...res.records)
    const next = res.next_after
    if (typeof next !== 'number' || res.records.length === 0 || !(next > after)) break
    after = next
  }
  return all
}

/**
 * Stream one content-addressed blob straight to disk: scratch file first,
 * rename into place on completion — a truncated download can never read as
 * a valid file. `onBytes` reports cumulative received bytes for progress.
 */
async function downloadBlobToFile(
  sha: string,
  abs: string,
  onBytes?: (received: number) => void
): Promise<number> {
  return cloudSession.withAccessToken(async (token) => {
    const res = await fetch(`${API_BASE}/v1/files/${sha}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(600_000)
    })
    if (!res.ok) throw new SyncHttpError(res.status, `HTTP ${res.status}: blob ${sha}`)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.wfc-part`
    const handle = await fs.open(tmp, 'w')
    let received = 0
    try {
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await handle.write(value)
          received += value.byteLength
          onBytes?.(received)
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer())
        await handle.write(buf)
        received = buf.byteLength
        onBytes?.(received)
      }
      await handle.close()
      await fs.rename(tmp, abs)
      return received
    } catch (err) {
      await handle.close().catch(() => undefined)
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  })
}

// ── On-open hydration: a conversation's media, downloaded when it is
//    opened — never before — with streamed progress (mobile parity) ──────

type HydrationTarget = { rel: string; sha: string | null; size: number }

type HydrationFlight = {
  promise: Promise<HydrationProgress>
}

const hydrationFlights = new Map<string, HydrationFlight>()
const HYDRATION_EMIT_MS = 100

/** True when this path is safe to write inside the workspace. */
function safeWorkspaceRel(rel: string): boolean {
  return rel.length > 0 && !rel.includes('..') && !path.isAbsolute(rel)
}

/**
 * Materialize one org blob at a workspace path — for files the PHONE
 * uploaded straight to the org (message attachments, project files) that
 * this machine has never held. The bytes are registered as already-synced
 * so the next sweep neither re-uploads nor tombstones them. False when the
 * path is unsafe or the blob cannot be fetched.
 */
export async function hydrateBlob(rel: string, sha: string): Promise<boolean> {
  if (!safeWorkspaceRel(rel) || !/^[0-9a-f]{64}$/.test(sha)) return false
  const abs = path.join(workspaceRoot(), rel)
  try {
    const size = await downloadBlobToFile(sha, abs)
    serverFiles.set(rel, { sha, size })
    if (syncablePath(rel) && underSyncRoots(rel)) {
      syncedPaths.add(rel)
      void persistOutbox()
    }
    return true
  } catch (err) {
    wlog.warn('sync', `hydrate of ${rel} from the org failed:`, err)
    return false
  }
}

/**
 * Everything this conversation's media needs from the org: its messages'
 * attachments (sha carried in the record) plus every server-side file under
 * its media directories (voice notes, TTS replies, generated videos —
 * things segments reference by path without an attachments entry).
 */
async function collectHydrationTargets(conversationId: string): Promise<HydrationTarget[]> {
  const conv = await loadConversation(conversationId)
  const targets = new Map<string, HydrationTarget>()
  if (conv) {
    for (const msg of conv.messages) {
      for (const att of msg.attachments ?? []) {
        const rel = att.filePath
        if (!rel || !safeWorkspaceRel(rel) || targets.has(rel)) continue
        const sha = (att as unknown as Record<string, unknown>).sha256
        const known = serverFiles.get(rel)
        targets.set(rel, {
          rel,
          sha: typeof sha === 'string' ? sha : (known?.sha ?? null),
          size: known?.size ?? att.sizeBytes ?? 0
        })
      }
    }
  }
  const prefixes = lazyMediaPrefixes(conversationDirName(conversationId))
  for (const [rel, meta] of serverFiles) {
    if (targets.has(rel) || !safeWorkspaceRel(rel) || !syncablePath(rel)) continue
    if (prefixes.some((prefix) => rel.startsWith(prefix))) {
      targets.set(rel, { rel, sha: meta.sha, size: meta.size })
    }
  }
  return [...targets.values()]
}

/**
 * Hydrate one conversation's media on open: download whatever is missing on
 * disk, serially, streaming per-byte progress through the
 * onHydrationProgress hook (throttled, first and final events always
 * emitted). Idempotent and deduped — concurrent opens share one flight, a
 * fully-hydrated conversation costs a directory stat pass and emits one
 * terminal event with filesTotal 0. Failures are per-file: a missing blob
 * or a network drop never breaks the transcript, and the next open retries
 * just the files still absent.
 */
export async function hydrateConversationFiles(conversationId: string): Promise<HydrationProgress> {
  const existing = hydrationFlights.get(conversationId)
  if (existing) return existing.promise

  const flight: HydrationFlight = {
    promise: (async () => {
      const progress: HydrationProgress = {
        conversationId,
        filesTotal: 0,
        filesDone: 0,
        totalBytes: 0,
        doneBytes: 0,
        current: null,
        pending: [],
        failed: 0,
        done: false
      }
      let lastEmit = 0
      const emit = (force: boolean): void => {
        const now = Date.now()
        if (!force && now - lastEmit < HYDRATION_EMIT_MS) return
        lastEmit = now
        try {
          deps.onHydrationProgress?.({ ...progress, pending: [...progress.pending] })
        } catch {
          // a listener failure never breaks the download
        }
      }
      try {
        // The path→{sha,size} map is the download index; on a launch where
        // the ready-time seeding failed (or hasn't run), fetch it now.
        if (serverFiles.size === 0) {
          await seedServerPaths().catch(() => undefined)
        }
        const root = workspaceRoot()
        const needed: HydrationTarget[] = []
        for (const target of await collectHydrationTargets(conversationId)) {
          try {
            await fs.access(path.join(root, target.rel))
          } catch {
            needed.push(target)
          }
        }
        progress.filesTotal = needed.length
        progress.totalBytes = needed.reduce((sum, t) => sum + Math.max(0, t.size), 0)
        progress.pending = needed.map((t) => t.rel)
        emit(true)

        let syncedChanged = false
        let baseBytes = 0
        for (const target of needed) {
          progress.current = target.rel
          emit(true)
          try {
            if (!target.sha) throw new SyncHttpError(404, `no server copy of ${target.rel}`)
            const abs = path.join(root, target.rel)
            const onBytes = (bytes: number): void => {
              progress.doneBytes = baseBytes + bytes
              emit(false)
            }
            let sha = target.sha
            let received: number
            try {
              received = await downloadBlobToFile(sha, abs, onBytes)
            } catch (err) {
              // The record's sha names content the path no longer holds (the
              // file changed after the message referenced it, and the server
              // keeps one live row per path): fall back to the newest row.
              const newest = serverFiles.get(target.rel)?.sha
              if (
                !(err instanceof SyncHttpError && err.status === 404) ||
                !newest ||
                newest === sha
              )
                throw err
              sha = newest
              received = await downloadBlobToFile(sha, abs, onBytes)
            }
            baseBytes += Math.max(received, target.size)
            progress.doneBytes = baseBytes
            serverFiles.set(target.rel, { sha, size: received })
            if (syncablePath(target.rel) && underSyncRoots(target.rel)) {
              syncedPaths.add(target.rel)
              syncedChanged = true
            }
          } catch (err) {
            baseBytes += Math.max(0, target.size)
            progress.doneBytes = baseBytes
            progress.failed++
            wlog.warn('sync', `hydration failed (${target.rel}):`, err)
          }
          progress.filesDone++
          progress.current = null
          progress.pending = progress.pending.filter((rel) => rel !== target.rel)
          emit(true)
        }
        if (syncedChanged) await persistOutbox().catch(() => undefined)
        return progress
      } finally {
        progress.done = true
        progress.current = null
        progress.pending = []
        emit(true)
        hydrationFlights.delete(conversationId)
      }
    })()
  }
  hydrationFlights.set(conversationId, flight)
  return flight.promise
}

/** Walk every conversation-index page starting from bootstrap's first. */
async function* conversationPages(
  first: WireConversationMeta[],
  firstNext: number | null | undefined
): AsyncGenerator<WireConversationMeta[]> {
  yield first
  let next = firstNext ?? null
  while (next !== null && next !== undefined) {
    const res = await apiJson<{ conversations: WireConversationMeta[]; next: number | null }>(
      'GET',
      `/v1/conversations?after=${next}`
    )
    yield res.conversations
    if (!(typeof res.next === 'number' && res.next > next)) break
    next = res.next
  }
}

/** Walk every file-manifest page starting from bootstrap's first. */
async function* filePages(
  first: WireFileRow[],
  firstNext: string | null | undefined
): AsyncGenerator<WireFileRow[]> {
  yield first
  let next = firstNext ?? null
  while (next) {
    const res = await apiJson<{ files: WireFileRow[]; next: string | null }>(
      'GET',
      `/v1/files/manifest?before=${encodeURIComponent(next)}`
    )
    yield res.files
    if (!res.next || res.next === next) break
    next = res.next
  }
}

/** Seed serverFiles from every manifest page (used when restore already
 *  completed on an earlier launch — restore itself seeds from bootstrap). */
async function seedServerPaths(): Promise<void> {
  const firstPage = await apiJson<{ files: WireFileRow[]; next: string | null }>(
    'GET',
    '/v1/files/manifest'
  )
  for await (const page of filePages(firstPage.files, firstPage.next)) {
    for (const f of page) {
      const name = f.name ?? ''
      if (name && !serverFiles.has(name)) {
        serverFiles.set(name, { sha: f.sha256, size: f.size ?? 0 })
      }
    }
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight. `fn` must
 *  handle its own errors — a rejection here would abandon the queue. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** sha256 of the bundled default shipped at this workspace path, or null
 *  when the defaults tree has no such file. Memoized per process. */
const bundledDefaultShas = new Map<string, string | null>()
async function bundledDefaultSha(rel: string): Promise<string | null> {
  const memo = bundledDefaultShas.get(rel)
  if (memo !== undefined) return memo
  let sha: string | null = null
  try {
    sha = sha256(await fs.readFile(path.join(defaultsWorkspacePath(), rel)))
  } catch {
    sha = null
  }
  bundledDefaultShas.set(rel, sha)
  return sha
}

/**
 * Restore this workspace from the org — durable and retryable. Runs until
 * ONE attempt completes cleanly, then never again (restore_done). Safe to
 * re-run at any time: conversations merge onto whatever is on disk (an
 * id-keyed union that can never lose local messages), blobs are only
 * written where the path is absent or still holds its bundled default, and
 * config adoption is stamp-guarded.
 */
export async function restoreFromCloud(): Promise<RestoreSummary> {
  const none: RestoreSummary = {
    attempted: false,
    completed: false,
    virgin: false,
    configAdopted: false,
    conversations: 0,
    files: 0,
    failures: 0,
    quarantined: 0
  }
  if (restoring) return none
  const state = await loadSyncState()
  if (state.restore_done) return none
  restoring = true
  const summary: RestoreSummary = { ...none, attempted: true }
  // Per-item attempt ledger. `completed` used to require literally zero
  // failures, so one conversation the server could not serve kept
  // restore_done unset forever: a full bootstrap walk on every launch, the
  // retry ladder always armed, and — because the memo is only persisted on
  // a clean pass — the file sweep re-walking and re-uploading each time.
  // Now an item that has failed RESTORE_MAX_ATTEMPTS times is skipped and
  // named, and the rest of the restore is allowed to be finished.
  const attempts = { ...state.restore_failures }
  const quarantined: string[] = []
  /** True when this item is spent — skip it, and stop counting it. */
  const isSpent = (key: string): boolean => (attempts[key] ?? 0) >= RESTORE_MAX_ATTEMPTS
  const noteFailure = (key: string): void => {
    attempts[key] = (attempts[key] ?? 0) + 1
    if (attempts[key]! >= RESTORE_MAX_ATTEMPTS) quarantined.push(key)
    else summary.failures++
  }
  try {
    const localCfg = await readConfig()
    const hadStamp = state.config_updated_at !== null
    // Virgin = a workspace that has never been lived in: the purge and
    // second-device cases. Decides whether the full blob tree materializes
    // (a lived-in workspace only heals per-message attachments — mass
    // re-materialization there would resurrect files deleted before
    // deletion tracking existed). Decided ONCE and persisted: a failed
    // first attempt may adopt config (minting a stamp) or see onboarding
    // complete before the retry, and neither is allowed to demote the
    // retry into skipping the blob tree.
    if (state.restore_fresh === null) {
      const fresh = !hadStamp && localCfg?.onboardingCompleted !== true
      await mutateSyncState((s) => {
        s.restore_fresh = fresh
      })
      summary.virgin = fresh
    } else {
      summary.virgin = state.restore_fresh
    }

    const boot = await apiJson<{
      config: Record<string, unknown>
      config_updated_at: string | null
      conversations: WireConversationMeta[]
      conversations_next?: number | null
      files: WireFileRow[]
      files_next?: string | null
    }>('GET', '/v1/sync/bootstrap')

    // Config: a stampless client adopts the existing server row (see
    // pushConfig for why this direction is the only safe one).
    if (!hadStamp && boot.config_updated_at) {
      await adoptServerConfig(boot.config ?? {}, boot.config_updated_at)
      summary.configAdopted = true
    }

    // Files: every manifest page seeds the path→sha map; a virgin
    // workspace also materializes the blobs onto their paths (newest row
    // per path wins — pages arrive newest-first), a few at a time.
    const seenPaths = new Set<string>()
    const root = workspaceRoot()
    const restoreBlob = async (f: WireFileRow & { name: string }): Promise<void> => {
      const abs = path.join(root, f.name)
      let localSha: string | null = null
      try {
        localSha = sha256(await fs.readFile(abs))
      } catch {
        localSha = null
      }
      if (localSha === f.sha256) {
        syncedPaths.add(f.name)
        return
      }
      if (localSha !== null) {
        // Something is already at this path in a virgin workspace: either a
        // bundled default the boot laid down (soul.md, heartbeat.md, the
        // knowledge stubs, the ledger header) — replaced by the org's copy —
        // or content the user produced in the seconds since sign-in, which
        // stays and syncs up like any other edit.
        if (localSha !== (await bundledDefaultSha(f.name))) {
          wlog.info('sync', `restore keeps local ${f.name} (differs from bundled default)`)
          syncedPaths.add(f.name)
          return
        }
      }
      try {
        await downloadBlobToFile(f.sha256, abs)
        syncedPaths.add(f.name)
        summary.files++
      } catch (err) {
        // A missing blob degrades to a missing file — logged, and the
        // attempt is NOT marked complete so a later retry heals it. After
        // RESTORE_MAX_ATTEMPTS it is quarantined instead: a blob the org
        // has genuinely lost must not cost the user their restore.
        wlog.warn('sync', `blob restore failed (${f.name}):`, err)
        noteFailure(`blob:${f.name}`)
      }
    }
    for await (const page of filePages(boot.files, boot.files_next)) {
      const wanted: Array<WireFileRow & { name: string }> = []
      for (const f of page) {
        const name = f.name ?? ''
        if (!name || seenPaths.has(name)) continue
        seenPaths.add(name)
        if (!serverFiles.has(name)) serverFiles.set(name, { sha: f.sha256, size: f.size ?? 0 })
        if (!summary.virgin) continue
        if (!underSyncRoots(name) || name.includes('..') || !syncablePath(name)) continue
        // Conversation media hydrates on open, with progress — never here.
        if (isLazyMediaPath(name)) continue
        // Spent its attempts on an earlier pass: the manifest row stays
        // known (it seeded serverFiles above), the download does not repeat.
        if (isSpent(`blob:${name}`)) continue
        wanted.push({ ...f, name })
      }
      await mapPool(wanted, BLOB_CONCURRENCY, restoreBlob)
    }

    // Conversations: every index page, no cap, RESTORE_CONCURRENCY at a
    // time. Each transcript rebuilds from its records and MERGES onto disk —
    // a retry, or a turn the user ran between attempts, can never be
    // clobbered. A transcript written onto an empty path is exactly what
    // the server holds, so it is memoized as pushed (and its record ids as
    // acknowledged): the sweep that follows restore has nothing to send.
    const restoreConversation = async (meta: WireConversationMeta): Promise<void> => {
      try {
        // Deleted here while the restore was in flight: the tombstone is on
        // its way to the server — don't materialize it again.
        if (pendingDeletes.has(meta.id)) return
        // Spent its attempts on earlier passes — skipped so the rest of the
        // restore can finish. The catch-up pull retries it later anyway:
        // its next server-side write puts it back in the `since` feed.
        if (isSpent(`conv:${meta.id}`)) return
        const serverUpdated = Date.parse(meta.updated_at) || 0
        const local = await loadConversation(meta.id)
        if (local && local.messages.length > 0 && local.updatedAt >= serverUpdated) {
          return // already current (an earlier attempt, or this device wrote it)
        }
        const records = await pullRecords(meta.id)
        if (records.length === 0) return
        const file = rebuildConversation(meta, records)
        let wroteFresh = false
        await updateConversation(meta.id, (disk) => {
          if (!disk) wroteFresh = true
          return disk ? mergeConversationOnto(disk, file) : file
        })
        if (wroteFresh) {
          const written = await loadConversationWithDigest(meta.id)
          if (written) pushedDigests.set(meta.id, written.digest)
          ackedRecords.set(
            meta.id,
            new Set(records.filter((r) => r.kind === 'message').map((r) => r.id))
          )
        }
        // Attachments are NOT fetched here — they hydrate when the
        // conversation is opened, with visible progress.
        summary.conversations++
      } catch (err) {
        // One bad conversation never sinks the restore — and after
        // RESTORE_MAX_ATTEMPTS it stops holding restore_done unset either.
        wlog.warn('sync', `restore of ${meta.id} failed:`, err)
        noteFailure(`conv:${meta.id}`)
      }
    }
    for await (const page of conversationPages(boot.conversations, boot.conversations_next)) {
      await mapPool(page, RESTORE_CONCURRENCY, restoreConversation)
    }

    // The usage ledger: a virgin workspace rebuilds it from the org's
    // metering table (every device's calls). Best-effort — a failure here
    // leaves usage_after null, and the next reconcile walks the table again.
    if (summary.virgin) {
      try {
        await reconcileUsage('rebuild')
      } catch (err) {
        wlog.warn('sync', 'usage ledger rebuild failed — next reconcile retries:', err)
      }
    }

    summary.quarantined = quarantined.length
    if (quarantined.length) {
      // Loud, and by name: these are the items the org could not serve
      // three times running, and the reason this restore is allowed to
      // finish without them.
      wlog.error(
        'sync',
        `restore quarantined ${quarantined.length} item(s) after ${RESTORE_MAX_ATTEMPTS} attempts each: ` +
          quarantined.join(', ')
      )
    }
    // `failures` now counts only items with attempts still to spend, so a
    // permanently-unreadable one no longer keeps every launch re-restoring.
    if (summary.failures === 0) {
      summary.completed = true
      await mutateSyncState((s) => {
        s.restore_done = true
        s.synced_paths = [...syncedPaths]
        s.pushed = Object.fromEntries(pushedDigests)
        s.restore_failures = attempts
      })
      wlog.info(
        'sync',
        `restore complete: ${summary.conversations} conversations, ${summary.files} files` +
          (summary.configAdopted ? ', config adopted' : '') +
          (quarantined.length ? `, ${quarantined.length} quarantined` : '')
      )
    } else {
      // The attempt ledger persists on the FAILING path too — it is what
      // makes "three attempts" mean three launches rather than three
      // attempts inside one process that a restart resets.
      await mutateSyncState((s) => {
        s.restore_failures = attempts
      })
      await persistOutbox().catch(() => undefined)
      wlog.warn(
        'sync',
        `restore incomplete (${summary.failures} failures) — will retry; ` +
          `${summary.conversations} conversations, ${summary.files} files so far`
      )
    }
    return summary
  } finally {
    restoring = false
  }
}

// ── Catch-up pull: conversations written somewhere else ──────────────────
//
// Restore is a one-time event; this is the steady state. Without it the
// desktop is push-only for the two largest data types, and a second signed-in
// machine diverges permanently: conversations created there never arrive,
// and a conversation deleted there stays on this screen forever.
//
// The server primitive is the one the phone already runs on every foreground
// (apps/mobile/src/lib/sync/sync.ts): `?since=<cursor>` returns rows whose
// SERVER stamp moved past the cursor — `synced_at` for writes, `deleted_at`
// for tombstones — so deletions ride the same feed as edits and no id sweep
// is needed. `include=meta` is deliberately omitted: the phone needs the
// envelope to draw a list without a body fetch, this client rebuilds the
// whole transcript from records anyway, and the meta join carries a
// per-row message-count subquery worth skipping.
//
// Three rules keep it cheap and keep it from fighting the push side:
//   · our own pushes bump `synced_at`, so this device sees its own writes
//     come back. A row whose server `updated_at` is not ahead of the local
//     file costs one local read and no network;
//   · every record id that arrives is marked acknowledged, so the push that
//     follows a merge sends only what is genuinely local-only — not the
//     transcript we just received;
//   · a conversation with a local tombstone already queued is skipped: that
//     delete is on its way and must not be undone by the row it will remove.

type WireConversationRow = WireConversationMeta & { deleted_at?: string | null }

let lastConvPullMs = 0

/**
 * One catch-up pass. Returns what changed so the caller can tell the UI.
 * A null cursor walks the index from the beginning — a couple of pages, no
 * record fetches for anything already level, and it heals an install that
 * diverged before this build.
 */
async function pullConversations(): Promise<{ changed: string[]; removed: string[] }> {
  const changed: string[] = []
  const removed: string[] = []
  let cursor = (await loadSyncState()).conversations_cursor
  // Bounded: 500 rows a page, so this is far more pages than any real
  // account has and only exists so a server that never stops handing out a
  // `next` cannot spin here forever.
  for (let page = 0; page < 2_000; page++) {
    const query = new URLSearchParams({ since: cursor ?? '', limit: String(CONV_PULL_PAGE) })
    const res = await apiJson<{
      conversations: WireConversationRow[]
      next: string | null
      cursor: string | null
    }>('GET', `/v1/conversations?${query.toString()}`)
    const rows = (res.conversations ?? []).filter(
      (row): row is WireConversationRow =>
        Boolean(row) && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0
    )
    for (const row of rows) {
      try {
        if (row.deleted_at) {
          if (await applyRemoteDelete(row.id)) removed.push(row.id)
        } else if (await applyRemoteConversation(row)) {
          changed.push(row.id)
        }
      } catch (err) {
        // One row never sinks the pass — but the cursor does NOT advance
        // past a page that failed, so the next pass retries it.
        wlog.warn('sync', `catch-up of ${row.id} failed — next pass retries:`, err)
        return { changed, removed }
      }
    }
    // Advance only after the whole page applied: the cursor is a promise
    // that everything before it is on disk.
    if (typeof res.cursor === 'string' && res.cursor && res.cursor !== cursor) {
      cursor = res.cursor
      await mutateSyncState((s) => {
        s.conversations_cursor = cursor
      })
    }
    if (!res.next) break
  }
  return { changed, removed }
}

/** A tombstone from elsewhere, applied locally. False = nothing was here. */
async function applyRemoteDelete(id: string): Promise<boolean> {
  if (pendingDeletes.has(id)) return false
  if (!(await loadConversation(id))) return false
  // notifySync: false — the org is where this tombstone CAME from; sending
  // it back would delete-loop and re-tombstone media already retired.
  await deleteConversation(id, { notifySync: false })
  pendingConversations.delete(id)
  pushedDigests.delete(id)
  ackedRecords.delete(id)
  ackedSnapshots.delete(id)
  refusedRecords.delete(id)
  wireMemo.delete(id)
  for (const rel of [...syncedPaths]) {
    if (lazyMediaPrefixes(conversationDirName(id)).some((prefix) => rel.startsWith(prefix))) {
      syncedPaths.delete(rel)
    }
  }
  await persistOutbox().catch(() => undefined)
  wlog.info('sync', `catch-up: ${id} was deleted elsewhere — removed locally`)
  return true
}

/** A conversation written elsewhere, merged onto disk. False = already level. */
async function applyRemoteConversation(row: WireConversationRow): Promise<boolean> {
  if (pendingDeletes.has(row.id)) return false
  const serverUpdated = Date.parse(row.updated_at) || 0
  const local = await loadConversation(row.id)
  // The common case by far — this device's own push echoing back, or a row
  // it already holds. One local read, no network.
  if (local && local.messages.length > 0 && local.updatedAt >= serverUpdated) return false

  const records = await pullRecords(row.id)
  if (records.length === 0) return false
  const rebuilt = rebuildConversation(row, records)
  let wroteFresh = false
  await updateConversation(row.id, (disk) => {
    if (!disk) wroteFresh = true
    // Union by message id: a turn this device ran while the other machine
    // was writing survives the merge, and so does theirs.
    return disk ? mergeConversationOnto(disk, rebuilt) : rebuilt
  })
  // Everything that just arrived is, by definition, already on the server:
  // acknowledging it here is what makes the push this write schedules send
  // only local-only messages plus the envelope, instead of the transcript
  // we were just handed.
  const acked = ackedRecords.get(row.id) ?? new Set<string>()
  for (const rec of records) if (rec.kind === 'message') acked.add(rec.id)
  ackedRecords.set(row.id, acked)
  if (wroteFresh) {
    // Nothing local to reconcile — what is on disk IS the server's copy, so
    // the scheduled push has nothing to say.
    const written = await loadConversationWithDigest(row.id)
    if (written) pushedDigests.set(row.id, written.digest)
    pendingConversations.delete(row.id)
  }
  return true
}

// ── Usage ledger reconcile ───────────────────────────────────────────────

type WireUsageRow = {
  id: number
  device_id: string | null
  model: string
  /** 'chat' (model call, the default) or 'search' (one metered web search). */
  kind?: string
  tokens_in: number
  tokens_out: number
  tokens_cached?: number
  cost_microusd: number
  decision: string
  created_at: string
}

const ledgerRowOf = (r: WireUsageRow): LedgerRow => ({
  at: new Date(r.created_at),
  model: r.model,
  inputTokens: r.tokens_in,
  outputTokens: r.tokens_out,
  cacheReadTokens: r.tokens_cached && r.tokens_cached > 0 ? r.tokens_cached : undefined,
  cost: r.cost_microusd / 1_000_000
})

/**
 * Fold the org's usage table into the local ledger. The org meters every
 * call this user makes from any device, so it is the record — the local
 * ledger files are a cache of it that the usage panel and the phone read.
 *   rebuild      (virgin restore) rewrite the ledger from every row;
 *   incremental  (steady state) append rows newer than the cursor that
 *                OTHER devices produced — this device wrote its own lines
 *                at turn end. A never-reconciled workspace (cursor null)
 *                walks the whole table once, appending other devices' rows.
 * Only spend is a ledger line (allowed decisions with tokens); denials and
 * errors are the admin console's business.
 */
async function reconcileUsage(mode: 'rebuild' | 'incremental'): Promise<void> {
  const state = await loadSyncState()
  const mine = deps.getDeviceId?.() ?? null
  let after = mode === 'rebuild' ? 0 : (state.usage_after ?? 0)
  const rows: WireUsageRow[] = []
  for (let guard = 0; guard < 10_000; guard++) {
    const res = await apiJson<{ rows?: WireUsageRow[]; next?: number | null }>(
      'GET',
      `/v1/usage?after=${after}&limit=1000`
    )
    const page = res.rows ?? []
    rows.push(...page)
    const next = res.next
    if (typeof next !== 'number' || page.length === 0 || !(next > after)) break
    after = next
  }
  const spend = rows.filter(
    (r) => r.kind !== 'search' && r.decision === 'allowed' && r.tokens_in + r.tokens_out > 0
  )
  // Web searches: the same contract on the Brave ledger — this device's
  // lines land when the plugin gets its results, other devices' fold in
  // here, and a purge rebuilds the file from the org (no query text: the
  // org never records it).
  const searches = rows.filter((r) => r.kind === 'search' && r.decision === 'allowed')
  const braveRowOf = (r: WireUsageRow): BraveLedgerRow => ({ at: new Date(r.created_at) })
  let changed = false
  if (mode === 'rebuild') {
    await rewriteLedger(workspaceRoot(), spend.map(ledgerRowOf))
    await rewriteBraveLedger(workspaceRoot(), searches.map(braveRowOf))
    changed = true
  } else {
    const foreign = mine ? spend.filter((r) => r.device_id !== mine) : spend
    for (const r of foreign) await appendLedgerRow(workspaceRoot(), ledgerRowOf(r))
    const foreignSearches = mine ? searches.filter((r) => r.device_id !== mine) : searches
    for (const r of foreignSearches) await appendBraveLedgerRow(workspaceRoot(), braveRowOf(r))
    changed = foreign.length > 0 || foreignSearches.length > 0
  }
  const lastId = rows.length ? rows[rows.length - 1]!.id : null
  await mutateSyncState((s) => {
    if (lastId !== null) s.usage_after = Math.max(s.usage_after ?? 0, lastId)
    else if (s.usage_after === null) s.usage_after = 0
  })
  if (changed) {
    try {
      deps.onUsageLedgerChanged?.()
    } catch (err) {
      wlog.warn('sync', 'onUsageLedgerChanged hook failed:', err)
    }
  }
}

// ── Session flow ─────────────────────────────────────────────────────────

function clearRestoreRetry(): void {
  if (restoreRetryTimer) {
    clearTimeout(restoreRetryTimer)
    restoreRetryTimer = null
  }
}

function scheduleRestoreRetry(): void {
  if (restoreRetryTimer) return
  const delay = RESTORE_RETRY_MS[Math.min(restoreRetryCount, RESTORE_RETRY_MS.length - 1)]
  restoreRetryCount++
  restoreRetryTimer = setTimeout(() => {
    restoreRetryTimer = null
    const status = cloudSession.getState().status
    if (status !== 'ready' && status !== 'locked') return
    void runSessionFlow()
  }, delay)
  restoreRetryTimer.unref?.()
  wlog.info('sync', `restore retry scheduled in ${Math.round(delay / 1000)}s`)
}

/**
 * Everything that happens when a session becomes usable: ownership check,
 * restore (until done), then the convergence sweep. Also the body of every
 * restore retry. Guarded against overlapping runs.
 */
async function runSessionFlow(): Promise<void> {
  if (sessionFlowActive) return
  sessionFlowActive = true
  try {
    await hydrateOutbox()

    // The workspace is a cache of ONE user's cloud record. A different
    // signed-in user must never sweep this data into their own account.
    const uid = deps.getUserId?.() ?? null
    if (uid) {
      const state = await loadSyncState()
      if (!state.owner_user_id) {
        await mutateSyncState((s) => {
          s.owner_user_id = uid
        })
      } else if (state.owner_user_id !== uid) {
        wlog.error(
          'sync',
          `workspace belongs to user ${state.owner_user_id}, session is ${uid} — sync halted`
        )
        try {
          deps.onForeignWorkspace?.(state.owner_user_id)
        } catch (err) {
          wlog.error('sync', 'onForeignWorkspace hook failed:', err)
        }
        return
      }
    }

    let summary: RestoreSummary | null = null
    const state = await loadSyncState()
    if (!state.restore_done) {
      try {
        summary = await restoreFromCloud()
      } catch (err) {
        wlog.error('sync', 'restore attempt failed:', err)
        summary = null
      }
      if (!summary || (summary.attempted && !summary.completed)) {
        scheduleRestoreRetry()
      } else {
        restoreRetryCount = 0
      }
    } else {
      // Restore already done on an earlier launch — just seed the dedupe
      // map so pushes skip content the org already holds.
      try {
        await seedServerPaths()
      } catch {
        // an optimization, never a gate
      }
    }

    if (
      summary?.completed &&
      summary.virgin &&
      (summary.configAdopted || summary.conversations > 0)
    ) {
      // Real content landed in a fresh workspace: hand the host the chance
      // to relaunch so boot-read config (channels, MCP, theme, model)
      // actually applies. restore_done is already durable, so the relaunch
      // can never re-trigger a restore loop.
      try {
        deps.onRestored?.(summary)
      } catch (err) {
        wlog.error('sync', 'onRestored hook failed:', err)
      }
    }

    // Usage: fold in what the user's other devices spent since last time
    // (a never-reconciled workspace walks the table once).
    lastUsagePullMs = Date.now()
    try {
      await reconcileUsage('incremental')
    } catch (err) {
      wlog.debug('sync', 'usage reconcile at session start failed — the drain retries:', err)
    }

    // Convergence sweep: only conversations whose file digest differs from
    // what was last pushed are queued — a launch of an unchanged workspace
    // sends nothing but its config check. The memo is checked against the
    // server's index first (two small pages for hundreds of conversations):
    // a conversation this device believes pushed that the server no longer
    // lists is re-sent whole, so the memo can never hide local data from an
    // org record that lost it.
    try {
      const digests = await listConversationDigests()
      if (pushedDigests.size > 0) {
        try {
          const first = await apiJson<{
            conversations: WireConversationMeta[]
            next: number | null
          }>('GET', '/v1/conversations?after=0')
          const onServer = new Set<string>()
          for await (const page of conversationPages(first.conversations, first.next)) {
            for (const meta of page) onServer.add(meta.id)
          }
          for (const id of [...pushedDigests.keys()]) {
            if (!onServer.has(id) && !pendingDeletes.has(id)) pushedDigests.delete(id)
          }
        } catch (err) {
          wlog.debug('sync', 'server index check skipped:', err)
        }
      }
      let queued = 0
      for (const { id, digest } of digests) {
        if (pushedDigests.get(id) === digest) continue
        pendingConversations.add(id)
        queued++
      }
      if (queued > 0)
        wlog.info('sync', `sweep: ${queued} of ${digests.length} conversations changed`)
      // Config direction is decided BEFORE the launch push: a row stamped
      // by someone else while this app was closed (an admin fixing or
      // resetting the user's settings) must be adopted, or the blind
      // re-push would bury it. Anything else falls through to pushConfig,
      // whose stampless guard reads before ever writing.
      try {
        if ((await pullForeignConfig()) === 'none') configDirty = true
      } catch {
        configDirty = true
      }
      arm()
    } catch (err) {
      wlog.error('sync', 'sweep failed:', err)
    }
  } finally {
    sessionFlowActive = false
  }
}

// ── Sign-out support ─────────────────────────────────────────────────────

/**
 * Drain everything the outbox holds, now, and report whether it is empty.
 * The sign-out path calls this before revoking the session so the purge
 * that follows can never discard a turn the org has not received; a drain
 * that cannot finish inside the deadline (offline) answers false and the
 * caller keeps the cache instead.
 */
export async function flushOutbox(timeoutMs = 20_000): Promise<boolean> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const pending = (): boolean =>
    pendingConversations.size + pendingDeletes.size + pendingFileDeletes.size > 0 || configDirty
  const deadline = Date.now() + timeoutMs
  while (pending() || draining) {
    if (Date.now() > deadline) return false
    if (draining) await new Promise((r) => setTimeout(r, 250))
    else await drain()
  }
  return true
}

// ── Factory reset & account switch support ───────────────────────────────

/**
 * Tombstone this user's entire synced record (conversations + files). The
 * factory-reset path calls this so "wipe my data" wipes the org copy too —
 * otherwise the next purge+sign-in would resurrect everything.
 */
export async function wipeCloudData(): Promise<{ conversations: number; files: number }> {
  return apiJson('POST', '/v1/sync/wipe')
}

/**
 * Stamp a just-reset workspace so the next launch does NOT run a restore
 * (which would resurrect what factory reset intentionally erased). Written
 * AFTER the reset recreated the workspace directory.
 */
export async function markWorkspaceReset(ownerUserId: string | null): Promise<void> {
  syncStateMemo = undefined
  await mutateSyncState((s) => {
    Object.assign(s, emptySyncState())
    s.restore_done = true
    s.restore_fresh = false
    s.owner_user_id = ownerUserId
  })
}

// ── Wiring ───────────────────────────────────────────────────────────────

export function initCloudSync(injected: CloudSyncDeps = {}): void {
  deps = injected
  setConversationSyncHook((event, id) => {
    if (event === 'deleted') scheduleConversationDelete(id)
    else scheduleConversationPush(id)
  })
  setConfigSyncHook(() => scheduleConfigPush())

  const interval = setInterval(() => {
    const status = cloudSession.getState().status
    if (status === 'ready' || status === 'locked') arm()
  }, 120_000)
  interval.unref?.()

  cloudSession.onState((state) => {
    const authenticated = state.status === 'ready' || state.status === 'locked'
    if (!authenticated) {
      sessionAuthenticated = false
      clearRestoreRetry()
      return
    }
    if (sessionAuthenticated) {
      // Same session, a UI-only transition (lock/unlock, a profile save, a
      // PIN change): the outbox may drain, but nothing warrants a new
      // ownership check, restore attempt, or sweep.
      arm()
      return
    }
    sessionAuthenticated = true
    void runSessionFlow()
  })
}
