/**
 * The Mobile channel — the desktop end of the org bridge to wolffish-mobile.
 *
 * Structurally a sibling of the terminal channel: it owns a transport,
 * exposes status to the settings panel, and serves the agent's world to a
 * remote surface. What differs is the shape of that surface: a terminal is
 * a message stream; the phone is a second view of the whole app.
 *
 * What this channel serves has SHRUNK on purpose. The phone is a signed-in
 * device of the same org user now, so everything durable — the conversation
 * index and bodies, workspace files, usage, the config snapshot the desktop
 * writes to `brain/mobile/snapshot.json` — it reads straight from the API.
 * What remains here is what only a running desktop can do: run a turn and
 * stream it, park a question or an approval, apply a settings write through
 * this app's own code paths, and say what it is busy with. All of it rides
 * the bridge (cloud/bridge.ts): one WebSocket to the org's UserBridge, held
 * for as long as the session is signed in, over which the phone's RPCs
 * arrive and this desktop's pushes leave.
 *
 * The desktop PARKS on the bridge: it must be there whenever a phone decides
 * to open, which is most often when nothing here is watching. The phone
 * dials in when it is in the foreground and disappears when iOS suspends it,
 * which is why nothing here assumes continuity.
 */
import { buildConfigSnapshot, type SnapshotSources } from '@main/channels/mobile/snapshot'
import { API_BASE } from '@main/cloud/api'
import type { BridgeClient, BridgeState } from '@main/cloud/bridge'
import {
  assistantSegmentsToHistory,
  buildAssistantMessage,
  replayWindow,
  stubStaleToolResults,
  type AssistantAccumulator,
  type MirrorMessageListener
} from '@main/channels/channel'
import { extractTranscript, extractVoiceLanguage } from '@main/channels/stt-result'
import { fitMirrorMessage } from '@main/channels/mirror-budget'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import type { CorpusEvents } from '@main/runtime/corpus'
import {
  createConversation,
  loadConversation,
  mintMessageId,
  saveConversation,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type MessageAttachment
} from '@main/conversations'
import {
  adoptUploadedProcedureFile,
  createProcedure,
  deleteProcedure,
  listProcedures,
  updateProcedure,
  type Procedure,
  type ProcedureFileRef
} from '@main/procedures'
import {
  adoptUploadedProjectFile,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type Project,
  type ProjectFileRef
} from '@main/projects'
import { nextCronMs } from '@main/runtime/cronNext'
import type { QueuedJobInfo, RunningJobInfo } from '@main/runtime/brainstem'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import { classifyFile, resolveUploadPath, statUpload, uploadExists } from '@main/uploads/uploads'
import { adoptUploadedAutomationFile } from '@main/automations/files'
import { resolveWorkingDirectory } from '@main/uploads/owned-copies'
import { readViewerFile, writeViewerFile } from '@main/viewer'
import { workspaceRoot } from '@main/workspace/root'
import {
  CODE_TTL_MS,
  Event,
  PUSH_WIRE_VERSION,
  Rpc,
  type AutomationJob,
  type AutomationRuns,
  type ConversationMeta,
  type DiagnosticProgress,
  type DiagnosticResult,
  type NotifyFrame,
  type NotifyResultFrame,
  type OverlaySeed,
  type ReindexStatus,
  type SyncProcedure,
  type SyncProject,
  type UpdaterWireState
} from '@main/cloud/bridge-protocol'
import {
  MOBILE_CAPABILITY_NAME,
  TTL_BY_PHASE,
  buildMobileCapability,
  mintNotificationId,
  type NotifyPhoneRequest
} from '@main/channels/mobile/tools'
import type { TurnRunner } from '@main/channels/turn-runner'
import type { TurnSink } from '@main/channels/channel'
import { appendTextSegment, upsertWorkflowSegment, type Segment } from '@main/runtime/broca'
import type { ApprovalDecision, ApprovalRequest } from '@main/runtime/amygdala'
import type { AskUserAnswer, AskUserRequest, AskUserResponse } from '@main/runtime/cerebellum'
import type { ChatHistoryMessage } from '@preload/index'
import path from 'node:path'

/**
 * Min gap between live mirror snapshots of an in-flight turn — the same budget
 * the Electron and terminal mirrors use, for the same reason: a fast text
 * stream must not emit (and make the phone re-render) per token.
 */
const MIRROR_THROTTLE_MS = 500

/**
 * How long a notify waits for the bridge's notify_result before reporting the
 * notification as dropped. The bridge tries the live phone first (a two-
 * second ack window) and only then the push service, so a healthy answer
 * takes at most a few seconds — this only fires against a bridge that has
 * gone away mid-call.
 */
const NOTIFY_RESULT_TIMEOUT_MS = 15_000

/** How often an open offer is re-read from the org while the bridge cannot
 *  announce the claim itself (the socket down, or mid-reconnect). */
const OFFER_POLL_MS = 3_000

/**
 * Ceiling on one mirrored message, well under the bridge's 1 MiB frame cap.
 * Events are single frames — nothing chunks them — so an oversized push is not
 * a slow push, it is a closed connection (CloseCode.MessageTooLarge). A turn
 * that accumulates more (a few large tool outputs) is TRIMMED to fit — tool
 * payloads shortened oldest-first, the live edge kept whole — never withheld:
 * withholding is how a 12-minute Gmail sweep once went dark on the phone for
 * its whole remaining runtime, and a phone relaunched mid-turn came back to a
 * blank conversation. The saved transcript restores every byte at the fold.
 */
const MIRROR_MAX_BYTES = 384 * 1024

/**
 * Byte budget for the mirror rail — the sustained rate the full-snapshot
 * pushes may ask of the tunnel, per conversation. The 500ms throttle bounds
 * mirrors in TIME; nothing bounded them in BYTES, and a long turn's snapshot
 * grows without limit until every emit is a six-figure payload twice a second
 * (768 KB/s at the ceiling) on a single FIFO socket the relay forwards
 * fire-and-forget. A phone link slower than that never catches up: the queue
 * grows for the whole run, every other event sits behind it, and the phone
 * replays the backlog for minutes after the desktop finished — the reply
 * still "streaming" a word a second long after the turn ended.
 *
 * So a mirror's own size sets the earliest moment of the NEXT one: under
 * 16 KB keeps the 500ms cadence (every ordinary turn — nothing changes),
 * a 125 KB automation monster drops to one every ~4s, the ceiling to one
 * every 12s. Nothing is lost to the slower cadence: a skipped tick's content
 * rides the next snapshot (each is a superset of the last), the trailing
 * flush below sends the newest cached snapshot the moment the window opens,
 * and phone-run turns keep their token-by-token feel from the delta rail,
 * whose cost is the prose itself.
 *
 * The budget is charged GLOBALLY as well as per conversation — the socket is
 * one pipe, and two automations overlapping would otherwise each claim the
 * full rate and rebuild the very backlog this bounds. The number leaves
 * interactive headroom (deltas, card events, file chunks) even on a 3G-grade
 * ~50 KB/s link.
 */
const MIRROR_BYTES_PER_SEC = 32 * 1024

/**
 * Local-socket backlog above which even a due mirror waits. bufferedAmount
 * sees only the desktop→relay hop — what the relay is still holding for a
 * slow phone drains out of sight — so this is a supplement to the byte
 * pacing above, not the mechanism: it catches this machine's own uplink
 * filling, which no wall-clock budget can.
 */
const MIRROR_BACKLOG_MAX_BYTES = 512 * 1024

/** Re-check cadence while a due mirror waits out a congested socket. */
const MIRROR_RETRY_MS = 250

/**
 * What a non-verbose phone is shown WHILE a turn runs: assistant prose,
 * file-bearing results and errors, task cards — the clean feed the Mobile
 * panel's "Task results / off" setting describes. Tool mechanics are held
 * back from the live push, exactly as they were when this channel nudged
 * instead of mirroring; the stored body the phone reads afterwards still
 * carries everything, and its own verbose switch decides what to draw.
 */
function isCleanFeedSegment(segment: Segment): boolean {
  return (
    segment.kind === 'text' ||
    // In-place thinking is the reply's provenance, not tool mechanics — the
    // in-app feed and the phone's stored bodies show it regardless of
    // verbose, so the live mirror must too or the cards pop in only after
    // the turn persists.
    segment.kind === 'reasoning' ||
    segment.kind === 'tool_result' ||
    segment.kind === 'separator' ||
    segment.kind === 'turn_end'
  )
}

/** One phone paired with this user, as the org lists it plus what the
 *  phone said about itself the last time it connected. */
export type PairedPhone = {
  /** The org's device id — the one identity notifications are keyed by. */
  id: string
  name: string
  platform: 'ios' | 'android' | null
  model: string | null
  osVersion: string | null
  appVersion: string | null
  pairedAt: number
  lastSeenAt: number | null
  /** Which door this phone came through, as the ORG recorded it at the claim
   *  — not something the phone told us. Null on a device paired before the
   *  org started keeping it. */
  pairMethod: 'qr' | 'code' | null
  /** On the bridge right now. */
  connected: boolean
  /** Since when, for the phone that is on the bridge; null for the rest. */
  connectedSince: number | null
}

export type MobileStatus = {
  /** At least one phone holds a live session with the org. */
  paired: boolean
  phones: PairedPhone[]
  /** The desktop's own bridge socket; null before it is started. */
  bridge: BridgeState | null
  /** Present only while a pairing offer is open. */
  offer: {
    mode: 'qr' | 'code'
    /** The QR's payload string; the panel renders it as a QR image. */
    payload: string | null
    /** The typed code, formatted `K7M9-2QXR`. */
    code: string | null
    expiresAt: number
  } | null
  verbose: boolean
  /** Whether the model's notify_phone tool may send push notifications. */
  notificationsEnabled: boolean
  /** Whether a running automation draws its floating card on the phone. */
  runCards: boolean
  /** The org API both devices talk to. */
  apiBase: string
}

/** A pairing offer as the org minted it (POST /v1/pair/offer). */
export type PairOffer = { id: string; code: string; qr: string; expiresAt: number }

/** A device row as the org lists it (GET /v1/devices). */
export type WireDevice = {
  id: string
  platform: string
  name: string
  app_version: string
  /** What the device is and how it was paired, as the org recorded it at the
   *  claim and refreshed on every connect. Empty when it never said. */
  model: string
  os: string
  os_version: string
  pair_method: string
  created_at: string
  last_seen_at: string | null
  paired: boolean
  current: boolean
}

/** The reflection fields the phone may patch — mirrors workspace's ReflectionConfig. */
export type ReflectionWirePatch = {
  hour?: number
  quietHours?: number
  /** Whether a running reflection job draws its floating card, either side. */
  cards?: boolean
}

export type MobileChannelDeps = SnapshotSources & {
  /** Runs turns the phone starts, exactly as the other channels do. */
  runner: TurnRunner
  /**
   * Apply a reflection-config patch exactly as the settings IPC does —
   * persist, reschedule, announce — answering the complete post-write
   * config. Optional so hosts that don't serve reflection simply refuse.
   */
  applyReflectionConfig?: (patch: ReflectionWirePatch) => Promise<Record<string, unknown>>
  /** Start a reflection job now — the same enqueue the panel's Run-now uses. */
  runReflectionJob?: (
    kind: 'reflection' | 'deepClean'
  ) => Promise<'running' | 'queued' | 'coalesced'>
  /**
   * Apply a phone-edited settings patch through the same setters the
   * desktop's own panels use. Whitelisted inside; throws on unknown keys.
   * Absent = phone settings stay a read-only mirror.
   */
  applySettings?: (settings: Record<string, unknown>) => Promise<void>
  /** Replace the workspace's prompt variables — the phone's Variables page. */
  applyVariables?: (
    variables: Array<{ name: string; value: string; sensitive: boolean }>
  ) => Promise<void>
  /**
   * Flip one capability through the same implementation the desktop's own
   * settings toggle runs. Resolves to the enabled state that actually holds
   * (a locked core refuses the off); throws on a name this desktop no longer
   * has, which can only be a stale phone screen.
   */
  applyCapability?: (name: string, enabled: boolean) => Promise<boolean>
  /**
   * One month of this build's own release notes, markdown verbatim — the
   * same pages the desktop's Changelog screen reads. Null for a month this
   * build does not carry. Absent = the snapshot omits `changelog` and the
   * phone's What's-new desktop tab shows its empty state.
   */
  readChangelog?: (month: string, locale: string) => Promise<string | null>
  /**
   * The self-updater, reached through the SAME registered handlers the
   * desktop's own Updates panel and the CLI invoke (main wires these to
   * updater:getState / updater:check / updater:install) — one implementation,
   * three surfaces. `updaterCheck` carries the desktop's own guards: a check
   * never disturbs an in-flight download. `updaterInstall` must answer BEFORE
   * arming the restart, because its reply has to leave on a tunnel the
   * shutdown is about to close; `ok: false` means nothing verified is ready.
   * All three absent = this desktop cannot self-update, and the phone's card
   * stays the mirror-only surface it was before the feature.
   */
  updaterState?: () => Promise<UpdaterWireState>
  updaterCheck?: () => Promise<{ ok: boolean; version?: string | null; error?: string }>
  updaterInstall?: () => Promise<{ ok: boolean }>
  /**
   * Persisted switch for model-initiated phone notifications. Absent = the
   * feature is always on (tests). Checked before anything else in the notify
   * path, so "off" means no frame is even built.
   */
  loadNotificationsEnabled?: () => Promise<boolean>
  saveNotificationsEnabled?: (enabled: boolean) => Promise<void>
  /**
   * Persisted feed preference — see setVerbose. Stored beside notifications
   * so the phone's feed reads the same on the next launch as it did on this
   * one. Absent = clean feed, never remembered (tests).
   */
  loadVerbose?: () => Promise<boolean>
  saveVerbose?: (verbose: boolean) => Promise<void>
  /**
   * Persisted switch for the phone's floating automation-run cards — see
   * setRunCards. Absent = no cards, never remembered (tests).
   */
  loadRunCards?: () => Promise<boolean>
  saveRunCards?: (enabled: boolean) => Promise<void>
  /** Broadcast to the renderer so the panel updates without polling. */
  onStatus?: (status: MobileStatus) => void
  /**
   * One conversation's stored metadata changed because the PHONE wrote it —
   * today only a project re-file. Announced so this app's own rail, History and
   * Projects pages re-read, exactly as they do for a re-file made here. Absent
   * = no renderer to tell (tests).
   */
  onConversationChanged?: (conversationId: string) => void
  /**
   * Relay logging. Always on and always per-day, in the workspace log beside
   * every other channel: the desktop is the source of truth for what the
   * connection did, and the phone keeps no log of its own.
   */
  log?: (line: string) => void
  /** Detail for diagnosis — frame-level activity, resolved values. */
  debug?: (line: string) => void
  /**
   * The desktop's socket to the org bridge. Owned by main (it is started
   * and stopped with the cloud session); this channel registers its
   * handlers on it and reads its presence. Absent = no transport (tests).
   */
  bridge?: BridgeClient
  /** The org's pairing endpoints. Absent = pairing refused (tests). */
  pairing?: {
    offer: () => Promise<PairOffer>
    status: (id: string) => Promise<{ status: 'pending' | 'claimed' | 'expired' }>
    withdraw: (id: string) => Promise<void>
  }
  /** The org's device list, and the revoke that unpairs a phone. */
  devices?: {
    list: () => Promise<WireDevice[]>
    revoke: (id: string) => Promise<void>
  }
  /**
   * Materialize one org blob at a workspace path — the phone uploads its
   * attachments straight to the org, so a message may name files this
   * machine has never seen. Resolves false when the blob cannot be fetched.
   */
  hydrateBlob?: (relPath: string, sha256: string) => Promise<boolean>
  /**
   * Upload one workspace file to the org (content-addressed), answering its
   * sha — how a diagnostic archive reaches the phone. Absent = the phone is
   * told there is nothing to download.
   */
  uploadWorkspaceFile?: (relPath: string, mime: string) => Promise<string | null>
}

/** The scheduler's source file, workspace-relative — the desktop's own path. */
const HEARTBEAT_PATH = 'brain/brainstem/heartbeat.md'

/**
 * Ceilings on phone-authored text. Every one is far above anything a person
 * types on a phone and exists for the same reason MAX_UPLOAD_BYTES does: these
 * values are written into workspace files the agent reads back as instructions,
 * so a runaway client must stay bounded rather than grow one unboundedly.
 */
const ID_MAX = 128
const ICON_MAX = 16
const TITLE_MAX = 200
const INSTRUCTIONS_MAX = 100_000
const PROMPT_MAX = 100_000
const HEARTBEAT_MAX = 1_000_000
/**
 * Floor between two reindex progress ticks on the wire. The rebuild indexes in
 * batches of eight files and emits on each, which on a real workspace is far
 * faster than a phone can repaint one line of text — and far faster than anyone
 * can read it.
 */
const REINDEX_PUSH_THROTTLE_MS = 1_000

export class MobileChannel {
  private bridge: BridgeClient | null = null
  private bridgeState: BridgeState | null = null
  private offer: MobileStatus['offer'] = null
  private offerId: string | null = null
  private offerTimer: ReturnType<typeof setTimeout> | null = null
  private offerPoll: ReturnType<typeof setInterval> | null = null
  /** The org's list of this user's phones, refreshed on session start, on
   *  every claim and unpair, and whenever a phone connects. */
  private phones: WireDevice[] = []
  /** What each phone said about itself at hello, by device id. */
  private readonly phoneInfo = new Map<
    string,
    {
      platform: 'ios' | 'android' | null
      model: string | null
      osVersion: string | null
      appVersion: string | null
    }
  >()
  private verbose = false
  private runCards = false
  /** Live turns the phone started, so it can abort them. */
  private readonly turns = new Map<string, { turnId: string; controller: AbortController }>()
  /**
   * Requests the agent has parked waiting on the phone, keyed by request id —
   * approvals and ask-the-user cards, exactly as the Electron channel holds
   * the renderer's. The turn is BLOCKED inside the pipeline until one of these
   * resolves, so every exit path has to fire one: the phone's answer, the end
   * of the turn, or the tunnel going away. None of them may be missed.
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      turnId: string
      conversationId: string
      resolve: (decision: ApprovalDecision) => void
      /** The turn's accumulator map, so a decision reaches the saved record. */
      approvals: AssistantAccumulator['approvals']
    }
  >()
  private readonly pendingAsks = new Map<
    string,
    {
      turnId: string
      conversationId: string
      resolve: (response: AskUserResponse) => void
      /** The card as it was pushed, re-served to a phone that rejoins mid-park
       *  (a relaunched app has lost the original push and nothing re-sends it). */
      card: { toolCallId: string; questions: AskUserRequest['questions'] }
    }
  >()
  /**
   * The newest mirror snapshot per conversation with a turn in flight — the
   * fitted message exactly as the last push carried it (or would have, had a
   * phone been connected), plus the prompt it answers. This is what
   * Rpc.turnMirror serves: a phone that connects — or RECONNECTS after iOS
   * killed it — mid-turn has missed every push so far, and across a long tool
   * call the next one is minutes away; this cache is the only copy of the
   * turn-so-far anywhere outside the accumulator. Written on every mirror
   * tick whether or not a phone is listening, dropped when the turn ends.
   */
  private readonly lastMirrors = new Map<
    string,
    /** deltaSeq: how many text deltas had been pushed when this snapshot was
     *  cached — the trailing flush's staleness check (see mirrorDeltaSeq). */
    { message: ConversationMessage; userMessage?: ConversationMessage; deltaSeq?: number }
  >()
  /**
   * Mirror pacing per conversation: when the last snapshot was actually SENT
   * and how big it was — its size decides the earliest next send — plus the
   * trailing timer that pushes the newest cached snapshot once the window
   * opens. A deferred tick loses nothing: lastMirrors above always holds the
   * freshest fitted snapshot, and the flush sends THAT, so the phone's next
   * mirror is a superset of every one skipped under it.
   */
  private readonly mirrorPace = new Map<
    string,
    { sentAt: number; sentBytes: number; timer: NodeJS.Timeout | null }
  >()
  /**
   * The whole rail's last send — every conversation's mirrors share one
   * socket, so the byte budget is charged here as well as per conversation:
   * concurrent turns split the rate instead of stacking it.
   */
  private mirrorRail = { sentAt: 0, sentBytes: 0 }
  /**
   * Text deltas pushed per conversation, counted so the trailing flush can
   * tell whether its cached snapshot is already BEHIND the delta rail. A
   * snapshot is only allowed to reset the phone's tail when it contains
   * every delta sent before it (prompt.ts composes on that promise); one
   * cached before the newest delta would punch that delta's words out of
   * the visible prose. Such a flush is skipped — the phone holds the words
   * as tail, and the next fresh tick sends a snapshot that truly contains
   * them.
   */
  private readonly mirrorDeltaSeq = new Map<string, number>()
  /**
   * Live out-of-window mirror INTO the renderer — the exact counterpart of
   * ElectronChannel.setMessageMirror, pointed the other way. A phone-run turn
   * used to reach the desktop's own window only at the end-of-turn save, so
   * an open conversation there sat on a thinking shimmer for the whole run
   * while the phone showed prose and cards. index.ts wires this to the same
   * `conversation:messageMirror` broadcast the terminal mirror uses;
   * the renderer upserts by the stable message id, so the saved copy replaces
   * the snapshot rather than joining it.
   */
  private rendererMirror: MirrorMessageListener | null = null

  setMessageMirror(listener: MirrorMessageListener | null): void {
    this.rendererMirror = listener
  }

  /**
   * The cached turn-so-far for one conversation, for surfaces on THIS
   * machine — the renderer's counterpart of Rpc.turnMirror. A window opened
   * (or reloaded) mid-run has the same problem a rejoining phone does: the
   * assistant message is not on disk until the fold, and the next mirror
   * tick can be a long tool call away. The cache is fed by every channel's
   * mirror (this channel's own sinks, and the cli/
   * autonomous/in-app mirrors routed through pushMessageAppended), so it
   * answers for a run started anywhere.
   */
  turnMirrorFor(conversationId: string): ConversationMessage | null {
    return this.lastMirrors.get(conversationId)?.message ?? null
  }

  /**
   * When the last reindex tick went out, so the throttle has something to
   * measure against. Zero means "no rebuild is being reported" — which is both
   * the resting state and the flag that makes the next tick an unthrottled
   * start edge.
   */
  private lastReindexPush = 0
  /** notify frames awaiting the bridge's notify_result, by notificationId. */
  private readonly pendingNotifies = new Map<
    string,
    { resolve: (result: NotifyResultFrame) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Gate for the model's notify_phone tool. Restored from config at start. */
  private notificationsEnabled = true
  /** The built capability pair, made once and re-registered as needed. */
  private phoneCapability: ReturnType<typeof buildMobileCapability> | null = null
  /** Whether notify_phone is currently registered with the cerebellum. */
  private phoneCapabilityRegistered = false
  /** Set while the channel is stopped, so status churn can't re-register. */
  private channelStopped = false
  /**
   * The diagnostic-export runner, injected from main because it owns the
   * single-flight guard the desktop's own button runs behind. Absent until
   * main wires it, which is also what makes the RPC honest on an older build:
   * the phone is told this desktop cannot export rather than being left to
   * wait on a promise nobody will settle.
   */
  private diagnosticExporter:
    | ((
        conversationId: string,
        onProgress: (progress: DiagnosticProgress) => void
      ) => Promise<DiagnosticResult>)
    | null = null

  constructor(private readonly deps: MobileChannelDeps) {
    this.bridge = deps.bridge ?? null
  }

  /** Wire the collector main owns — see `diagnosticExporter`. */
  setDiagnosticExporter(
    exporter: (
      conversationId: string,
      onProgress: (progress: DiagnosticProgress) => void
    ) => Promise<DiagnosticResult>
  ): void {
    this.diagnosticExporter = exporter
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Wire the bridge and restore the persisted switches. Safe to call on
   * every boot; the socket itself is started and stopped by main with the
   * cloud session (see `sessionReady` / `sessionGone`).
   */
  async start(): Promise<void> {
    this.channelStopped = false
    this.notificationsEnabled = (await this.deps.loadNotificationsEnabled?.()) ?? true
    this.verbose = (await this.deps.loadVerbose?.()) ?? false
    this.runCards = (await this.deps.loadRunCards?.()) ?? false
    if (this.bridge) this.attachBridge(this.bridge)
    this.emitStatus()
  }

  /**
   * The session is usable: learn which phones the org lists for this user,
   * so the panel and the notify tool are right before any phone connects.
   */
  async sessionReady(): Promise<void> {
    await this.refreshPhones()
  }

  /** Signed out: nothing is paired from this machine's point of view. */
  sessionGone(): void {
    this.phones = []
    this.phoneInfo.clear()
    this.clearOffer()
    this.drainTurnRequests(null, 'signed out')
    this.emitStatus()
  }

  async stop(): Promise<void> {
    this.log('channel stopping')
    this.channelStopped = true
    this.syncPhoneCapability()
    for (const [id, pending] of this.pendingNotifies) {
      clearTimeout(pending.timer)
      pending.resolve({
        v: 1,
        type: 'notify_result',
        notificationId: id,
        route: 'dropped',
        reason: 'channel stopped'
      })
    }
    this.pendingNotifies.clear()
    this.drainTurnRequests(null, 'channel stopped')
    this.clearOffer()
    this.clearMirrorPacing()
    this.bridgeState = null
    this.emitStatus()
  }

  private attachBridge(bridge: BridgeClient): void {
    this.bridge = bridge
    this.registerHandlers(bridge)
    bridge.onNotifyResult((frame) =>
      this.onNotifyResult(frame as unknown as Record<string, unknown>)
    )
    // The org tells this desktop the moment a phone claims its offer, so the
    // offer card becomes a paired-phone card without polling.
    bridge.onServerEvent('pair.claimed', (payload) => {
      const device = (payload as { device?: { id?: string; name?: string } } | null)?.device
      this.log(`pairing claimed by ${device?.name || device?.id || 'a phone'}`)
      this.clearOffer()
      void this.refreshPhones()
    })
    // …and the moment a phone signs itself out (or an admin revokes it), so
    // the paired-phone card goes away without waiting for the next re-list.
    bridge.onServerEvent('device.revoked', (payload) => {
      const deviceId = (payload as { deviceId?: string } | null)?.deviceId
      const known = this.phones.find((p) => p.id === deviceId)
      this.log(`${known?.name || deviceId || 'a phone'} signed out`)
      void this.refreshPhones()
    })
    bridge.onState((state) => {
      const previous = this.bridgeState
      this.bridgeState = state
      const hadPhone = (previous?.phones.length ?? 0) > 0
      const hasPhone = state.phones.length > 0
      if (state.status !== previous?.status) {
        this.log(
          state.lastError && state.status === 'error'
            ? `${state.status} — ${state.lastError}`
            : state.status
        )
      }
      if (hasPhone && !hadPhone) {
        // A phone the org list does not know yet is a fresh claim this
        // desktop missed (the claim event raced a reconnect) — re-list.
        if (state.phones.some((p) => !this.phones.some((d) => d.id === p.deviceId))) {
          void this.refreshPhones()
        }
      }
      // The phone is where every parked card lives. Lose the last one and
      // nobody can answer — so anything still waiting fails closed here
      // rather than holding its turn open until the app is opened again,
      // which on a phone can be hours.
      if (!hasPhone && hadPhone) this.drainTurnRequests(null, 'phone disconnected')
      if (!hasPhone) this.clearMirrorPacing()
      this.emitStatus()
    })
  }

  /** Re-read the org's device list; the mobile ones are the paired phones. */
  async refreshPhones(): Promise<void> {
    if (!this.deps.devices) return
    try {
      const all = await this.deps.devices.list()
      this.phones = all.filter((d) => d.platform === 'mobile' && d.paired)
    } catch (err) {
      this.debug(`device list unavailable — ${(err as Error).message}`)
      return
    }
    this.emitStatus()
  }

  // ---------------------------------------------------------- notifications

  /**
   * Keep the notify_phone tool's EXISTENCE in step with deliverability: the
   * capability is registered exactly while at least one phone is paired and
   * the user allows notifications. Presence in the model's capability index
   * is therefore the cheap availability check — the model never has to
   * probe, and a send can never be attempted into a void. A parked
   * (backgrounded) phone stays deliverable on purpose: reaching an away
   * phone via push is the feature. Runs off every emitStatus, so any state
   * change — a claim, an unpair, the settings toggle — converges the
   * registration without dedicated wiring.
   */
  private syncPhoneCapability(): void {
    const deliverable = !this.channelStopped && this.phones.length > 0 && this.notificationsEnabled
    if (deliverable === this.phoneCapabilityRegistered) return
    if (deliverable) {
      this.phoneCapability ??= buildMobileCapability({
        notify: (request) => this.notifyPhone(request)
      })
      this.deps.agent.cerebellum.registerInProcessCapability(
        this.phoneCapability.capability,
        this.phoneCapability.plugin
      )
      this.log('notify_phone exposed — a phone is paired and notifications allowed')
    } else {
      this.deps.agent.cerebellum.unregisterInProcessCapability(MOBILE_CAPABILITY_NAME)
      this.log('notify_phone withdrawn — no phone paired, or notifications off')
    }
    this.phoneCapabilityRegistered = deliverable
  }

  /**
   * The whole notify path, model side down: the tool handler (tools.ts) has
   * already validated the model's words — validated, not rationed; nothing
   * caps how many a run may send. This stamps a freshly minted ULID, derives
   * the ttl from the phase, hands the frame to the bridge (which addresses
   * every phone of this user: in-band first, push otherwise) and resolves
   * with the bridge's routing decision. Every refusal is a thrown Error
   * with a message the model can read and act on.
   */
  async notifyPhone(request: NotifyPhoneRequest): Promise<NotifyResultFrame> {
    if (!this.notificationsEnabled) {
      throw new Error(
        "phone notifications are disabled in this desktop's Settings → Mobile — do not retry"
      )
    }
    if (this.phones.length === 0) throw new Error('no phone paired')
    const bridge = this.bridge
    if (!bridge?.connected) throw new Error('the org bridge is not connected right now')

    const frame: NotifyFrame = {
      v: PUSH_WIRE_VERSION,
      type: 'notify',
      notificationId: mintNotificationId(),
      runId: request.runId,
      phase: request.phase,
      title: request.title,
      body: request.body,
      urgency: request.urgency,
      deeplink: request.deeplink,
      ttl: TTL_BY_PHASE[request.phase],
      ts: Date.now()
    }

    const result = new Promise<NotifyResultFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingNotifies.delete(frame.notificationId)
        resolve({
          v: 1,
          type: 'notify_result',
          notificationId: frame.notificationId,
          route: 'dropped',
          // Deliberately worded as ignorance, not failure. The bridge forwards
          // to the phone BEFORE it answers, so a missing answer says nothing
          // about whether the notification arrived — and it usually did. Read
          // as "not delivered" this was retried, and the user got the same
          // notification three times.
          reason:
            'the bridge did not answer within ' +
            `${NOTIFY_RESULT_TIMEOUT_MS / 1000}s, so delivery is unknown — the notification may ` +
            'have reached the phone anyway'
        })
      }, NOTIFY_RESULT_TIMEOUT_MS)
      this.pendingNotifies.set(frame.notificationId, { resolve, timer })
    })

    try {
      bridge.notify(frame)
    } catch {
      const pending = this.pendingNotifies.get(frame.notificationId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingNotifies.delete(frame.notificationId)
      }
      throw new Error('the bridge link is down right now — the notification was not sent')
    }
    this.debug(`notify ${frame.notificationId} sent (${frame.phase}, run ${frame.runId})`)

    const answer = await result
    this.log(
      `notification ${frame.notificationId} → ${answer.route}` +
        (answer.reason ? ` (${answer.reason})` : '')
    )
    return answer
  }

  /** The bridge's answer to a notify — resolves the matching waiter. */
  private onNotifyResult(raw: Record<string, unknown>): void {
    const id = typeof raw.notificationId === 'string' ? raw.notificationId : null
    if (!id) return
    const pending = this.pendingNotifies.get(id)
    if (!pending) return
    this.pendingNotifies.delete(id)
    clearTimeout(pending.timer)
    const route = raw.route === 'inband' || raw.route === 'push' ? raw.route : 'dropped'
    pending.resolve({
      v: 1,
      type: 'notify_result',
      notificationId: id,
      route,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {})
    })
  }

  /** Flip the persisted notifications gate; answers the updated status. */
  async setNotificationsEnabled(enabled: boolean): Promise<MobileStatus> {
    this.notificationsEnabled = enabled
    await this.deps.saveNotificationsEnabled?.(enabled)
    this.log(`model-initiated phone notifications ${enabled ? 'enabled' : 'disabled'}`)
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Whether the phone's feed shows tool calls and task results, mirroring the
   * same switch on the terminal and the in-app feed. Off (default) sends
   * a clean feed: assistant messages, file-bearing results and errors only.
   * Display-only — it never affects what is stored, and never affects logging.
   *
   * Persisted, like the notifications gate beside it: this switch is edited
   * from two devices, and one that forgot itself on restart would have the
   * phone and the panel disagreeing about a setting neither of them changed.
   */
  async setVerbose(verbose: boolean): Promise<MobileStatus> {
    this.verbose = verbose
    await this.deps.saveVerbose?.(verbose)
    this.log(`phone feed ${verbose ? 'relays every tool call' : 'kept clean'}`)
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Whether an automation running on this desktop draws its live card over
   * whatever screen the PHONE is on. Off by default: the run pool announces
   * itself either way (the phone still receives the pushes, the automations
   * screen still shows what ran), this is only whether it interrupts.
   *
   * Persisted and status-borne like the two switches above, so the phone's own
   * Channels screen and the desktop's Mobile panel edit one value.
   */
  async setRunCards(enabled: boolean): Promise<MobileStatus> {
    this.runCards = enabled
    await this.deps.saveRunCards?.(enabled)
    this.log(`phone automation cards ${enabled ? 'shown' : 'hidden'}`)
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Connection logging is unconditional. A link that will not connect is
   * exactly when the record matters, and nobody can be asked to reproduce a
   * failure with logging switched on afterwards. `verbose` is a *feed*
   * preference and has nothing to do with this.
   */
  private log(line: string): void {
    this.deps.log?.(line)
  }

  /** Detail: served RPCs, pushes, per-frame activity. */
  private debug(line: string): void {
    this.deps.debug?.(line)
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Open a pairing offer with the org and show it as a QR. The payload
   * carries the org API's address and a one-time token; the phone claims it
   * and receives a session of its own. Nothing about this desktop travels
   * — the org already knows both devices.
   */
  async offerQr(): Promise<MobileStatus> {
    await this.beginPairing('qr')
    return this.getStatus()
  }

  /**
   * The same offer as a short typed code, for a desktop with no screen the
   * phone can see — a headless box, or a session over SSH.
   */
  async offerCode(): Promise<MobileStatus> {
    await this.beginPairing('code')
    return this.getStatus()
  }

  private async beginPairing(mode: 'qr' | 'code'): Promise<void> {
    if (!this.deps.pairing) throw new Error('pairing is not available on this desktop')
    this.clearOffer()
    const minted = await this.deps.pairing.offer()
    const expiresAt = Math.min(
      minted.expiresAt || Date.now() + CODE_TTL_MS,
      Date.now() + CODE_TTL_MS
    )
    this.offerId = minted.id
    this.offer = {
      mode,
      payload: mode === 'qr' ? minted.qr : null,
      code: mode === 'code' ? minted.code : null,
      expiresAt
    }
    this.offerTimer = setTimeout(
      () => {
        // An unclaimed offer must not linger: a code read aloud or a QR left
        // on screen should stop working on its own. The org expires it too;
        // this just takes it off the screen at the same moment.
        if (this.offer) this.log('pairing offer expired unclaimed')
        this.clearOffer()
        this.emitStatus()
      },
      Math.max(1_000, expiresAt - Date.now())
    )
    // Belt and braces for the claim announcement: while the bridge socket is
    // down the org cannot tell this desktop a phone claimed, so the offer is
    // re-read on a slow clock until it settles.
    this.offerPoll = setInterval(() => void this.pollOffer(), OFFER_POLL_MS)
    this.offerPoll.unref?.()
    this.log(`pairing offer opened (${mode}, ${minted.id})`)
    this.emitStatus()
  }

  private async pollOffer(): Promise<void> {
    const id = this.offerId
    if (!id || !this.deps.pairing) return
    try {
      const state = await this.deps.pairing.status(id)
      if (this.offerId !== id) return
      if (state.status === 'claimed') {
        this.log('pairing claimed (seen on poll)')
        this.clearOffer()
        await this.refreshPhones()
        this.emitStatus()
      } else if (state.status === 'expired') {
        this.clearOffer()
        this.emitStatus()
      }
    } catch {
      // the bridge event, the timer, or the next poll settles it
    }
  }

  private clearOffer(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer)
    if (this.offerPoll) clearInterval(this.offerPoll)
    this.offerTimer = null
    this.offerPoll = null
    const withdrawn = this.offer && this.offerId ? this.offerId : null
    this.offer = null
    this.offerId = null
    // Withdrawn at the org too, so a code shown on screen and then dismissed
    // cannot be typed later. Best-effort: expiry retires it regardless.
    if (withdrawn) void this.deps.pairing?.withdraw(withdrawn).catch(() => undefined)
  }

  /** Withdraw an open offer without touching any paired phone. */
  async cancelOffer(): Promise<MobileStatus> {
    this.clearOffer()
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Forget a phone: revoke its sessions at the org, which closes its bridge
   * socket and drops its push registration on the spot. Without an id every
   * paired phone goes.
   */
  async unpair(deviceId?: string): Promise<MobileStatus> {
    this.drainTurnRequests(null, 'phone unpaired')
    this.clearOffer()
    this.clearMirrorPacing()
    this.lastMirrors.clear()
    this.mirrorDeltaSeq.clear()
    const targets = deviceId ? this.phones.filter((p) => p.id === deviceId) : [...this.phones]
    for (const phone of targets) {
      try {
        await this.deps.devices?.revoke(phone.id)
        this.phoneInfo.delete(phone.id)
        this.log(`unpaired ${phone.name || phone.id} — sessions revoked at the org`)
      } catch (err) {
        this.log(`unpair of ${phone.id} failed — ${(err as Error).message}`)
        throw err
      }
    }
    await this.refreshPhones()
    this.emitStatus()
    return this.getStatus()
  }

  // --------------------------------------------------------------- handlers

  private registerHandlers(tunnel: BridgeClient): void {
    tunnel.onRpc(Rpc.hello, async (params, from) => {
      // The phone describes itself here — model, OS, app build — for the
      // panel's device card. Keyed by the org device id the bridge stamps on
      // the request, never by anything the phone claims about its identity.
      const text = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null
      const platform =
        params.platform === 'ios' || params.platform === 'android' ? params.platform : null
      if (from?.deviceId) {
        this.phoneInfo.set(from.deviceId, {
          platform,
          model: text(params.model),
          osVersion: text(params.osVersion),
          appVersion: text(params.appVersion)
        })
        if (!this.phones.some((p) => p.id === from.deviceId)) void this.refreshPhones()
        else this.emitStatus()
      }
      return { ok: true, app: 'wolffish-app', platform: process.platform, protocol: 2 }
    })

    /**
     * Which conversations have a turn in flight RIGHT NOW — the phone's
     * chat:activeRuns, and it exists for the reason that one does: 'started'
     * is a broadcast, so a surface that connects mid-run has already missed
     * the only announcement that turn was ever going to send. Both halves,
     * exactly as index.ts concatenates them for this app's own windows —
     * channel turns and autonomous runs.
     *
     * Without it a phone opening a conversation this desktop is still writing
     * renders it idle: live composer and no stop, over a turn that has not
     * finished.
     */
    tunnel.onRpc(Rpc.activeRuns, async () => {
      const ids = [...this.deps.runner.activeRuns(), ...this.deps.agent.activeAutonomousRuns()].map(
        (run) => run.conversationId
      )
      return { conversationIds: [...new Set(ids)] }
    })

    /**
     * The turn-so-far for one conversation — the newest mirror snapshot (with
     * the prompt it answers) plus every card the turn is still parked on.
     *
     * This is the recovery path for a phone that joins or REJOINS a turn in
     * flight: pushes only describe what happens next, the assistant message
     * is not on disk until the fold, and across a long tool call the next
     * mirror tick is minutes away — so without this, a phone relaunched
     * mid-turn (iOS reclaiming a backgrounded app is the ordinary case)
     * renders a running conversation as blank thinking words, and a question
     * the turn is parked on is lost until the tunnel drops. Served from the
     * same cache every mirror tick maintains, so it costs a map read.
     */
    tunnel.onRpc(Rpc.turnMirror, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      const cached = this.lastMirrors.get(conversationId)
      const asks = [...this.pendingAsks.entries()]
        .filter(([, entry]) => entry.conversationId === conversationId)
        .map(([id, entry]) => ({
          id,
          toolCallId: entry.card.toolCallId,
          questions: entry.card.questions
        }))
      const approvals = [...this.pendingApprovals.entries()]
        .filter(([, entry]) => entry.conversationId === conversationId)
        .flatMap(([id, entry]) => {
          const stored = entry.approvals.get(id)
          if (!stored || stored.decision) return []
          return [
            {
              id,
              toolCallId: stored.toolCallId,
              tool: stored.tool,
              args: stored.args,
              level: stored.level,
              reason: stored.reason,
              description: stored.description
            }
          ]
        })
      this.debug(
        `served turn mirror for ${conversationId} — ` +
          `${cached ? 'snapshot' : 'no snapshot'}, ${asks.length} ask(s), ` +
          `${approvals.length} approval(s)`
      )
      return {
        message: cached?.message ?? null,
        ...(cached?.userMessage !== undefined ? { userMessage: cached.userMessage } : {}),
        asks,
        approvals
      }
    })

    tunnel.onRpc(Rpc.configSnapshot, async () => {
      const snapshot = await buildConfigSnapshot(this.deps)
      this.debug(`served config snapshot (${Object.keys(snapshot).length} sections)`)
      return snapshot
    })

    /**
     * The phone edits a setting; this desktop persists it through the same
     * setters its own panels call, so the change is live everywhere at once.
     * The applier validates against a whitelist and throws on anything else —
     * an error here makes the phone refetch the snapshot and revert.
     */
    tunnel.onRpc(Rpc.configSet, async (params) => {
      const settings = (params as { settings?: unknown })?.settings
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('configSet needs a settings object')
      }
      if (!this.deps.applySettings) throw new Error('this desktop does not accept phone edits')
      await this.deps.applySettings(settings as Record<string, unknown>)
      this.debug(`applied phone settings: ${Object.keys(settings).join(', ')}`)
      return { ok: true }
    })

    /**
     * Whole-array variables replace — same contract as the desktop's own
     * variables:save. Each row is coerced field by field so a malformed
     * entry costs itself, never the write.
     */
    tunnel.onRpc(Rpc.variablesSet, async (params) => {
      const raw = (params as { variables?: unknown })?.variables
      if (!Array.isArray(raw)) throw new Error('variablesSet needs a variables array')
      if (!this.deps.applyVariables) throw new Error('this desktop does not accept phone edits')
      const variables = raw
        .map((entry) => {
          const row = (entry ?? {}) as Record<string, unknown>
          return {
            name: typeof row.name === 'string' ? row.name.trim() : '',
            value: typeof row.value === 'string' ? row.value : '',
            sensitive: row.sensitive === true
          }
        })
        .filter((row) => row.name.length > 0)
      await this.deps.applyVariables(variables)
      this.debug(`applied ${variables.length} variable(s) from phone`)
      return { ok: true }
    })

    /**
     * One capability toggle, applied through the same implementation the
     * desktop's own switch runs (validation, locked-core guard, broadcast).
     * The answer carries the state that actually holds, which is how a
     * refused write tells the phone to snap its switch back without a full
     * snapshot round trip.
     */
    tunnel.onRpc(Rpc.capabilitySet, async (params) => {
      const { name, enabled } = (params ?? {}) as { name?: unknown; enabled?: unknown }
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('capabilitySet needs a capability name')
      }
      if (!this.deps.applyCapability) throw new Error('this desktop does not accept phone edits')
      const actual = await this.deps.applyCapability(name, enabled === true)
      this.log(`capability ${name} switched ${actual ? 'on' : 'off'} by the phone`)
      return { ok: true, enabled: actual }
    })

    /**
     * File a conversation under a project. The phone cannot do this locally:
     * every turn's project overlay is built from the `projectId` on THIS side's
     * conversation file, so a binding written only to the phone's database
     * would show project chrome over turns that never received the project's
     * instructions.
     */
    tunnel.onRpc(Rpc.conversationProject, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      if (!conversationId) throw new Error('conversationProject needs a conversationId')
      const requested = wireText(params.projectId, ID_MAX) || null
      // An unknown project unfiles rather than dangles. buildProjectOverlay
      // returns an empty overlay for a missing id, so a dangling binding is
      // precisely the silent case above — a stale phone screen must not create
      // one, and answering with what actually holds lets it correct itself.
      const projectId = requested && (await getProject(requested)) ? requested : null
      let found = false
      await updateConversation(conversationId, (current) => {
        if (!current) return null
        found = true
        current.projectId = projectId ?? undefined
        return current
      })
      if (!found) throw new Error(`unknown conversation ${conversationId}`)
      this.log(`conversation ${conversationId} filed under project ${projectId ?? 'none'}`)
      // The desktop's own list re-reads on this, so an open Projects page and
      // the conversations rail both follow a re-file made on the phone.
      this.deps.onConversationChanged?.(conversationId)
      return { ok: true, projectId }
    })

    /**
     * One month of this desktop's own release notes. The month is a path
     * segment on the serving side, so anything but a literal `YYYY-MM` is
     * refused here — wire values index into the filesystem and must never
     * carry a traversal. Locale likewise reduces to a plain language tag;
     * the reader falls back to English exactly as the desktop's own
     * Changelog screen does.
     */
    tunnel.onRpc(Rpc.changelogRead, async (params) => {
      const month = String(params.month ?? '')
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`not a changelog month: ${month}`)
      const locale = /^[a-z]{2}$/.test(String(params.locale ?? '')) ? String(params.locale) : 'en'
      const markdown = (await this.deps.readChangelog?.(month, locale)) ?? null
      this.debug(`served changelog ${month} (${locale}) — ${markdown ? markdown.length : 0} chars`)
      return { markdown }
    })

    /**
     * The self-updater, from the phone: seed, check, install. Thin passes
     * into the same registered handlers the desktop's own panel and the CLI
     * invoke (see MobileChannelDeps), so a tap over the tunnel is the
     * identical act. A host without the deps answers the honest no — the
     * phone hides its controls rather than offering a button that lies.
     */
    tunnel.onRpc(Rpc.updaterState, async () => {
      if (!this.deps.updaterState) return { state: null }
      return { state: await this.deps.updaterState() }
    })

    tunnel.onRpc(Rpc.updaterCheck, async () => {
      if (!this.deps.updaterCheck) return { ok: false, error: 'this desktop cannot self-update' }
      const result = await this.deps.updaterCheck()
      this.log(
        `update check from phone — ${result.ok ? (result.version ?? 'up to date') : `failed (${result.error ?? 'unknown'})`}`
      )
      return result
    })

    tunnel.onRpc(Rpc.updaterInstall, async () => {
      if (!this.deps.updaterInstall) return { ok: false }
      const result = await this.deps.updaterInstall()
      this.log(
        `update install from phone — ${result.ok ? 'armed, restarting' : 'refused (nothing ready)'}`
      )
      return result
    })

    /**
     * The phone hands over a prompt; this desktop runs the turn. Output goes
     * back as events rather than an RPC result — the phone renders a stream,
     * not a reply, so it looks the same as a turn started here.
     *
     * The answer carries only the conversation id, and the rest of the turn —
     * persisting the user message, dispatching the runner — continues after
     * the reply is on the wire, because the phone needs the id immediately to
     * navigate. Failures in the continuation surface as a `turn.status` error
     * push against that id, which the phone already renders.
     */
    tunnel.onRpc(Rpc.sendMessage, async (params) => {
      const text = String(params.text ?? '').trim()
      const attachments = await this.sanitizeAttachments(params.attachments)
      // Only an audio file can be a voice prompt — a flag on anything else is
      // a malformed client and is ignored rather than honored.
      const voicePrompt = params.voicePrompt === true && attachments.some((a) => a.type === 'audio')
      const voiceLang =
        typeof params.voiceLang === 'string' && params.voiceLang.trim()
          ? params.voiceLang.trim()
          : undefined
      if (!text && attachments.length === 0) throw new Error('empty prompt')
      let conversationId = typeof params.conversationId === 'string' ? params.conversationId : null
      // The phone shows the prompt from the moment it is typed and needs the
      // stored copy to REPLACE that bubble rather than join it, which it can
      // only do if both carry one id. So the phone mints it and this desktop
      // saves under it. Validated to the shape mintMessageId produces — the
      // wire is data, not policy — and simply minted here when absent, which
      // is what a phone predating this field leaves.
      const messageId = /^m_\d{1,17}_[0-9a-f]{6}$/.test(String(params.messageId ?? ''))
        ? String(params.messageId)
        : undefined

      // A conversation the phone MINTED — so its attachments had a folder to
      // upload into before this send — does not exist here yet. Created
      // under the phone's id (shape-checked: ids are filenames), so the
      // uploads it already made land in the right place.
      if (conversationId && /^[A-Za-z0-9._-]{1,128}$/.test(conversationId)) {
        if (!(await loadConversation(conversationId))) {
          const created = createConversation(null)
          created.id = conversationId
          if (text) created.title = text.slice(0, 60)
          created.messages = []
          created.channel = 'mobile'
          const projectId = wireText(params.projectId, ID_MAX) || null
          if (projectId && (await getProject(projectId))) created.projectId = projectId
          await saveConversation(created)
        }
      } else if (conversationId) {
        throw new Error(`invalid conversation id ${conversationId}`)
      }
      if (!conversationId) {
        const created = createConversation(null)
        if (text) created.title = text.slice(0, 60)
        created.messages = []
        // Where this conversation began, the same way a terminal one is
        // stamped. Both apps badge it from here, and it is the only record —
        // the desktop cannot tell later which surface asked.
        created.channel = 'mobile'
        // A first message sent from inside a project files the conversation
        // under it AT CREATION, not afterwards: the very turn this send starts
        // reads projectId off this file to build its overlay, so a re-file a
        // moment later would give the project's instructions to every turn
        // except the first. An unknown id is dropped rather than dangled — see
        // Rpc.conversationProject for why a dangling one is the silent case.
        const projectId = wireText(params.projectId, ID_MAX) || null
        if (projectId && (await getProject(projectId))) created.projectId = projectId
        await saveConversation(created)
        conversationId = created.id
      }

      const cid = conversationId
      void this.continueSend(cid, text, attachments, voicePrompt, voiceLang, messageId).catch(
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.log(`send from the phone failed in ${cid} — ${message}`)
          this.pushTurnStatus(cid, 'error', message)
        }
      )
      return { conversationId: cid }
    })

    tunnel.onRpc(Rpc.abortTurn, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      const live = this.turns.get(conversationId)
      live?.controller.abort()
      this.turns.delete(conversationId)
      // An aborted turn takes its parked cards with it: the abort unwinds the
      // pipeline, but the promise the pipeline is sitting on is held here.
      if (live) this.drainTurnRequests(live.turnId, 'turn aborted from the phone')
      this.log(`abort requested for ${conversationId} — ${live ? 'stopped' : 'nothing running'}`)
      return { aborted: Boolean(live) }
    })

    /**
     * The phone answered an ask-the-user card. `ok: false` means the id names
     * nothing pending — the turn ended, or the link dropped and the request
     * was already failed closed — which is how the phone learns to take a
     * card down instead of leaving it interactive forever.
     */
    tunnel.onRpc(Rpc.askRespond, async (params) => {
      const id = String(params.id ?? '')
      const entry = this.pendingAsks.get(id)
      if (!entry) {
        this.log(`ask answer for ${id} arrived too late — nothing pending`)
        return { ok: false }
      }
      const response = sanitizeAskResponse(params.response)
      this.pendingAsks.delete(id)
      this.log(`ask ${id} answered from the phone — ${response.kind}`)
      entry.resolve(response)
      return { ok: true }
    })

    /** The phone approved or denied a flagged tool call. */
    tunnel.onRpc(Rpc.approvalRespond, async (params) => {
      const id = String(params.id ?? '')
      const entry = this.pendingApprovals.get(id)
      if (!entry) {
        this.log(`approval decision for ${id} arrived too late — nothing pending`)
        return { ok: false }
      }
      // Anything that is not an explicit approval is a denial: the wire is
      // data, and this gate only ever opens on the exact word.
      const decision: ApprovalDecision = params.decision === 'approved' ? 'approved' : 'denied'
      this.pendingApprovals.delete(id)
      const stored = entry.approvals.get(id)
      if (stored) stored.decision = decision
      this.log(`approval ${id} ${decision} from the phone`)
      entry.resolve(decision)
      return { ok: true }
    })

    /**
     * The phone edits the reflection schedule. The wire shape is data, not
     * policy: every field is re-derived here and anything malformed costs
     * itself rather than the whole patch. The answer is the desktop's own
     * post-write config — the phone renders that, so the two screens can
     * never disagree about what was saved.
     */
    tunnel.onRpc(Rpc.setReflectionConfig, async (params) => {
      const apply = this.deps.applyReflectionConfig
      if (!apply) throw new Error('reflection config not served here')
      const patch = sanitizeReflectionPatch(params)
      const cfg = await apply(patch)
      this.log(
        `reflection config updated from the phone (${Object.keys(patch).join(', ') || 'no-op'})`
      )
      return cfg
    })

    tunnel.onRpc(Rpc.runReflection, async (params) => {
      const run = this.deps.runReflectionJob
      if (!run) throw new Error('reflection jobs not served here')
      const kind = params.kind === 'deepClean' ? 'deepClean' : 'reflection'
      const result = await run(kind)
      this.log(`${kind} run requested from the phone — ${result}`)
      return { result }
    })

    // ---------------------------------------------------------- projects
    //
    // Straight through to the store the desktop's own Projects page edits —
    // same functions, same mutation tail, same changed-listener. That is what
    // makes a phone edit land on an open desktop page (and vice versa) rather
    // than the two screens keeping separate copies of one JSON file.

    tunnel.onRpc(Rpc.projectsList, async () => {
      const projects = await listProjects()
      this.debug(`served ${projects.length} project(s)`)
      return { projects: projects.map(toWireProject) }
    })

    tunnel.onRpc(Rpc.projectCreate, async (params) => {
      const project = await createProject({
        title: wireText(params.title, TITLE_MAX) ?? '',
        icon: wireText(params.icon, ICON_MAX),
        instructions: wireText(params.instructions, INSTRUCTIONS_MAX)
      })
      this.log(`project created from the phone — ${project.id}`)
      return { project: toWireProject(project) }
    })

    tunnel.onRpc(Rpc.projectUpdate, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('projectUpdate needs an id')
      // A `files` array is a whole-list replace and the desktop deletes the
      // copies it owns for everything dropped, so it is only ever honoured as
      // a real array — an absent field must leave the list alone, and reading
      // a malformed one as `[]` would delete every attached file.
      const files = Array.isArray(params.files)
        ? await this.resolveProjectFiles(id, params.files as unknown[])
        : undefined
      // Folders are references, so a dropped one costs nothing — but an ADDED
      // one is a path typed on a phone, and it names something on THIS machine
      // or nothing at all. Checked here, once, for both directions.
      const directories = Array.isArray(params.directories)
        ? await resolveWireDirectories(params.directories as unknown[])
        : undefined
      const project = await updateProject({
        id,
        title: wireText(params.title, TITLE_MAX),
        icon: wireText(params.icon, ICON_MAX),
        instructions: wireText(params.instructions, INSTRUCTIONS_MAX),
        ...(files ? { files } : {}),
        ...(directories ? { directories } : {})
      })
      this.debug(`project ${id} updated from the phone`)
      return { project: toWireProject(project) }
    })

    tunnel.onRpc(Rpc.projectDelete, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('projectDelete needs an id')
      await deleteProject(id)
      this.log(`project ${id} deleted from the phone`)
      return { ok: true }
    })

    // -------------------------------------------------------- procedures

    tunnel.onRpc(Rpc.proceduresList, async () => {
      const procedures = await listProcedures()
      this.debug(`served ${procedures.length} procedure(s)`)
      return { procedures: procedures.map(toWireProcedure) }
    })

    tunnel.onRpc(Rpc.procedureCreate, async (params) => {
      const procedure = await createProcedure({
        title: wireText(params.title, TITLE_MAX) ?? '',
        prompt: wireText(params.prompt, PROMPT_MAX) ?? '',
        mode: wireMode(params.mode),
        icon: wireText(params.icon, ICON_MAX),
        projectId: wireText(params.projectId, ID_MAX)
      })
      this.log(`procedure created from the phone — ${procedure.id}`)
      return { procedure: toWireProcedure(procedure) }
    })

    tunnel.onRpc(Rpc.procedureUpdate, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('procedureUpdate needs an id')
      // A `files` array is a whole-list replace and the desktop deletes the
      // copies it owns for everything dropped, so it is only ever honoured as
      // a real array — an absent field must leave the list alone, and reading
      // a malformed one as `[]` would delete every attached file.
      const files = Array.isArray(params.files)
        ? await this.resolveProcedureFiles(id, params.files as unknown[])
        : undefined
      // Folders are references, so a dropped one costs nothing — but an ADDED
      // one is a path typed on a phone, and it names something on THIS machine
      // or nothing at all. Checked here, once, for both directions.
      const directories = Array.isArray(params.directories)
        ? await resolveWireDirectories(params.directories as unknown[])
        : undefined
      const procedure = await updateProcedure({
        id,
        title: wireText(params.title, TITLE_MAX),
        prompt: wireText(params.prompt, PROMPT_MAX),
        mode: wireMode(params.mode),
        icon: wireText(params.icon, ICON_MAX),
        // '' unbinds, exactly as the desktop's setter reads it — so this one
        // passes an empty string through rather than treating it as absent.
        projectId: wireText(params.projectId, ID_MAX),
        ...(files ? { files } : {}),
        ...(directories ? { directories } : {})
      })
      this.debug(`procedure ${id} updated from the phone`)
      return { procedure: toWireProcedure(procedure) }
    })

    tunnel.onRpc(Rpc.procedureDelete, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('procedureDelete needs an id')
      await deleteProcedure(id)
      this.log(`procedure ${id} deleted from the phone`)
      return { ok: true }
    })

    // ------------------------------------------------------- automations

    tunnel.onRpc(Rpc.automationsRead, async () => {
      const [markdown, stamps] = await Promise.all([
        readViewerFile(HEARTBEAT_PATH).catch(() => ''),
        this.deps.agent.brainstem.getHeartbeatEditStamps().catch(() => ({}))
      ])
      const jobs = this.activeAutomationJobs()
      this.debug(`served heartbeat.md (${markdown.length} chars, ${jobs.length} active job(s))`)
      return { markdown, jobs, stamps, runs: this.automationRuns() }
    })

    /**
     * Whole-file write — the same shape the desktop's markdown view and card
     * editor both use, because the scheduler's unit of truth is the file. The
     * atomic writer means a reader never sees a torn file, and the watcher
     * reloads the scheduler for both screens off the same change.
     */
    tunnel.onRpc(Rpc.automationsWrite, async (params) => {
      const markdown = wireText(params.markdown, HEARTBEAT_MAX)
      if (markdown === undefined) throw new Error('automationsWrite needs markdown')
      await writeViewerFile(HEARTBEAT_PATH, markdown)
      this.log(`heartbeat.md written from the phone (${markdown.length} chars)`)
      return { ok: true }
    })

    tunnel.onRpc(Rpc.resolveDirectory, async (params) => {
      const resolved = await resolveWorkingDirectory(String(params.path ?? ''))
      if (!resolved.ok) throw new Error(resolved.error)
      this.debug(`resolved working folder for the phone — ${resolved.path}`)
      return { path: resolved.path }
    })

    tunnel.onRpc(Rpc.automationRun, async (params) => {
      const label = String(params.label ?? '')
      if (!label) throw new Error('automationRun needs a label')
      const result = this.deps.agent.brainstem.runJobNow(label)
      this.log(
        `automation "${label}" run requested from the phone — ` +
          (result.started
            ? 'started'
            : result.ok
              ? `${result.state ?? 'queued'} (${result.running ?? 0} runs hold the pool)`
              : `refused: ${result.error}`)
      )
      return result
    })

    /**
     * The overlay stack's seed, taken once per connection.
     *
     * Both halves of it are push-only — the run pool announces itself when it
     * moves, the reindex when it starts and stops — so a phone that connects
     * mid-run has already missed the announcement and would show nothing until
     * whatever is running ended. This is the one read that closes that window.
     */
    tunnel.onRpc(Rpc.overlaysRead, async () => {
      const seed: OverlaySeed = {
        runs: this.automationRuns(),
        reindex: this.deps.agent.cortex.getReindexStatus()
      }
      this.debug(
        `served overlay seed (${seed.runs.running.length} running, ` +
          `${seed.runs.queued.length} queued, reindex ${seed.reindex ? 'active' : 'idle'})`
      )
      return seed
    })

    /**
     * The phone's Debug button — the same per-conversation bundle the desktop's
     * own History page collects, through the same runner and the same
     * single-flight guard (see setDiagnosticExporter).
     *
     * Only the RESULT crosses the bridge. The archive itself is uploaded to
     * the org like any workspace file and the answer carries its sha, which
     * the phone downloads from the API — a zip is exactly the kind of thing
     * the content-addressed lane exists for, and inlining megabytes into one
     * RPC answer would blow the bridge's frame cap.
     *
     * Progress is pushed as it happens and is advisory: it makes the bar move,
     * and a phone that misses every tick still gets a complete result here.
     */
    tunnel.onRpc(Rpc.diagnosticsExport, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      if (!conversationId) throw new Error('diagnosticsExport needs a conversationId')
      if (!this.diagnosticExporter) throw new Error('this desktop cannot export diagnostics')
      this.debug(`diagnostic export requested for ${conversationId}`)
      const result = await this.diagnosticExporter(conversationId, (progress) => {
        this.bridge?.emit(Event.diagnosticsProgress, progress)
      })
      let sha256: string | null = null
      if (result.ok && result.relativePath) {
        sha256 =
          (await this.deps.uploadWorkspaceFile?.(result.relativePath, 'application/zip')) ?? null
      }
      this.debug(
        result.ok
          ? `diagnostic export ready: ${result.fileName} (${result.sizeBytes} bytes, ${sha256 ? 'uploaded' : 'NOT uploaded'})`
          : `diagnostic export failed: ${result.error}`
      )
      return { ...result, sha256 } as unknown as Record<string, unknown>
    })

    /**
     * Attach a blob the phone uploaded to the org to a project, a procedure or
     * an automation. The phone's Add-files uploads bytes straight to the org
     * under `uploads/<target>/<name>`; this makes them real HERE — download
     * if this machine does not hold them, then adopt through the exact
     * functions the desktop's own dialogs call, so the answer already
     * describes the stored project/procedure the phone renders.
     */
    tunnel.onRpc(Rpc.filesAdopt, async (params) => {
      const rel = String(params.path ?? '')
      const sha256 = String(params.sha256 ?? '').toLowerCase()
      const name = String(params.name ?? '').trim() || (rel.split('/').pop() ?? '')
      const abs = rel ? resolveUploadPath(rel) : null
      if (!rel || !abs) throw new Error(`invalid path: ${rel}`)
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('filesAdopt needs the blob sha256')
      if (!name) throw new Error('filesAdopt needs a file name')
      const target = (params.target ?? {}) as { kind?: unknown; id?: unknown; existing?: unknown }
      if (!(await uploadExists(rel))) {
        if (!this.deps.hydrateBlob) throw new Error('this desktop cannot fetch org files')
        if (!(await this.deps.hydrateBlob(rel, sha256))) {
          throw new Error(`could not fetch ${rel} from the org`)
        }
      }
      const stat = await statUpload(rel)
      const metadata = {
        ...classifyFile(name, typeof params.mimeType === 'string' ? params.mimeType : undefined),
        originalName: name,
        sizeBytes: stat?.sizeBytes ?? 0
      }
      if (target.kind === 'automation') {
        const existing = Array.isArray(target.existing)
          ? (target.existing as unknown[]).filter((v): v is string => typeof v === 'string')
          : []
        const file = await adoptUploadedAutomationFile(existing, abs, name)
        this.log(`automation file added from the phone — ${file.name}`)
        return { ...metadata, filePath: toWirePath(file.path), path: file.path, name: file.name }
      }
      const id = typeof target.id === 'string' ? target.id : ''
      if (!id) throw new Error('filesAdopt needs a target id')
      if (target.kind === 'procedure') {
        const { procedure, file } = await adoptUploadedProcedureFile(id, abs, name)
        this.log(`procedure file added from the phone — ${file.name}`)
        return {
          ...metadata,
          filePath: toWirePath(file.path),
          procedureId: id,
          procedure: toWireProcedure(procedure)
        }
      }
      if (target.kind === 'project') {
        const { project, file } = await adoptUploadedProjectFile(id, abs, name)
        this.log(`project file added from the phone — ${file.name}`)
        return {
          ...metadata,
          filePath: toWirePath(file.path),
          projectId: id,
          project: toWireProject(project)
        }
      }
      throw new Error(`unknown adopt target ${String(target.kind)}`)
    })
  }

  /**
   * The phone's project file list, reduced to refs the project ACTUALLY holds.
   *
   * The phone only ever removes files here — adding goes through the upload
   * path — so this write is a subset filter, and stating it as one is what
   * makes it safe: a wire path is matched against the stored refs rather than
   * resolved into one. Nothing else can be attached (an absolute path the
   * agent would then be told to read), and nothing else can be deleted (a
   * mismatched path would drop a file the phone meant to keep, since
   * updateProject removes the copies it owns for everything not in the list).
   */
  private async resolveProjectFiles(id: string, wire: unknown[]): Promise<ProjectFileRef[]> {
    const project = await getProject(id)
    if (!project) throw new Error(`project not found: ${id}`)
    const root = workspaceRoot()
    const byWirePath = new Map(
      project.files.map((file) => [
        file.path.startsWith(root + path.sep) ? path.relative(root, file.path) : file.path,
        file
      ])
    )
    const kept: ProjectFileRef[] = []
    const seen = new Set<string>()
    for (const entry of wire) {
      const wirePath = (entry as { path?: unknown } | null)?.path
      if (typeof wirePath !== 'string') continue
      const file = byWirePath.get(wirePath)
      if (!file || seen.has(file.path)) continue
      seen.add(file.path)
      kept.push(file)
    }
    return kept
  }

  /**
   * The phone's procedure file list, reduced to refs the procedure ACTUALLY
   * holds — the same guard resolveProjectFiles applies, for the same reason:
   * the list is a whole-list replace that DELETES the copies it drops, so a
   * path the phone invented can never enter it.
   */
  private async resolveProcedureFiles(id: string, wire: unknown[]): Promise<ProcedureFileRef[]> {
    const procedure = (await listProcedures()).find((p) => p.id === id)
    if (!procedure) throw new Error(`procedure not found: ${id}`)
    const byWirePath = new Map((procedure.files ?? []).map((file) => [toWirePath(file.path), file]))
    const kept: ProcedureFileRef[] = []
    const seen = new Set<string>()
    for (const entry of wire) {
      const wirePath = (entry as { path?: unknown } | null)?.path
      if (typeof wirePath !== 'string') continue
      const file = byWirePath.get(wirePath)
      if (!file || seen.has(file.path)) continue
      seen.add(file.path)
      kept.push(file)
    }
    return kept
  }

  /** The scheduler's live view: the cron and the next fire, in THIS zone. */
  private activeAutomationJobs(): AutomationJob[] {
    const now = Date.now()
    return this.deps.agent.brainstem.getActiveJobs().map((job) => ({
      id: job.id,
      label: job.label,
      type: job.type,
      cron: job.cron,
      // A `once` job's moment is absolute and already registered; everything
      // else resolves from its cron. Served rather than computed on the phone:
      // these fire against this machine's clock and zone.
      nextRunMs: job.runAt ?? (job.cron ? nextCronMs(job.cron, now) : null),
      mode: job.mode
    }))
  }

  /**
   * The run pool, minus procedure runs. They share the pool but are not
   * automations, so they never gate an automation's play button — the same
   * filter the desktop's own cards apply.
   */
  private automationRuns(): AutomationRuns {
    const brainstem = this.deps.agent.brainstem
    return toWireRuns({ running: brainstem.getRunningJobs(), queued: brainstem.getQueuedJobs() })
  }

  /**
   * The rest of a send after the RPC reply: persist the user message, build
   * the LLM history, dispatch the runner. Failures
   * here reach the phone as a turn.status error push — the caller wired that.
   */
  private async continueSend(
    conversationId: string,
    text: string,
    attachments: MessageAttachment[],
    voicePrompt: boolean,
    voiceLangHint: string | undefined,
    messageId?: string
  ): Promise<void> {
    let content = text
    let voiceLang = voiceLangHint

    if (voicePrompt && !content) {
      const audio = attachments.find((a) => a.type === 'audio')
      if (!audio) throw new Error('voice note without an audio attachment')
      try {
        // Conversation-scoped so the transcript files under speech/conv-…,
        // ffmpeg ensured because a direct tool call bypasses the agent loop's
        // dependency resolution.
        await this.deps.agent.cerebellum.ensureSystemTool('ffmpeg')
        const result = await this.deps.agent.cerebellum.runWithConversation(conversationId, () =>
          this.deps.agent.cerebellum.executeTool('stt_transcribe', { filePath: audio.filePath })
        )
        if (!result.success) throw new Error(result.error ?? 'transcription failed')
        content = extractTranscript(result.output ?? '')
        if (!content) throw new Error('voice message transcribed to nothing')
        voiceLang = extractVoiceLanguage(result.output ?? '') || voiceLang
      } catch (error) {
        // The recording must survive its failed transcription: persist the
        // message (empty content, audio attached) so both transcripts keep
        // the voice note, then let the error reach the phone.
        await this.persistUserMessage(
          conversationId,
          '',
          attachments,
          voicePrompt,
          voiceLang,
          messageId
        )
        throw error
      }
    }

    const conversation = await loadConversation(conversationId)
    if (!conversation) throw new Error(`unknown conversation ${conversationId}`)

    const userMessage = await this.persistUserMessage(
      conversationId,
      content,
      attachments,
      voicePrompt,
      voiceLang,
      messageId
    )
    // The local copy feeds the history build below; the persist above already
    // merged it onto the freshest disk state.
    conversation.messages.push(userMessage)
    conversation.updatedAt = userMessage.timestamp

    // Same-conversation preemption, matching the Electron channel: a second
    // send into a streaming conversation replaces its turn rather than
    // running two against one transcript.
    this.turns.get(conversationId)?.controller.abort()

    const handle = this.deps.runner.send({
      history: this.buildHistory(conversation),
      conversationId,
      userMessageId: userMessage.id,
      projectId: conversation.projectId ?? null,
      makeSink: ({ turnId, conversationId: sinkConversationId }) =>
        this.createSink(turnId, sinkConversationId ?? conversationId, userMessage)
    })
    this.turns.set(conversationId, { turnId: handle.turnId, controller: handle.controller })
    this.log(`turn ${handle.turnId} started from the phone in ${conversationId}`)
  }

  /**
   * Append the phone's user message to the conversation file. An append-RMW
   * against the freshest disk state, exactly like the terminal channel: a
   * concurrent writer (summarizer, another surface) must never be clobbered
   * by a stale copy. A null disk means the conversation was deleted out from
   * under us — the write is skipped rather than resurrecting the file.
   *
   * `id` comes from the phone when it sent one: it is already showing this
   * message, and matching ids are what let its copy be replaced by this one
   * rather than appear twice. Ids are scoped to a conversation and the phone
   * mints in the same `m_<ts>_<rand>` shape, so adopting one is no different
   * from minting it here.
   */
  private async persistUserMessage(
    conversationId: string,
    content: string,
    attachments: MessageAttachment[],
    voicePrompt: boolean,
    voiceLang: string | undefined,
    id?: string
  ): Promise<ConversationMessage> {
    const message: ConversationMessage = {
      id: id ?? mintMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(voicePrompt ? { voicePrompt: true } : {}),
      ...(voiceLang ? { voiceLang } : {})
    }
    await updateConversation(conversationId, (disk) => {
      if (!disk) return null
      disk.messages.push(message)
      disk.updatedAt = message.timestamp
      return disk
    })
    return message
  }

  /**
   * The LLM-bound history, built the way the terminal channel builds it so a
   * turn from the phone sees exactly what a turn from anywhere else sees:
   * summarized prefix + replay window, assistant segments with their tool
   * calls and results, voice notes as `<voice_note>` transcripts (the audio
   * never reaches the model), attachments composed into the message content
   * and forwarded so images and PDFs become native blocks downstream.
   */
  private buildHistory(conversation: ConversationFile): ChatHistoryMessage[] {
    const window = replayWindow(conversation)
    return stubStaleToolResults(
      window.preamble.concat(
        window.messages.flatMap((m) => {
          if (m.role !== 'user') return assistantSegmentsToHistory(m)
          if (m.voicePrompt) {
            const langAttr = m.voiceLang ? ` lang="${m.voiceLang}"` : ''
            return [{ role: 'user' as const, content: `<voice_note${langAttr}>\n${m.content}` }]
          }
          const atts = m.attachments ?? []
          const entry: ChatHistoryMessage = {
            role: 'user',
            content: composeAttachmentContext(m.content, atts)
          }
          if (atts.length > 0) {
            entry.attachments = atts.map((a) => ({
              type: a.type,
              filePath: a.filePath,
              originalName: a.originalName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes
            }))
          }
          return [entry]
        })
      ),
      conversation.id
    )
  }

  /**
   * The attachments a phone message may carry, reduced to the ones that are
   * real: a workspace-relative path that resolves inside the root and whose
   * bytes are here — already, or fetched now from the org by the sha the
   * phone uploaded them under (the phone uploads straight to the org before
   * it sends, so this machine may never have seen the file). Type and mime
   * are re-derived rather than trusted — the wire shape is data, not policy.
   */
  private async sanitizeAttachments(raw: unknown): Promise<MessageAttachment[]> {
    if (!Array.isArray(raw)) return []
    const out: MessageAttachment[] = []
    for (const item of raw.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : ''
      if (!filePath || !resolveUploadPath(filePath)) continue
      if (!(await uploadExists(filePath))) {
        const sha = typeof candidate.sha256 === 'string' ? candidate.sha256.toLowerCase() : ''
        const fetched =
          /^[0-9a-f]{64}$/.test(sha) && this.deps.hydrateBlob
            ? await this.deps.hydrateBlob(filePath, sha)
            : false
        if (!fetched) {
          this.log(`attachment dropped — no bytes on disk or in the org for ${filePath}`)
          continue
        }
        this.debug(`attachment hydrated from the org — ${filePath}`)
      }
      const originalName =
        typeof candidate.originalName === 'string' && candidate.originalName
          ? candidate.originalName
          : (filePath.split('/').pop() ?? filePath)
      const declaredMime = typeof candidate.mimeType === 'string' ? candidate.mimeType : undefined
      const { type, mimeType } = classifyFile(originalName, declaredMime)
      const stat = await statUpload(filePath)
      const attachment: MessageAttachment = {
        type,
        filePath,
        originalName,
        mimeType,
        sizeBytes: stat?.sizeBytes ?? 0
      }
      for (const key of ['width', 'height', 'durationSeconds'] as const) {
        const value = candidate[key]
        if (typeof value === 'number' && Number.isFinite(value)) attachment[key] = value
      }
      out.push(attachment)
    }
    return out
  }

  /**
   * Renders a turn onto the phone. Text deltas stream as they arrive so the
   * phone shows the assistant writing; anything else (tool calls, the finished
   * message) resolves to a fetch, because the phone already knows how to read
   * a stored conversation and that keeps one shape rather than two.
   *
   * The sink is also this channel's persister. The Electron channel leans on
   * its renderer to save the turn and the terminal saves inside its own sink —
   * nobody else writes a mobile turn to disk, so without the accumulator here
   * the phone's post-turn refetch would pull a transcript that stops before
   * the answer it just watched stream.
   */
  private createSink(
    turnId: string,
    conversationId: string,
    userMessage?: ConversationMessage
  ): TurnSink {
    let seq = 0
    const acc: AssistantAccumulator = {
      assistantMessageId: mintMessageId(),
      assistantTimestamp: Date.now(),
      assistantContent: '',
      segments: [],
      approvals: new Map(),
      toolTimings: new Map(),
      stopReason: null
    }
    /**
     * This turn's tokenomics, folded into the conversation's persisted
     * `stats` when the turn lands. Without it a phone-driven conversation
     * saved no stats at all, so opening it in the app showed an empty
     * context-meter card — the same gap TurnStatsCollector was written to
     * close for the other channels, which this one never wired up. Fed from
     * onTurnEvent below; see {@link TurnStatsCollector} for the routing
     * rules it mirrors from the renderer.
     */
    const stats = new TurnStatsCollector(Date.now())
    /**
     * Append the accumulated assistant message and fold this turn's stats;
     * resolves once both are on disk. Runs even when the turn produced no
     * assistant message (errored before its first segment) so an errored
     * turn still records its all-time roll-up — matching how every other
     * channel persists.
     */
    const persistTurn = async (error?: string): Promise<void> => {
      const assistant = buildAssistantMessage(acc)
      const foldStats = stats.hasData()
      if (!assistant && !foldStats) return
      if (assistant && error) assistant.error = error
      const endedAt = Date.now()
      await updateConversation(conversationId, (disk) => {
        if (!disk) return null
        if (assistant) {
          disk.messages.push(assistant)
          disk.updatedAt = endedAt
        }
        if (foldStats) disk.stats = stats.foldInto(disk.stats, endedAt)
        return disk
      }).catch(() => undefined)
    }
    /**
     * The live mirror of this turn, throttled — the same message this sink
     * will persist, as it stands right now, under the id it will be saved
     * with. Identical in kind to what the Electron and terminal mirrors
     * send the phone, which is the point: a turn started ON the phone was the
     * one case that pushed something else, and that something else was a bare
     * `{turnId, kind}` nudge meaning "re-read the conversation". Mid-turn
     * there is nothing to re-read — the assistant message is not on disk until
     * persistTurn above — so the phone would fetch a transcript from BEFORE
     * the turn and overwrite what it was showing. Sending the message itself
     * costs the same push and needs no fetch at all.
     */
    let lastMirrorAt = 0
    let mirrorTimer: NodeJS.Timeout | null = null
    const emitMirror = (urgent: boolean): void => {
      // A trailing tick from a turn already released — finished, or preempted
      // by a second send into the same conversation — must not push a stale
      // snapshot over the message that replaced it.
      if (this.turns.get(conversationId)?.turnId !== turnId) return
      lastMirrorAt = Date.now()
      // The desktop's own window first, with the FULL accumulator: it renders
      // every segment its own turns produce and has no relay record cap, so
      // neither the phone's clean-feed setting nor the wire budget applies.
      try {
        const full = buildAssistantMessage(acc)
        if (full) this.rendererMirror?.(conversationId, full, userMessage)
      } catch {
        // a broken renderer bridge must never affect the turn
      }
      const message = buildAssistantMessage(
        this.verbose ? acc : { ...acc, segments: acc.segments.filter(isCleanFeedSegment) }
      )
      if (!message) return
      // The prompt rides every tick, exactly as the in-app mirror sends it: a
      // phone that pairs — or relaunches — mid-turn only ever sees ticks, and
      // the answer without its question is the gap this closes. `urgent` is
      // the immediate flush — a parked card's anchor — which must not sit out
      // the byte pacing either.
      this.pushMessageAppended(conversationId, message, userMessage, { urgent })
    }
    const scheduleMirror = (immediate: boolean): void => {
      const sinceLast = Date.now() - lastMirrorAt
      if (immediate || sinceLast >= MIRROR_THROTTLE_MS) {
        if (mirrorTimer) {
          clearTimeout(mirrorTimer)
          mirrorTimer = null
        }
        emitMirror(immediate)
        return
      }
      if (mirrorTimer) return
      mirrorTimer = setTimeout(() => {
        mirrorTimer = null
        emitMirror(false)
      }, MIRROR_THROTTLE_MS - sinceLast)
      mirrorTimer.unref?.()
    }
    return {
      channelId: 'mobile',
      turnId,
      conversationId,
      onSegment: (segment: Segment) => {
        // Subagent output never renders as the assistant's own voice — the
        // same rule every other channel's replay path follows. `worker` is
        // only present on the segment kinds that can carry it.
        if ('worker' in segment && segment.worker) return
        // Everything the phone's replay will want, whatever the mirror below
        // decides to push right now. Workflow/task snapshots upsert by id — a
        // stream of them is one card, not a card per tick.
        if (segment.kind === 'workflow') upsertWorkflowSegment(acc.segments, segment)
        else if (segment.kind === 'text' || segment.kind === 'reasoning')
          appendTextSegment(acc.segments, segment)
        else acc.segments.push(segment)
        if (segment.kind === 'turn_end') acc.stopReason = segment.stopReason
        if (segment.kind === 'text') {
          acc.assistantContent += segment.delta
          // Text rides BOTH rails: the delta so the phone shows the answer
          // arriving token by token, the throttled snapshot so it also gets
          // the structure around it. The phone folds one into the other —
          // a snapshot supersedes the deltas it already contains — so the two
          // can never print the same words twice.
          this.pushMessageDelta(conversationId, segment.delta, seq++)
          scheduleMirror(false)
          return
        }
        // A card flipping to running/succeeded should not wait out the text
        // throttle, exactly as in the in-app mirror.
        scheduleMirror(false)
      },
      onTurnEvent: <E extends keyof CorpusEvents>(type: E, payload: CorpusEvents[E]): void => {
        // The phone renders none of these, but the desktop's context-meter
        // card is built from exactly four of them — the collector picks
        // those out and ignores the rest.
        stats.note(type, payload)
      },
      /**
       * A flagged tool call, put to the phone as the card the desktop shows
       * for the same request. The turn parks here until the phone answers,
       * the turn ends, or the phone drops — `drainTurnRequests` owns the
       * last two, and every one of them resolves this promise.
       *
       * The record goes into the accumulator whether or not it is ever
       * answered, so the saved transcript carries the same approval card the
       * in-app and terminal histories do; the decision is back-filled where
       * it is made.
       */
      onApprovalRequest: (req: ApprovalRequest & { id: string }) => {
        return new Promise<ApprovalDecision>((resolve) => {
          acc.approvals.set(req.id, {
            approvalId: req.id,
            toolCallId: req.toolCall.id,
            tool: req.toolCall.name,
            args: req.toolCall.args,
            reason: req.reason,
            level: req.level,
            description: req.description
          })
          // Nothing on the other end can answer — fail closed exactly as this
          // sink did before it could ask at all.
          if (!this.bridge?.phonePresent) {
            const stored = acc.approvals.get(req.id)
            if (stored) stored.decision = 'denied'
            this.log(`approval ${req.toolCall.name} denied — no phone connected`)
            resolve('denied')
            return
          }
          // Several requests can be parked at once — a turn can have more than
          // one tool call in flight, and the phone anchors a card per tool
          // call, so nothing here supersedes anything. Same as the Electron
          // channel; the text channels collapse to one only because a chat
          // thread has no way to show two.
          this.pendingApprovals.set(req.id, {
            turnId,
            conversationId,
            resolve,
            approvals: acc.approvals
          })
          // The card anchors to its tool_call segment, so the phone must have
          // that segment before the request arrives — flush the mirror rather
          // than let it sit out the throttle.
          scheduleMirror(true)
          this.log(`approval requested from the phone — ${req.toolCall.name} (${req.level})`)
          this.bridge?.emit(Event.approvalRequest, {
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCall.id,
            tool: req.toolCall.name,
            args: req.toolCall.args,
            level: req.level,
            reason: req.reason,
            description: req.description
          })
        })
      },
      /**
       * ask_user, put to the phone as the interactive question card. With no
       * phone on the other end this resolves `unsupported` rather than
       * `canceled` — the `ask` tool then degrades to posing the question as
       * plain text, which is readable whenever the user next opens the app,
       * where a cancel would just lose it.
       */
      onAskUserRequest: (req: AskUserRequest & { id: string }) => {
        return new Promise<AskUserResponse>((resolve) => {
          if (!this.bridge?.phonePresent) {
            this.debug('ask_user degraded to text — no phone connected')
            resolve({ kind: 'unsupported' })
            return
          }
          this.pendingAsks.set(req.id, {
            turnId,
            conversationId,
            resolve,
            card: { toolCallId: req.toolCallId, questions: req.questions }
          })
          scheduleMirror(true)
          this.log(`ask_user put to the phone — ${req.questions.length} question(s)`)
          this.bridge?.emit(Event.askRequest, {
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCallId,
            questions: req.questions
          })
        })
      },
      onDone: () => {
        this.turns.delete(conversationId)
        this.drainTurnRequests(turnId, 'turn ended')
        this.log(`turn ${turnId} finished`)
        // Disk first, pushes second: the refresh push triggers the phone's
        // body refetch, and a refetch that outruns the save would hand back
        // a transcript without the reply — the exact hole this sink closes.
        void persistTurn().then(() => {
          this.pushTurnStatus(conversationId, 'done')
          void this.pushConversationRefresh(conversationId)
        })
      },
      onError: (error: string) => {
        this.turns.delete(conversationId)
        this.drainTurnRequests(turnId, 'turn failed')
        this.log(`turn ${turnId} failed — ${error}`)
        // A failed turn still persists what streamed before it broke —
        // matching every other channel, and keeping both transcripts honest
        // about how far the answer got.
        void persistTurn(error).then(() => {
          this.pushTurnStatus(conversationId, 'error', error)
          void this.pushConversationRefresh(conversationId)
        })
      },
      onCredentialBlocked: (type: string) => {
        this.pushTurnStatus(conversationId, 'error', `blocked: ${type}`)
      }
    }
  }

  /**
   * Resolve every request still parked on the phone — for one turn, or for
   * all of them when `turnId` is null (the phone went away, the channel
   * stopped). Fails closed, exactly like the Electron channel draining a
   * closed window: approvals deny, asks cancel, and a denied approval is
   * written into the turn's accumulator so the saved transcript records the
   * outcome the agent actually got.
   *
   * The pipeline is BLOCKED on these promises. Anything that ends a turn or
   * takes the phone away has to come through here, or the turn hangs forever.
   */
  private drainTurnRequests(turnId: string | null, reason: string): void {
    for (const [id, entry] of this.pendingApprovals) {
      if (turnId !== null && entry.turnId !== turnId) continue
      this.pendingApprovals.delete(id)
      const stored = entry.approvals.get(id)
      if (stored && !stored.decision) stored.decision = 'denied'
      this.log(`approval ${id} denied — ${reason}`)
      entry.resolve('denied')
    }
    for (const [id, entry] of this.pendingAsks) {
      if (turnId !== null && entry.turnId !== turnId) continue
      this.pendingAsks.delete(id)
      this.log(`ask ${id} canceled — ${reason}`)
      entry.resolve({ kind: 'canceled' })
    }
  }

  /** Nudge the phone to re-read a conversation whose body just changed. */
  private async pushConversationRefresh(conversationId: string): Promise<void> {
    this.bridge?.emit(Event.messageAppended, { conversationId })
  }

  /**
   * A conversation's records landed in the org — the one moment the phone
   * may fetch its body from the API and expect the turn it just watched to
   * be in it. Announced from the sync engine's push hook.
   */
  pushConversationSynced(conversationId: string, updatedAt: number): void {
    this.debug(`push synced ${conversationId}`)
    this.bridge?.emit(Event.conversationSynced, { id: conversationId, updatedAt })
  }

  // ------------------------------------------------------------------ push

  /** A conversation was created or changed — the phone's list updates live. */
  pushConversationUpserted(meta: ConversationMeta): void {
    this.debug(`push conversation ${meta.id} (${meta.messageCount} messages)`)
    this.bridge?.emit(Event.conversationUpserted, meta)
  }

  pushConversationDeleted(id: string): void {
    this.debug(`push delete ${id}`)
    this.bridge?.emit(Event.conversationDeleted, { id })
  }

  /** Streaming assistant output for whichever conversation the phone has open. */
  pushMessageDelta(conversationId: string, text: string, seq: number): void {
    // Counted before the emit so a snapshot cached in the same tick reads the
    // count INCLUDING this delta exactly when it includes its text.
    this.mirrorDeltaSeq.set(conversationId, (this.mirrorDeltaSeq.get(conversationId) ?? 0) + 1)
    this.bridge?.emit(Event.messageDelta, { conversationId, text, seq })
  }

  /**
   * The assistant message so far, in full, rather than the piece just added.
   * `replace` tells the phone to show this instead of appending it — the
   * mirror other channels emit is a snapshot, and appending snapshots would
   * repeat the whole answer on screen once per tick.
   */
  pushMessageSnapshot(conversationId: string, text: string): void {
    this.bridge?.emit(Event.messageDelta, { conversationId, text, replace: true })
  }

  /**
   * A message the phone should show, or — with no message — a bare nudge to
   * re-read the conversation once nothing is being written into it.
   *
   * An event is one frame with no chunking behind it, so a push past the
   * relay's record cap does not arrive late, it closes the tunnel. An
   * oversized snapshot is therefore TRIMMED to the budget (fitMirrorMessage:
   * tool payloads shortened oldest-first, the live edge kept whole, the id
   * kept always) rather than sent — and rather than WITHHELD, which was the
   * old degrade and is how a long tool-heavy turn went dark on the phone for
   * its whole remaining runtime. Only a message that defeats even the trimmer
   * (unserializable, or an envelope no budget can hold) falls back to the
   * nudge.
   *
   * Every full snapshot that passes through here is also CACHED as the
   * conversation's turn-so-far, connected phone or not — Rpc.turnMirror
   * serves it to a phone that joins or rejoins mid-turn, which is the one
   * moment nothing else can redraw the run.
   *
   * `userMessage` — the prompt this turn is answering — travels on BOTH paths.
   * It is a couple of hundred bytes and it is the half of the exchange the
   * phone cannot get anywhere else while the turn runs, so it must not be
   * dropped along with an assistant snapshot that needed trimming: those are
   * exactly the long turns where the gap is most visible.
   */
  pushMessageAppended(
    conversationId: string,
    message: unknown,
    userMessage?: unknown,
    opts?: { urgent?: boolean }
  ): void {
    const prompt = userMessage === undefined ? {} : { userMessage }
    if (message !== undefined) {
      const fitted = this.fitMirror(conversationId, message)
      if (fitted === null) {
        this.bridge?.emit(Event.messageAppended, { conversationId, ...prompt })
        return
      }
      this.lastMirrors.set(conversationId, {
        message: fitted.message,
        deltaSeq: this.mirrorDeltaSeq.get(conversationId) ?? 0,
        ...(userMessage !== undefined ? { userMessage: userMessage as ConversationMessage } : {})
      })
      // Urgent flushes (a parked approval/ask needs its anchor segment on the
      // phone BEFORE the request event) go regardless; everything else pays
      // the byte pacing. A deferred tick is not lost — the trailing flush
      // sends the newest cached snapshot when the window opens.
      if (!opts?.urgent && this.deferMirror(conversationId)) return
      this.mirrorPace.set(conversationId, {
        sentAt: Date.now(),
        sentBytes: fitted.bytes,
        timer: this.clearMirrorTimer(conversationId)
      })
      this.mirrorRail = { sentAt: Date.now(), sentBytes: fitted.bytes }
      this.bridge?.emit(Event.messageAppended, {
        conversationId,
        message: fitted.message,
        ...prompt
      })
      return
    }
    this.bridge?.emit(Event.messageAppended, { conversationId, ...prompt })
  }

  /** Cancel a conversation's pending mirror flush, if any. Returns null for
   *  the convenience of writing the cleared field in one expression. */
  private clearMirrorTimer(conversationId: string): null {
    const pace = this.mirrorPace.get(conversationId)
    if (pace?.timer) clearTimeout(pace.timer)
    if (pace) pace.timer = null
    return null
  }

  /**
   * Drop every pacing record and pending flush — the tunnel they were pacing
   * is going away. The turn-so-far cache is NOT touched here: a disconnect
   * keeps the pairing, and the rejoin serves lastMirrors to the returning
   * phone. Only unpair forgets that too, with the rest of the relationship.
   */
  private clearMirrorPacing(): void {
    for (const pace of this.mirrorPace.values()) {
      if (pace.timer) clearTimeout(pace.timer)
    }
    this.mirrorPace.clear()
    this.mirrorRail = { sentAt: 0, sentBytes: 0 }
  }

  /**
   * True when this mirror tick must wait — still inside the pace window its
   * predecessor's size bought, or behind a congested local socket. Arms the
   * trailing flush so the newest snapshot still goes out the moment it may.
   */
  private deferMirror(conversationId: string): boolean {
    const pace = this.mirrorPace.get(conversationId)
    const congested = (this.bridge?.outboundBufferedBytes ?? 0) > MIRROR_BACKLOG_MAX_BYTES
    const paceWait = (sent: { sentAt: number; sentBytes: number } | undefined): number =>
      sent
        ? sent.sentAt + Math.ceil((sent.sentBytes * 1000) / MIRROR_BYTES_PER_SEC) - Date.now()
        : 0
    // The stricter of two windows: this conversation's own, and the whole
    // rail's — one socket, so concurrent turns split the budget rather than
    // each claiming it.
    const waitMs = Math.max(paceWait(pace), paceWait(this.mirrorRail))
    if (!congested && waitMs <= 0) return false
    const delay = congested ? Math.max(waitMs, MIRROR_RETRY_MS) : waitMs
    const entry = pace ?? { sentAt: 0, sentBytes: 0, timer: null }
    if (!pace) this.mirrorPace.set(conversationId, entry)
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flushPacedMirror(conversationId), delay)
      entry.timer.unref?.()
    }
    return true
  }

  /** The trailing edge of the pacing: push the newest cached snapshot, or
   *  nothing if the turn has since ended — the stored body is the truth then. */
  private flushPacedMirror(conversationId: string): void {
    this.clearMirrorTimer(conversationId)
    const cached = this.lastMirrors.get(conversationId)
    if (!cached) return
    // A snapshot cached BEFORE the newest delta must not go out: on the
    // phone a mirror resets the tail on the promise that it contains every
    // delta sent before it, and this one would arrive after deltas it does
    // not contain — their words would vanish from the visible prose. The
    // phone already holds them as tail; the next tick caches a snapshot
    // that truly contains them and sends into a now-open window.
    if ((this.mirrorDeltaSeq.get(conversationId) ?? 0) !== (cached.deltaSeq ?? 0)) return
    try {
      // Re-enters the paced path: a still-congested socket re-arms the timer,
      // an open window sends.
      this.pushMessageAppended(conversationId, cached.message, cached.userMessage)
    } catch {
      // a socket that died between the check and the send costs one mirror,
      // never the process — the reconnect path re-serves the turn-so-far
    }
  }

  /** The snapshot within the wire budget — trimmed when it must be, null only
   *  when nothing sendable can be made of it. */
  private fitMirror(
    conversationId: string,
    message: unknown
  ): { message: ConversationMessage; bytes: number } | null {
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(message) ?? '')
    } catch {
      return null // unserializable is not sendable either
    }
    if (size <= MIRROR_MAX_BYTES) return { message: message as ConversationMessage, bytes: size }
    const fitted = fitMirrorMessage(message as ConversationMessage, MIRROR_MAX_BYTES)
    if (fitted === null) {
      this.debug(`mirror for ${conversationId} withheld — ${size} bytes and untrimmable`)
      return null
    }
    this.debug(`mirror for ${conversationId} trimmed to fit — ${size} bytes over budget`)
    let fittedBytes = MIRROR_MAX_BYTES
    try {
      fittedBytes = Buffer.byteLength(JSON.stringify(fitted) ?? '')
    } catch {
      // sized a moment ago; the ceiling stands in if it will not size again
    }
    return { message: fitted, bytes: fittedBytes }
  }

  pushTurnStatus(conversationId: string, state: string, detail?: unknown): void {
    // Every state this carries is a turn boundary — started, done, canceled,
    // error — and at a boundary the cached turn-so-far is over: a finished
    // turn's truth is the stored body, a fresh turn's first tick re-caches.
    // The pace record and its pending flush go with it: a mirror sent after
    // the boundary would re-open the live overlay the phone just settled.
    this.clearMirrorTimer(conversationId)
    this.mirrorPace.delete(conversationId)
    this.mirrorDeltaSeq.delete(conversationId)
    this.lastMirrors.delete(conversationId)
    this.bridge?.emit(Event.turnStatus, { conversationId, state, detail })
  }

  /**
   * The same config snapshot the phone fetches, for a caller that isn't a
   * phone. The CLI reads current setting values from exactly this — one
   * assembler for every non-renderer surface, so a terminal and a phone can
   * never disagree about what a setting is set to.
   */
  buildSnapshot(): Promise<Record<string, unknown>> {
    return buildConfigSnapshot(this.deps)
  }

  /** True when a phone is actually on the other end — lets callers skip the
   *  work of building a push nobody will receive. */
  get hasPeer(): boolean {
    return this.bridge?.phonePresent ?? false
  }

  /**
   * Any settings change — the phone refreshes the affected screen. The fresh
   * snapshot rides along when the caller has one, so the phone applies it
   * without a round trip; otherwise the phone re-reads (the RPC while this
   * desktop is up, the synced file when it is not).
   */
  pushConfigChanged(section?: string, snapshot?: Record<string, unknown>): void {
    this.debug(`push config change (${section ?? 'all'}${snapshot ? ', with snapshot' : ''})`)
    this.bridge?.emit(Event.configChanged, {
      section: section ?? null,
      at: Date.now(),
      ...(snapshot ? { snapshot } : {})
    })
  }

  /**
   * Variables travel whole and immediately — the phone writes them straight
   * into its store, no snapshot round trip, so an edit made here (or echoed
   * back from there) is on its screen in the push's own latency. The
   * debounced config.changed that follows every save still covers phones
   * that predate this topic.
   */
  pushVariablesChanged(
    variables: Array<{ name: string; value: string; sensitive: boolean }>
  ): void {
    this.bridge?.emit(Event.variablesChanged, { variables, at: Date.now() })
  }

  pushUsageChanged(): void {
    this.bridge?.emit(Event.usageChanged, { at: Date.now() })
  }

  /**
   * `brain/projects.json` changed, whoever wrote it. Payload-free: the phone
   * re-lists, exactly as an open desktop Projects page re-fetches on the same
   * signal. Fired from the store's own changed-listener, so a write made ON the
   * phone echoes back here too — which is what confirms it landed.
   */
  pushProjectsChanged(): void {
    this.bridge?.emit(Event.projectsChanged, { at: Date.now() })
  }

  /** `brain/procedures.json` changed — same contract as projects. */
  pushProceduresChanged(): void {
    this.bridge?.emit(Event.proceduresChanged, { at: Date.now() })
  }

  /** The scheduler reloaded: heartbeat.md changed, whatever wrote it. */
  pushAutomationsChanged(): void {
    this.bridge?.emit(Event.automationsChanged, { at: Date.now() })
  }

  /**
   * The run pool moved. Carries its payload — this fires several times per run
   * and a fetch per tick would be pure overhead — with procedure runs stripped,
   * since they share the pool but never gate an automation card.
   */
  pushAutomationRuns(snapshot: { running: RunningJobInfo[]; queued: QueuedJobInfo[] }): void {
    this.bridge?.emit(Event.automationRunsChanged, toWireRuns(snapshot))
  }

  /**
   * The memory index started, moved, or finished rebuilding — null when it is
   * over, which is what retires the phone's card.
   *
   * Throttled, unlike the run pool: progress ticks once per batch of eight
   * files, so a large workspace would otherwise spend the tunnel on a number
   * that changes faster than anyone can read it. Start and finish are never
   * throttled — those are the two edges the card appears and disappears on, and
   * dropping either would leave a card that never showed or never left.
   */
  pushReindexStatus(status: ReindexStatus | null): void {
    const now = Date.now()
    const isEdge = status === null || this.lastReindexPush === 0
    if (!isEdge && now - this.lastReindexPush < REINDEX_PUSH_THROTTLE_MS) return
    this.lastReindexPush = status === null ? 0 : now
    this.bridge?.emit(Event.reindexChanged, { status })
  }

  /**
   * The self-updater moved — checking, downloading (percent ticks), ready,
   * installing, error. The whole machine travels every time, exactly as the
   * renderer's own updater:state broadcast does, so the phone renders it
   * straight and a missed tick costs nothing. Unthrottled on purpose: the
   * download emits per whole percent, tens of ticks over minutes, and the
   * 'installing' edge right before this app exits must never be the one a
   * throttle swallows.
   */
  pushUpdaterState(state: UpdaterWireState): void {
    this.bridge?.emit(Event.updaterChanged, { state })
  }

  // ----------------------------------------------------------------- status

  getStatus(): MobileStatus {
    // Presence is the live half; the org's row is the durable half. What the
    // phone said in THIS session wins, and the row answers for a phone that
    // has not connected since this desktop started — which is why the panel
    // can still describe a sleeping phone.
    const live = new Map((this.bridgeState?.phones ?? []).map((p) => [p.deviceId, p]))
    const text = (value: string | null | undefined): string | null => value?.trim() || null
    return {
      paired: this.phones.length > 0,
      phones: this.phones.map((d) => {
        const info = this.phoneInfo.get(d.id)
        const os = text(d.os)
        return {
          id: d.id,
          name: d.name,
          platform: info?.platform ?? (os === 'ios' || os === 'android' ? os : null),
          model: info?.model ?? text(d.model),
          osVersion: info?.osVersion ?? text(d.os_version),
          appVersion: info?.appVersion ?? text(d.app_version),
          pairedAt: Date.parse(d.created_at) || 0,
          lastSeenAt: d.last_seen_at ? Date.parse(d.last_seen_at) || null : null,
          pairMethod: d.pair_method === 'qr' || d.pair_method === 'code' ? d.pair_method : null,
          connected: live.has(d.id),
          connectedSince: live.get(d.id)?.connectedAt ?? null
        }
      }),
      bridge: this.bridgeState,
      offer: this.offer,
      verbose: this.verbose,
      notificationsEnabled: this.notificationsEnabled,
      runCards: this.runCards,
      apiBase: API_BASE
    }
  }

  private emitStatus(): void {
    // Every state change flows through here, which makes it the one place
    // the notify_phone tool's registration is kept honest — a claim, an
    // unpair, the settings toggle.
    this.syncPhoneCapability()
    this.deps.onStatus?.(this.getStatus())
  }

  /** A phone is on the bridge right now. */
  get connected(): boolean {
    return this.bridge?.phonePresent ?? false
  }
}

/**
 * A reflection patch from the wire, reduced to the fields that are real: an
 * integer hour 0-23, an integer quiet window 1-48 h, a boolean cards flag.
 * Malformed fields are dropped rather than clamped — clamping would persist a
 * value the user never chose, while dropping costs that field alone and the
 * authoritative answer corrects the screen that sent it.
 */
export function sanitizeReflectionPatch(params: unknown): ReflectionWirePatch {
  const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const patch: ReflectionWirePatch = {}
  if (
    typeof raw.hour === 'number' &&
    Number.isInteger(raw.hour) &&
    raw.hour >= 0 &&
    raw.hour <= 23
  ) {
    patch.hour = raw.hour
  }
  if (
    typeof raw.quietHours === 'number' &&
    Number.isInteger(raw.quietHours) &&
    raw.quietHours >= 1 &&
    raw.quietHours <= 48
  ) {
    patch.quietHours = raw.quietHours
  }
  if (typeof raw.cards === 'boolean') patch.cards = raw.cards
  return patch
}

/**
 * Desktop project → wire project. The one transformation is the file path:
 * stored absolute, served workspace-relative, because that is the form the
 * phone's file cache resolves and an absolute path would only leak the home
 * directory. Legacy refs from outside the workspace (pre-copy-on-attach, which
 * importOutsideProjectFiles migrates at launch) keep their absolute path —
 * path.relative would produce a `..` escape the phone's cache refuses, so the
 * file simply reads as unavailable there rather than as some other file.
 */
function toWireProject(project: Project): SyncProject {
  const root = workspaceRoot()
  return {
    id: project.id,
    title: project.title,
    icon: project.icon,
    instructions: project.instructions,
    files: project.files.map((file) => ({
      path: file.path.startsWith(root + path.sep) ? path.relative(root, file.path) : file.path,
      name: file.name
    })),
    directories: project.directories ?? [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }
}

/** Desktop procedure → wire procedure; optionals become explicit nulls. */
function toWireProcedure(procedure: Procedure): SyncProcedure {
  return {
    id: procedure.id,
    title: procedure.title,
    prompt: procedure.prompt,
    mode: procedure.mode ?? null,
    icon: procedure.icon ?? '',
    projectId: procedure.projectId ?? null,
    // Paths are sent WORKSPACE-RELATIVE for the copies we own (the phone shows
    // a name, and an absolute desktop path means nothing to it) — the same
    // shape a project's files travel in, so removal round-trips through
    // resolveProcedureFiles below.
    files: procedure.files?.map((file) => ({ path: toWirePath(file.path), name: file.name })) ?? [],
    directories: procedure.directories ?? [],
    createdAt: procedure.createdAt,
    updatedAt: procedure.updatedAt
  }
}

/** Workspace-relative when the file is ours, absolute otherwise. */
function toWirePath(filePath: string): string {
  const root = workspaceRoot()
  return filePath.startsWith(root + path.sep) ? path.relative(root, filePath) : filePath
}

/**
 * A phone's directory list, resolved and checked against THIS machine. A path
 * that names nothing here is refused with the reason rather than stored — a
 * working folder the run cannot list is worse than no folder at all.
 */
async function resolveWireDirectories(wire: unknown[]): Promise<string[]> {
  const out: string[] = []
  for (const entry of wire) {
    if (typeof entry !== 'string') continue
    const resolved = await resolveWorkingDirectory(entry)
    if (!resolved.ok) throw new Error(resolved.error)
    if (!out.includes(resolved.path)) out.push(resolved.path)
  }
  return out
}

/**
 * The run pool as the phone reads it — every row, whatever family.
 *
 * `kind` is the brainstem's own `family`, resolved from the job id where the
 * ids are minted (see its `runFamily`), so no surface re-derives it. The two
 * vocabularies are the same four words on purpose.
 *
 * Procedure runs used to be dropped here, on the grounds that they are not
 * automations. They now travel like the rest: the phone cards them under the
 * automations switch, because "something is running for me" is one question.
 * A consumer that means automations SPECIFICALLY — the Automations screen's
 * per-job status — filters `kind === 'procedure'` itself.
 *
 * Each row is widened with everything a card draws: `body` (the prompt — an
 * i18n key for the built-ins, see OverlayKind), `startedAt` for the elapsed
 * clock, and the run's own mode.
 */
function toWireRuns(snapshot: {
  running: RunningJobInfo[]
  queued: QueuedJobInfo[]
}): AutomationRuns {
  return {
    running: snapshot.running.map((row) => ({
      id: row.id,
      label: row.label,
      body: row.body,
      kind: row.family,
      startedAt: row.startedAt,
      mode: row.mode ?? null
    })),
    queued: snapshot.queued.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.family,
      queuedAt: row.queuedAt
    }))
  }
}

/**
 * Read a string off the wire, trimmed and bounded. Every phone-authored field
 * below goes through here — the wire is data, not policy, and these values are
 * written into a workspace file the agent reads back as instructions.
 */
function wireText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.slice(0, max)
}

/** The two chat modes, or undefined — which means "leave it alone". */
function wireMode(value: unknown): 'single' | 'workflow' | undefined {
  return value === 'single' || value === 'workflow' ? value : undefined
}

/**
 * Read an AskUserResponse off the wire. The `ask` plugin pairs answers with
 * questions BY POSITION, so a malformed entry cannot simply be dropped — that
 * would shift every answer after it onto the wrong question. Anything that is
 * not a complete, well-formed answer list is therefore read as a cancel, which
 * is the one outcome that cannot be misattributed.
 */
function sanitizeAskResponse(raw: unknown): AskUserResponse {
  if (!raw || typeof raw !== 'object') return { kind: 'canceled' }
  const value = raw as Record<string, unknown>
  if (value.kind !== 'answered' || !Array.isArray(value.answers)) return { kind: 'canceled' }
  const answers: AskUserAnswer[] = []
  for (const item of value.answers) {
    if (!item || typeof item !== 'object') return { kind: 'canceled' }
    const answer = item as Record<string, unknown>
    if (answer.kind === 'option') {
      const index = answer.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        return { kind: 'canceled' }
      }
      answers.push({ kind: 'option', index })
      continue
    }
    if (answer.kind === 'custom' && typeof answer.text === 'string' && answer.text.trim()) {
      answers.push({ kind: 'custom', text: answer.text })
      continue
    }
    return { kind: 'canceled' }
  }
  if (answers.length === 0) return { kind: 'canceled' }
  return { kind: 'answered', answers }
}
