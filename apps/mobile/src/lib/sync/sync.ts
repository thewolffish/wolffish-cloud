import { hydrateOverflow, rebuildConversation, type RebuiltConversation } from '@/lib/sync/rebuild'
import { coalesceTextSegments, messageFilePaths } from '@/lib/conversations/segments'
import type { ConversationMessage, Segment } from '@/lib/conversations/types'
import { getDb, withExclusiveTransaction } from '@/lib/db/database'
import { resolveWorkspaceFile } from '@/lib/files/fileCache'
import { bridgeClient } from '@/lib/cloud/bridge'
import { cloudSession } from '@/lib/cloud/session'
import {
  conversationRecords,
  conversationsSince,
  fileTextBySha,
  usageDays as fetchUsageDays,
  type WireConversationRow,
  type WireRecord
} from '@/lib/cloud/api'
import { fetchConfigSnapshot } from '@/lib/sync/snapshot'
import { Event, type ConversationMeta } from '@/lib/bridge/protocol'
import {
  applyVariablesPush,
  refreshConfigSnapshot,
  applyPushedSnapshot,
  useDemoConfig,
  type ConfigSnapshot
} from '@/state/demoConfig'
import { pushCapability, setOutboxRefreshHook } from '@/lib/sync/outbox'
import { applyRunsPush, invalidateAutomations, readRuns } from '@/lib/sync/automations'
import { applyOverlayReindex, readReindex } from '@/lib/sync/overlays'
import { applyUpdaterPush, readUpdaterState } from '@/lib/sync/updater'
import { invalidateProcedures } from '@/lib/sync/procedures'
import { invalidateProjects } from '@/lib/sync/projects'
import { usageDaysFromWire } from '@/lib/usage/ledger'
import { useAppStore } from '@/state/appStore'
import { useBadges } from '@/state/badges'
import { useChatRuntime } from '@/state/chatRuntime'
import { clearConversationBadges, getActiveConversation } from '@/lib/notifications/push'
import { clearConversationDirty } from '@/lib/sync/dirty'
import { invalidateConversation, invalidateConversationList } from '@/lib/conversations/cache'
import { beginSync } from '@/lib/sync/activity'

/**
 * Sync with the org — the phone's copy of the user's record.
 *
 * The shape mirrors demo mode deliberately. Demo mode downloads a bundle into
 * SQLite and applies a config snapshot; paired mode pulls the same things
 * from the ORG instead of the CDN: the settings snapshot the desktop keeps
 * synced (fresh from the desktop itself while it is on the bridge), the
 * conversation index, and usage. Every screen downstream reads the same
 * local store either way and cannot tell the difference.
 *
 * What travels up front is deliberately small: conversation METADATA only —
 * a real workspace is hundreds of conversations and close to a gigabyte of
 * message bodies, and a phone opens one conversation at a time, so bodies
 * are fetched on open (the org's record pages, rebuilt exactly as the
 * desktop rebuilds them after a purge) and cached after.
 *
 * Nothing here needs the desktop to be awake. The desktop is needed to RUN
 * things — turns, edits — and lib/sync/prompt and the outbox own that; the
 * bridge's pushes are what keep this mirror live in between, and the org's
 * `since` cursor is what brings it level after time away.
 */

export type SyncPhase = 'connect' | 'config' | 'conversations' | 'usage' | 'done'

export type SyncProgress = {
  phase: SyncPhase
  /** 0–1 across the whole run, so one bar can show the lot. */
  ratio: number
  /** Rows written so far, for the "N of M" line. */
  imported: number
  total: number
}

export type SyncResult = { conversations: number; at: number }

/** Weighting so the bar moves in proportion to real work, not step count. */
const PHASE_START: Record<SyncPhase, number> = {
  connect: 0,
  config: 0.1,
  conversations: 0.25,
  usage: 0.9,
  done: 1
}

/**
 * First sync after pairing: config, the full conversation index, and usage.
 * Safe to re-run — every write is an upsert keyed by conversation id, so a
 * failed run leaves a partial index that the next run completes rather than
 * duplicating.
 */
export async function initialSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
  const report = (phase: SyncPhase, within = 0, imported = 0, total = 0): void => {
    const start = PHASE_START[phase]
    const next = phase === 'done' ? 1 : PHASE_START[nextPhase(phase)]
    onProgress?.({
      phase,
      ratio: Math.min(1, start + (next - start) * Math.min(1, Math.max(0, within))),
      imported,
      total
    })
  }

  report('connect', 1)

  // 1. Config — the settings surface, straight into the same store demo mode
  //    fills, so every settings screen works with no branch. A workspace the
  //    desktop has not written a snapshot for yet (its first launch on this
  //    account) is not a failure: the screens render their defaults until
  //    the desktop's next config change lands one.
  report('config', 0)
  const snapshot = (await fetchConfigSnapshot()) as ConfigSnapshot | null
  if (snapshot) useDemoConfig.getState().applySnapshot(snapshot)
  report('config', 1)

  // 2. Conversation index — metadata only, every page from the beginning.
  report('conversations', 0)
  await setSyncCursor('')
  const pulled = await pullIndex((done) => report('conversations', 0.5, done, 0))
  report('conversations', 1, pulled.upserted, pulled.upserted)

  // 3. Usage — the org's ledger, folded per day, for the Usage screen.
  report('usage', 0)
  await refreshUsage().catch(() => undefined)
  report('usage', 1)

  invalidateConversationList()
  noteSynced()
  report('done', 1, pulled.upserted, pulled.upserted)
  return { conversations: pulled.upserted, at: Date.now() }
}

function nextPhase(phase: SyncPhase): SyncPhase {
  const order: SyncPhase[] = ['connect', 'config', 'conversations', 'usage', 'done']
  return order[Math.min(order.length - 1, order.indexOf(phase) + 1)]
}

/**
 * Walk the org's index from the stored cursor: rows whose server stamp moved
 * past it, tombstones included. Every page is applied as it lands and the
 * cursor advances with it, so an interrupted pull resumes where it stopped
 * rather than starting over.
 */
async function pullIndex(
  onProgress?: (done: number) => void
): Promise<{ upserted: number; removed: number; changedIds: string[] }> {
  let since = await getSyncCursor()
  let upserted = 0
  let removed = 0
  const changedIds: Array<{ id: string; updatedAt: number }> = []
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await cloudSession.withAccessToken((token) => conversationsSince(token, since))
    // A malformed row is not a conversation, it is a bad frame — dropped
    // before anything reads it, so it can neither throw nor become a ghost.
    const rows = (page.conversations ?? []).filter(
      (row): row is WireConversationRow =>
        Boolean(row) && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0
    )
    const live = rows.filter((row) => !row.deleted_at)
    const dead = rows.filter((row) => Boolean(row.deleted_at))
    if (live.length) await upsertConversations(live.map(toMeta))
    for (const row of dead) {
      if (await deleteConversation(row.id)) removed++
      clearConversationBadges(row.id)
    }
    upserted += live.length
    for (const row of live)
      changedIds.push({ id: row.id, updatedAt: Date.parse(row.updated_at) || 0 })
    onProgress?.(upserted)
    const cursor = typeof page.cursor === 'string' ? page.cursor : null
    if (cursor && cursor !== since) {
      since = cursor
      await setSyncCursor(cursor)
    }
    if (!page.next) break
  }
  changedIds.sort((a, b) => b.updatedAt - a.updatedAt)
  return { upserted, removed, changedIds: changedIds.map((row) => row.id) }
}

/**
 * Catch-up sync: ask only for what changed since the last cursor.
 *
 * The phone is often asleep while the desktop keeps working, so this runs on
 * every foreground and whenever a screen that renders org-owned data opens.
 * Cheap by construction — an unchanged record answers with an empty page —
 * and complete: deletions ride the same cursor as tombstones, so a
 * conversation deleted while the phone was away converges without a full id
 * sweep.
 */
export async function refreshSync(
  _withIds = false
): Promise<{ changed: number; removed: number; changedIds: string[] }> {
  const pulled = await pullIndex()
  if (pulled.upserted || pulled.removed) invalidateConversationList()
  // Every changed conversation's own query too, not just the list. The one
  // on screen is the one that matters: its query pinned a body it judged
  // current before this pull moved updated_at; invalidated, the mounted
  // screen re-reads against the fresh metadata and fetches exactly when it
  // is behind.
  for (const id of pulled.changedIds) invalidateConversation(id)
  noteSynced()
  return { changed: pulled.upserted, removed: pulled.removed, changedIds: pulled.changedIds }
}

/**
 * Everything the phone mirrors, brought level with the org in one pass:
 * settings, the conversation index (deletions included), and usage.
 *
 * This is what runs on every connection and every return to the foreground
 * — the answer to "the phone was off and missed the events". Silent by
 * design: it reports nothing and shows nothing, because the user did not ask
 * for it. Each half is independent, so a part that cannot be answered still
 * leaves the others up to date.
 */
export async function reconcile(): Promise<void> {
  const progress = beginSync()
  let settings = false
  let conversations = false
  let changedIds: string[] = []
  try {
    await Promise.allSettled([
      refreshConfig().finally(() => {
        settings = true
        progress.step({ settings, conversations })
      }),
      refreshSync(true)
        .then((result) => {
          changedIds = result.changedIds
        })
        .finally(() => {
          conversations = true
          progress.step({ settings, conversations })
        }),
      refreshUsage()
    ])
  } finally {
    // Always, including on failure: an overlay left up after a sync that
    // gave up is worse than the failed sync.
    progress.end()
  }
  // Bodies, for the conversations that moved while the phone was away — the
  // half a metadata pull cannot deliver. Bounded and newest-first: only
  // conversations whose body is already on the device refetch (the rest
  // download on open, as ever), and a week of catch-up must not become a
  // download storm on the connect edge.
  for (const id of changedIds.slice(0, RECONCILE_BODY_REFRESH_MAX)) {
    await refreshChangedBody(id).catch(() => undefined)
  }
}

/** How many changed conversations a single reconcile refreshes the bodies
 *  of. The rest stay metadata-fresh and download on open. */
const RECONCILE_BODY_REFRESH_MAX = 4

/** The org's usage ledger, folded per local day, into the config store. */
export async function refreshUsage(): Promise<void> {
  const tz = -new Date().getTimezoneOffset()
  const wire = await cloudSession.withAccessToken((token) => fetchUsageDays(token, tz))
  useDemoConfig.getState().setUsageDays(usageDaysFromWire(wire.days ?? []))
}

/**
 * The settle path for a conversation whose turn just ended — registered by
 * sync/prompt.ts (which owns live turns and cannot be imported from here
 * without a cycle). Routing through it rather than fetching directly is what
 * releases the live overlay once the stored copy holds the turn's message.
 */
let settleHook: ((conversationId: string) => void) | null = null

export function setConversationSettleHook(hook: (conversationId: string) => void): void {
  settleHook = hook
}

/**
 * Bring one changed conversation's BODY level with the org, respecting the
 * live-turn contract. One rule set, shared by the push handlers and
 * reconcile's catch-up pass, so the signals cannot disagree:
 *
 *  - a turn still streaming fetches nothing — the assistant message is not in
 *    the org yet, and a mid-turn body is the transcript from BEFORE the turn;
 *  - a turn just ended routes through the settle path, which fetches AND
 *    releases the live overlay against the stored copy;
 *  - otherwise, a cached-but-stale body refetches. A conversation never
 *    opened has nothing here to go stale and downloads on open, as ever.
 */
async function refreshChangedBody(id: string): Promise<void> {
  const live = useChatRuntime.getState().streams[id]
  if (live?.status === 'streaming') return
  if (live) {
    settleHook?.(id)
    return
  }
  if ((await hasCachedBody(id)) && (await isBodyStale(id))) {
    const fetched = await fetchConversationBody(id).catch(() => false)
    if (fetched) invalidateConversation(id)
  }
}

/**
 * When the last catch-up finished. Persisted in sync_meta beside the cursor:
 * "last synced" is a fact about the data on this device, and the data
 * survives a relaunch, so the timestamp must too.
 */
let lastSyncedAt: number | null = null
let lastSyncedHydrated = false

function noteSynced(): void {
  lastSyncedAt = Date.now()
  lastSyncedHydrated = true
  void setMeta('lastSyncedAt', String(lastSyncedAt)).catch(() => undefined)
}

export function getLastSyncedAt(): number | null {
  if (!lastSyncedHydrated) {
    lastSyncedHydrated = true
    void getMeta('lastSyncedAt')
      .then((value) => {
        const at = Number(value)
        if (at && lastSyncedAt === null) lastSyncedAt = at
      })
      .catch(() => undefined)
  }
  return lastSyncedAt
}

/**
 * Coalesce a burst of change signals into one snapshot fetch.
 *
 * The desktop announces a config change on every path that touches settings,
 * and a single user action there can fire several. Each one is a whole
 * snapshot to pull, so the phone waits for the burst to settle instead of
 * fetching once per signal.
 */
let configRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleConfigRefresh(): void {
  if (configRefreshTimer) clearTimeout(configRefreshTimer)
  configRefreshTimer = setTimeout(() => {
    configRefreshTimer = null
    void refreshConfig().catch(() => undefined)
  }, 250)
}

// A failed outbox send leaves this phone claiming a value the desktop never
// took; the outbox asks for a refresh through here to re-align. Registered at
// module scope so the hook exists before the first edit could need it.
setOutboxRefreshHook(scheduleConfigRefresh)

/**
 * Pull the newest config without touching conversations — for settings
 * screens and change pushes. One fetch at a time, with a trailing rerun:
 * concurrent pulls could apply out of order, so late callers share the
 * running fetch, and a signal that arrives mid-flight queues exactly one
 * more round after it.
 */
let configRefreshRunning: Promise<void> | null = null
let configRefreshAgain = false

export function refreshConfig(): Promise<void> {
  if (configRefreshRunning) {
    configRefreshAgain = true
    return configRefreshRunning
  }
  configRefreshRunning = (async () => {
    try {
      do {
        configRefreshAgain = false
        await refreshConfigSnapshot()
      } while (configRefreshAgain)
    } finally {
      configRefreshRunning = null
    }
  })()
  return configRefreshRunning
}

/**
 * Flip one capability — the write path that makes the Capabilities screen's
 * toggle real on the paired desktop rather than cosmetic. The local store
 * updates first so the switch answers the finger instantly; the outbox then
 * owns the wire. Demo mode keeps its offline behavior; paired but the
 * desktop away refuses, exactly like setConfigValue.
 */
export function setCapabilityEnabled(name: string, enabled: boolean): void {
  const store = useDemoConfig.getState()
  if (!useAppStore.getState().paired) {
    store.setMapEntry('capabilities', name, enabled)
    return
  }
  if (!bridgeClient.connected) return
  store.setMapEntry('capabilities', name, enabled)
  pushCapability(name, enabled)
}

/**
 * Subscribe to the desktop's pushes so the phone feels live rather than
 * polled: a conversation started on the desktop appears here immediately,
 * the same way it appears in the desktop's own list.
 */
export function attachLiveUpdates(): () => void {
  const bridge = bridgeClient.active
  if (!bridge) return () => undefined

  bridge.onEvent(Event.conversationUpserted, (payload) => {
    const meta = payload as ConversationMeta
    void upsertConversations([meta]).then(() => {
      invalidateConversationList()
      if (!meta?.id) return
      // Unconditionally: a mounted screen showing this conversation must
      // re-read against the metadata that just landed.
      invalidateConversation(meta.id)
    })
  })

  // The desktop's push of the records to the org completed — the one signal
  // that means "the body in the org is the one you just watched". Metadata
  // pushes say the desktop changed; this says the org has it.
  bridge.onEvent(Event.conversationSynced, (payload) => {
    const { id, updatedAt } = (payload ?? {}) as { id?: string; updatedAt?: number }
    if (!id) return
    void (async () => {
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
        const db = await getDb()
        await db.runAsync('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?', [
          updatedAt,
          id
        ])
      }
      await refreshChangedBody(id)
      invalidateConversation(id)
    })().catch(() => undefined)
  })

  bridge.onEvent(Event.conversationDeleted, (payload) => {
    const id = (payload as { id?: string })?.id
    if (id) {
      clearConversationBadges(id)
      void deleteConversation(id).then(invalidateConversationList)
    }
  })

  // The desktop sends its fresh snapshot with the change when it has one —
  // applied straight in (the outbox's dirty keys still win); otherwise a
  // debounced fetch lands it.
  bridge.onEvent(Event.configChanged, (payload) => {
    const snapshot = (payload as { snapshot?: unknown } | null)?.snapshot
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      Array.isArray((snapshot as ConfigSnapshot).capabilities)
    ) {
      applyPushedSnapshot(snapshot as ConfigSnapshot)
      return
    }
    scheduleConfigRefresh()
  })

  bridge.onEvent(Event.variablesChanged, (payload) => {
    applyVariablesPush((payload as { variables?: unknown })?.variables)
  })

  // Usage moves on every scored turn from any channel; the org's ledger is
  // the record, one small read away.
  bridge.onEvent(Event.usageChanged, () => {
    void refreshUsage().catch(() => undefined)
  })

  bridge.onEvent(Event.projectsChanged, () => {
    invalidateProjects()
  })

  bridge.onEvent(Event.proceduresChanged, () => {
    invalidateProcedures()
  })

  bridge.onEvent(Event.automationsChanged, () => {
    invalidateAutomations()
  })

  bridge.onEvent(Event.automationRunsChanged, (payload) => {
    applyRunsPush(readRuns(payload))
    invalidateAutomations()
  })

  bridge.onEvent(Event.reindexChanged, (payload) => {
    applyOverlayReindex(readReindex(payload))
  })

  bridge.onEvent(Event.updaterChanged, (payload) => {
    applyUpdaterPush(readUpdaterState(payload))
  })

  return () => undefined
}

/** Whether this conversation's messages are on the device at all. */
async function hasCachedBody(id: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    [id]
  )
  return (row?.count ?? 0) > 0
}

// --------------------------------------------------------------- persistence

/** An org index row as the local table stores it. */
function toMeta(row: WireConversationRow): ConversationMeta {
  const updatedAt = Date.parse(row.updated_at) || Date.now()
  return {
    id: row.id,
    title: row.title ?? '',
    model: typeof row.model === 'string' ? row.model : null,
    channel: typeof row.channel === 'string' ? row.channel : null,
    icon: typeof row.icon === 'string' ? row.icon : null,
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    sealed: row.sealed === 1 || row.sealed === true,
    createdAt: Date.parse(row.created_at) || updatedAt,
    updatedAt,
    messageCount: typeof row.message_count === 'number' ? row.message_count : 0,
    stats: row.stats ?? null,
    summary: typeof row.summary === 'string' ? row.summary : null
  }
}

/**
 * Upsert metadata. Conflicts resolve last-write-wins on `updated_at`: whoever
 * edited most recently owns the row, which matches how the two apps are used
 * — one person, two screens, never a merge.
 */
async function upsertConversations(
  rows: ConversationMeta[],
  onProgress?: (done: number) => void
): Promise<void> {
  // A row without a string id is not a conversation, it is a malformed
  // frame — and INSERTed it becomes a NULL-keyed ghost nothing can delete.
  rows = rows.filter((row) => typeof row?.id === 'string' && row.id.length > 0)
  if (!rows.length) return
  const db = await getDb()
  let done = 0
  await withExclusiveTransaction(db, async (tx) => {
    for (const row of rows) {
      await tx.runAsync(
        `INSERT INTO conversations
           (id, title, model, channel, icon, project_id, sealed, created_at, updated_at,
            message_count, stats_json, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           model = COALESCE(excluded.model, conversations.model),
           channel = COALESCE(excluded.channel, conversations.channel),
           icon = COALESCE(excluded.icon, conversations.icon),
           project_id = excluded.project_id,
           sealed = excluded.sealed,
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           stats_json = COALESCE(excluded.stats_json, conversations.stats_json),
           summary = COALESCE(excluded.summary, conversations.summary)
         WHERE excluded.updated_at >= conversations.updated_at`,
        [
          row.id,
          row.title ?? '',
          row.model ?? null,
          row.channel ?? null,
          row.icon ?? null,
          row.projectId ?? null,
          row.sealed ? 1 : 0,
          row.createdAt ?? row.updatedAt ?? Date.now(),
          row.updatedAt ?? Date.now(),
          row.messageCount ?? 0,
          row.stats ? JSON.stringify(row.stats) : null,
          row.summary ?? null
        ]
      )
      done += 1
      if (onProgress && done % 25 === 0) onProgress(done)
    }
  })
  onProgress?.(done)
}

async function deleteConversation(id: string): Promise<boolean> {
  const db = await getDb()
  // Everything except the conversation ON SCREEN: a tombstone for the open
  // one would yank the transcript out from under the user; it goes on the
  // first sweep after they leave it (its query re-asks the org on open).
  if (getActiveConversation() === id) return false
  await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id])
  const res = await db.runAsync('DELETE FROM conversations WHERE id = ?', [id])
  return (res.changes ?? 0) > 0
}

/**
 * Fetch one conversation's messages from the org. Called when the user
 * opens it, never up front — this is the whole reason the index carries
 * metadata alone.
 *
 * Single-flight per conversation, with a trailing rerun: three callers can
 * want the same body inside one second — the open query, the settle after
 * a finished turn, the push that follows the org's write — and a caller
 * arriving mid-fetch joins the flight and asks for one rerun after it, so
 * everyone resolves against the freshest copy, downloaded once.
 */
export function fetchConversationBody(id: string): Promise<boolean> {
  const active = bodyFetches.get(id)
  if (active) {
    active.again = true
    return active.run
  }
  const entry = { again: false, run: Promise.resolve(false) }
  entry.run = (async () => {
    try {
      let fetched = false
      do {
        entry.again = false
        fetched = await fetchConversationBodyOnce(id)
      } while (entry.again)
      return fetched
    } finally {
      bodyFetches.delete(id)
    }
  })()
  bodyFetches.set(id, entry)
  return entry.run
}

const bodyFetches = new Map<string, { again: boolean; run: Promise<boolean> }>()

async function pullRecords(conversationId: string): Promise<WireRecord[] | null> {
  const all: WireRecord[] = []
  let after = 0
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await cloudSession.withAccessToken((token) =>
      conversationRecords(token, conversationId, after)
    )
    if (!Array.isArray(page?.records)) return null
    all.push(...page.records)
    const next = page.next_after
    if (typeof next !== 'number' || page.records.length === 0 || !(next > after)) break
    after = next
  }
  // Spilled bodies come back here, through the owner's own blob route, so
  // the phone holds the same message the desktop holds — not the 4,000-char
  // preview the record carries. A body that will not come — the blob gone,
  // the network gone, the token unrefreshable — keeps its preview and is
  // tried again on the next pull (hydrateOverflow); it never fails a pull
  // whose pages already landed.
  return hydrateOverflow(all, ownerOverflowBody, {
    onMiss: (sha, err) =>
      console.warn(
        `[sync] overflow body ${sha.slice(0, 12)} unavailable — keeping the preview:`,
        err
      )
  })
}

const ownerOverflowBody = (sha: string): Promise<string> =>
  cloudSession.withAccessToken((token) => fileTextBySha(token, sha))

async function fetchConversationBodyOnce(id: string): Promise<boolean> {
  if (!cloudSession.isSignedIn) return false
  const db = await getDb()

  // body_synced_at answers WHICH VERSION is the copy on this device, and the
  // honest answer travels with the copy: the envelope's own updatedAt, the
  // same number the index and the desktop's pushes carry — never this
  // phone's clock, which is not synchronized with the desktop's.
  const before = await db.getFirstAsync<{ updated_at: number }>(
    'SELECT updated_at FROM conversations WHERE id = ?',
    [id]
  )
  const askedAt = before?.updated_at ?? 0

  let records: WireRecord[] | null
  try {
    records = await pullRecords(id)
  } catch {
    return false
  }
  if (records === null) return false
  const body = rebuildConversation(records)
  const syncedTo = body.updatedAt ?? askedAt
  const messages = body.messages
  // An empty answer over a NON-empty local copy is refused: nothing in the
  // product empties a conversation in place — deletion removes it whole,
  // and that arrives as a tombstone — so a served [] for a transcript this
  // phone holds is the desktop's push racing this read, not a fact. A live
  // overlay extends the refusal to a conversation with nothing cached yet:
  // the turn this phone is rendering has not reached the org.
  if (messages.length === 0) {
    if (await hasCachedBody(id)) return false
    if (useChatRuntime.getState().streams[id]) return false
  }
  await withExclusiveTransaction(db, async (tx) => {
    await tx.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id])
    let seq = 0
    for (const message of messages) {
      // Compact at the store boundary: adjacent same-run text folds into one
      // segment here, once, so SQLite and every render after it hold the
      // compact shape.
      let payload = message.payload
      if (payload && Array.isArray(payload.segments)) {
        payload = { ...payload, segments: coalesceTextSegments(payload.segments as Segment[]) }
      }
      await tx.runAsync(
        `INSERT INTO messages (conversation_id, seq, id, role, content, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seq++,
          message.id,
          message.role,
          message.content ?? '',
          message.timestamp ?? Date.now(),
          payload ? JSON.stringify(payload) : null
        ]
      )
    }
    // Stamped inside the same transaction as the rows it describes, so a
    // failed write can never leave the phone believing it is current.
    await tx.runAsync(
      'UPDATE conversations SET body_synced_at = ?, message_count = ? WHERE id = ?',
      [syncedTo, messages.length, id]
    )
  })
  clearConversationDirty(id)
  // Every file this conversation shows, pulled into the cache now rather
  // than when its card scrolls into view. Only for the conversation on
  // screen (or an open that outran the focus report); background fetches
  // keep fresh transcripts and download their files on open.
  const active = getActiveConversation()
  if (active === null || active === id) {
    void prefetchConversationFiles(id, referencedFiles(messages))
  }
  return true
}

/**
 * The workspace paths a fetched body renders, unioned across its messages,
 * each with the content hash the desktop stamped on the attachment when it
 * synced it (a direct download, no path lookup).
 */
function referencedFiles(
  messages: RebuiltConversation['messages']
): Array<{ relPath: string; sha256: string | null }> {
  const seen = new Map<string, string | null>()
  for (const message of messages) {
    const payload = (message.payload ?? {}) as Partial<ConversationMessage> & {
      attachments?: Array<{ filePath?: string; sha256?: string }>
    }
    const full: ConversationMessage = {
      ...payload,
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content ?? '',
      timestamp: message.timestamp
    }
    for (const relPath of messageFilePaths(full)) if (!seen.has(relPath)) seen.set(relPath, null)
    for (const att of payload.attachments ?? []) {
      if (att?.filePath && typeof att.sha256 === 'string') seen.set(att.filePath, att.sha256)
    }
  }
  return [...seen.entries()].map(([relPath, sha256]) => ({ relPath, sha256 }))
}

/** One file at a time: a burst of parallel downloads would only compete
 *  with the file the user is actually looking at. */
async function prefetchConversationFiles(
  conversationId: string,
  files: Array<{ relPath: string; sha256: string | null }>
): Promise<void> {
  for (const file of files) {
    try {
      await resolveWorkspaceFile(file.relPath, conversationId, file.sha256 ?? undefined)
    } catch {
      // A file that will not come is the viewer's problem to report.
    }
  }
}

/**
 * Has this conversation changed at the org since its body was pulled? A body
 * is only skipped when it is empty *and* current, never merely because it
 * has messages in it.
 */
export async function isBodyStale(id: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ updated_at: number; body_synced_at: number | null }>(
    'SELECT updated_at, body_synced_at FROM conversations WHERE id = ?',
    [id]
  )
  if (!row) return false
  return row.body_synced_at === null || row.updated_at > row.body_synced_at
}

// ------------------------------------------------------------------- cursor

/**
 * The cursor lives in SQLite beside the rows it describes, so it can never
 * disagree with them — a cleared database resyncs from zero automatically.
 */
async function ensureMeta(): Promise<void> {
  const db = await getDb()
  await db.execAsync('CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)')
}

async function getMeta(key: string): Promise<string | null> {
  await ensureMeta()
  const db = await getDb()
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_meta WHERE key = ?',
    [key]
  )
  return row?.value ?? null
}

async function setMeta(key: string, value: string): Promise<void> {
  await ensureMeta()
  const db = await getDb()
  await db.runAsync(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  )
}

/** The org's `since` cursor — '' means "from the beginning". A cursor left
 *  by the relay-era app (a bare epoch number) is treated as none. */
export async function getSyncCursor(): Promise<string> {
  const stored = await getMeta('cursor')
  if (!stored || !/T/.test(stored)) return ''
  return stored
}

async function setSyncCursor(cursor: string): Promise<void> {
  await setMeta('cursor', cursor)
}
