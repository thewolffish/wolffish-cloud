import type { Segment, SegmentTurnEndReason, ToolResultStatus } from '@main/runtime/broca'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

export type { Segment, SegmentTurnEndReason, ToolResultStatus }

export type ThemeSource = 'system' | 'light' | 'dark'
export type Locale = 'en' | 'ar'

export type ThemeState = {
  themeSource: ThemeSource
  shouldUseDarkColors: boolean
}

export type SystemInfo = {
  totalRamBytes: number
  freeDiskBytes: number | null
  totalDiskBytes: number | null
  platform: NodeJS.Platform
  arch: string
  cpuCount: number
  cpuModel: string
}

export type SafetyConfig = {
  bypassPermissions: boolean
  blockCredentials: boolean
}

/**
 * In-app (desktop) chat display preferences — the verbose toggle for the
 * primary renderer feed: when false
 * (default) the in-app chat shows a clean feed — agent replies,
 * file-bearing tool results, errors, and the model chip — and hides
 * tool-activity and compaction cards. Display-only; history is unaffected.
 *
 * `runCards` (default false) is the separate question of whether a
 * RUNNING automation floats its live card over this app. Compaction and
 * reflection runs have the same switch in their own panels.
 *
 * `reasoning` (default false) is whether the model's thinking renders as a
 * collapsible card. One workspace answer for this app and the phone, and
 * display-only: the reasoning is still streamed, stored and exported.
 */
export type InAppConfig = {
  verbose?: boolean
  runCards?: boolean
  reasoning?: boolean
}

export type InAppApi = {
  getConfig: () => Promise<InAppConfig>
  setConfig: (patch: Partial<InAppConfig>) => Promise<{ ok: true; config: InAppConfig }>
  onConfigChange: (callback: (config: InAppConfig) => void) => () => void
}

// MCP connection views. Mirrors src/main/runtime/mcp/types.ts (the
// preload re-declares main types by convention) — keep both in sync.
export type McpTransportKind = 'stdio' | 'http'

export type McpServerState = 'connected' | 'connecting' | 'needs-auth' | 'offline' | 'disabled'

/**
 * One custom HTTP header for a remote server. Persisted plaintext;
 * `sensitive` only masks the value in the settings UI.
 */
export type McpHeader = {
  key: string
  value: string
  sensitive?: boolean
}

export type McpServerSnapshot = {
  id: string
  name: string
  slug: string
  transport: McpTransportKind
  target: string
  enabled: boolean
  state: McpServerState
  toolCount: number
  toolNames: string[]
  /** http: the configured custom headers (values raw; UI masks sensitive ones). */
  headers?: McpHeader[]
  serverName?: string
  serverVersion?: string
  error?: string
  /** Live connect-progress line, present only while state is `connecting`. */
  progress?: string
  lastConnectedAt?: number
}

export type McpTestResult = {
  ok: boolean
  toolCount?: number
  durationMs?: number
  error?: string
}

export type McpAddInput = {
  name?: string
  target: string
  env?: Record<string, string>
  /** http custom headers. Ignored for stdio targets. */
  headers?: McpHeader[]
}

export type McpAddResult = { ok: true; server: McpServerSnapshot } | { ok: false; error: string }

export type McpApi = {
  list: () => Promise<McpServerSnapshot[]>
  add: (input: McpAddInput) => Promise<McpAddResult>
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  setHeaders: (id: string, headers: McpHeader[]) => Promise<{ ok: boolean; error?: string }>
  test: (id: string) => Promise<McpTestResult>
  authorize: (id: string) => Promise<{ ok: boolean; error?: string }>
  onStatusChange: (callback: (servers: McpServerSnapshot[]) => void) => () => void
}

export type SttConfig = {
  defaultModel: string
  /** Pinned transcription language: ISO 639-1/Whisper code, `auto`, or '' (= the `en` default). */
  language: string
}

export type TtsConfig = {
  defaultVoice: string
  defaultSpeed: string
  /** Voice prompts get spoken replies (default ON) — a model directive, mirrored from workspace.ts. */
  voiceReplies: boolean
}

export type Variable = {
  name: string
  value: string
  sensitive: boolean
}

export type WeekStartsOn = 0 | 1

export type WorkspaceConfig = {
  version: 1
  launchAtStartup?: boolean
  llm: {
    /** The selected model id; the org API serves the allowed catalog. */
    model: string | null
    /** Chat mode: 'single' (default, solo turns) vs 'workflow' (model-led agents). */
    mode?: 'single' | 'workflow'
    /** Per-model thinking mode. Key is model name, value is ThinkingMode. */
    thinkingModes?: Record<string, ThinkingMode>
  }
  safety?: SafetyConfig
  weekStartsOn?: WeekStartsOn
  variables?: Variable[]
  inapp?: InAppConfig
  stt?: SttConfig
  tts?: TtsConfig
  computerUse?: ComputerUseConfig
  browserExtension?: BrowserExtensionConfig
  updates?: UpdatesConfig
  lastSettingsState?: {
    tab?: string
    provider?: string
    channel?: string
    service?: string
    knowledgeTab?: string
    sidebarCollapsed?: string
    rightSidebarCollapsed?: string
  }
  locale: Locale
  theme: ThemeSource
  onboardingCompleted: boolean
}

export type WorkspaceStatus = {
  rootPath: string
  initialized: boolean
  onboardingCompleted: boolean
  config: WorkspaceConfig | null
}

export type PullProgressEvent = {
  modelName: string
  status: string
  completed: number | null
  total: number | null
}

export type PullDoneEvent =
  | { modelName: string; ok: true }
  | { modelName: string; ok: false; error: string; aborted: boolean }

export type SelectModelResult =
  | { ok: true; alreadyDownloaded?: boolean; alreadyRunning?: boolean }
  | { ok: false; error: string; aborted: boolean }

export type PersistedApproval = {
  approvalId: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  reason: string
  level: DangerLevel
  description?: ApprovalDescription
  decision?: ApprovalDecision
}

export type PersistedToolTiming = {
  startedAt: number
  endedAt?: number
}

export type MessageAttachmentType = 'audio' | 'video' | 'image' | 'pdf' | 'other'

export type MessageAttachment = {
  type: MessageAttachmentType
  /** Path relative to workspace root, e.g. "uploads/conv-2026-05-01_14-30-45/photo.png". */
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type ConversationMessage = {
  /**
   * Stable per-message identity, unique within one conversation — the
   * reconciliation key mergeConversationOnto unions transcripts by (dual
   * decl — see src/main/conversations.ts for the full contract). Optional
   * only for files written before the field shipped.
   */
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  segments?: Segment[]
  approvals?: Record<string, PersistedApproval>
  toolTimings?: Record<string, PersistedToolTiming>
  stopReason?: SegmentTurnEndReason
  error?: string
  attachments?: MessageAttachment[]
  /** Set when this user message is a voice transcript — the audio attachment must not be exposed to the LLM. */
  voicePrompt?: boolean
  /** Whisper's detected language for a voicePrompt message (ISO 639-1). */
  voiceLang?: string
}

export type ConversationChannel = 'electron' | 'mobile' | 'heartbeat' | 'procedure'

export type TimelineEntry = {
  id: string
  timestamp: number
  kind: string
  summary?: string
  detail?: string
}

/** Frozen roll-up of the most recent completed turn (dual decl — see src/main/conversations.ts). */
export type ConversationTurnStats = {
  endedAt: number
  elapsedMs: number
  apiMs: number
  apiCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cost: number
  provider: string | null
  model: string | null
}

/** Persisted per-conversation tokenomics (dual decl — see src/main/conversations.ts). */
export type ConversationStats = {
  /**
   * Lifetime totals for this conversation. Includes workflow-agent spend;
   * accrues from the first turn after this feature shipped for pre-existing
   * conversations.
   */
  allTime: {
    processingMs: number
    apiMs: number
    turns: number
    apiCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cost: number
  }
  lastTurn: ConversationTurnStats | null
  /**
   * Context-meter snapshot at last save. `model` records which model the
   * reading was measured under so a reload never divides an old model's
   * numerator by a different model's window.
   */
  meter: {
    contextTokens: number
    contextBudget: number
    compactionAt?: number | null
    model?: string | null
  } | null
}

export type ConversationFile = {
  id: string
  title: string
  model: string | null
  messages: ConversationMessage[]
  createdAt: number
  updatedAt: number
  channel?: ConversationChannel
  /** Binds this conversation to a project (dual decl — see src/main/conversations.ts). */
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  sealed?: boolean
  workingFolder?: string[] | null
  /** Reference files for every turn — seeded by a procedure's Play (dual decl — see src/main/conversations.ts). */
  contextFiles?: string[] | null
  /** Legacy meter snapshot — superseded by `stats.meter`, still read as a fallback. */
  contextMeter?: { contextTokens: number; contextBudget: number } | null
  stats?: ConversationStats | null
  timeline?: TimelineEntry[]
  /** Rolling prefix summary — see src/main/conversations.ts (dual decl). */
  summary?: string | null
  /**
   * First message index NOT covered by `summary` (always a user message).
   * Legacy positional form — the id form below wins when it resolves.
   */
  summarizedThroughMessage?: number | null
  /** Id of the first message NOT covered by `summary` — survives id-keyed merges that insert before the mark (dual decl — see src/main/conversations.ts). */
  summarizedThroughMessageId?: string | null
}

export type ConversationMeta = {
  id: string
  title: string
  updatedAt: number
  channel?: ConversationChannel
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  messageCount: number
}

export type ChatHistoryAttachment = {
  type: MessageAttachmentType
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

export type ChatHistoryMessage =
  | {
      role: 'user'
      content: string
      attachments?: ChatHistoryAttachment[]
      reasoningContent?: string
    }
  | {
      role: 'assistant'
      content: string
      toolUses?: Array<{ id: string; name: string; args: Record<string, unknown> }>
      reasoningContent?: string
    }
  | {
      role: 'tool'
      toolUseId: string
      toolName: string
      content: string
      isError?: boolean
    }
export type ChatDoneEvent = { turnId: string; conversationId: string | null }
export type ChatErrorEvent = { turnId: string; conversationId: string | null; error: string }

/**
 * Turn lifecycle broadcast (chat:turnState) — fired for EVERY channel's
 * turns (in-app, terminal, phone) so the Conversations sidebar can show
 * live status chips without owning the turn.
 */
export type ChatTurnStateEvent = {
  phase: 'started' | 'done' | 'canceled' | 'error'
  turnId: string
  conversationId: string | null
  channel: string
  title?: string | null
  error?: string
}

/**
 * One conversation with a turn in flight right now, on any channel
 * (chat:activeRuns). The lifecycle broadcast above only carries
 * TRANSITIONS, so a window that opened mid-run — the normal case for a tray
 * app whose terminal and phone channels keep running with no window — needs
 * this snapshot to render those conversations as running.
 */
export type ChatActiveRun = {
  conversationId: string
  channel: string
  title: string | null
}

export type ChatTurnEvent = {
  turnId: string
  conversationId: string | null
  type:
    | 'context.built'
    | 'llm.response'
    | 'turn.usage'
    | 'task.created'
    | 'task.stepCompleted'
    | 'task.completed'
    | 'task.failed'
    | 'task.stopped'
    | 'tool.called'
    | 'tool.completed'
    | 'tool.failed'
    | 'safety.allowed'
    | 'safety.blocked'
    | 'safety.approved'
    | 'safety.denied'
    | 'compaction.started'
    | 'compaction.applied'
  payload: Record<string, unknown>
}

export type DangerLevel = 'safe' | 'warn' | 'confirm' | 'destructive' | 'block'
export type ApprovalDecision = 'approved' | 'denied'

export type RiskLevel = 'low' | 'medium' | 'high'

export type ApprovalDescription = {
  title: string
  description: string
  command?: string
  impact?: string
  risk: RiskLevel
}

export type ChatApprovalRequestEvent = {
  turnId: string
  conversationId: string | null
  id: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  level: DangerLevel
  reason: string
  description?: ApprovalDescription
}

/** One selectable choice on an ask-the-user question card. */
export type AskUserOption = {
  label: string
  description?: string
}

/** One question on an ask-the-user card. A card carries 1..N of these. */
export type AskUserQuestion = {
  question: string
  details?: string
  options: AskUserOption[]
  allowOther: boolean
  otherLabel?: string
  otherDescription?: string
}

/** The user's answer to ONE question on the card. */
export type AskUserAnswer = { kind: 'option'; index: number } | { kind: 'custom'; text: string }

/**
 * The user's response to a whole question card, sent back to the main
 * process once — `answers[i]` answers `questions[i]`, and the card only
 * submits when every question is answered.
 */
export type AskUserResponse =
  | { kind: 'answered'; answers: AskUserAnswer[] }
  | { kind: 'canceled' }
  | { kind: 'unsupported' }

/** Emitted when the agent asks the user multiple-choice question(s). */
export type ChatAskRequestEvent = {
  turnId: string
  conversationId: string | null
  id: string
  toolCallId: string
  questions: AskUserQuestion[]
}

export type ChatCredentialBlockedEvent = {
  turnId: string
  conversationId: string | null
  type: string
}

export type ThemeApi = {
  get: () => Promise<ThemeState>
  set: (source: ThemeSource) => Promise<ThemeState>
  onUpdated: (listener: (state: ThemeState) => void) => () => void
}

export type LocaleApi = {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<Locale>
}

export type SystemApi = {
  getInfo: () => Promise<SystemInfo>
}

export type WorkspaceApi = {
  getStatus: () => Promise<WorkspaceStatus>
  completeOnboarding: () => Promise<WorkspaceConfig>
  /**
   * Config paths the organization owns, as dot paths ("channels.telegram.
   * enabled"). The API applies the org's values on read and forces them on
   * write, so these are already reflected in the config the app holds — the
   * list is here so a settings control can say so rather than accepting an
   * edit that reverts at the next pull.
   */
  lockedConfigKeys: () => Promise<string[]>
  onLockedConfigKeysChanged: (listener: (keys: string[]) => void) => () => void
}

// ── Cloud auth ────────────────────────────────────────────────────────────
// Tokens never cross this bridge: the renderer drives the auth screens off
// this redacted state and the main process owns the session.

export type AuthStatus =
  | 'initializing'
  | 'loggedOut'
  | 'mustChangePassword'
  | 'needsPin'
  | 'locked'
  | 'ready'

export type AuthState = {
  status: AuthStatus
  user: { email: string; name: string; role: 'owner' | 'admin' | 'support' | 'employee' } | null
  orgName: string | null
  pinAttemptsLeft: number | null
  lastError: string | null
  lastErrorDetail: string | null
}

export type CloudProfile = {
  name: string
  email: string
  phone: string
  position: string
  bio: string
  role: 'owner' | 'admin' | 'support' | 'employee'
  orgName: string | null
  pinSet: boolean
  hasAvatar: boolean
}

export type AuthApi = {
  getState: () => Promise<AuthState>
  login: (email: string, password: string) => Promise<AuthState>
  changePassword: (newPassword: string) => Promise<AuthState>
  setPin: (pin: string) => Promise<AuthState>
  unlock: (pin: string) => Promise<AuthState>
  signOut: () => Promise<AuthState>
  /** Re-locks the app behind the PIN immediately. */
  lock: () => Promise<AuthState>
  changePin: (currentPin: string, nextPin: string) => Promise<AuthState>
  getProfile: () => Promise<CloudProfile | null>
  updateProfile: (patch: {
    name?: string
    phone?: string
    position?: string
    bio?: string
  }) => Promise<AuthState>
  changePasswordSelf: (currentPassword: string, newPassword: string) => Promise<AuthState>
  /** Emailed-code password reset (no session). */
  resetRequest: (email: string) => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  resetConfirm: (
    email: string,
    code: string,
    newPassword: string
  ) => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  /** Emailed-code account activation — an invited account's first password. */
  activateRequest: (
    email: string
  ) => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  activateConfirm: (
    email: string,
    code: string,
    newPassword: string
  ) => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  /** Avatar travels as a data URL; null means none set. */
  getAvatar: () => Promise<string | null>
  setAvatar: (
    bytes: ArrayBuffer,
    mime: string
  ) => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  removeAvatar: () => Promise<{ ok: boolean; code?: string; detail?: string | null }>
  onChanged: (listener: (state: AuthState) => void) => () => void
  /**
   * Fires when the cached avatar actually changes — an upload, a removal,
   * or a background revalidation discovering a change made elsewhere.
   */
  onAvatarChanged: (listener: (dataUrl: string | null) => void) => () => void
}

export type AppClosingPendingEvent = { tasks: number }

export type AppApi = {
  factoryReset: () => Promise<void>
  onClosingPending: (listener: (event: AppClosingPendingEvent) => void) => () => void
}

export type DataAnalytics = {
  workspaceBytes: number
  hippocampusBytes: number
  corpusBytes: number
  prefrontalBytes: number
  ramBytes: number
  cpuPercent: number
  totalRamBytes: number
  cpuCount: number
}

export type DataApi = {
  getAnalytics: () => Promise<DataAnalytics>
}

/** Which service's config changed — the panels re-seed from this. */
export type ServicesChangedPayload = {
  service: 'brave' | 'stt' | 'tts' | 'computerUse' | 'browserExtension'
}

export type ServicesApi = {
  /**
   * A service's config was saved — by this window, another window, or the
   * paired phone over the tunnel. Payload names the service so a panel can
   * ignore everyone else's changes.
   */
  onChanged: (listener: (payload: ServicesChangedPayload) => void) => () => void
}

export type LaunchAtStartupStatus = { active: boolean }

/** What a preferences:changed broadcast carries — only the fields that were saved. */
export type PreferencesPatch = {
  launchAtStartup?: boolean
  bypassPermissions?: boolean
  blockCredentials?: boolean
  weekStartsOn?: WeekStartsOn
}

export type RuntimeApi = {
  setLaunchAtStartup: (value: boolean) => Promise<{ value: boolean; active: boolean }>
  getLaunchAtStartupStatus: () => Promise<LaunchAtStartupStatus>
  setBypassPermissions: (value: boolean) => Promise<{ value: boolean }>
  setBlockCredentials: (value: boolean) => Promise<{ value: boolean }>
  setThinkingMode: (model: string, mode: ThinkingMode) => Promise<void>
  setWeekStartsOn: (value: WeekStartsOn) => Promise<{ value: WeekStartsOn }>
  setLastSettingsState: (patch: Record<string, string>) => Promise<void>
  /** A preference saved anywhere — this window, another window. Payload is the patch. */
  onPreferencesChanged: (listener: (patch: PreferencesPatch) => void) => () => void
  /** A paired phone wrote settings over the tunnel — the applied patch rides along. */
  onMobileSettingsChange: (
    listener: (payload: { keys: string[]; settings?: Record<string, unknown> }) => void
  ) => () => void
  getCompactionConfig: () => Promise<CompactionConfig>
  setCompactionConfig: (patch: Partial<CompactionConfig>) => Promise<CompactionConfig>
  getCompactionRuns: () => Promise<CompactionRuns>
  onCompactionChanged: (listener: (payload: unknown) => void) => () => void
  /**
   * The compaction CONFIG changed — this window, another window, or the paired
   * phone. Distinct from onCompactionChanged, which announces a finished run:
   * this one carries the saved config, so a panel (and the floating run card)
   * adopts a flip made anywhere without refetching.
   */
  onCompactionConfigChanged: (listener: (config: CompactionConfig) => void) => () => void
  getReflectionConfig: () => Promise<ReflectionConfig>
  setReflectionConfig: (patch: Partial<ReflectionConfig>) => Promise<ReflectionConfig>
  runReflectionNow: () => Promise<'running' | 'queued' | 'coalesced'>
  runDeepCleanNow: () => Promise<'running' | 'queued' | 'coalesced'>
  onReflectionChanged: (listener: (payload: unknown) => void) => () => void
}

export type CompactionConfig = {
  dailyHour: number
  weeklyDay: number
  weeklyHour: number
  /** Whether a running compaction job draws its floating card (default off). */
  cards: boolean
}

/** Last completed run of a compaction job (mirrors brainstem's type). */
export type CompactionRunRecord = {
  at: number
  durationMs: number
  /** Null for the weekly digest — that pass makes no LLM call. */
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  output: string
}

export type CompactionRuns = {
  daily: CompactionRunRecord | null
  weekly: CompactionRunRecord | null
  /** Nightly reflection pass (mirrors brainstem's type; absent pre-feature). */
  reflection?: CompactionRunRecord | null
  /** Monthly adversarial deep clean. */
  deepClean?: CompactionRunRecord | null
}

/** Mirrors workspace's ReflectionConfig (dual decl). Reflection + deep clean are core — no off switches, only the hour. */
export type ReflectionConfig = {
  hour: number
  quietHours: number
  /** Whether a running reflection job draws its floating card (default off). */
  cards: boolean
}

export type ModelCapabilities = {
  provider: string | null
  model: string | null
  supportsVision: boolean
  contextWindow: number
  /** Token count where auto-compaction triggers for this model. */
  compactionAt: number
}

export type ModelApi = {
  capabilities: () => Promise<ModelCapabilities>
  /**
   * The org catalog from main's cache — answered at once, never behind the
   * network once a copy exists. Calling it on a stale copy triggers a
   * background refresh whose result, if different, arrives through
   * onCatalogChanged.
   */
  catalog: () => Promise<{ models: CatalogModelEntry[] }>
  /** A refreshed catalog that differs from the one cached before it. */
  onCatalogChanged: (listener: (event: { models: CatalogModelEntry[] }) => void) => () => void
}

/** One row of the org's model catalog (GET /v1/models, cached in main). */
export type CatalogModelEntry = {
  id: string
  name: string
  reasoning: boolean
  vision: boolean
  contextWindow: number
  inPerMtokMicroUsd: number
  outPerMtokMicroUsd: number
  default: boolean
}

// `id` is null for events not tied to a specific selection (e.g. cleared).
export type ProviderUpdatedEvent = { id: 'cloud' | null }

export type ProviderApi = {
  setMode: (mode: 'single' | 'workflow') => Promise<{ ok: true }>
  onUpdated: (listener: (event: ProviderUpdatedEvent) => void) => () => void
}

export type ModelSelectApi = {
  /** Persist the selected model (null clears). Validity is the org API's call. */
  select: (model: string | null) => Promise<{ ok: true }>
}

// Canonical reasoning scale (see src/main/runtime/reasoning.ts). Inlined here
// to keep the preload bundle decoupled from main.
export type ThinkingMode = 'off' | 'on' | 'high' | 'max'

export type ChatApi = {
  send: (payload: {
    history: ChatHistoryMessage[]
    conversationId?: string | null
    /**
     * The feed id of the user message this turn sends. The titler may
     * pre-persist that same logical message (the titled shell for a first
     * in-app turn) — stamping it with THIS id is what lets the renderer's
     * end-of-turn save reconcile with the shell instead of duplicating it.
     */
    userMessageId?: string
    /**
     * The feed id of the assistant message this turn will stream into. Main
     * checkpoints the turn-so-far to disk under this id while it runs, so the
     * end-of-turn save reconciles with the checkpoint by id instead of leaving
     * a duplicate — and so a crash or a machine restart mid-run leaves the run
     * on disk (and on its way to the org) rather than the prompt alone.
     */
    assistantMessageId?: string
    /** Active working-folder paths — the agent injects fresh listings into the outbound volatile tail. */
    workingFolders?: string[]
    /**
     * Reference files this conversation's turns are told about (name, size,
     * path) and read with their own tools — never injected. Seeded by a
     * procedure's Play from that procedure's own attachments.
     */
    contextFiles?: string[]
    thinkingMode?: ThinkingMode
    /** Per-turn chat-mode override (procedure Play honors the procedure's stamp). */
    modeOverride?: 'single' | 'workflow'
    /** Project this conversation runs inside — overlays its context on the turn. */
    projectId?: string | null
  }) => Promise<{ turnId: string; ok: boolean; error?: string }>
  /**
   * Cancel one conversation's in-flight turn; omitted id cancels all. Works
   * whatever channel started the turn — an in-app Stop on a mirrored
   * terminal or phone run aborts it through the shared TurnRunner.
   */
  cancel: (payload?: { conversationId?: string | null }) => Promise<{ canceled: boolean }>
  /** Conversations running RIGHT NOW, any channel (window cold-start seed). */
  activeRuns: () => Promise<ChatActiveRun[]>
  /**
   * The newest live-mirror snapshot of one running conversation's in-progress
   * assistant message, or null when nothing is cached (no run, or the turn
   * has produced nothing yet). activeRuns says a run exists; this is what it
   * has written so far — the seed that lets a window opened mid-run draw the
   * turn instead of a bare thinking bubble until the next mirror tick.
   */
  turnMirror: (conversationId: string) => Promise<ConversationMessage | null>
  respondApproval: (payload: { id: string; decision: ApprovalDecision }) => Promise<{ ok: boolean }>
  respondAsk: (payload: { id: string; response: AskUserResponse }) => Promise<{ ok: boolean }>
  /** Save-dialog + Chromium print of a renderer-built transcript HTML. */
  exportPdf: (payload: {
    html: string
    fileName: string
  }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  onSegment: (
    listener: (segment: Segment & { conversationId?: string | null }) => void
  ) => () => void
  onDone: (listener: (event: ChatDoneEvent) => void) => () => void
  onError: (listener: (event: ChatErrorEvent) => void) => () => void
  onTurnEvent: (listener: (event: ChatTurnEvent) => void) => () => void
  onApprovalRequest: (listener: (event: ChatApprovalRequestEvent) => void) => () => void
  onAskRequest: (listener: (event: ChatAskRequestEvent) => void) => () => void
  onCredentialBlocked: (listener: (event: ChatCredentialBlockedEvent) => void) => () => void
  /** Turn lifecycle across ALL channels — backs the sidebar status chips. */
  onTurnState: (listener: (event: ChatTurnStateEvent) => void) => () => void
}

export type ConversationSummaryUpdate = {
  conversationId: string
  summary: string
  summarizedThroughMessage: number
  /** Id of the first uncovered message — null while a transition file still lacks message ids. */
  summarizedThroughMessageId: string | null
}

export type ConversationApi = {
  list: () => Promise<ConversationMeta[]>
  load: (id: string) => Promise<ConversationFile | null>
  save: (conv: ConversationFile) => Promise<{ ok: true }>
  /** ok:false ⇒ refused (conversation has a turn in flight). */
  delete: (id: string) => Promise<{ ok: boolean }>
  create: (model: string | null) => Promise<ConversationFile>
  /**
   * Fired when the main-side rolling summarizer persisted a new prefix
   * summary. The renderer folds it into its in-memory conversation so the
   * next whole-file save preserves it and the next send replays lean.
   */
  onSummaryUpdated: (listener: (update: ConversationSummaryUpdate) => void) => () => void
  /**
   * Fired when a conversation was deleted anywhere (in-app History OR a
   * channel /delete). The sidebar prunes its live run-status so a
   * channel-side delete doesn't leave a ghost row.
   */
  onDeleted: (listener: (event: { id: string }) => void) => () => void
  /**
   * Fired when the conversation list-visible set may have changed on disk (a
   * conversation was created, renamed, appended, or removed and re-indexed).
   * Covers paths that emit no turn lifecycle — autonomous heartbeat/procedure
   * runs, create-without-turn, the sensitive-data gate — so the rail and
   * History refetch. Payload-free: the listener just re-lists.
   */
  onChanged: (listener: () => void) => () => void
  /**
   * Fired repeatedly while a channel turn is IN FLIGHT — a live
   * snapshot of its in-progress assistant message so an in-app viewer of the
   * same conversation mirrors the run as it streams, not only at end-of-turn.
   * The message id is stable for the turn and matches the record the save
   * later writes, so the renderer upserts by id (never a duplicate).
   */
  onMessageMirror: (
    listener: (payload: { conversationId: string; message: ConversationMessage }) => void
  ) => () => void
  /**
   * Download this conversation's media from the org if any of it is missing
   * on disk (nothing is predownloaded at restore — media hydrates on open,
   * like the phone). Resolves with the final summary; live ticks stream
   * through onHydrationProgress. Idempotent — a hydrated conversation
   * resolves immediately with filesTotal 0.
   */
  hydrate: (id: string) => Promise<ConversationHydrationProgress>
  /** Streamed hydration ticks (throttled ~100ms; first and final always). */
  onHydrationProgress: (listener: (progress: ConversationHydrationProgress) => void) => () => void
}

/**
 * Live progress of one conversation's on-open media download (dual decl —
 * mirrors HydrationProgress in src/main/cloud/sync.ts). `filesTotal` counts
 * only files that actually need downloading; 0 means nothing to fetch.
 */
export type ConversationHydrationProgress = {
  conversationId: string
  filesTotal: number
  filesDone: number
  totalBytes: number
  doneBytes: number
  /** Workspace-relative path currently downloading, null between files. */
  current: string | null
  /** Paths still waiting or mid-download — drives per-card download states. */
  pending: string[]
  failed: number
  done: boolean
}

export type ViewerTreeNode =
  | { type: 'dir'; name: string; relativePath: string; children: ViewerTreeNode[] }
  | { type: 'file'; name: string; relativePath: string }

export type UsageTimeRange = 'today' | 'this_month' | '3_months' | '6_months' | 'ytd' | 'all_time'

export type UsageProviderSummary = {
  provider: 'cloud'
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  models: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
}

export type BraveUsageSummary = {
  totalQueries: number
  totalCost: number
}

export type UsageSummary = {
  providers: UsageProviderSummary[]
  brave: BraveUsageSummary
}

export type UsageStats = {
  messages: number
  conversations: number
  activeDays: number
  longestStreak: number
  totalTokens: number
  favouriteModel: string | null
  totalCost: number
  topSpendDay: { date: string; cost: number } | null
}

export type UsageDailyEntry = {
  date: string
  totalTokens: number
}

/**
 * One person's standing on the org leaderboard — the wire row verbatim
 * (dual decl — mirrors LeaderboardRowWire in src/main/cloud/api.ts). `rank`
 * is the rank in the WHOLE org, so it stays meaningful inside a filtered
 * page; the client never computes it.
 */
export type LeaderboardRow = {
  rank: number
  user_id: string
  name: string
  role: string
  tokens: number
  conversations: number
  agentic_tasks: number
}

export type LeaderboardPage = {
  generated_at: string
  /** Rows matching the search (the whole board when there is none). */
  total: number
  /** People on the board, regardless of the search — the denominator. */
  board_size: number
  /** The org outgrew the server's board cap; the tail is not listed. */
  truncated: boolean
  limit: number
  offset: number
  rows: LeaderboardRow[]
  /** The signed-in user's own row, on every page and past every filter. */
  me: LeaderboardRow | null
}

export type LeaderboardApi = {
  list: (params?: { limit?: number; offset?: number; q?: string }) => Promise<LeaderboardPage>
}

export type UsageApi = {
  getSummary: (range: UsageTimeRange) => Promise<UsageSummary>
  getStats: (range: UsageTimeRange) => Promise<UsageStats>
  getDaily: (year: number) => Promise<UsageDailyEntry[]>
  sync: () => Promise<{ ok: true }>
}

// ── Admin ────────────────────────────────────────────────────────────────
//
// The admin layer's wire shapes, mirrored from apps/api/src/routes/admin.ts.
// Every one of these is read live and held only in renderer memory — none of
// it is cached to disk, because it is other people's spend and other
// people's conversations (see src/main/admin-ipc.ts).

export type AdminRole = 'owner' | 'admin' | 'support' | 'employee'
export type AdminUserStatus = 'invited' | 'active' | 'suspended' | 'removed'
/** The three ceilings an admin assigns. Everyone starts on `standard`. */
export type TokenPlan = 'standard' | 'high' | 'unmetered'
/** Monthly input/output token ceilings; 0 means unlimited. */
export type PlanCeilings = { monthlyIn: number; monthlyOut: number }

/** What this device's signed-in user may do on the admin screen. */
export type AdminAccess = {
  canRead: boolean
  canWrite: boolean
  isOwner: boolean
  role: string | null
  email: string | null
}

/** One card in the people grid — every figure from the server-side rollup. */
export type RosterPerson = {
  id: string
  email: string
  name: string
  role: AdminRole
  status: AdminUserStatus
  must_change_password: number
  created_at: string
  last_login_at: string | null
  token_plan: TokenPlan
  ceilings: PlanCeilings
  daily_token_cap: number | null
  daily_search_cap: number | null
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  searches: number
  days_active: number
  last_active_day: string | null
  month_tokens_in: number
  month_tokens_out: number
  month_cost_microusd: number
  month_searches: number
  devices: number
  phones: number
  conversations: number
}

export type AdminRoster = {
  since: string
  days: number
  month_start: string
  plans: Record<TokenPlan, PlanCeilings>
  people: RosterPerson[]
}

export type AdminLaneTotals = {
  kind: 'chat' | 'search'
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  month_requests: number
  month_tokens_in: number
  month_tokens_out: number
  month_cost_microusd: number
}

export type AdminSurfaceTotals = {
  surface: string
  kind: 'chat' | 'search'
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  cost_microusd: number
}

export type AdminDailyPoint = {
  day: string
  requests: number
  tokens_in: number
  tokens_out: number
  cost_microusd: number
  searches: number
}

export type AdminDevice = {
  id: string
  platform: string
  name: string
  app_version: string
  status: string
  pin_set: number
  pin_clear_requested: number
  created_at: string
  last_seen_at: string | null
}

export type AdminSession = {
  id: string
  device_id: string
  issued_at: string
  refreshed_at: string | null
  expires_at: string
  revoked_at: string | null
  revoked_by: string | null
}

export type AdminUsageRow = {
  id: number
  device_id: string | null
  model: string
  kind: string
  surface: string
  upstream: string
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  latency_ms: number
  decision: string
  error: string | null
  created_at: string
}

export type AdminUserOverview = {
  user: {
    id: string
    email: string
    name: string
    role: AdminRole
    status: AdminUserStatus
    must_change_password: number
    phone: string
    position: string
    bio: string
    created_at: string
    updated_at: string
    last_login_at: string | null
    temp_password_expires_at: string | null
  }
  window: { since: string; days: number; month_start: string }
  policy: {
    token_plan: TokenPlan
    ceilings: PlanCeilings
    allowed_models?: string | null
    daily_token_cap?: number | null
    daily_search_cap?: number | null
    updated_at?: string
  }
  plans: Record<TokenPlan, PlanCeilings>
  /** Live gate counters — what the ceilings are actually enforced against. */
  standing: {
    tokens: {
      userDayUsed: number
      orgMonthUsed: number
      userMonthIn: number
      userMonthOut: number
    } | null
    searches: { userDayUsed: number; orgMonthUsed: number } | null
  }
  lanes: AdminLaneTotals[]
  surfaces: AdminSurfaceTotals[]
  daily: AdminDailyPoint[]
  devices: AdminDevice[]
  sessions: AdminSession[]
  recent: AdminUsageRow[]
  counts: { conversations: number; files: number; bytes: number }
}

/** A transcript row — provenance and size without opening anything. */
export type AdminConversationRow = {
  id: string
  title: string
  device_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  model: string | null
  channel: string | null
  icon: string | null
  project_id: string | null
  sealed: number | null
  summary: string | null
  stats: Record<string, unknown> | null
  message_count: number
}

/**
 * One conversation rebuilt into the same file the employee's own client
 * holds — so the admin's transcript is drawn by the same components, from
 * the same shape, as the one they saw.
 */
export type AdminTranscript = {
  conversation: ConversationFile
  owner: { userId: string; name: string | null; email: string | null }
  truncated: boolean
}

export type AdminAuditEntry = {
  id: number
  actor_user_id: string
  actor_name?: string | null
  actor_email?: string | null
  action: string
  target: string
  detail: string
  created_at: string
}

export type AdminOrgSettings = {
  id: number
  name: string
  default_model: string
  default_allowed_models: string
  user_daily_token_cap: number
  org_monthly_token_cap: number
  search_enabled: number
  user_daily_search_cap: number
  org_monthly_search_cap: number
  created_at: string
  updated_at: string
}

/**
 * What adding a person returns. No credential: the account's only key is
 * the code that was mailed to the address. `email_sent` is the one field
 * the UI must act on — false means nobody received anything, and the
 * activation code is echoed back ONLY where the server has no mail
 * configured at all (a local API), never from a deployment whose send
 * merely failed.
 */
export type AdminInviteResult = {
  user_id: string
  email: string
  role: AdminRole
  activation_expires_at: string
  email_sent: boolean
  email_error?: string
  email_error_detail?: string | null
  activation_code?: string
}

export type AdminActivationResult = {
  user_id: string
  email: string
  activation_expires_at: string
  email_sent: boolean
  email_error?: string
  email_error_detail?: string | null
  activation_code?: string
}

export type AdminResetResult = {
  user_id: string
  temp_password: string
  temp_password_expires_at: string
}

export type AdminApi = {
  getAccess: () => Promise<AdminAccess>
  roster: (days?: number) => Promise<AdminRoster>
  userOverview: (userId: string, days?: number) => Promise<AdminUserOverview>
  listConversations: (
    userId: string,
    opts?: { before?: string; limit?: number }
  ) => Promise<{ conversations: AdminConversationRow[]; next: string | null }>
  readConversation: (conversationId: string) => Promise<AdminTranscript>
  userAudit: (userId: string, limit?: number) => Promise<{ entries: AdminAuditEntry[] }>
  audit: (limit?: number) => Promise<{ entries: AdminAuditEntry[] }>
  getOrg: () => Promise<{ org: AdminOrgSettings | null }>
  getGates: () => Promise<Record<string, unknown>>
  invite: (input: { email: string; name: string; role: AdminRole }) => Promise<AdminInviteResult>
  updateUser: (
    userId: string,
    patch: { name?: string; role?: AdminRole; status?: 'active' | 'suspended' }
  ) => Promise<{ ok: true }>
  setPlan: (
    userId: string,
    plan: TokenPlan
  ) => Promise<{ ok: true; token_plan: TokenPlan; ceilings: PlanCeilings }>
  setPolicy: (
    userId: string,
    policy: {
      allowed_models?: string[] | null
      daily_token_cap?: number | null
      daily_search_cap?: number | null
      token_plan?: TokenPlan | null
    }
  ) => Promise<{ ok: true }>
  resetPassword: (userId: string) => Promise<AdminResetResult>
  /** Re-send the invite email: a fresh code, a fresh 7 days, old one dead. */
  resendActivation: (userId: string) => Promise<AdminActivationResult>
  clearPin: (userId: string, deviceId?: string) => Promise<{ ok: true }>
  revokeSessions: (userId: string) => Promise<{ ok: true; revoked: number }>
  patchOrg: (patch: {
    name?: string
    default_model?: string
    default_allowed_models?: string[]
    user_daily_token_cap?: number
    org_monthly_token_cap?: number
    search_enabled?: boolean
    user_daily_search_cap?: number
    org_monthly_search_cap?: number
  }) => Promise<{ ok: true }>
}

export type ViewerApi = {
  readTree: () => Promise<ViewerTreeNode[]>
  readFile: (relativePath: string) => Promise<string>
  readBinaryFile: (relativePath: string) => Promise<ArrayBuffer>
  writeFile: (relativePath: string, content: string) => Promise<void>
  hasDefault: (relativePath: string) => Promise<boolean>
  readDefault: (relativePath: string) => Promise<string>
  stat: (relativePath: string) => Promise<{ mtimeMs: number }>
  download: (relativePath: string) => Promise<{ ok: boolean }>
  revealInFolder: (relativePath: string) => Promise<{ ok: boolean }>
  resync: () => Promise<ViewerTreeNode[]>
  /**
   * One of the three customization documents (soul / user / agents) was
   * written — by this window, another window, or the paired phone. Carries the
   * workspace-relative path so a listener can ignore documents it is not
   * showing. Fires only for those three: every other workspace file has a
   * single editor and nothing to reconcile with.
   */
  onCustomizationChanged: (listener: (payload: { doc: string; path: string }) => void) => () => void
}

export type HeartbeatJobView = {
  id: string
  type: string
  cron: string | null
  label: string
  /**
   * The automation's display name (its `name: …` marker); null on a job that
   * predates the field, where the schedule heading stands in. The heading —
   * `label` — stays the identity the scheduler and the file grammar key on.
   */
  name: string | null
  body: string
  /** The job's own chat mode (its `mode: …` marker); null ⇒ follows global. */
  mode: 'single' | 'workflow' | null
  nextRunMs: number | null
}

/**
 * Which family a pooled run belongs to (dual decl — see brainstem's RunFamily).
 * The run pool is shared, and each family's live card has its own visibility
 * switch: automations in Settings → Channels → In-app, the other two in their
 * own Knowledge panels. Procedure runs ride the automations switch — a
 * procedure is a saved prompt run in the background, and "is something running
 * for me" is one question, not two.
 */
export type RunFamily = 'automation' | 'compaction' | 'reflection' | 'procedure'

export type HeartbeatRunningJob = {
  id: string
  label: string
  body: string
  startedAt: number
  /** The run's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  /** Resolved in main from the job id — never re-derived here. */
  family: RunFamily
}

export type HeartbeatQueuedJob = {
  id: string
  label: string
  /** The job's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  queuedAt: number
  /** Resolved in main from the job id — never re-derived here. */
  family: RunFamily
}

/** Live run-pool state: up to 3 concurrent runs plus the FIFO overflow. */
export type HeartbeatRunsSnapshot = {
  running: HeartbeatRunningJob[]
  queued: HeartbeatQueuedJob[]
}

export type HeartbeatLogEntry = {
  id: string
  timestamp: number
  kind: 'text' | 'tool_call' | 'tool_result' | 'started' | 'completed' | 'failed' | 'skipped'
  summary: string
}

export type HeartbeatApi = {
  getJobs: () => Promise<HeartbeatJobView[]>
  /** Snapshot of the run pool — every running job plus the queued overflow. */
  getRuns: () => Promise<HeartbeatRunsSnapshot>
  /** Run an automation on demand by id or exact heading label, bypassing its schedule. */
  runJob: (idOrLabel: string) => Promise<{
    ok: boolean
    started: boolean
    /** Which kind of wait: 'queued' runs on its own, 'coalesced' never will. */
    state?: 'running' | 'queued' | 'coalesced'
    /** Runs holding the shared pool right now — what a queued fire waits behind. */
    running?: number
    error?: string
  }>
  /**
   * Per-job "Edited …" stamps (heading label → epoch ms), maintained in main
   * by diffing the file at every scheduler reload — so edits stamp no matter
   * which surface wrote them (card editor, markdown, the agent, external).
   */
  getMeta: () => Promise<Record<string, number>>
  /** One-shot donation of the legacy localStorage stamps; returns the merged map. */
  adoptMeta: (stamps: Record<string, number>) => Promise<Record<string, number>>
  /** The heartbeat file changed (any writer) — re-fetch jobs + meta. */
  onChanged: (listener: () => void) => () => void
  onJobStarted: (listener: (job: HeartbeatRunningJob) => void) => () => void
  onJobEnded: (
    listener: (payload: { id: string; status: 'completed' | 'failed'; error?: string }) => void
  ) => () => void
  onJobLog: (listener: (entry: HeartbeatLogEntry) => void) => () => void
  /** The run pool changed: a run started or ended, or the queue moved. */
  onRunsChanged: (listener: (snapshot: HeartbeatRunsSnapshot) => void) => () => void
}

/** One attached automation file (dual decl — see src/main/automations/files.ts). */
export type AutomationFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source in. */
  path: string
  name: string
}

/**
 * Live ticks while picked files are copied into the automation's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/automations/files.ts).
 */
export type AutomationCopyProgress = {
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type AutomationAttachResult = {
  added: AutomationFileRef[]
  /** Sources already attached under that name — not copied again. */
  skipped: string[]
  /** Sources that don't exist on disk. */
  missing: string[]
}

/**
 * The disk half of an automation's files and working directories. The LISTS
 * themselves live as `file:`/`dir:` marker lines in heartbeat.md and are
 * written by whoever edits that file — these calls only do what needs main:
 * the native pickers, the copy into the workspace, and deleting a copy we own.
 */
export type AutomationFilesApi = {
  /**
   * Native multi-select picker that COPIES the chosen files into this
   * automation's uploads dir. `existing` is its current file list, so the copy
   * lands in the dir it already owns. Returns null on cancel; the caller
   * writes the returned refs out as `file:` markers.
   */
  pickFiles: (existing: string[]) => Promise<AutomationAttachResult | null>
  /** Delete an attached file's copy. A path outside our uploads dir is left alone. */
  removeFile: (path: string) => Promise<{ ok: true }>
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: AutomationCopyProgress) => void) => () => void
}

/** One attached procedure file (dual decl — see src/main/procedures.ts). */
export type ProcedureFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source into uploads/procedure-<id>/. */
  path: string
  name: string
}

/**
 * Native path pickers that belong to no one feature — automations and
 * procedures both point runs at folders, and only main has `dialog`.
 */
export type PathsApi = {
  /** Native multi-select folder picker. Returns null on cancel. */
  pickDirectories: () => Promise<string[] | null>
}

export type Procedure = {
  id: string
  title: string
  prompt: string
  /** The procedure's own chat mode; absent (legacy rows) ⇒ follows global. */
  mode?: 'single' | 'workflow'
  /** Emoji shown on the card; absent (legacy rows) ⇒ the page's default. */
  icon?: string
  /** Project binding — runs get the project overlay and register under it. */
  projectId?: string
  /** Copied-in reference files every run is told about (never injected). */
  files?: ProcedureFileRef[]
  /** Working folders every run gets a fresh listing of. References, not copies. */
  directories?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Live ticks while picked files are copied into the procedure's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/uploads/owned-copies.ts).
 */
export type ProcedureCopyProgress = {
  procedureId: string
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type ProceduresApi = {
  list: () => Promise<Procedure[]>
  create: (payload: {
    title: string
    prompt: string
    mode?: 'single' | 'workflow'
    icon?: string
    projectId?: string
  }) => Promise<Procedure>
  update: (payload: {
    id: string
    title?: string
    prompt?: string
    mode?: 'single' | 'workflow'
    icon?: string
    projectId?: string
    /** Whole-list replace — detached copies WE own are deleted from disk. */
    files?: ProcedureFileRef[]
    /** Whole-list replace. References only, so nothing is deleted. */
    directories?: string[]
  }) => Promise<Procedure>
  delete: (id: string) => Promise<{ ok: true }>
  /**
   * Native multi-select picker that COPIES the chosen files into the
   * procedure's uploads dir and attaches them. Returns the updated procedure,
   * or null on cancel.
   */
  pickFiles: (procedureId: string) => Promise<Procedure | null>
  /** The store changed (any writer, incl. the agent's tools) — re-fetch the list. */
  onChanged: (listener: () => void) => () => void
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: ProcedureCopyProgress) => void) => () => void
}

export type ProjectFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source into uploads/project-<id>/ (dual decl — see src/main/projects.ts). */
  path: string
  name: string
}

export type Project = {
  id: string
  title: string
  /** Emoji icon (native emoji set — universal across OSes). */
  icon: string
  instructions: string
  files: ProjectFileRef[]
  /** Working folders every turn in the project gets a fresh listing of. */
  directories?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Live ticks while picked files are copied into the project's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/projects.ts).
 */
export type ProjectCopyProgress = {
  projectId: string
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type ProjectsApi = {
  list: () => Promise<Project[]>
  create: (payload: { title: string; icon?: string; instructions?: string }) => Promise<Project>
  update: (payload: {
    id: string
    title?: string
    icon?: string
    instructions?: string
    files?: ProjectFileRef[]
    /** Whole-list replace. References only, so nothing is deleted. */
    directories?: string[]
  }) => Promise<Project>
  delete: (id: string) => Promise<{ ok: true }>
  /**
   * Native multi-select picker that COPIES the chosen files into the
   * project's uploads dir and attaches them. Returns the updated project,
   * or null on cancel.
   */
  pickFiles: (projectId: string) => Promise<Project | null>
  /** The store changed (any writer, incl. the agent's tools) — re-fetch the list. */
  onChanged: (listener: () => void) => () => void
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: ProjectCopyProgress) => void) => () => void
}

export type ReindexStatus = {
  startedAt: number
  total: number
  done: number
}

export type ReindexApi = {
  getStatus: () => Promise<ReindexStatus | null>
  onStarted: (listener: (status: { startedAt: number; total: number }) => void) => () => void
  onProgress: (listener: (status: { done: number; total: number }) => void) => () => void
  onEnded: (listener: (payload: { filesCount: number; durationMs: number }) => void) => () => void
}

/**
 * Per-conversation diagnostic export (dual decl — mirrors src/main/diagnostics.ts).
 * The overlay renders one localized line per step key, so the union here and
 * DIAGNOSTIC_STEPS there must stay in step.
 */
export type DiagnosticStep =
  | 'conversation'
  | 'logs'
  | 'tasks'
  | 'memory'
  | 'context'
  | 'settings'
  | 'attachments'
  | 'opinion'
  | 'archive'

export type DiagnosticProgress = {
  conversationId: string
  step: DiagnosticStep
  index: number
  total: number
  files: number
}

export type DiagnosticResult = {
  ok: boolean
  error?: string
  conversationId: string
  conversationTitle: string
  fileName: string
  zipPath: string
  relativePath: string
  sizeBytes: number
  fileCount: number
  durationMs: number
  modelOpinion: boolean
  opinionSkipped?: 'no-model' | 'local-only' | 'failed' | 'empty'
  groups: Array<{ key: string; count: number }>
  warnings: string[]
}

export type DiagnosticsApi = {
  export: (payload: { conversationId: string }) => Promise<DiagnosticResult>
  saveCopy: (payload: {
    zipPath: string
    fileName: string
  }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  reveal: (zipPath: string) => Promise<{ ok: boolean }>
  onProgress: (listener: (progress: DiagnosticProgress) => void) => () => void
}

export type CapabilityEntry = {
  name: string
  description: string
  status: 'ok' | 'error'
  hasPlugin: boolean
  toolCount: number
  triggers: string[]
  requires: string[]
  official: boolean
  /** A locked core capability — shows the Core badge, sorts last, can't be disabled. */
  core: boolean
  /** Authored by Wolffish itself (skill_create) — shows the Wolffish badge. */
  wolffish: boolean
  /**
   * False only for a Wolffish-authored plugin skill that hasn't passed a real
   * tool call since it was created or last edited — shows an Untested badge.
   */
  tested: boolean
  enabled: boolean
  error?: string
}

export type CapabilityImportSource = 'skill' | 'folder' | 'zip'

export type CapabilityImportResult =
  | {
      ok: true
      name: string
      folderName: string
      source: CapabilityImportSource
      hasPlugin: boolean
      toolCount: number
    }
  | { ok: false; error: string }

export type CapabilityDeleteResult =
  | { ok: true; capabilities: CapabilityEntry[] }
  | { ok: false; error: string }

export type CerebellumApi = {
  listCapabilities: () => Promise<CapabilityEntry[]>
  reload: () => Promise<CapabilityEntry[]>
  toggleCapability: (name: string, enabled: boolean) => Promise<void>
  /** Validate and import a dropped/picked SKILL.md, folder, or .zip. */
  importCapability: (sourcePath: string) => Promise<CapabilityImportResult>
  /** Open a native file/folder picker for the import dropzone. Null if canceled. */
  pickImport: (options?: { title?: string; filterName?: string }) => Promise<string | null>
  /** Delete a user-imported capability and nuke its folder. Refuses official ones. */
  deleteCapability: (name: string) => Promise<CapabilityDeleteResult>
  /**
   * A capability was toggled somewhere other than this window — the paired
   * phone, the agent's skills plugin — and the panel should follow. Fires
   * with the full refreshed list; returns the unsubscribe.
   */
  onCapabilitiesChanged: (callback: (capabilities: CapabilityEntry[]) => void) => () => void
}

export type VoiceApi = {
  readFile: (filePath: string) => Promise<ArrayBuffer>
  download: (filePath: string) => Promise<{ ok: boolean }>
  revealInFolder: (filePath: string) => Promise<{ ok: boolean }>
  exists: (filePath: string) => Promise<boolean>
}

export type UploadedFileMetadata = {
  type: MessageAttachmentType
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type UploadFileMeta = {
  sizeBytes: number
  mtimeMs: number
  mimeType: string
}

export type VariablesApi = {
  list: () => Promise<Variable[]>
  save: (variables: Variable[]) => Promise<{ ok: true }>
  /** Fires on every save from any origin — this panel, another window, the
   *  paired phone — with the array that now holds. Returns unsubscribe. */
  onChanged: (listener: (payload: { variables: Variable[] }) => void) => () => void
}

/**
 * Mobile channel — the tunnel to the Wolffish phone app.
 *
 * There is no token to type: the desktop offers a
 * pairing (a QR to scan, or a code to read out) and the phone claims it. The
 * panel then renders live connection state, including the short key
 * fingerprints both devices display so they can be compared at a glance.
 */
export type MobileBridgeState = {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  /** Phones on the bridge right now. */
  phones: Array<{
    deviceId: string
    name: string
    platform: string
    appVersion: string
    connectedAt: number
  }>
  connectedAt: number | null
  lastError: string | null
  reconnects: number
  framesSent: number
  framesReceived: number
  bytesSent: number
  bytesReceived: number
}

export type MobilePairedPhone = {
  id: string
  name: string
  platform: 'ios' | 'android' | null
  model: string | null
  osVersion: string | null
  appVersion: string | null
  pairedAt: number
  lastSeenAt: number | null
  /** Which door it came through, as the org recorded it at the claim. */
  pairMethod: 'qr' | 'code' | null
  connected: boolean
  connectedSince: number | null
}

export type MobileStatus = {
  /** At least one phone holds a live session with the org. */
  paired: boolean
  phones: MobilePairedPhone[]
  /** The desktop's own bridge socket; null before it is started. */
  bridge: MobileBridgeState | null
  offer: {
    mode: 'qr' | 'code'
    payload: string | null
    code: string | null
    expiresAt: number
  } | null
  verbose: boolean
  /** Whether the model's notify_phone tool may send push notifications. */
  notificationsEnabled: boolean
  /** Whether a running automation draws its live card on the PHONE. */
  runCards: boolean
  /** The org API both devices talk to. */
  apiBase: string
}

export type MobileApi = {
  status: () => Promise<MobileStatus>
  /** Open a QR pairing — the payload is rendered as a QR by the panel. */
  offerQr: () => Promise<MobileStatus>
  /** Open a typed-code pairing, for a desktop the phone cannot see. */
  offerCode: () => Promise<MobileStatus>
  /** Drop the live link but keep the pairing — the phone reconnects itself. */
  cancelOffer: () => Promise<MobileStatus>
  /** Forget the phone and drop the keys. */
  unpair: (deviceId?: string) => Promise<MobileStatus>
  setVerbose: (verbose: boolean) => Promise<MobileStatus>
  /** Allow or forbid the model's notify_phone push notifications. */
  setNotifications: (enabled: boolean) => Promise<MobileStatus>
  /** Show or hide the phone's floating automation-run cards. */
  setRunCards: (enabled: boolean) => Promise<MobileStatus>
  /**
   * Point the tunnel at a different relay (null resets to the default).
   * Rejects on a malformed URL. Changing relay drops any offer or pairing —
   * both name the old relay — so the panel confirms first.
   */
  onStatusChange: (callback: (status: MobileStatus) => void) => () => void
}

/**
 * Brave Search is provided by the organization — one key behind the API's
 * /v1/search lane, never on this device — so the service has no config,
 * only a status: the lane's state and this user's standing against the
 * org's allowances (main/brave.ts, from GET /v1/search/status).
 */
export type BraveLaneState = 'ready' | 'disabled' | 'unconfigured' | 'signed_out' | 'unreachable'

export type BraveStatus = {
  provider: 'brave'
  managed: true
  state: BraveLaneState
  configured: boolean
  enabled: boolean
  usedToday: number
  /** 0 = unlimited. */
  dailyCap: number
  orgUsedMonth: number
  /** 0 = unlimited. */
  orgMonthlyCap: number
  pricePerQueryUsd: number
  planQps: number
  limitPerSec: number | null
  error: string | null
  fetchedAt: number
}

export type BraveApi = {
  /** The org lane's status; `refresh` bypasses main's short cache. */
  status: (opts?: { refresh?: boolean }) => Promise<BraveStatus>
}

export type UpdatesConfig = {
  enabled: boolean
}

export type ComputerUseConfig = {
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
}

export type ComputerUsePermissions = {
  platform: string
  hint: string | null
  accessibility: boolean
  screenRecording: boolean
}

/**
 * No setter: screenshot resolution and format are the agent's to choose per
 * capture (`max_width` / `format` on computer_screenshot), so the stored
 * values are a fallback default and nothing in the UI writes them.
 */
export type ComputerUseApi = {
  getConfig: () => Promise<ComputerUseConfig>
  checkPermissions: () => Promise<ComputerUsePermissions>
}

export type BrowserExtensionConfig = {
  port: number
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
  screenshotQuality: number
}

export type ExtensionConnectionStatus = 'stopped' | 'listening' | 'connected' | 'error'

export type ExtensionBrowserInfo = {
  id: string
  instanceId: string | null
  key: string
  browser: string
  name: string
  version: string | null
  browserVersion: string | null
  os: string | null
  profileEmail: string | null
  connectedAt: number
  lastPing: number
}

export type ExtensionServerStatus = {
  status: ExtensionConnectionStatus
  error: string | null
  extensionVersion: string | null
  port: number
  browsers: ExtensionBrowserInfo[]
}

export type BrowserExtensionApi = {
  getConfig: () => Promise<BrowserExtensionConfig>
  setConfig: (
    patch: Partial<BrowserExtensionConfig>
  ) => Promise<{ ok: true; config: BrowserExtensionConfig }>
  status: () => Promise<ExtensionServerStatus>
  openExtensionFolder: () => Promise<void>
  getExtensionPath: () => Promise<string>
  updateExtension: (target?: string | null) => Promise<{ ok: true }>
  testConnection: (
    target?: string | null
  ) => Promise<{ ok: boolean; steps: number; passed: number; error?: string }>
  openExtensionsPage: () => Promise<void>
  onStatusChange: (callback: (status: ExtensionServerStatus) => void) => () => void
}

export type SttTranscribeResult =
  | { ok: true; transcript: string; language?: string }
  | { ok: false; error: string }

export type MicApi = {
  checkAccess: () => Promise<'granted' | 'denied' | 'not-determined' | 'restricted'>
  requestAccess: () => Promise<boolean>
}

// Local voice-engine provisioning (Kokoro TTS / faster-whisper STT) exposed to
// the Settings panels: a manual install with streamed progress + a readiness
// check so the panels can gate voice/model selection until installed.
export type EngineInstallPhase = 'python' | 'engine' | 'ffmpeg' | 'model' | 'done'
export type EngineInstallProgressEvent = { phase: EngineInstallPhase; percent: number }
export type EngineStatus = { installed: boolean }
export type EngineInstallResult = { ok: true } | { ok: false; error: string }
export type TtsPreviewResult = { ok: true; filePath: string } | { ok: false; error: string }
// Queryable in-flight install state — lets a panel recover progress after the
// user navigates away and back (the install keeps running in main).
export type EngineInstallRuntimeState = {
  installing: boolean
  progress: EngineInstallProgressEvent | null
  error: string | null
}

export type SttApi = {
  getConfig: () => Promise<SttConfig>
  setConfig: (patch: Partial<SttConfig>) => Promise<{ ok: true; config: SttConfig }>
  transcribe: (payload: {
    filePath: string
    conversationId?: string
  }) => Promise<SttTranscribeResult>
  installStatus: () => Promise<EngineStatus>
  install: () => Promise<EngineInstallResult>
  onInstallProgress: (listener: (event: EngineInstallProgressEvent) => void) => () => void
  getInstallState: () => Promise<EngineInstallRuntimeState>
}

export type TtsApi = {
  getConfig: () => Promise<TtsConfig>
  setConfig: (patch: Partial<TtsConfig>) => Promise<{ ok: true; config: TtsConfig }>
  installStatus: () => Promise<EngineStatus>
  install: () => Promise<EngineInstallResult>
  onInstallProgress: (listener: (event: EngineInstallProgressEvent) => void) => () => void
  getInstallState: () => Promise<EngineInstallRuntimeState>
  preview: (payload: { text?: string; voice?: string; speed?: string }) => Promise<TtsPreviewResult>
}

export type UploadValidationError =
  | { code: 'file_too_large'; maxBytes: number }
  | { code: 'max_files_reached'; max: number }
  | { code: 'total_size_exceeded'; maxBytes: number }
  | { code: 'type_not_supported' }

/** One top-level entry of a working folder, for attaching folder structure to chat context. */
export type FolderEntry = { name: string; isDirectory: boolean }
/**
 * The top-level listing of a working folder (capped). When `truncated`,
 * `omittedDirectories`/`omittedFiles` count what was dropped past the cap.
 * `error` is set when the dir was unreadable.
 */
export type FolderListing = {
  entries: FolderEntry[]
  truncated: boolean
  omittedDirectories?: number
  omittedFiles?: number
  error?: string
}

/** Byte progress for one in-flight saveFile(), keyed by its progressId. */
export type UploadCopyProgress = {
  progressId: string
  copiedBytes: number
  totalBytes: number
}

export type UploadApi = {
  pickFile: () => Promise<string[]>
  pickFolder: () => Promise<string | null>
  saveFile: (payload: {
    conversationId: string
    sourcePath: string
    /** Opt in to onCopyProgress ticks tagged with this id. */
    progressId?: string
  }) => Promise<UploadedFileMetadata>
  saveBuffer: (payload: {
    conversationId: string
    buffer: ArrayBuffer
    fileName: string
  }) => Promise<UploadedFileMetadata>
  readFile: (relativePath: string) => Promise<ArrayBuffer | null>
  exists: (relativePath: string) => Promise<boolean>
  getMetadata: (relativePath: string) => Promise<UploadFileMeta | null>
  isSupported: (fileName: string) => Promise<boolean>
  validate: (payload: {
    fileName: string
    sizeBytes: number
    currentCount: number
    currentTotalBytes: number
  }) => Promise<UploadValidationError | null>
  openExternal: (relativePath: string) => Promise<{ ok: boolean; error?: string }>
  /** Existence + type of a device path (resolves a leading ~), for chat path cards. */
  statPath: (path: string) => Promise<{ exists: boolean; isDirectory: boolean }>
  /** Top-level contents of a directory (resolves a leading ~), for attaching working-folder structure to chat context. */
  listFolder: (path: string) => Promise<FolderListing>
  /** Open a directory, or reveal a file in its parent folder (resolves a leading ~). */
  revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>
  /** Save a copy of a device path (resolves a leading ~) to a user-picked location. */
  downloadPath: (path: string) => Promise<{ ok: boolean; error?: string }>
  download: (relativePath: string) => Promise<{ ok: boolean }>
  /** Reveal the file in the OS file manager (Finder/Explorer). */
  revealInFolder: (relativePath: string) => Promise<{ ok: boolean }>
  /** Resolve the absolute filesystem path for a File object (e.g. from drag-and-drop). */
  getPathForFile: (file: File) => string
  /** Byte progress for saveFile() calls that passed a progressId. */
  onCopyProgress: (listener: (progress: UploadCopyProgress) => void) => () => void
}

/** Spellcheck fields relayed from the main-process `context-menu` event — the
 *  only place Chromium exposes the misspelled word + its suggestions. `misspelledWord`
 *  is empty when nothing under the cursor is misspelled. */
export type SpellcheckContextMenu = {
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
}

export type SpellcheckApi = {
  /** Fires on every right-click that the page doesn't preventDefault. Carries the
   *  spellcheck payload so the renderer's own styled menu can offer corrections. */
  onContextMenu: (listener: (event: SpellcheckContextMenu) => void) => () => void
  /** Replace the currently-selected misspelled word in the focused field. */
  replace: (word: string) => Promise<void>
  /** Add a word to the spellchecker's custom dictionary so it stops being flagged. */
  addToDictionary: (word: string) => Promise<void>
}

export type WolffishApi = {
  theme: ThemeApi
  locale: LocaleApi
  system: SystemApi
  workspace: WorkspaceApi
  auth: AuthApi
  model: ModelApi
  modelSelect: ModelSelectApi
  provider: ProviderApi
  chat: ChatApi
  conversation: ConversationApi
  viewer: ViewerApi
  heartbeat: HeartbeatApi
  automationFiles: AutomationFilesApi
  paths: PathsApi
  procedures: ProceduresApi
  projects: ProjectsApi
  reindex: ReindexApi
  diagnostics: DiagnosticsApi
  app: AppApi
  data: DataApi
  services: ServicesApi
  runtime: RuntimeApi
  usage: UsageApi
  admin: AdminApi
  leaderboard: LeaderboardApi
  cerebellum: CerebellumApi
  variables: VariablesApi
  voice: VoiceApi
  upload: UploadApi
  mobile: MobileApi
  inapp: InAppApi
  mcp: McpApi
  brave: BraveApi
  mic: MicApi
  stt: SttApi
  tts: TtsApi
  computerUse: ComputerUseApi
  browserExtension: BrowserExtensionApi
  spellcheck: SpellcheckApi
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WolffishApi = {
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (source) => ipcRenderer.invoke('theme:set', source),
    onUpdated: (listener) => subscribe('theme:updated', listener)
  },
  locale: {
    get: () => ipcRenderer.invoke('locale:get'),
    set: (locale) => ipcRenderer.invoke('locale:set', locale)
  },
  system: {
    getInfo: () => ipcRenderer.invoke('system:getInfo')
  },
  workspace: {
    getStatus: () => ipcRenderer.invoke('workspace:getStatus'),
    completeOnboarding: () => ipcRenderer.invoke('workspace:completeOnboarding'),
    /** Config paths the organization owns — enforced server-side; a settings
     *  control on one of these belongs to the org, not the employee. */
    lockedConfigKeys: (): Promise<string[]> => ipcRenderer.invoke('workspace:lockedConfigKeys'),
    onLockedConfigKeysChanged: (listener: (keys: string[]) => void) =>
      subscribe('workspace:lockedConfigKeys', (payload: { keys?: string[] }) =>
        listener(payload?.keys ?? [])
      )
  },
  auth: {
    getState: () => ipcRenderer.invoke('auth:getState'),
    login: (email, password) => ipcRenderer.invoke('auth:login', email, password),
    changePassword: (newPassword) => ipcRenderer.invoke('auth:changePassword', newPassword),
    setPin: (pin) => ipcRenderer.invoke('auth:setPin', pin),
    unlock: (pin) => ipcRenderer.invoke('auth:unlock', pin),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    lock: () => ipcRenderer.invoke('auth:lock'),
    changePin: (currentPin, nextPin) => ipcRenderer.invoke('auth:changePin', currentPin, nextPin),
    getProfile: () => ipcRenderer.invoke('auth:profileGet'),
    updateProfile: (patch) => ipcRenderer.invoke('auth:profileUpdate', patch),
    resetRequest: (email) => ipcRenderer.invoke('auth:resetRequest', email),
    resetConfirm: (email, code, newPassword) =>
      ipcRenderer.invoke('auth:resetConfirm', email, code, newPassword),
    activateRequest: (email) => ipcRenderer.invoke('auth:activateRequest', email),
    activateConfirm: (email, code, newPassword) =>
      ipcRenderer.invoke('auth:activateConfirm', email, code, newPassword),
    getAvatar: () => ipcRenderer.invoke('auth:avatarGet'),
    setAvatar: (bytes, mime) => ipcRenderer.invoke('auth:avatarSet', bytes, mime),
    removeAvatar: () => ipcRenderer.invoke('auth:avatarRemove'),
    changePasswordSelf: (currentPassword, newPassword) =>
      ipcRenderer.invoke('auth:passwordChangeSelf', currentPassword, newPassword),
    onChanged: (listener) => subscribe('auth:changed', listener),
    onAvatarChanged: (listener) => subscribe('auth:avatarChanged', listener)
  },
  model: {
    capabilities: () => ipcRenderer.invoke('model:capabilities'),
    catalog: () => ipcRenderer.invoke('model:catalog'),
    onCatalogChanged: (listener) => subscribe('model:catalogChanged', listener)
  },
  modelSelect: {
    select: (model) => ipcRenderer.invoke('model:select', model)
  },
  provider: {
    setMode: (mode) => ipcRenderer.invoke('provider:setMode', mode),
    onUpdated: (listener) => subscribe('provider:updated', listener)
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    cancel: (payload) => ipcRenderer.invoke('chat:cancel', payload),
    activeRuns: () => ipcRenderer.invoke('chat:activeRuns'),
    turnMirror: (conversationId) => ipcRenderer.invoke('chat:turnMirror', conversationId),
    respondApproval: (payload) => ipcRenderer.invoke('chat:approvalRespond', payload),
    respondAsk: (payload) => ipcRenderer.invoke('chat:askRespond', payload),
    exportPdf: (payload) => ipcRenderer.invoke('chat:exportPdf', payload),
    onSegment: (listener) => subscribe('chat:segment', listener),
    onDone: (listener) => subscribe('chat:done', listener),
    onError: (listener) => subscribe('chat:error', listener),
    onTurnEvent: (listener) => subscribe('chat:turnEvent', listener),
    onApprovalRequest: (listener) => subscribe('chat:approvalRequest', listener),
    onAskRequest: (listener) => subscribe('chat:askRequest', listener),
    onCredentialBlocked: (listener) => subscribe('chat:credentialBlocked', listener),
    onTurnState: (listener) => subscribe('chat:turnState', listener)
  },
  conversation: {
    list: () => ipcRenderer.invoke('conversation:list'),
    load: (id) => ipcRenderer.invoke('conversation:load', id),
    save: (conv) => ipcRenderer.invoke('conversation:save', conv),
    delete: (id) => ipcRenderer.invoke('conversation:delete', id),
    create: (model) => ipcRenderer.invoke('conversation:create', model),
    onSummaryUpdated: (listener) => subscribe('conversation:summaryUpdated', listener),
    onDeleted: (listener) => subscribe('conversation:deleted', listener),
    onChanged: (listener) => subscribe('conversation:changed', listener),
    onMessageMirror: (listener) => subscribe('conversation:messageMirror', listener),
    hydrate: (id) => ipcRenderer.invoke('conversation:hydrate', id),
    onHydrationProgress: (listener) => subscribe('conversation:hydrationProgress', listener)
  },
  viewer: {
    readTree: () => ipcRenderer.invoke('viewer:readTree'),
    readFile: (relativePath) => ipcRenderer.invoke('viewer:readFile', relativePath),
    readBinaryFile: (relativePath) => ipcRenderer.invoke('viewer:readBinaryFile', relativePath),
    writeFile: (relativePath, content) =>
      ipcRenderer.invoke('viewer:writeFile', relativePath, content),
    hasDefault: (relativePath) => ipcRenderer.invoke('viewer:hasDefault', relativePath),
    readDefault: (relativePath) => ipcRenderer.invoke('viewer:readDefault', relativePath),
    stat: (relativePath) => ipcRenderer.invoke('viewer:stat', relativePath),
    download: (relativePath) => ipcRenderer.invoke('viewer:download', relativePath),
    revealInFolder: (relativePath) => ipcRenderer.invoke('viewer:revealInFolder', relativePath),
    resync: () => ipcRenderer.invoke('viewer:resync'),
    onCustomizationChanged: (listener) => subscribe('customization:changed', listener)
  },
  heartbeat: {
    getJobs: () => ipcRenderer.invoke('heartbeat:getJobs'),
    getRuns: () => ipcRenderer.invoke('heartbeat:getRuns'),
    runJob: (idOrLabel) => ipcRenderer.invoke('heartbeat:runJob', idOrLabel),
    getMeta: () => ipcRenderer.invoke('heartbeat:getMeta'),
    adoptMeta: (stamps) => ipcRenderer.invoke('heartbeat:adoptMeta', stamps),
    onChanged: (listener) => subscribe('heartbeat:changed', listener),
    onJobStarted: (listener) => subscribe('heartbeat:jobStarted', listener),
    onJobEnded: (listener) => subscribe('heartbeat:jobEnded', listener),
    onJobLog: (listener) => subscribe('heartbeat:jobLog', listener),
    onRunsChanged: (listener) => subscribe('heartbeat:runsChanged', listener)
  },
  paths: {
    pickDirectories: () => ipcRenderer.invoke('paths:pickDirectories')
  },
  automationFiles: {
    pickFiles: (existing) => ipcRenderer.invoke('automations:pickFiles', existing),
    removeFile: (path) => ipcRenderer.invoke('automations:removeFile', path),
    onCopyProgress: (listener) => subscribe('automations:copyProgress', listener)
  },
  procedures: {
    list: () => ipcRenderer.invoke('procedures:list'),
    create: (payload) => ipcRenderer.invoke('procedures:create', payload),
    update: (payload) => ipcRenderer.invoke('procedures:update', payload),
    delete: (id) => ipcRenderer.invoke('procedures:delete', id),
    pickFiles: (procedureId) => ipcRenderer.invoke('procedures:pickFiles', procedureId),
    onChanged: (listener) => subscribe('procedures:changed', listener),
    onCopyProgress: (listener) => subscribe('procedures:copyProgress', listener)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (payload) => ipcRenderer.invoke('projects:create', payload),
    update: (payload) => ipcRenderer.invoke('projects:update', payload),
    delete: (id) => ipcRenderer.invoke('projects:delete', id),
    pickFiles: (projectId) => ipcRenderer.invoke('projects:pickFiles', projectId),
    onChanged: (listener) => subscribe('projects:changed', listener),
    onCopyProgress: (listener) => subscribe('projects:copyProgress', listener)
  },
  reindex: {
    getStatus: () => ipcRenderer.invoke('reindex:getStatus'),
    onStarted: (listener) => subscribe('reindex:started', listener),
    onProgress: (listener) => subscribe('reindex:progress', listener),
    onEnded: (listener) => subscribe('reindex:ended', listener)
  },
  diagnostics: {
    export: (payload) => ipcRenderer.invoke('diagnostics:export', payload),
    saveCopy: (payload) => ipcRenderer.invoke('diagnostics:saveCopy', payload),
    reveal: (zipPath) => ipcRenderer.invoke('diagnostics:reveal', zipPath),
    onProgress: (listener) => subscribe('diagnostics:progress', listener)
  },
  app: {
    factoryReset: () => ipcRenderer.invoke('app:factoryReset'),
    onClosingPending: (listener) => subscribe('app:closingPending', listener)
  },
  data: {
    getAnalytics: () => ipcRenderer.invoke('data:getAnalytics')
  },
  services: {
    onChanged: (listener) => subscribe('services:changed', listener)
  },
  runtime: {
    setLaunchAtStartup: (value) => ipcRenderer.invoke('runtime:setLaunchAtStartup', value),
    getLaunchAtStartupStatus: () => ipcRenderer.invoke('runtime:getLaunchAtStartupStatus'),
    setBypassPermissions: (value) => ipcRenderer.invoke('runtime:setBypassPermissions', value),
    setBlockCredentials: (value) => ipcRenderer.invoke('runtime:setBlockCredentials', value),
    setThinkingMode: (model, mode) => ipcRenderer.invoke('runtime:setThinkingMode', model, mode),
    setWeekStartsOn: (value) => ipcRenderer.invoke('runtime:setWeekStartsOn', value),
    setLastSettingsState: (patch) => ipcRenderer.invoke('runtime:setLastSettingsState', patch),
    onPreferencesChanged: (listener) => subscribe('preferences:changed', listener),
    onMobileSettingsChange: (listener) => subscribe('settings:mobileChange', listener),
    getCompactionConfig: () => ipcRenderer.invoke('runtime:getCompactionConfig'),
    setCompactionConfig: (patch) => ipcRenderer.invoke('runtime:setCompactionConfig', patch),
    getCompactionRuns: () => ipcRenderer.invoke('runtime:getCompactionRuns'),
    onCompactionChanged: (listener) => subscribe('compaction:changed', listener),
    onCompactionConfigChanged: (listener) => subscribe('compaction:configChanged', listener),
    getReflectionConfig: () => ipcRenderer.invoke('runtime:getReflectionConfig'),
    setReflectionConfig: (patch) => ipcRenderer.invoke('runtime:setReflectionConfig', patch),
    runReflectionNow: () => ipcRenderer.invoke('runtime:runReflectionNow'),
    runDeepCleanNow: () => ipcRenderer.invoke('runtime:runDeepCleanNow'),
    onReflectionChanged: (listener) => subscribe('reflection:changed', listener)
  },
  usage: {
    getSummary: (range) => ipcRenderer.invoke('usage:getSummary', range),
    getStats: (range) => ipcRenderer.invoke('usage:getStats', range),
    getDaily: (year) => ipcRenderer.invoke('usage:getDaily', year),
    sync: () => ipcRenderer.invoke('usage:sync')
  },
  admin: {
    getAccess: () => ipcRenderer.invoke('admin:getAccess'),
    roster: (days) => ipcRenderer.invoke('admin:roster', days),
    userOverview: (userId, days) => ipcRenderer.invoke('admin:userOverview', userId, days),
    listConversations: (userId, opts) =>
      ipcRenderer.invoke('admin:listConversations', userId, opts),
    readConversation: (conversationId) =>
      ipcRenderer.invoke('admin:readConversation', conversationId),
    userAudit: (userId, limit) => ipcRenderer.invoke('admin:userAudit', userId, limit),
    audit: (limit) => ipcRenderer.invoke('admin:audit', limit),
    getOrg: () => ipcRenderer.invoke('admin:getOrg'),
    getGates: () => ipcRenderer.invoke('admin:getGates'),
    invite: (input) => ipcRenderer.invoke('admin:invite', input),
    updateUser: (userId, patch) => ipcRenderer.invoke('admin:updateUser', userId, patch),
    setPlan: (userId, plan) => ipcRenderer.invoke('admin:setPlan', userId, plan),
    setPolicy: (userId, policy) => ipcRenderer.invoke('admin:setPolicy', userId, policy),
    resetPassword: (userId) => ipcRenderer.invoke('admin:resetPassword', userId),
    resendActivation: (userId) => ipcRenderer.invoke('admin:resendActivation', userId),
    clearPin: (userId, deviceId) => ipcRenderer.invoke('admin:clearPin', userId, deviceId),
    revokeSessions: (userId) => ipcRenderer.invoke('admin:revokeSessions', userId),
    patchOrg: (patch) => ipcRenderer.invoke('admin:patchOrg', patch)
  },
  leaderboard: {
    list: (params) => ipcRenderer.invoke('leaderboard:list', params ?? {})
  },
  cerebellum: {
    listCapabilities: () => ipcRenderer.invoke('cerebellum:listCapabilities'),
    reload: () => ipcRenderer.invoke('cerebellum:reload'),
    toggleCapability: (name, enabled) =>
      ipcRenderer.invoke('cerebellum:toggleCapability', name, enabled),
    importCapability: (sourcePath) => ipcRenderer.invoke('cerebellum:importCapability', sourcePath),
    pickImport: (options) => ipcRenderer.invoke('cerebellum:pickImport', options),
    deleteCapability: (name) => ipcRenderer.invoke('cerebellum:deleteCapability', name),
    onCapabilitiesChanged: (callback) => subscribe('cerebellum:capabilitiesChanged', callback)
  },
  variables: {
    list: () => ipcRenderer.invoke('variables:list'),
    save: (variables) => ipcRenderer.invoke('variables:save', variables),
    onChanged: (listener) => subscribe('variables:changed', listener)
  },
  voice: {
    readFile: (filePath) => ipcRenderer.invoke('voice:readFile', filePath),
    download: (filePath) => ipcRenderer.invoke('voice:download', filePath),
    revealInFolder: (filePath) => ipcRenderer.invoke('voice:revealInFolder', filePath),
    exists: (filePath) => ipcRenderer.invoke('voice:exists', filePath)
  },
  upload: {
    pickFile: () => ipcRenderer.invoke('upload:pickFile'),
    pickFolder: () => ipcRenderer.invoke('upload:pickFolder'),
    saveFile: (payload) => ipcRenderer.invoke('upload:saveFile', payload),
    saveBuffer: (payload) => ipcRenderer.invoke('upload:saveBuffer', payload),
    readFile: (relativePath) => ipcRenderer.invoke('upload:readFile', relativePath),
    exists: (relativePath) => ipcRenderer.invoke('upload:exists', relativePath),
    getMetadata: (relativePath) => ipcRenderer.invoke('upload:getMetadata', relativePath),
    isSupported: (fileName) => ipcRenderer.invoke('upload:isSupported', fileName),
    validate: (payload) => ipcRenderer.invoke('upload:validate', payload),
    openExternal: (relativePath) => ipcRenderer.invoke('upload:openExternal', relativePath),
    statPath: (path) => ipcRenderer.invoke('upload:statPath', path),
    listFolder: (path) => ipcRenderer.invoke('upload:listFolder', path),
    revealPath: (path) => ipcRenderer.invoke('upload:revealPath', path),
    downloadPath: (path) => ipcRenderer.invoke('upload:downloadPath', path),
    download: (relativePath) => ipcRenderer.invoke('upload:download', relativePath),
    revealInFolder: (relativePath) => ipcRenderer.invoke('upload:revealInFolder', relativePath),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    onCopyProgress: (listener) => subscribe('upload:copyProgress', listener)
  },
  mobile: {
    status: () => ipcRenderer.invoke('mobile:status'),
    offerQr: () => ipcRenderer.invoke('mobile:offerQr'),
    offerCode: () => ipcRenderer.invoke('mobile:offerCode'),
    cancelOffer: () => ipcRenderer.invoke('mobile:cancelOffer'),
    unpair: (deviceId) => ipcRenderer.invoke('mobile:unpair', deviceId),
    setVerbose: (verbose) => ipcRenderer.invoke('mobile:setVerbose', verbose),
    setNotifications: (enabled) => ipcRenderer.invoke('mobile:setNotifications', enabled),
    setRunCards: (enabled) => ipcRenderer.invoke('mobile:setRunCards', enabled),
    onStatusChange: (callback) => subscribe('mobile:statusChange', callback)
  },
  inapp: {
    getConfig: () => ipcRenderer.invoke('inapp:getConfig'),
    setConfig: (patch) => ipcRenderer.invoke('inapp:setConfig', patch),
    onConfigChange: (callback) => subscribe('inapp:configChange', callback)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    setHeaders: (id, headers) => ipcRenderer.invoke('mcp:setHeaders', id, headers),
    test: (id) => ipcRenderer.invoke('mcp:test', id),
    authorize: (id) => ipcRenderer.invoke('mcp:authorize', id),
    onStatusChange: (callback) => subscribe('mcp:statusChange', callback)
  },
  brave: {
    status: (opts) => ipcRenderer.invoke('brave:status', opts)
  },
  mic: {
    checkAccess: () => ipcRenderer.invoke('mic:checkAccess'),
    requestAccess: () => ipcRenderer.invoke('mic:requestAccess')
  },
  stt: {
    getConfig: () => ipcRenderer.invoke('stt:getConfig'),
    setConfig: (patch) => ipcRenderer.invoke('stt:setConfig', patch),
    transcribe: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
    installStatus: () => ipcRenderer.invoke('stt:installStatus'),
    install: () => ipcRenderer.invoke('stt:install'),
    onInstallProgress: (listener) => subscribe('stt:installProgress', listener),
    getInstallState: () => ipcRenderer.invoke('stt:getInstallState')
  },
  tts: {
    getConfig: () => ipcRenderer.invoke('tts:getConfig'),
    setConfig: (patch) => ipcRenderer.invoke('tts:setConfig', patch),
    installStatus: () => ipcRenderer.invoke('tts:installStatus'),
    install: () => ipcRenderer.invoke('tts:install'),
    onInstallProgress: (listener) => subscribe('tts:installProgress', listener),
    getInstallState: () => ipcRenderer.invoke('tts:getInstallState'),
    preview: (payload) => ipcRenderer.invoke('tts:preview', payload)
  },
  computerUse: {
    getConfig: () => ipcRenderer.invoke('computerUse:getConfig'),
    checkPermissions: () => ipcRenderer.invoke('computerUse:checkPermissions')
  },
  browserExtension: {
    getConfig: () => ipcRenderer.invoke('browserExtension:getConfig'),
    setConfig: (patch) => ipcRenderer.invoke('browserExtension:setConfig', patch),
    status: () => ipcRenderer.invoke('browserExtension:status'),
    openExtensionFolder: () => ipcRenderer.invoke('browserExtension:openExtensionFolder'),
    getExtensionPath: () => ipcRenderer.invoke('browserExtension:getExtensionPath'),
    updateExtension: (target) => ipcRenderer.invoke('browserExtension:updateExtension', target),
    testConnection: (target) => ipcRenderer.invoke('browserExtension:testConnection', target),
    openExtensionsPage: () => ipcRenderer.invoke('browserExtension:openExtensionsPage'),
    onStatusChange: (listener) => subscribe('extension:statusChange', listener)
  },
  spellcheck: {
    onContextMenu: (listener) => subscribe('spellcheck:contextMenu', listener),
    replace: (word) => ipcRenderer.invoke('spellcheck:replace', word),
    addToDictionary: (word) => ipcRenderer.invoke('spellcheck:addToDictionary', word)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { api: WolffishApi }).api = api
}
