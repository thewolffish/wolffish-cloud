/**
 * The bridge wire contract, shared verbatim between desktop and mobile.
 *
 * This file is vendored identically into apps/desktop (`src/main/cloud/`)
 * and apps/mobile (`src/lib/bridge/`). Keep the two byte-identical — a drift
 * here is a protocol split, and the names below are the only thing the two
 * apps agree on. It has no imports for exactly that reason.
 *
 * The bridge itself is the org API's UserBridge Durable Object
 * (apps/api/src/lib/bridge.ts): one per user, reached over an authenticated
 * WebSocket at `/v1/bridge/ws`. It forwards plain JSON frames between the
 * user's desktop and phone(s) and answers presence. Everything durable —
 * config, conversations, files, usage — travels over the API's REST routes
 * and never through here.
 */

export const PROTOCOL_VERSION = 2

/** The keepalive the bridge answers without waking; sent as bare text. */
export const KEEPALIVE_REQUEST = 'ping'
export const KEEPALIVE_RESPONSE = 'pong'
export const KEEPALIVE_MS = 25_000

/** Application close codes the bridge uses (4000–4999 is the app range). */
export const CloseCode = {
  /** A newer socket for the same device took over. */
  Replaced: 4000,
  /** The device's sessions were revoked (unpaired, signed out, admin). */
  Revoked: 4001,
  ProtocolViolation: 4400,
  MessageTooLarge: 4413
} as const

/**
 * The frames on the socket. `rpc`/`res` pair by id; the bridge stamps the
 * phone's socket tag onto the id on the way to the desktop and strips it on
 * the way back, so neither device ever sees the other's ids. `ev` fans out
 * from the desktop to every phone. `presence` is sent by the bridge on every
 * connection change and on request.
 */
export type BridgeFrame =
  | {
      t: 'rpc'
      id: number | string
      method: string
      params: Record<string, unknown>
      phone?: PresenceDevice
    }
  | { t: 'res'; id: number | string; result?: unknown; error?: { code?: string; message: string } }
  | { t: 'ev'; topic: string; payload: unknown }
  | {
      t: 'presence'
      desktop: PresenceDevice | null
      desktops: PresenceDevice[]
      phones: PresenceDevice[]
    }
  | { t: 'push'; frame: Record<string, unknown> }
  | { t: 'notify'; frame: NotifyFrame }
  | { t: 'notification'; frame: Record<string, unknown> }
  | { t: 'notify_result'; frame: NotifyResultFrame }

export type PresenceDevice = {
  deviceId: string
  name: string
  platform: string
  appVersion: string
  connectedAt: number
}

/**
 * RPC methods. The desktop serves everything under `desktop.*`. Kept as a
 * const map rather than free strings so both sides fail at compile time
 * when a method is renamed on one side only.
 *
 * What is NOT here any more, and where it went: the conversation index and
 * bodies (`GET /v1/conversations?since`, `/records`), usage (`/v1/usage/days`),
 * workspace file bytes (`/v1/files/path`, `/v1/files/:sha`), and the chunked
 * upload trio (`POST /v1/files/upload`, then `files.adopt` below to attach an
 * uploaded blob to a project, procedure or automation).
 */
export const Rpc = {
  /** Handshake sanity + versions; the phone describes itself. */
  hello: 'desktop.hello',
  /**
   * The full ConfigSnapshot the mobile settings screens render — the fresh
   * path while the desktop is up. The same object is written to the
   * workspace as `brain/mobile/snapshot.json` and synced as a file, which is
   * what the phone reads when the desktop is away (SNAPSHOT_PATH).
   */
  configSnapshot: 'desktop.config.snapshot',
  /** Whole-array variables replace. Params: `{ variables }`. */
  variablesSet: 'desktop.variables.set',
  /** File a conversation under a project (null unfiles). */
  conversationProject: 'desktop.conversations.project',
  /**
   * One conversation's plan-mode stance — `{ conversationId }` →
   * `{ planMode }`. Read when the phone opens a chat so its switch matches
   * the desktop's chip; the desktop holds the stance (main/runtime/plan-mode).
   */
  planModeGet: 'desktop.chat.planMode.get',
  /**
   * Set one conversation's plan-mode stance — `{ conversationId, planMode }`
   * → `{ planMode }`. The desktop applies it and pushes `Event.planMode` to
   * every surface, the phone included, so both sides settle on one answer.
   */
  planModeSet: 'desktop.chat.planMode.set',
  /** One month of the desktop's own release notes. */
  changelogRead: 'desktop.changelog.read',
  /** Flip one capability; answers the state that actually holds. */
  capabilitySet: 'desktop.capabilities.set',
  /** Apply a whitelisted settings patch. Params: `{ settings }`. */
  configSet: 'desktop.config.set',
  /**
   * Send a user turn; the reply streams back as events. Attachments name
   * workspace-relative paths the phone already uploaded to the org
   * (`uploads/conv-<id>/…`) with their `sha256`; the desktop hydrates any it
   * does not hold before the turn runs. A `conversationId` the desktop does
   * not know yet (the phone minted it so its uploads had a home) is created
   * under that id.
   */
  sendMessage: 'desktop.chat.send',
  abortTurn: 'desktop.chat.abort',
  activeRuns: 'desktop.chat.activeRuns',
  turnMirror: 'desktop.chat.turnMirror',
  askRespond: 'desktop.chat.askRespond',
  approvalRespond: 'desktop.chat.approvalRespond',
  setReflectionConfig: 'desktop.config.setReflection',
  runReflection: 'desktop.reflection.run',
  projectsList: 'desktop.projects.list',
  projectCreate: 'desktop.projects.create',
  projectUpdate: 'desktop.projects.update',
  projectDelete: 'desktop.projects.delete',
  proceduresList: 'desktop.procedures.list',
  procedureCreate: 'desktop.procedures.create',
  procedureUpdate: 'desktop.procedures.update',
  procedureDelete: 'desktop.procedures.delete',
  resolveDirectory: 'desktop.paths.resolveDirectory',
  automationsRead: 'desktop.automations.read',
  automationsWrite: 'desktop.automations.write',
  automationRun: 'desktop.automations.run',
  /**
   * Attach a blob the phone uploaded to the org to a project, procedure or
   * automation. Params `{ target: { kind: 'project'|'procedure'|'automation',
   * id?, existing? }, path, sha256, name, mimeType, sizeBytes }` — `path` is
   * the workspace-relative name it was uploaded under. The desktop downloads
   * the bytes to that path (when it does not hold them) and adopts them
   * exactly as its own Add-files does, answering the stored project /
   * procedure, or `{ path, name }` for an automation.
   */
  filesAdopt: 'desktop.files.adopt',
  /** Collect one conversation's diagnostic bundle; the answer carries the
   *  archive's `sha256` and workspace path, which the phone downloads from
   *  the org. */
  diagnosticsExport: 'desktop.diagnostics.export',
  overlaysRead: 'desktop.overlays.read',
  updaterState: 'desktop.updater.state',
  updaterCheck: 'desktop.updater.check',
  updaterInstall: 'desktop.updater.install',
  /** Abort a pending turn-end countdown (the countdown card's Abort). `{ ok }`. */
  countdownAbort: 'desktop.countdown.abort'
} as const

/** Event topics pushed without a request. */
export const Event = {
  /** A conversation was created or its metadata changed (desktop-side view). */
  conversationUpserted: 'conversation.upserted',
  /**
   * A conversation's records landed in the org — `{ id, updatedAt }`. This,
   * not `conversation.upserted`, is the moment a phone may fetch the body
   * from the API and expect the turn it just watched to be in it.
   */
  conversationSynced: 'conversation.synced',
  conversationDeleted: 'conversation.deleted',
  messageDelta: 'message.delta',
  messageAppended: 'message.appended',
  turnStatus: 'turn.status',
  /**
   * A conversation's plan-mode stance changed on any surface —
   * `{ conversationId, planMode }`. The phone mirrors it into its switch and
   * chip; the desktop chip does the same through its own IPC.
   */
  planMode: 'chat.planMode',
  askRequest: 'ask.request',
  approvalRequest: 'approval.request',
  /**
   * Any config section changed on the desktop. Carries `{ section, at,
   * snapshot? }` — the fresh ConfigSnapshot rides along when the desktop
   * has one built, so the phone applies it without a round trip.
   */
  configChanged: 'config.changed',
  variablesChanged: 'variables.changed',
  usageChanged: 'usage.changed',
  projectsChanged: 'projects.changed',
  proceduresChanged: 'procedures.changed',
  automationsChanged: 'automations.changed',
  automationRunsChanged: 'automations.runs',
  diagnosticsProgress: 'diagnostics.progress',
  reindexChanged: 'reindex.status',
  updaterChanged: 'updater.state',
  /**
   * A turn-end countdown changed state after its turn ended (`{ snapshot }`)
   * — counting, fired, aborted, failed. Folded into the stored message that
   * holds the matching `countdown` segment; the desktop also nudges a body
   * re-read once its own file write has landed.
   */
  countdownChanged: 'countdown.changed'
} as const

export type RpcMethod = (typeof Rpc)[keyof typeof Rpc]
export type EventTopic = (typeof Event)[keyof typeof Event]

/** Where the desktop writes the phone's config snapshot in the workspace —
 *  under a synced root, so the org holds the latest copy. */
export const SNAPSHOT_PATH = 'brain/mobile/snapshot.json'

/** Conversation metadata as the desktop pushes it. */
export type ConversationMeta = {
  id: string
  title: string
  model: string | null
  channel: string | null
  icon: string | null
  projectId: string | null
  sealed: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  stats: unknown | null
  summary: string | null
}

export type SyncProjectFile = { path: string; name: string }

export type SyncProject = {
  id: string
  title: string
  icon: string
  instructions: string
  files: SyncProjectFile[]
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type SyncProcedure = {
  id: string
  title: string
  prompt: string
  mode: 'single' | 'workflow' | null
  icon: string
  projectId: string | null
  files: SyncProjectFile[]
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type AutomationJob = {
  id: string
  label: string
  type: string
  cron: string | null
  nextRunMs: number | null
  mode: 'single' | 'workflow' | null
}

/**
 * Which family a run belongs to — resolved on the DESKTOP from the brainstem's
 * job id. Every family rides the wire; consumers that mean automations
 * specifically (the Automations screen's per-job status) skip `procedure`.
 */
export const RUN_KINDS = ['automation', 'compaction', 'reflection', 'procedure'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** One in-flight run — what the Automations screen's play-button gating reads. */
export type AutomationRun = {
  id: string
  label: string
  kind: RunKind
}

export type AutomationQueuedRun = {
  id: string
  label: string
  kind: RunKind
}

export type AutomationRuns = {
  running: AutomationRun[]
  queued: AutomationQueuedRun[]
}

export type ReindexStatus = {
  startedAt: number
  done: number
  total: number
}

/** The reindex overlay's once-per-connection seed. */
export type OverlaySeed = {
  reindex: ReindexStatus | null
}

export const UPDATER_PHASES = [
  'idle',
  'checking',
  'downloading',
  'verifying',
  'ready',
  'installing',
  'error'
] as const

export type UpdaterWirePhase = (typeof UPDATER_PHASES)[number]

export type UpdaterWireError = {
  code: string
  message: string
  detail: string | null
}

export type UpdaterWireState = {
  phase: UpdaterWirePhase
  version: string | null
  percent: number
  error: UpdaterWireError | null
}

export const DIAGNOSTIC_STEPS = [
  'conversation',
  'logs',
  'tasks',
  'memory',
  'context',
  'settings',
  'attachments',
  'opinion',
  'archive'
] as const

export type DiagnosticStep = (typeof DIAGNOSTIC_STEPS)[number]

export type DiagnosticProgress = {
  conversationId: string
  step: DiagnosticStep
  index: number
  total: number
  files: number
}

export type OpinionSkipReason = 'no-model' | 'local-only' | 'failed' | 'empty'

export type DiagnosticGroup = { key: string; count: number }

export type DiagnosticResult = {
  ok: boolean
  error?: string
  conversationId: string
  conversationTitle: string
  fileName: string
  /** Absolute path on the DESKTOP. Meaningless to the phone. */
  zipPath: string
  /** Workspace-relative — `diagnostics/<fileName>` — and the org's blob
   *  name once uploaded. */
  relativePath: string
  /** Content hash of the archive in the org, null when the upload failed
   *  (the phone then has nothing to fetch). */
  sha256?: string | null
  sizeBytes: number
  fileCount: number
  durationMs: number
  modelOpinion: boolean
  opinionSkipped?: OpinionSkipReason
  groups: DiagnosticGroup[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** What the QR encodes: base64url JSON behind this prefix. v2 = org API. */
export const PAIRING_PREFIX = 'wolffish-pair:v2:'

/** The QR's payload: which API to claim at, and the one-time token. */
export type PairingPayload = {
  v: 2
  api: string
  token: string
}

/** Crockford base32: no I, L, O or U, so a code survives being read aloud.
 *  Mirrored in the API (routes/pair.ts) — keep the three identical. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_CHARS = 8
export const CODE_TTL_MS = 3 * 60 * 1000

/** Accepts what a human actually types: lower case, missing or extra dashes,
 *  spaces, and the classic look-alike substitutions. */
export function normalizeCode(input: string): string {
  const folded = String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (folded.length !== CODE_CHARS) throw new Error(`a pairing code is ${CODE_CHARS} characters`)
  for (const character of folded) {
    if (!CODE_ALPHABET.includes(character))
      throw new Error(`"${character}" is not a pairing character`)
  }
  return folded
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without btoa/atob — this file runs on Hermes and in Node alike. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b === undefined) break
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c === undefined) break
    out += B64[c & 63]
  }
  return out
}

export function fromBase64Url(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bits = 0
  let acc = 0
  let index = 0
  for (const character of clean) {
    const digit = B64.indexOf(character)
    if (digit < 0) throw new Error('malformed base64url')
    acc = (acc << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, index)
}

export function decodePairingPayload(text: string): PairingPayload {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PAIRING_PREFIX)) throw new Error('not a Wolffish pairing code')
  const json = new TextDecoder().decode(fromBase64Url(trimmed.slice(PAIRING_PREFIX.length)))
  const payload = JSON.parse(json) as Partial<PairingPayload>
  if (payload.v !== 2 || typeof payload.api !== 'string' || typeof payload.token !== 'string') {
    throw new Error('malformed pairing payload')
  }
  return { v: 2, api: payload.api, token: payload.token }
}

// ---------------------------------------------------------------------------
// Push notifications (bridge-terminated frames)
// ---------------------------------------------------------------------------

export const PUSH_WIRE_VERSION = 1

export const NOTIFY_PHASES = ['started', 'needs_input', 'failed', 'completed', 'info'] as const
export type NotifyPhase = (typeof NOTIFY_PHASES)[number]

export const NOTIFY_URGENCIES = ['normal', 'high'] as const
export type NotifyUrgency = (typeof NOTIFY_URGENCIES)[number]

export type PushPlatform = 'ios' | 'android'

export const NOTIFY_TITLE_MAX = 60
export const NOTIFY_BODY_MAX = 180
export const NOTIFY_TTL_MIN = 60
export const NOTIFY_TTL_MAX = 86_400

/** Android notification channel; the phone creates it, the bridge names it. */
export const ANDROID_CHANNEL_ID = 'agent-runs'

export const DEEPLINK_SCHEME = 'wolffishcloud://'

export function isAllowedDeeplink(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.startsWith(DEEPLINK_SCHEME) &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f\s]/.test(value)
  )
}

/**
 * Every screen a notification tap can land on, spelled exactly as the
 * phone's router knows it. Both ends hold this list: the desktop refuses a
 * deeplink naming anything else, the phone ignores one it cannot resolve.
 */
export const DEEPLINK_ROUTES = [
  'chat',
  'history',
  'settings',
  'settings/model',
  'settings/appearance',
  'settings/preferences',
  'settings/projects',
  'settings/automations',
  'settings/procedures',
  'settings/customization',
  'settings/channels',
  'settings/capabilities',
  'settings/knowledge',
  'settings/mcp',
  'settings/services',
  'settings/variables',
  'settings/usage',
  'settings/data',
  'settings/updates',
  'settings/connection',
  'settings/changelog'
] as const

export type DeeplinkRoute = (typeof DEEPLINK_ROUTES)[number]

export type DeeplinkTarget = {
  route: DeeplinkRoute
  conversationId: string | null
}

const CONVERSATION_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/

export function parseDeeplink(value: unknown): DeeplinkTarget | null {
  if (!isAllowedDeeplink(value)) return null
  const withoutScheme = value.slice(DEEPLINK_SCHEME.length)
  const queryAt = withoutScheme.indexOf('?')
  const rawRoute = queryAt === -1 ? withoutScheme : withoutScheme.slice(0, queryAt)
  const query = queryAt === -1 ? '' : withoutScheme.slice(queryAt + 1)
  const route = rawRoute.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!(DEEPLINK_ROUTES as readonly string[]).includes(route)) return null
  if (route !== 'chat') return { route: route as DeeplinkRoute, conversationId: null }
  const conversationId = readQueryParam(query, 'id')
  if (conversationId !== null && !CONVERSATION_ID_SHAPE.test(conversationId)) return null
  return { route: 'chat', conversationId }
}

export function buildDeeplink(target: DeeplinkTarget): string {
  const query =
    target.route === 'chat' && target.conversationId ? `?id=${target.conversationId}` : ''
  return `${DEEPLINK_SCHEME}${target.route}${query}`
}

function readQueryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    if (!pair) continue
    const equals = pair.indexOf('=')
    if ((equals === -1 ? pair : pair.slice(0, equals)) !== name) continue
    const raw = equals === -1 ? '' : pair.slice(equals + 1)
    try {
      return decodeURIComponent(raw) || null
    } catch {
      return null
    }
  }
  return null
}

/** Phone → bridge, on pairing and on every app foreground. */
export type RegisterPushFrame = {
  v: 1
  type: 'register_push'
  /** Null when notification permission was denied — in-band only then. */
  expoPushToken: string | null
  platform: PushPlatform
  appVersion?: string | null
}

/** Desktop → bridge, when the model calls the notify tool. The bridge
 *  addresses every phone of the user; no phone id travels. */
export type NotifyFrame = {
  v: 1
  type: 'notify'
  /** ULID, generated by the desktop — never by the model. */
  notificationId: string
  runId: string
  phase: NotifyPhase
  title: string
  body: string
  urgency: NotifyUrgency
  deeplink: string | null
  /** Seconds. */
  ttl: number
  /** Unix ms at the desktop. */
  ts: number
}

/** Bridge → phone, in-band delivery: the notify frame under another type. */
export type NotificationFrame = Omit<NotifyFrame, 'type'> & { type: 'notification' }

export type NotificationAckFrame = { v: 1; type: 'notification_ack'; notificationId: string }

/** Phone → bridge: the phone's current unread count, absolute. */
export type SetBadgeFrame = { v: 1; type: 'set_badge'; count: number }

/** Phone → bridge, on unpairing: forget this device's push registration. */
export type UnregisterPushFrame = { v: 1; type: 'unregister_push' }

/** Bridge → desktop: how the notify was routed. */
export type NotifyResultFrame = {
  v: 1
  type: 'notify_result'
  notificationId: string | null
  route: 'inband' | 'push' | 'dropped'
  reason?: string
}

/** An incoming in-band notification, reduced to the fields this build
 *  understands — tolerant reads, so a newer sender degrades rather than
 *  breaks. */
export function parseNotification(raw: Record<string, unknown>): NotificationFrame | null {
  if (raw.v !== PUSH_WIRE_VERSION || raw.type !== 'notification') return null
  const notificationId = raw.notificationId
  if (typeof notificationId !== 'string' || !notificationId || notificationId.length > 64) {
    return null
  }
  const title = raw.title
  const body = raw.body
  if (typeof title !== 'string' || !title || title.length > NOTIFY_TITLE_MAX) return null
  if (typeof body !== 'string' || !body || body.length > NOTIFY_BODY_MAX) return null
  const ttlRaw = typeof raw.ttl === 'number' && Number.isFinite(raw.ttl) ? raw.ttl : NOTIFY_TTL_MIN
  return {
    v: 1,
    type: 'notification',
    notificationId,
    runId: typeof raw.runId === 'string' ? raw.runId : '',
    phase: NOTIFY_PHASES.includes(raw.phase as NotifyPhase) ? (raw.phase as NotifyPhase) : 'info',
    title,
    body,
    urgency: NOTIFY_URGENCIES.includes(raw.urgency as NotifyUrgency)
      ? (raw.urgency as NotifyUrgency)
      : 'normal',
    deeplink: isAllowedDeeplink(raw.deeplink) ? raw.deeplink : null,
    ttl: Math.min(NOTIFY_TTL_MAX, Math.max(NOTIFY_TTL_MIN, Math.round(ttlRaw))),
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now()
  }
}
