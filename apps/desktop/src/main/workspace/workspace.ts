import { is } from '@electron-toolkit/utils'
import { diskWriter } from '@main/io/diskWriter'
import { importOutsideProjectFiles } from '@main/projects'
import { mcpCapabilityName } from '@main/runtime/mcp/naming'
import type { McpConfig, McpOauthState, McpServerConfig } from '@main/runtime/mcp/types'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WORKSPACE_ROOT } from './root'

// Wolffish Cloud carries no model-provider configuration on the device.
// There are no provider entries, no API keys, no local models: the org's
// API is the only model lane, the catalog and policy come from it, and the
// only model state stored here is which allowed model the user selected
// (llm.model below). The API integration phase wires the catalog in.

export type SafetyConfig = {
  bypassPermissions: boolean
  blockCredentials: boolean
}

/**
 * In-app (desktop) chat display preferences — the primary renderer feed.
 * `verbose` gates what the in-app chat DISPLAYS: false (default) = a clean
 * feed (agent replies, file-bearing tool results, errors); true = the
 * model/provider chip plus every tool call/result/activity card. Display-only
 * — never affects history persistence.
 *
 * `runCards` gates the floating run card an AUTOMATION draws over this
 * app while it runs (the compaction and reflection families have their own
 * switches, in their own panels). False is the default and the whole point:
 * the runs still happen, are still logged, and still reach the automations
 * screen — the card simply does not float over the chat.
 */
export type InAppConfig = {
  verbose?: boolean
  runCards?: boolean
}

/**
 * Mobile channel preferences that must survive restarts. `notifications`
 * gates the model's notify_phone tool entirely: off means the tool refuses
 * before any frame is built, and nothing reaches the relay or the phone.
 * Default ON — the phone still shows nothing unless the model deliberately
 * calls the tool, and the phone's own OS permission is the second gate.
 *
 * `verbose` is the same feed preference the in-app
 * chat carries: false (default) mirrors a clean feed to the phone (agent
 * replies, file-bearing results, errors), true relays every tool call and
 * activity card. Display-only — it never affects what is stored, and never
 * affects connection logging, which is unconditional.
 *
 * `runCards` is the phone's own copy of the in-app switch: whether an
 * AUTOMATION run draws a card over whatever screen the phone is on. Separate
 * from `inapp.runCards` because the two devices are looked at
 * differently — a card worth having on the desk is not automatically one worth
 * having in a pocket. Default off, like the desktop's.
 */
export type MobileChannelConfig = {
  notifications?: boolean
  verbose?: boolean
  runCards?: boolean
  /**
   * Power-user tunnel relay override (Settings → Mobile). Lives HERE — not
   * in the device-local pairing file — because it is user-authored
   * configuration that must survive a purge and reach the user's other
   * devices; the pairing file keeps only the device-bound keypair.
   * Absent = the built-in default relay.
   */
  relayUrl?: string
}

/**
 * Legacy Brave Search block. Web search is now provided by the organization
 * (one key behind the API's /v1/search lane), so nothing reads these fields
 * any more; the type survives only so an older config.json still parses.
 */
export type BraveConfig = {
  enabled: boolean
  apiKey: string
}

/**
 * Speech-to-text defaults the cerebellum plugin reads on every call.
 * `defaultModel` is the Whisper model size — tiny / base / small /
 * medium / large. Empty string falls back to the plugin's hard-coded
 * default (`small`). `language` is the transcription language every
 * voice note and transcription is pinned to: an ISO 639-1/Whisper code
 * (`en`, `ar`, …), or `auto` for Whisper's own detection. Empty string
 * falls back to the plugin default (`en`) — pinned on purpose: detection
 * on short clips misfires (an English sentence transcribed INTO Arabic
 * script), so autodetect is the explicit opt-in, never the default.
 */
export type SttConfig = {
  defaultModel: string
  language: string
}

/**
 * Text-to-speech defaults the cerebellum plugin reads on every call.
 * `defaultVoice` is a Kokoro voice id (e.g. `af_bella`). `defaultSpeed` is a
 * float multiplier string between `0.5` and `1.5` (e.g. `1.0`). Empty values
 * fall back to the plugin defaults (`af_bella`, `1.0`).
 *
 * `voiceReplies` (default ON — absent means true, like VideoConfig.director):
 * the Voice replies switch on the Preferences page. It is the ONE control
 * over whether the voice-reply instructions exist at all: ON = every turn's
 * prompt carries the `<voice_prompts>` standing policy plus a per-iteration
 * runtime notice (end a `<voice_note>` turn with one spoken voice_respond);
 * OFF = neither is included and voice prompts get text replies. A model
 * directive only: the harness never synthesizes or suppresses audio itself.
 */
export type TtsConfig = {
  defaultVoice: string
  defaultSpeed: string
  voiceReplies: boolean
}

export type ComputerUseConfig = {
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
}

export type BrowserExtensionConfig = {
  port: number
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
  screenshotQuality: number
}

export type Variable = {
  name: string
  value: string
  sensitive: boolean
}

export type WeekStartsOn = 0 | 1

export type CompactionConfig = {
  /** Hour of day (0-23) for daily compaction. Defaults to 23. */
  dailyHour: number
  /** Day of week (0=Sun, 6=Sat) for weekly consolidation. Defaults to 0 (Sunday). */
  weeklyDay: number
  /** Hour of day (0-23) for weekly consolidation. Defaults to 23. */
  weeklyHour: number
  /**
   * Whether a running compaction job draws its floating card — over the chat
   * here, over whatever screen the phone is on there. One switch for both
   * surfaces: this is housekeeping either device can see, not a per-device
   * taste. Defaults to false; the jobs run either way.
   */
  cards: boolean
}

export type ReflectionConfig = {
  /**
   * Hour of day (0-23) the nightly reflection fires. Defaults to 3. The
   * nightly reflection AND the monthly deep clean (which runs at hour+1 on
   * the 1st) are CORE features with no off switch — the learning loop gets
   * scheduled, never disabled.
   */
  hour: number
  /**
   * A conversation is only reviewed once it has been quiet for this many
   * hours — a conversation still warm may not be done yet. Defaults to 12.
   */
  quietHours: number
  /**
   * Whether a running reflection job (nightly review or monthly deep clean)
   * draws its floating card on either surface — the compaction switch's twin,
   * and off for the same reason. The review runs regardless; this is only
   * whether it announces itself over the chat.
   */
  cards: boolean
}

export type WorkspaceConfig = {
  version: 1
  // When true, Wolffish registers itself as a login item so the OS
  // launches it automatically on boot/login. Enabled by default.
  // The actual OS registration is checked at runtime via
  // app.getLoginItemSettings() — this field stores the user's intent.
  launchAtStartup?: boolean
  llm: {
    // The user's selected model, by id. The catalog of allowed models —
    // ids, names, reasoning flags, logos — is served per-user by the
    // Wolffish Cloud API (GET /v1/models); nothing model-shaped beyond
    // this selection is stored on the device. Null means not chosen yet.
    model: string | null
    // Chat mode, switched from the chat composer's mode button. 'single'
    // (default) runs every turn solo. 'workflow' makes each top-level turn a
    // workflow master: it can plan phases and spawn live parallel subagents
    // through the `workflow` capability.
    mode?: 'single' | 'workflow'
    // Per-model thinking mode. Key is model name, value is thinking mode string.
    thinkingModes?: Record<string, string>
  }
  // Optional so configs written before this field shipped still parse.
  safety?: SafetyConfig
  // Nightly self-review (reflection) and the monthly deep clean. Optional
  // so configs written before the feature shipped parse.
  reflection?: ReflectionConfig
  // Context optimization (prompt caching). On by default; set
  // enabled: false to restore the legacy per-iteration prompt rebuild
  // for debugging. Gates the per-turn pinning of system prompt + tools,
  // the outbound volatile runtime tail, and provider stickiness. Bug
  // fixes (memory exclusions, compaction calibration) are not gated.
  // `truncation` (also default on, requires enabled) additionally
  // collapses provably superseded page reads, byte-equal duplicate
  // results, and stale screenshots into self-describing stubs in the
  // outbound request only — internal history, episodes, and task files
  // keep full fidelity.
  contextOptimization?: {
    enabled?: boolean
    truncation?: boolean
  }
  // 0 = Sunday, 1 = Monday. Defaults to Monday (ISO 8601). Drives how the
  // activity heatmap is laid out and how the user thinks about week
  // boundaries. Optional so legacy configs migrate cleanly.
  weekStartsOn?: WeekStartsOn
  variables?: Variable[]
  // In-app (desktop) chat display preferences. Optional so legacy configs
  // migrate cleanly — when absent the feed defaults to clean (verbose off).
  inapp?: InAppConfig
  // Mobile channel preferences. Optional so legacy configs migrate cleanly
  // — when absent, model-initiated phone notifications default to ON.
  mobile?: MobileChannelConfig
  // Legacy Brave Search block (key + toggle) from before web search became
  // an org-provided lane. Ignored; kept so older configs still parse.
  brave?: BraveConfig
  // STT/TTS defaults exposed to the cerebellum plugins via config.json.
  // Optional for backwards compatibility — plugin falls back to its
  // own hard-coded defaults when missing or partially set.
  stt?: SttConfig
  tts?: TtsConfig
  computerUse?: ComputerUseConfig
  browserExtension?: BrowserExtensionConfig
  compaction?: CompactionConfig
  // MCP server connections. Types live in @main/runtime/mcp/types (pure,
  // test-importable) and are re-exported below. Optional so legacy
  // configs migrate cleanly — when absent no connections exist.
  mcp?: McpConfig
  lastSettingsState?: {
    tab?: string
    provider?: string
    channel?: string
    service?: string
    knowledgeTab?: string
    sidebarCollapsed?: string
    rightSidebarCollapsed?: string
  }
  disabledCapabilities?: string[]
  /**
   * Extra capabilities whose tool schemas ship on EVERY request, on top of
   * the built-in core set (see cerebellum CORE_CAPABILITIES). The tuning
   * knob for the lean tool surface — no UI, hand-edited in config.json.
   */
  pinnedCapabilities?: string[]
  locale: 'en' | 'ar'
  theme: 'system' | 'light' | 'dark'
  onboardingCompleted: boolean
}

export type WorkspaceStatus = {
  rootPath: string
  initialized: boolean
  onboardingCompleted: boolean
  config: WorkspaceConfig | null
}

const CONFIG_FILENAME = 'config.json'
const CONFIG_BACKUP_FILENAME = 'config.json.bak'
const LOCK_FILENAME = '.lock'

// Defined in ./root (a leaf module) so conversations.ts and
// compose-attachments.ts can import it without closing a cycle back into this
// module, which imports them statically. Re-exported because the rest of the
// app imports it from here.
export { workspaceRoot } from './root'

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Wolffish-internal storage roots. Tool calls whose paths land inside any
 * of these are housekeeping the user never asked about — memory updates,
 * knowledge writes, episode logs. The renderer skips approval cards and
 * tool cards entirely for these so the chat stays focused on the
 * conversation, not on plumbing.
 */
function internalRoots(): string[] {
  const home = os.homedir()
  return [WORKSPACE_ROOT, path.join(home, 'brain')]
}

/**
 * True when a tool call targets wolffish's own storage and should run
 * without surfacing any UI. Path-traversal attempts (`..`) are never
 * silenced — those still hit the normal danger-pattern flow.
 */
export function isInternalToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== 'file_read' && name !== 'file_write' && name !== 'file_patch') return false
  const raw = args.path
  if (typeof raw !== 'string' || raw.length === 0) return false
  if (raw.includes('..')) return false
  const resolved = path.resolve(expandHome(raw))
  return internalRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

/**
 * Wipe the entire ~/.wfc/workspace tree. Caller is responsible for
 * relaunching the app afterwards — leaving the process running with no
 * workspace would put us in an undefined state.
 */
export async function purgeWorkspace(): Promise<void> {
  await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true })
}

export function configPath(): string {
  return path.join(WORKSPACE_ROOT, CONFIG_FILENAME)
}

export function configBackupPath(): string {
  return path.join(WORKSPACE_ROOT, CONFIG_BACKUP_FILENAME)
}

export function lockfilePath(): string {
  return path.join(WORKSPACE_ROOT, LOCK_FILENAME)
}

export function defaultsRootPath(): string {
  if (is.dev) {
    return path.join(app.getAppPath(), 'src', 'defaults')
  }
  return path.join(process.resourcesPath, 'defaults')
}

export function defaultsWorkspacePath(): string {
  return path.join(defaultsRootPath(), 'workspace')
}

export async function readConfig(): Promise<WorkspaceConfig | null> {
  try {
    const { config } = await readConfigStrict()
    return config
  } catch {
    // Lenient read for the many read-only callers (getStatus, getVariables,
    // the integration getXConfig helpers) that already treat a missing or
    // unreadable config as null. Never throws.
    return null
  }
}

/**
 * Read config.json while preserving the distinction the lenient readConfig
 * throws away: a file that is genuinely ABSENT (fresh workspace) versus one
 * that EXISTS but momentarily fails to read or parse (a foreign writer caught
 * mid-write, a transient IO error). That distinction is load-bearing — a
 * config that exists must never be treated as "absent", or a follow-up
 * patchConfig would overwrite real settings with defaults.
 *
 * Returns { exists:false } only for ENOENT. Throws for any other read error
 * or for unparseable JSON.
 */
async function readConfigStrict(): Promise<{ exists: boolean; config: WorkspaceConfig | null }> {
  let raw: string
  try {
    raw = await fs.readFile(configPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, config: null }
    }
    throw err
  }
  return { exists: true, config: JSON.parse(raw) as WorkspaceConfig }
}

// Serializes every config write and read-modify-write through one in-process
// promise chain. The atomic write below guarantees no reader sees a torn
// file; this guarantees no two writers interleave and lose each other's
// update (e.g. a phone edit racing a UI setting change, or the
// renderer's thinking-mode effect racing a provider save). Single-threaded JS
// reassigns `configMutex` synchronously per call, so callers queue FIFO.
let configMutex: Promise<unknown> = Promise.resolve()

function withConfigLock<T>(op: () => Promise<T>): Promise<T> {
  const run = configMutex.then(op, op)
  // Keep the chain moving whether op resolves or rejects; never let a
  // rejection wedge the queue or surface as an unhandled rejection here.
  configMutex = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function writeConfig(config: WorkspaceConfig): Promise<void> {
  await withConfigLock(() => writeConfigAtomic(config))
}

/**
 * Atomic write through the single I/O layer: temp file + fsync + rename(2),
 * serialized per path, so a concurrent reader or a crash always sees the
 * complete old file or the complete new one — never the truncated window a
 * bare fs.writeFile exposes mid-write (the partial-read that made readConfig()
 * return null and patchConfig() fall back to defaults, wiping keys/providers).
 * After the swap we mirror the same bytes to config.json.bak as a last-known-
 * good snapshot for recovery.
 *
 * Always reached through writeConfig or patchConfig, both of which already hold
 * the config lock (the logical read-modify-write mutex); diskWriter adds the
 * physical per-path serialization on top.
 */
/** Cloud-sync notifier for config writes, injected by main at startup. */
let configSyncHook: (() => void) | null = null
export function setConfigSyncHook(hook: (() => void) | null): void {
  configSyncHook = hook
}

async function writeConfigAtomic(config: WorkspaceConfig): Promise<void> {
  const data = JSON.stringify(config, null, 2)
  await diskWriter.writeFileAtomic(configPath(), data)
  // Best-effort last-known-good snapshot. A failure here can never affect the
  // live file, and the backup is only ever read as a recovery fallback.
  await diskWriter.writeFileAtomic(configBackupPath(), data).catch(() => {})
  configSyncHook?.()
}

export async function patchConfig(
  patch: (current: WorkspaceConfig) => WorkspaceConfig
): Promise<WorkspaceConfig> {
  return withConfigLock(async () => {
    const current = await loadConfigBase()
    const next = patch(current)
    await writeConfigAtomic(next)
    return next
  })
}

/**
 * The object a patch is applied on top of. Seeds defaults ONLY when the
 * workspace genuinely has no config yet (fresh install). If config.json
 * exists but can't be read or parsed, we recover the last-known-good backup
 * rather than rebuilding from defaults — falling back to defaults here is the
 * precise bug that wiped real settings. If neither the file nor a usable
 * backup can be read, we throw to abort the write: failing one setting is
 * recoverable; clobbering the whole config is not.
 */
async function loadConfigBase(): Promise<WorkspaceConfig> {
  try {
    const { exists, config } = await readConfigStrict()
    if (config) return config
    if (!exists) return defaultConfig()
  } catch {
    // exists-but-unreadable — fall through to backup recovery
  }
  const backup = await readBackupConfig()
  if (backup) return backup
  throw new Error(
    'config.json exists but is unreadable and no usable backup was found; ' +
      'refusing to overwrite it with defaults'
  )
}

async function readBackupConfig(): Promise<WorkspaceConfig | null> {
  try {
    const raw = await fs.readFile(configBackupPath(), 'utf8')
    return JSON.parse(raw) as WorkspaceConfig
  } catch {
    return null
  }
}

function defaultConfig(): WorkspaceConfig {
  return {
    version: 1,
    launchAtStartup: false,
    llm: {
      model: null
    },
    safety: { bypassPermissions: true, blockCredentials: false },
    weekStartsOn: 1,
    locale: 'en',
    theme: 'system',
    onboardingCompleted: false
  }
}

export async function ensureWorkspace(): Promise<void> {
  const fresh = !existsSync(WORKSPACE_ROOT)

  if (fresh) {
    const source = defaultsWorkspacePath()
    if (!existsSync(source)) {
      throw new Error(`default workspace missing at ${source}`)
    }
    await fs.cp(source, WORKSPACE_ROOT, {
      recursive: true,
      force: false,
      filter: (src) => !src.endsWith('.DS_Store')
    })
    if (!existsSync(configPath())) {
      await writeConfig(defaultConfig())
    }
  }

  // Post-update migration: merge new config keys and refresh the app-managed
  // prompt files.
  await migrateConfig()
  await migrateAgentsCore()
  await migrateAgentsGuide()
  await migrateIdentityRoleFiles()
  // The standing removed-feature sweep — one function, extended in place.
  await cleanupWorkspace()

  // Capabilities are cloud-first: nothing ships in the app. The org set
  // (and the user's own imports) download from the registry on session
  // ready and stay in sync from then on — see cloud/capabilitySync.ts.
  // Only the empty directory is guaranteed here, so the loader and the
  // first sync pass have a stable root before sign-in.
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'brain', 'cerebellum'), { recursive: true })

  // cortex.db is NOT nuked here anymore: Cortex.init() is schema-versioned
  // (full rebuild on version bump) and its startup catch-up diff picks up any
  // files the migrations above changed — a full every-launch rebuild would
  // throw away the incremental index for nothing.

  await ensureUsageStructure()
  await ensureSpeechDirectory()
  await ensureVoiceDirectory()
  await ensureUploadsDirectory()
  await ensureFilesDirectory()
  await ensureScreenshotsDirectory()
  await ensureLogsDirectory()
  await ensureExtensionLogsDirectory()
  await ensureBundledExtension()
}

async function ensureSpeechDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'speech'), { recursive: true })
}

async function ensureVoiceDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'voice'), { recursive: true })
}

async function ensureUploadsDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'uploads'), { recursive: true })
}

async function ensureFilesDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'files'), { recursive: true })
}

async function ensureScreenshotsDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'screenshots'), { recursive: true })
}

async function ensureLogsDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'logs'), { recursive: true })
}

// ---------------------------------------------------------------------------
// Post-update migration helpers
// ---------------------------------------------------------------------------

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function deepMergeAdditive(
  user: Record<string, unknown>,
  defaults: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...user }
  for (const key of Object.keys(defaults)) {
    if (!(key in merged)) {
      merged[key] = defaults[key]
    } else if (isPlainObject(merged[key]) && isPlainObject(defaults[key])) {
      merged[key] = deepMergeAdditive(
        merged[key] as Record<string, unknown>,
        defaults[key] as Record<string, unknown>
      )
    }
  }
  return merged
}

async function migrateConfig(): Promise<void> {
  const userConfig = await readConfig()
  if (!userConfig) return
  const defaultsPath = path.join(defaultsWorkspacePath(), 'config.json')
  let bundledDefaults: Record<string, unknown>
  try {
    const raw = await fs.readFile(defaultsPath, 'utf8')
    bundledDefaults = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const merged = deepMergeAdditive(
    userConfig as unknown as Record<string, unknown>,
    bundledDefaults
  ) as unknown as WorkspaceConfig
  await writeConfig(merged)
}

/**
 * THE one permanent home for sweeping out what removed features left behind
 * in deployed footprints — retired capabilities, replaced prompt files, dead
 * config keys, stale caches. Runs every launch; every block is idempotent
 * (no-ops once clean) and strictly scoped to our own ~/.wfc footprint.
 * When a feature is removed from the app, append its cleanup HERE — never
 * mint a new one-off function for it.
 *
 * The accumulated legacy sweeps (openai-whisper venv,
 * planning/orchestrator capabilities and prompts, dead cascade +
 * orchestrator config keys, edge-tts values, legacy Notion/GitHub
 * connection shapes, the Untitled-title backfill, the message-id mint) were
 * all retired once every deployed footprint had converged — fresh installs
 * never had any of it, and a pre-id conversation file that ever resurfaces
 * degrades to mergeConversationOnto's positional pairing, the pre-id rules.
 */
async function cleanupWorkspace(): Promise<void> {
  // Projects own their files: copy-on-attach shipped after the first
  // projects, so legacy refs pointing outside the workspace (e.g. a PDF on
  // the Desktop) are imported into uploads/project-<id>/ here. Idempotent —
  // inside-workspace refs are untouched, missing sources left as-is.
  await importOutsideProjectFiles().catch(() => undefined)
  // The personal edition's model settings — local models, provider keys,
  // the updater — have no reader in Wolffish Cloud. They were seeded into
  // every profile by the old bundled defaults and travel with the synced
  // config row, so they are swept out of existing files here (the bundle
  // no longer carries them).
  await pruneRetiredConfigKeys().catch(() => undefined)
}

const RETIRED_LLM_KEYS = ['local', 'providers', 'restrictPowerfulModels', 'brain', 'localOnly']
const RETIRED_TOP_KEYS = [
  'updates',
  'ollamaModelsFolder',
  'video',
  // The retired service integrations (removed 2026-09-03): their config
  // blocks — bot tokens, PATs, integration secrets, engine defaults — are
  // swept out of every synced config so nothing lingers at the org either.
  'telegram',
  'whatsapp',
  'notion',
  'github',
  'google',
  'memes'
]

async function pruneRetiredConfigKeys(): Promise<void> {
  const config = await readConfig()
  if (!config) return
  const raw = config as unknown as Record<string, unknown>
  let changed = false
  const llm = isPlainObject(raw.llm) ? raw.llm : null
  if (llm) {
    for (const key of RETIRED_LLM_KEYS) {
      if (key in llm) {
        delete llm[key]
        changed = true
      }
    }
  }
  for (const key of RETIRED_TOP_KEYS) {
    if (key in raw) {
      delete raw[key]
      changed = true
    }
  }
  if (changed) await writeConfig(config)
}

async function migrateAgentsCore(): Promise<void> {
  const bundled = path.join(defaultsWorkspacePath(), 'brain', 'prefrontal', 'agents.core.md')
  if (!existsSync(bundled)) return
  const target = path.join(WORKSPACE_ROOT, 'brain', 'prefrontal', 'agents.core.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(bundled, target)
}

/**
 * AGENTS.md is the orientation guide for any AI assistant pointed at the
 * ~/.wfc folder. It lives at the ROOT of ~/.wfc (next to workspace/,
 * runtime/, logs/) — not inside the workspace — because it documents the whole
 * footprint, and its own map and path references are written relative to that
 * root. Bundled at src/defaults/AGENTS.md.
 *
 * App-managed, exactly like agents.core.md above: the bundled copy is rewritten
 * on every launch, so an app upgrade always ships the current guide. Wolffish
 * owns this file — local edits are replaced on the next launch. Custom,
 * persistent agent instructions belong in brain/prefrontal/agents.md, which we
 * never overwrite.
 */
async function migrateAgentsGuide(): Promise<void> {
  const bundled = path.join(defaultsRootPath(), 'AGENTS.md')
  if (!existsSync(bundled)) return
  const target = path.join(path.dirname(WORKSPACE_ROOT), 'AGENTS.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(bundled, target)
}

/**
 * The workflow master/agent role prompts (brain/identity/) are APP-MANAGED,
 * like agents.core.md: overwritten on every launch so prompt improvements ship
 * with an upgrade. They're framework behaviour, not personalization — custom
 * agent instructions belong in brain/prefrontal/agents.md, which we never
 * overwrite.
 */
async function migrateIdentityRoleFiles(): Promise<void> {
  for (const name of ['workflow.md', 'workflow-agent.md']) {
    const bundled = path.join(defaultsWorkspacePath(), 'brain', 'identity', name)
    if (!existsSync(bundled)) continue
    const target = path.join(WORKSPACE_ROOT, 'brain', 'identity', name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(bundled, target)
  }
}

async function ensureUsageStructure(): Promise<void> {
  const usageDir = path.join(WORKSPACE_ROOT, 'usage')
  const providersDir = path.join(usageDir, 'providers')
  const dailyDir = path.join(usageDir, 'daily')
  await fs.mkdir(providersDir, { recursive: true })
  await fs.mkdir(dailyDir, { recursive: true })

  // One lane only: every model call flows through the org's API. Real
  // metering lives server-side; this ledger is the local scratch record.
  const providerFiles = [{ file: 'cloud.md', header: '# Wolffish Cloud' }]
  for (const { file, header } of providerFiles) {
    const filepath = path.join(providersDir, file)
    if (!existsSync(filepath)) {
      await diskWriter.writeFileAtomic(filepath, `${header}\n`)
    }
  }
}

export async function getStatus(): Promise<WorkspaceStatus> {
  const config = await readConfig()
  const initialized = config !== null
  return {
    rootPath: WORKSPACE_ROOT,
    initialized,
    onboardingCompleted: !!config?.onboardingCompleted,
    config
  }
}

/**
 * Set (or clear) the selected model. Validity is the API's business — the
 * catalog endpoint decides what this user may pick, and the router refuses
 * disallowed models regardless of what is stored here.
 */
export async function setModel(model: string | null): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, llm: { ...c.llm, model } }))
}

/** Set the chat mode: 'single' (solo turns) vs 'workflow' (model-led agents). */
export async function setMode(mode: 'single' | 'workflow'): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, llm: { ...c.llm, mode } }))
}

export async function markOnboardingComplete(): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, onboardingCompleted: true }))
}

export async function setLocale(locale: 'en' | 'ar'): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, locale }))
}

export async function setTheme(theme: 'system' | 'light' | 'dark'): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, theme }))
}

export async function setBypassPermissions(value: boolean): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({
    ...c,
    safety: {
      ...(c.safety ?? { bypassPermissions: false, blockCredentials: false }),
      bypassPermissions: value
    }
  }))
}

export async function setBlockCredentials(value: boolean): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({
    ...c,
    safety: {
      ...(c.safety ?? { bypassPermissions: false, blockCredentials: false }),
      blockCredentials: value
    }
  }))
}

export async function setWeekStartsOn(value: WeekStartsOn): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, weekStartsOn: value }))
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  dailyHour: 23,
  weeklyDay: 0,
  weeklyHour: 23,
  cards: false
}

export async function getCompactionConfig(): Promise<CompactionConfig> {
  const cfg = await readConfig()
  // Merged over the defaults rather than returned raw: `cards` shipped after
  // the schedule did, so a config written before it has no such field and
  // must read as "no card" instead of undefined.
  return { ...DEFAULT_COMPACTION, ...(cfg?.compaction ?? {}) }
}

export async function setCompactionConfig(
  patch: Partial<CompactionConfig>
): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = c.compaction ?? DEFAULT_COMPACTION
    return { ...c, compaction: { ...current, ...patch } }
  })
}

export const DEFAULT_REFLECTION: ReflectionConfig = {
  hour: 3,
  quietHours: 12,
  cards: false
}

/**
 * Merge a possibly-partial stored value over the defaults. Constructed
 * field-by-field so retired keys in an older stored config (e.g. the removed
 * `enabled` switch, or the retired turn-scoring `scoring` map) are dropped
 * rather than carried forward.
 */
export function normalizeReflectionConfig(
  raw: Partial<ReflectionConfig> | undefined | null
): ReflectionConfig {
  return {
    hour: raw?.hour ?? DEFAULT_REFLECTION.hour,
    quietHours: raw?.quietHours ?? DEFAULT_REFLECTION.quietHours,
    cards: raw?.cards ?? DEFAULT_REFLECTION.cards
  }
}

export async function getReflectionConfig(): Promise<ReflectionConfig> {
  const cfg = await readConfig()
  return normalizeReflectionConfig(cfg?.reflection)
}

/** A partial reflection edit. */
export type ReflectionPatch = Partial<ReflectionConfig>

export async function setReflectionConfig(patch: ReflectionPatch): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = normalizeReflectionConfig(c.reflection)
    return {
      ...c,
      // Re-normalized so only known fields persist — a stale caller can't
      // write retired keys back into the stored config.
      reflection: normalizeReflectionConfig({ ...current, ...patch })
    }
  })
}

export async function setThinkingMode(model: string, mode: string): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({
    ...c,
    llm: {
      ...c.llm,
      thinkingModes: { ...c.llm.thinkingModes, [model]: mode }
    }
  }))
}

export async function setLaunchAtStartup(value: boolean): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, launchAtStartup: value }))
}

/**
 * Wipe the data inside ~/.wfc/workspace but preserve user preferences:
 * API keys, model selection, locale, theme, runtime toggles, and the
 * week-start setting. Memories, conversations, feedback, tasks, debug
 * snapshots, corpus event logs, knowledge files, identity tweaks, and
 * usage data are all deleted; bundled defaults are recreated. Caller is
 * responsible for stopping the agent and relaunching the app afterwards
 * so no stale handles survive.
 */
export async function factoryReset(): Promise<void> {
  const preserved = await readConfig()
  await purgeWorkspace()
  await ensureWorkspace()
  if (preserved) {
    // Default config has been laid down by ensureWorkspace; overwrite it
    // with the preserved one so API keys, model selection, locale, theme,
    // and runtime toggles survive the reset. onboardingCompleted is
    // forced true because the user has already completed onboarding;
    // making them redo it after a data reset would be punitive.
    await writeConfig({ ...preserved, onboardingCompleted: true })
  }
}

export async function getVariables(): Promise<Variable[]> {
  const config = await readConfig()
  return config?.variables ?? []
}

export async function setVariables(variables: Variable[]): Promise<WorkspaceConfig> {
  return patchConfig((c) => ({ ...c, variables }))
}

const EMPTY_INAPP_CONFIG: InAppConfig = {
  verbose: false,
  runCards: false
}

export async function getInAppConfig(): Promise<InAppConfig> {
  const config = await readConfig()
  // Merged, not returned raw: a config written before `runCards`
  // shipped has no such field, and undefined must read as off.
  return { ...EMPTY_INAPP_CONFIG, ...(config?.inapp ?? {}) }
}

export async function setInAppConfig(patch: Partial<InAppConfig>): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = c.inapp ?? EMPTY_INAPP_CONFIG
    const next: InAppConfig = {
      verbose: patch.verbose ?? current.verbose,
      runCards: patch.runCards ?? current.runCards ?? false
    }
    return { ...c, inapp: next }
  })
}

const EMPTY_MOBILE_CONFIG: MobileChannelConfig = {
  notifications: true,
  verbose: false,
  runCards: false
}

export async function getMobileChannelConfig(): Promise<MobileChannelConfig> {
  const config = await readConfig()
  return { ...EMPTY_MOBILE_CONFIG, ...(config?.mobile ?? {}) }
}

export async function setMobileChannelConfig(
  patch: Partial<MobileChannelConfig>
): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = { ...EMPTY_MOBILE_CONFIG, ...(c.mobile ?? {}) }
    const next: MobileChannelConfig = {
      notifications: patch.notifications ?? current.notifications,
      verbose: patch.verbose ?? current.verbose,
      runCards: patch.runCards ?? current.runCards,
      // Not a preference this setter owns — carried through so a prefs
      // save can never strip the synced relay override.
      ...(current.relayUrl ? { relayUrl: current.relayUrl } : {})
    }
    return { ...c, mobile: next }
  })
}

// Getters normalize field-by-field (not `?? EMPTY`) so a config.json written
// before a field existed still comes back complete — same contract as
// getVideoConfig. voiceReplies: absent means ON.
export async function getSttConfig(): Promise<SttConfig> {
  const config = await readConfig()
  return {
    defaultModel: config?.stt?.defaultModel ?? '',
    language: config?.stt?.language ?? ''
  }
}

export async function setSttConfig(patch: Partial<SttConfig>): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const next: SttConfig = {
      defaultModel: patch.defaultModel ?? c.stt?.defaultModel ?? '',
      language: patch.language ?? c.stt?.language ?? ''
    }
    return { ...c, stt: next }
  })
}

export async function getTtsConfig(): Promise<TtsConfig> {
  const config = await readConfig()
  return {
    defaultVoice: config?.tts?.defaultVoice ?? '',
    defaultSpeed: config?.tts?.defaultSpeed ?? '',
    voiceReplies: config?.tts?.voiceReplies !== false
  }
}

export async function setTtsConfig(patch: Partial<TtsConfig>): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const next: TtsConfig = {
      defaultVoice: patch.defaultVoice ?? c.tts?.defaultVoice ?? '',
      defaultSpeed: patch.defaultSpeed ?? c.tts?.defaultSpeed ?? '',
      voiceReplies: patch.voiceReplies ?? c.tts?.voiceReplies !== false
    }
    return { ...c, tts: next }
  })
}

const DEFAULT_COMPUTER_USE_CONFIG: ComputerUseConfig = {
  screenshotMaxWidth: 1280,
  screenshotFormat: 'jpeg'
}

export async function getComputerUseConfig(): Promise<ComputerUseConfig> {
  const config = await readConfig()
  const stored = config?.computerUse
  if (!stored) return DEFAULT_COMPUTER_USE_CONFIG
  return {
    screenshotMaxWidth: stored.screenshotMaxWidth ?? 1280,
    screenshotFormat: stored.screenshotFormat ?? 'jpeg'
  }
}

export async function setComputerUseConfig(
  patch: Partial<ComputerUseConfig>
): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = c.computerUse ?? DEFAULT_COMPUTER_USE_CONFIG
    const next: ComputerUseConfig = {
      screenshotMaxWidth: patch.screenshotMaxWidth ?? current.screenshotMaxWidth,
      screenshotFormat: patch.screenshotFormat ?? current.screenshotFormat
    }
    return { ...c, computerUse: next }
  })
}

// ─── Browser Extension ──────────────────────────────────────────────────

// 23152, not the personal edition's 23151 — both apps (and both extensions)
// must coexist on one machine without fighting over the socket.
const DEFAULT_BROWSER_EXTENSION_CONFIG: BrowserExtensionConfig = {
  port: 23152,
  screenshotMaxWidth: 1280,
  screenshotFormat: 'jpeg',
  screenshotQuality: 80
}

export async function getBrowserExtensionConfig(): Promise<BrowserExtensionConfig> {
  const config = await readConfig()
  const stored = config?.browserExtension
  if (!stored) return DEFAULT_BROWSER_EXTENSION_CONFIG
  return {
    port: stored.port ?? 23152,
    screenshotMaxWidth: stored.screenshotMaxWidth ?? 1280,
    screenshotFormat: stored.screenshotFormat ?? 'jpeg',
    screenshotQuality: stored.screenshotQuality ?? 80
  }
}

export async function setBrowserExtensionConfig(
  patch: Partial<BrowserExtensionConfig>
): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const current = { ...DEFAULT_BROWSER_EXTENSION_CONFIG, ...c.browserExtension }
    return {
      ...c,
      browserExtension: {
        port: patch.port ?? current.port,
        screenshotMaxWidth: patch.screenshotMaxWidth ?? current.screenshotMaxWidth,
        screenshotFormat: patch.screenshotFormat ?? current.screenshotFormat,
        screenshotQuality: patch.screenshotQuality ?? current.screenshotQuality
      }
    }
  })
}

export type { McpConfig, McpOauthState, McpServerConfig }

const EMPTY_MCP_CONFIG: McpConfig = { servers: [] }

export async function getMcpConfig(): Promise<McpConfig> {
  const config = await readConfig()
  return config?.mcp ?? EMPTY_MCP_CONFIG
}

export async function addMcpServer(server: McpServerConfig): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const servers = (c.mcp ?? EMPTY_MCP_CONFIG).servers.filter((s) => s.id !== server.id)
    return { ...c, mcp: { servers: [...servers, server] } }
  })
}

/**
 * Patch a server record by id. Strictly map-in-place: when the record no
 * longer exists (removed while an async caller was in flight) this is a
 * no-op — it must never re-create a deleted server.
 */
export async function updateMcpServer(
  id: string,
  patch: Partial<Pick<McpServerConfig, 'name' | 'enabled' | 'command' | 'url' | 'env' | 'headers'>>
): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const servers = (c.mcp ?? EMPTY_MCP_CONFIG).servers
    if (!servers.some((s) => s.id === id)) return c
    return {
      ...c,
      mcp: { servers: servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
    }
  })
}

/**
 * Merge OAuth state (tokens, client registration, callback port) into a
 * server record. Same map-in-place/no-op contract as updateMcpServer —
 * the MCP SDK calls this mid-connect and must not race a user's remove.
 * An explicit `undefined` value clears the field (credential invalidation).
 */
export async function patchMcpServerOauth(
  id: string,
  patch: Partial<McpOauthState>
): Promise<void> {
  await patchConfig((c) => {
    const servers = (c.mcp ?? EMPTY_MCP_CONFIG).servers
    if (!servers.some((s) => s.id === id)) return c
    return {
      ...c,
      mcp: {
        servers: servers.map((s) => {
          if (s.id !== id) return s
          const oauth: McpOauthState = { ...s.oauth }
          for (const key of ['clientInformation', 'tokens', 'redirectPort'] as const) {
            if (!(key in patch)) continue
            const value = patch[key]
            if (value === undefined) delete oauth[key]
            else (oauth as Record<string, unknown>)[key] = value
          }
          return { ...s, oauth }
        })
      }
    }
  })
}

/**
 * Remove a server and everything it owned: its config record (including
 * OAuth tokens) and any stale disabledCapabilities entry — a later
 * server that lands the same slug must not inherit a disable.
 */
export async function removeMcpServer(id: string): Promise<WorkspaceConfig> {
  return patchConfig((c) => {
    const servers = (c.mcp ?? EMPTY_MCP_CONFIG).servers
    const removed = servers.find((s) => s.id === id)
    const next: WorkspaceConfig = { ...c, mcp: { servers: servers.filter((s) => s.id !== id) } }
    if (removed && next.disabledCapabilities) {
      next.disabledCapabilities = next.disabledCapabilities.filter(
        (name) => name !== mcpCapabilityName(removed.slug)
      )
    }
    return next
  })
}

export function extensionFolderPath(): string {
  return path.join(WORKSPACE_ROOT, 'extension')
}

async function ensureExtensionLogsDirectory(): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE_ROOT, 'logs', 'extension'), { recursive: true })
}

/**
 * Read the version from a manifest.json file. Returns null if unreadable.
 */
async function readManifestVersion(manifestPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(raw) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/**
 * Version of the extension bundled with the app binary. This is the
 * source of truth — on every launch the runtime extension folder is
 * synced to this version.
 */
export async function getBundledExtensionVersion(): Promise<string | null> {
  return readManifestVersion(path.join(defaultsWorkspacePath(), 'extension', 'manifest.json'))
}

/**
 * Version of the extension currently in the runtime workspace folder
 * (~/.wfc/workspace/extension/). May lag behind the bundled
 * version until the next app launch syncs them.
 */
export async function getRuntimeExtensionVersion(): Promise<string | null> {
  return readManifestVersion(path.join(WORKSPACE_ROOT, 'extension', 'manifest.json'))
}

/**
 * Sync bundled extension files to the runtime workspace. Called on
 * every app launch so plugin bug fixes shipped with an app upgrade
 * reach the user automatically. Returns true if files were updated
 * (bundled version differs from runtime version).
 */
async function ensureBundledExtension(): Promise<void> {
  const source = path.join(defaultsWorkspacePath(), 'extension')
  if (!existsSync(source)) return
  const target = path.join(WORKSPACE_ROOT, 'extension')
  await fs.cp(source, target, {
    recursive: true,
    force: true,
    filter: (src) => !src.endsWith('.DS_Store')
  })
}
