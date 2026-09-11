process.noDeprecation = true

import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { attachFilesToAutomation, removeAutomationFile } from '@main/automations/files'
import { braveService, type BraveStatus } from '@main/brave'
import { turnRouter } from '@main/channels/channel'
import { collectChannelStatus } from '@main/channels/status'
import { normalizeReasoningMode, reasoningModesFor } from '@main/runtime/reasoning'
import { getPlanMode, onPlanModeChange, setPlanMode } from '@main/runtime/plan-mode'
import { ElectronChannel } from '@main/channels/electron/channel'
import { ExtensionServer } from '@main/channels/extension/server'
import { MobileChannel } from '@main/channels/mobile/channel'
import { BridgeClient } from '@main/cloud/bridge'
import { SNAPSHOT_PATH } from '@main/cloud/bridge-protocol'
import {
  CUSTOMIZATION_DOCS,
  CUSTOMIZATION_MAX_BYTES,
  THINKING_MODES,
  modelSelectable,
  type CustomizationDoc
} from '@main/channels/mobile/snapshot'
import { TurnRunner, type ActiveRun } from '@main/channels/turn-runner'
import {
  countConversationsSince,
  createConversation,
  deleteConversation,
  idFromFilename,
  listConversations,
  loadConversation,
  mergeConversationOnto,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type ConversationMeta
} from '@main/conversations'
import { getDataAnalytics, type DataAnalytics } from '@main/data'
import {
  copyDiagnosticArchive,
  exportConversationDiagnostics,
  type DiagnosticProgress,
  type DiagnosticResult
} from '@main/diagnostics'
import {
  getSttInstallState,
  getTtsInstallState,
  installStt,
  installTts,
  sttStatus,
  ttsStatus,
  type EngineInstallProgress,
  type EngineInstallResult,
  type EngineRuntimeState,
  type EngineStatus
} from '@main/voice-engines'
import {
  autostartStatus,
  installAutostart,
  uninstallAutostart,
  type AutostartStatus
} from '@main/autostart/autostart'
import { handle } from '@main/ipc-registry'
import { registerAdminIpc } from '@main/admin-ipc'
import { acquireLock, releaseLockSync } from '@main/lockfile'
import { configureSummarizer, queueConversationSummarization } from '@main/conversation-summarizer'
import {
  attachFilesToProcedure,
  createProcedure,
  deleteProcedure,
  listProcedures,
  setProceduresChangedListener,
  updateProcedure,
  type ProcedureFileRef
} from '@main/procedures'
import {
  attachFilesToProject,
  createProject,
  deleteProject,
  listProjects,
  setProjectsChangedListener,
  updateProject,
  type ProjectFileRef
} from '@main/projects'
import {
  API_BASE,
  fetchLeaderboard,
  offerPairing,
  pairingStatus,
  withdrawPairing,
  listDevices,
  revokeDevice
} from '@main/cloud/api'
import { getCatalog, onCatalogChanged, refreshCatalog } from '@main/cloud/catalogSync'
import {
  initCapabilitySync,
  queueUserCapabilityDelete,
  scheduleCapabilitySync
} from '@main/cloud/capabilitySync'
import {
  hydrateConversationFiles,
  initCloudSync,
  markWorkspaceReset,
  flushOutbox,
  lockedConfigKeys,
  wipeCloudData,
  type HydrationProgress,
  type RestoreSummary,
  hydrateBlob,
  ensureFileUploaded
} from '@main/cloud/sync'
import { cloudSession, type AuthState } from '@main/cloud/session'
import { connectCloudProvider } from '@main/runtime/providers/cloud'
import { workspaceMediaPath } from '@main/media-url'
import { pathToFileURL } from 'node:url'
import { diskWriter } from '@main/io/diskWriter'
import { Agent } from '@main/runtime/agent'
import type { ApprovalDecision } from '@main/runtime/amygdala'
import { nextCronMs, previewSchedule } from '@main/runtime/brainstem'
import { COMPACTION_THRESHOLD } from '@main/runtime/compactor'
import type { AskUserResponse } from '@main/runtime/cerebellum'
import { LOCKED_CAPABILITIES, WOLFFISH_AUTHOR } from '@main/runtime/cerebellum'
import {
  isKnowledgeTarget,
  KNOWLEDGE_TARGETS,
  KnowledgeStore,
  type EntrySource
} from '@main/runtime/knowledge'
import { deleteCapabilityFolder, importCapability } from '@main/runtime/capabilityImport'
import { McpManager } from '@main/runtime/mcp/manager'
import type { McpAddInput, McpHeader } from '@main/runtime/mcp/types'
import { sudoSession } from '@main/runtime/sudoSession'
import { Thalamus } from '@main/runtime/thalamus'
import type { TimeRange as UsageTimeRange } from '@main/runtime/usage'
import { cloudModelSupportsVision } from '@main/runtime/vision'
import { detectSystem, type SystemInfo } from '@main/system'
import {
  classifyFile,
  isSupportedExtension,
  readUpload,
  resolveUploadPath,
  saveUpload,
  saveUploadFromBuffer,
  statUpload,
  uploadExists,
  type UploadedFileMetadata
} from '@main/uploads/uploads'
import { categorizeFile, validateFile, type ValidationError } from '@main/uploads/validation'
import {
  hasBundledDefault,
  readBundledDefault,
  readViewerBinaryFile,
  readViewerFile,
  readViewerTree,
  resolveViewerPath,
  statViewerFile,
  writeViewerFile,
  type ViewerTreeNode
} from '@main/viewer'
import { wlog } from '@main/workspace/logger'
import {
  ensureWorkspace,
  extensionFolderPath,
  factoryReset,
  getBrowserExtensionConfig,
  getCompactionConfig,
  getReflectionConfig,
  normalizeReflectionConfig,
  getComputerUseConfig,
  getSttConfig,
  getTtsConfig,
  getInAppConfig,
  getMobileChannelConfig,
  setMobileChannelConfig as persistMobileChannelConfig,
  getStatus,
  getVariables,
  lockfilePath,
  markOnboardingComplete,
  patchConfig,
  purgeWorkspace,
  setBlockCredentials as persistBlockCredentials,
  setModel as persistModel,
  setMode as persistMode,
  setBrowserExtensionConfig as persistBrowserExtensionConfig,
  setBypassPermissions as persistBypassPermissions,
  setCompactionConfig as persistCompactionConfig,
  setReflectionConfig as persistReflectionConfig,
  setInAppConfig as persistInAppConfig,
  setLaunchAtStartup as persistLaunchAtStartup,
  setLocale as persistLocale,
  setTheme as persistTheme,
  setThinkingMode as persistThinkingMode,
  setVariables as persistVariables,
  setWeekStartsOn as persistWeekStartsOn,
  readConfig,
  workspaceRoot,
  setSttConfig as persistSttConfig,
  setTtsConfig as persistTtsConfig,
  type BrowserExtensionConfig,
  type ComputerUseConfig,
  type InAppConfig,
  type SttConfig,
  type TtsConfig,
  type Variable,
  type WeekStartsOn,
  type WorkspaceConfig,
  type WorkspaceStatus
} from '@main/workspace/workspace'
import type { ChatHistoryMessage } from '@preload/index'
import icon from '@resources/icons-win/icons/512x512.png?asset'
import dockIcon from '@resources/icons/icons/1024x1024.png?asset'
import trayIconDefault from '@resources/images/icon_transparent.png?asset'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray
} from 'electron'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

// Redirect Chromium/Electron-managed state into ~/.wfc so a single
// `rm -rf ~/.wfc` wipes every byte the app touches. Must run before
// app.whenReady() — Electron resolves these paths on first use.
const WOLFFISH_ROOT = join(os.homedir(), '.wfc')
app.setPath('userData', join(WOLFFISH_ROOT, 'runtime'))
app.setAppLogsPath(join(WOLFFISH_ROOT, 'logs'))

// Resolve a path the assistant mentioned in chat (which may start with ~) to an
// absolute path. Returns null for anything that isn't a real absolute/home path
// — the renderer only ever passes such paths, but this guards against junk.
function resolveDevicePath(p: string): string | null {
  if (!p || typeof p !== 'string') return null
  const trimmed = p.trim()
  let resolved = trimmed
  if (trimmed === '~') resolved = os.homedir()
  else if (trimmed.startsWith('~/')) resolved = join(os.homedir(), trimmed.slice(2))
  return isAbsolute(resolved) ? resolved : null
}

// Wolffish is a full-access local agent — it runs shell commands, installs
// software, and elevates with sudo on the user's behalf. Chromium's sandbox
// works against that: on Linux it sets the kernel's no_new_privs flag on the
// main process, which the kernel then uses to ignore the setuid bit on `sudo`
// and `pkexec` — so EVERY elevation a plugin spawns fails with
// `sudo: The "no new privileges" flag is set`. `--no-sandbox` runs every
// process unsandboxed: no no_new_privs (sudo works) and no setuid
// chrome-sandbox helper needed in a packaged AppImage/deb. Must run before
// app.whenReady(). Built-in safety lives in the amygdala approval gate.
//
// Do NOT also pass `--disable-setuid-sandbox`: it's redundant under
// `--no-sandbox` and Linux-only, so it only muddies the flag set.
app.commandLine.appendSwitch('no-sandbox')
// Test-harness escape hatch: an isolated $HOME (integration runs) has no
// authorized login keychain, and Chromium's Safe Storage bootstrap then
// blocks the main process on a keychain-auth dialog. The mock keychain
// keeps safeStorage functional without touching the real one. Never set
// in production; guarded by an explicit opt-in env.
if (process.env.WFC_MOCK_KEYCHAIN === '1') app.commandLine.appendSwitch('use-mock-keychain')

// Running unsandboxed, Chromium's guest/renderer processes allocate their
// shared memory directly in /dev/shm instead of via the sandbox broker. On some
// Linux hosts a guest process can't access /dev/shm from its context and dies
// FATAL ("Creating shared memory in /dev/shm ... failed"), which leaves the
// <webview> page viewer, PDF preview, and wolffish-media files BLANK while the
// main window (already painted) looks fine. This bit packaged Linux only —
// macOS/Windows don't use /dev/shm, and under the SUID sandbox (before we
// disabled it) the broker handled the shared memory. `--disable-dev-shm-usage`
// routes that shared memory to a regular temp file, fixing the blank guests
// with no effect on the sudo/no_new_privs behavior above.
app.commandLine.appendSwitch('disable-dev-shm-usage')

// The real fix for the blank Linux viewers. Even with --no-sandbox, the
// guest/renderer/GPU child processes in a packaged build still bring up the
// seccomp-bpf filter ("InitializeSandbox() called ... in process gpu-process"),
// and that filter REJECTS the syscall those processes use to allocate their
// compositor shared-memory buffer — failing thousands of times per second with
// the impossible `access(...) /tmp: No such process` (ESRCH = seccomp denial).
// With no buffer, the <webview> page viewer / PDF preview / wolffish-media files
// can't composite → BLANK, while the main window (already painted) looks fine.
// In dev the `--no-sandbox` command-line flag tears down seccomp too, which is
// why dev renders; macOS/Windows have no seccomp layer. Disabling the seccomp + GPU sandbox layers
// here matches the --no-sandbox intent (fully unsandboxed) and lets the guests
// get their shared memory. No effect on the sudo/no_new_privs behavior above.
app.commandLine.appendSwitch('disable-seccomp-filter-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
// --no-zygote: child processes are exec'd fresh (each inheriting the current
// command line incl. --no-sandbox) instead of forked from a zygote that may
// have committed to a sandbox before appendSwitch() ran in this main module.
// Belt-and-suspenders for the same blank-guest issue.
app.commandLine.appendSwitch('no-zygote')

// Single-instance guard: if Wolffish is already running (even collapsed to
// tray), focus the existing window instead of showing a lockfile error.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  restoreMainWindow()
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wolffish-media',
    privileges: { bypassCSP: true, supportFetchAPI: true, stream: true }
  }
])

export type ThemeSource = 'system' | 'light' | 'dark'
export type Locale = 'en' | 'ar'

export type ThemeState = {
  themeSource: ThemeSource
  shouldUseDarkColors: boolean
}

let lockAcquired = false
let isShuttingDown = false

const thalamus = new Thalamus()
const agent = new Agent({
  thalamus,
  workspaceRoot: workspaceRoot()
})

// Channels are the user-facing surfaces wfc speaks through — the Electron
// renderer, the terminal and the paired phone. They share
// one TurnRunner, which serializes turns PER CONVERSATION (one ordered
// transcript each) while conversations — across channels and within the
// renderer — run concurrently. Amygdala's approval bridge dispatches to
// the sink of the turn that asked, resolved through the turn-identity
// AsyncLocalStorage via the singleton turnRouter.
const turnRunner = new TurnRunner(agent)
// Every turn's lifecycle (any channel) is broadcast so the renderer's
// Conversations sidebar can show live status chips for in-app, terminal and
// phone runs alike.
turnRunner.setLifecycleListener((ev) => {
  broadcast('chat:turnState', ev)
  // The phone is a second view of this app, not a channel being relayed to:
  // a turn started anywhere — in-app, the terminal, the phone itself —
  // has to show up there as it happens, exactly as it does in the sidebar.
  pushTurnToMobile(ev)
})
// Autonomous heartbeat/procedure runs never pass through the TurnRunner —
// they end inside Agent.processAutonomous. Broadcast their terminal lifecycle
// through the SAME chat:turnState event, so their sealed conversations get
// the fresh success/danger chip tint in the rail exactly like a channel run.
agent.setAutonomousLifecycleListener((ev) => {
  broadcast('chat:turnState', ev)
  pushTurnToMobile(ev)
})
// Relay conversation deletions to the renderer so the sidebar prunes its live
// run-status — a channel-side /delete never touches the renderer otherwise.
agent.corpus.on('conversation.deleted', ({ id }) => broadcast('conversation:deleted', { id }))
// Relay conversation (re)index/remove so the rail + History refresh for every
// create/rename/delete path — including the ones that emit no turn lifecycle
// at all (renames, imports, rebuilds). Fires after the cortex row is
// committed.
//
// The phone rides the same signal, and for it this one is LOAD-BEARING: it is
// the only push that always fires AFTER a conversation file hits disk. The
// turn lifecycle's own metadata push cannot promise that — `done` is emitted
// before the sink's persist resolves, and an in-app turn is saved by the
// renderer moments after that — so the metadata it carries can describe the
// PRE-turn file. The phone then fetches a transcript without the answer it
// just watched, stamps it current, and with no later signal sits stale until
// the conversation is reopened. This push carries the post-save updatedAt,
// which is exactly what flips the phone's staleness check and triggers its
// refetch.
agent.corpus.on('conversation.indexed', ({ rel }) => {
  broadcast('conversation:changed', {})
  // hasPeer-gated: this fires on every conversation save forever, and the
  // push starts with a file read — I/O nobody should pay with no phone
  // listening.
  if (!mobileChannel.hasPeer) return
  const id = idFromFilename(rel.split('/').pop() ?? '')
  if (id) void pushConversationToMobile(id)
})
// Full rebuilds + the startup catch-up index via indexWalkedSync directly, so
// no conversation.indexed fires while they run — a list fetched mid-rebuild
// can be partial (see the getReindexStatus guard in conversation:list). Push
// one list-changed when the pass ends so every surface reconciles.
agent.corpus.on('index.reindexed', () => broadcast('conversation:changed', {}))
const electronChannel = new ElectronChannel(agent, turnRunner)

/**
 * The phone is a second view of this app, not a chat channel: it renders the
 * conversation list, most settings and usage, so the channel serves a config
 * snapshot and a metadata index rather than a message stream. Everything it
 * pushes below keeps that view live without the phone polling.
 */
/** Assigned once the settings IPC scope defines it; see below. */
let mobileSerializeCapabilities: () => Promise<
  Array<{
    name: string
    description: string
    enabled: boolean
    official: boolean
    core: boolean
    hasPlugin: boolean
    toolCount: number
    requires: string[]
  }>
> = async () => []

/**
 * Assigned in the same scope. Throwing is the honest default: a toggle
 * silently dropped would answer the phone with success and revert later,
 * which is worse than an RPC error it can act on. Unreachable in practice —
 * the tunnel only starts after the settings scope has run.
 */
let mobileSetCapabilityEnabled: (name: string, enabled: boolean) => Promise<boolean> = async () => {
  throw new Error('capability toggle not ready')
}

/**
 * What an in-app config reads as when the workspace has never written one —
 * the shape `inapp:configChange` carries, so a listener never has to guess at
 * undefined. Mirrors EMPTY_INAPP_CONFIG in workspace.ts.
 */
const EMPTY_INAPP: InAppConfig = { verbose: false, reasoning: false }

/**
 * The phone edited a setting. Every key maps onto the exact setter
 * the desktop's own panel calls — same persistence, same cache resets — so a
 * change is live for the agent immediately, no matter which screen made it.
 *
 * A whitelist, deliberately: the phone names flat keys from its own config
 * surface, and anything unlisted throws — the phone treats the error as a
 * refusal and refetches the snapshot, so an out-of-date app can never write
 * somewhere unexpected. One absence is deliberate: the extension PORT
 * (moving it restarts the local pairing server, which is the desktop's own
 * act).
 */
async function applyMobileSettings(settings: Record<string, unknown>): Promise<void> {
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''))
  const int = (value: unknown): number | null => {
    const n = Math.round(Number(value))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const applied: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    switch (key) {
      case 'braveEnabled':
      case 'braveApiKey':
        // Web search is provided by the organization — one key behind the
        // API's /v1/search lane — so there is nothing on this device to edit.
        // The phone treats the refusal like any other and refetches.
        throw new Error('Brave Search is managed by your organization')
      case 'sttModel':
        await persistSttConfig({ defaultModel: str(value) })
        break
      case 'sttLanguage':
        await persistSttConfig({ language: str(value) })
        break
      case 'ttsVoice':
        await persistTtsConfig({ defaultVoice: str(value) })
        break
      case 'ttsSpeed':
        await persistTtsConfig({ defaultSpeed: str(value) })
        break
      case 'ttsVoiceReplies':
        // A model directive like videoDirector — persisting it is the whole
        // job; the next turn's <voice_prompts> block and runtime notice pick
        // it up.
        await persistTtsConfig({ voiceReplies: value === true })
        break
      // No computer-use screenshotMaxWidth/screenshotFormat cases: the agent
      // sets those per capture now, so a phone write to them is a stale
      // client and falls through to the throw below — which is how this
      // switch is meant to reject one (the phone re-pulls the snapshot).
      case 'browserScreenshotMaxWidth': {
        const width = int(value)
        if (width) await persistBrowserExtensionConfig({ screenshotMaxWidth: width })
        break
      }
      case 'browserScreenshotFormat':
        await persistBrowserExtensionConfig({ screenshotFormat: value === 'png' ? 'png' : 'jpeg' })
        break
      case 'browserScreenshotQuality': {
        const quality = int(value)
        if (quality) {
          await persistBrowserExtensionConfig({ screenshotQuality: Math.min(100, quality) })
        }
        break
      }
      // Customization — the three hand-written documents behind the desktop's
      // Soul, User and Agents pages. Written through writeViewerFile, which is
      // the exact call those pages' Save button makes, so a save from the phone
      // and a save from here are one act with one atomic write.
      case 'soulMarkdown':
      case 'userMarkdown':
      case 'agentsMarkdown': {
        const doc = key.slice(0, -'Markdown'.length) as CustomizationDoc
        const text = str(value)
        // The phone enforces the same ceiling before sending; this is the side
        // that owns the file, so it refuses rather than trusting the sender.
        // Throwing IS the answer — the phone treats a rejected configSet as a
        // refusal, refetches the snapshot and puts the document back.
        if (Buffer.byteLength(text, 'utf8') > CUSTOMIZATION_MAX_BYTES) {
          throw new Error(`${CUSTOMIZATION_DOCS[doc]} is too large to write from the phone`)
        }
        await writeViewerFile(CUSTOMIZATION_DOCS[doc], text)
        // Same announcement this app's own editor makes below, so an open
        // Soul/User/Agents page adopts the phone's save live.
        broadcast('customization:changed', { doc, path: CUSTOMIZATION_DOCS[doc] })
        break
      }
      // Preferences — mirroring the runtime:* IPC handlers exactly: persist,
      // then update the live runtime the same way a click in the panel does.
      case 'bypassPermissions':
        await persistBypassPermissions(value === true)
        agent.amygdala.setBypassPermissions(value === true)
        break
      case 'blockCredentials':
        await persistBlockCredentials(value === true)
        turnRunner.setBlockCredentials(value === true)
        break
      case 'weekStartsOn':
        // 0 (Sunday) or 1 (Monday) — the same two values the panel's own
        // segmented control can send `runtime:setWeekStartsOn`.
        if (value !== 0 && value !== 1) {
          throw new Error(`"${String(value)}" is not a week start`)
        }
        await persistWeekStartsOn(value)
        break
      // The Model screen and the composer's control cluster. Each key maps
      // onto the exact handler its own desktop control calls —
      // `provider:setMode`, `runtime:setThinkingMode`, `model:select` —
      // same persistence, same live
      // runtime update, same announcement, so a pick on either screen is the
      // same act.
      case 'chatMode': {
        const mode = value === 'workflow' ? 'workflow' : 'single'
        await persistMode(mode)
        agent.setMode(mode)
        broadcast('provider:updated', { id: null })
        break
      }
      case 'thinkingMode': {
        const mode = str(value)
        if (!THINKING_MODES.has(mode)) throw new Error(`"${mode}" is not a thinking mode`)
        // Stored per model, exactly as the desktop's brain button stores it.
        // The snapshot serves the current Brain's entry, so the Brain is the
        // model this phone-side chip names — no Brain, nothing to hold it.
        const model = str((await readConfig())?.llm.model)
        if (!model) throw new Error('no selected model to hold a thinking mode')
        await persistThinkingMode(model, mode)
        broadcast('preferences:changed', { thinkingMode: { model, mode } })
        break
      }
      case 'brainModel': {
        // The phone's model pick, from the catalog this desktop sent it in the
        // snapshot — so a model that catalog does not list is refused here
        // rather than persisted for the API to reject on every turn (see
        // modelSelectable; an unfetched catalog still allows anything).
        const id = str(value)
        if (!modelSelectable(id)) {
          throw new Error(`"${id}" is not a model your organization offers`)
        }
        const updated = await persistModel(id)
        thalamus.setModel(updated.llm.model)
        broadcast('provider:updated', { id: 'cloud' })
        break
      }
      case 'mcpServers': {
        // The MCP screen's switches, as one name→enabled map — the snapshot
        // lists servers by display name and ids stay desktop-side, so the
        // name resolution here mirrors the snapshot's exactly. Applied as a
        // diff through the manager (the path `mcp:setEnabled` takes), which
        // owns lifecycle, persistence and the status broadcast.
        const map = (value ?? {}) as Record<string, unknown>
        const servers = (await readConfig())?.mcp?.servers ?? []
        for (const server of servers) {
          const name =
            typeof server.name === 'string'
              ? server.name
              : typeof server.slug === 'string'
                ? server.slug
                : 'server'
          const wanted = map[name]
          if (typeof wanted !== 'boolean' || wanted === (server.enabled !== false)) continue
          const result = await mcpManager.setEnabled(server.id, wanted)
          if (!result.ok) throw new Error(result.error ?? `could not switch "${name}"`)
        }
        break
      }
      // The compaction schedule — persist and reschedule exactly as
      // `runtime:setCompactionConfig` does. Reflection's settings ride their
      // own RPC (applyReflectionConfig below); these three are the phone's
      // only Knowledge keys on the generic path.
      case 'compactionDailyHour':
      case 'compactionWeeklyHour': {
        const hour = Math.round(Number(value))
        if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
          throw new Error(`"${String(value)}" is not an hour`)
        }
        const patch = key === 'compactionDailyHour' ? { dailyHour: hour } : { weeklyHour: hour }
        const updated = await persistCompactionConfig(patch)
        agent.brainstem.setCompactionConfig(updated.compaction!)
        break
      }
      case 'compactionWeeklyDay': {
        const day = Math.round(Number(value))
        if (!Number.isFinite(day) || day < 0 || day > 6) {
          throw new Error(`"${String(value)}" is not a weekday`)
        }
        const updated = await persistCompactionConfig({ weeklyDay: day })
        agent.brainstem.setCompactionConfig(updated.compaction!)
        break
      }
      // The phone's own two channel settings, edited from the phone. Routed
      // through the channel's setters rather than the config writer, because
      // each does more than persist: notifications registers or withdraws the
      // model's notify_phone tool, and both emit the status the desktop's
      // Mobile panel is listening to — so a flip made on the phone moves that
      // panel's segmented control in the same breath.
      case 'mobileNotifications':
        await mobileChannel.setNotificationsEnabled(value === true)
        break
      case 'mobileVerbose':
        await mobileChannel.setVerbose(value === true)
        break
      // The in-app feed preference — persist and announce exactly as
      // `inapp:setConfig` does, window push included, so an open desktop
      // chat adopts the phone's flip without a refetch. It drives the
      // phone's own chat feed too; the preference is the workspace's.
      case 'inappVerbose':
      case 'inappReasoning': {
        const patch: Partial<InAppConfig> =
          key === 'inappVerbose' ? { verbose: value === true } : { reasoning: value === true }
        const updated = await persistInAppConfig(patch)
        broadcast('inapp:configChange', updated.inapp ?? EMPTY_INAPP)
        break
      }
      default:
        throw new Error(`"${key}" is not editable from the phone`)
    }
    applied.push(key)
  }
  // One broadcast for the lot: the renderer hears it like any settings save,
  // and the broadcast hook's config.changed push is the phone's confirmation.
  // The applied values ride along so a listening panel can seed its controls
  // straight from the payload instead of refetching first.
  if (applied.length) broadcast('settings:mobileChange', { keys: applied, settings })
  // Plus the per-service announcements the service panels re-seed from — the
  // same channel their own desktop-side saves fire, so a panel cannot tell
  // (and needn't care) which device made the change.
  for (const service of new Set(applied.map((key) => MOBILE_KEY_SERVICE[key]))) {
    if (service) broadcast('services:changed', { service })
  }
}

/**
 * Which customization document a workspace-relative path names, or null for
 * every other file. Windows separators and a leading `./` are normalized away
 * because the caller is a UI path, not a canonical one — the same tolerance
 * resolveScoped applies before touching disk.
 */
function customizationDocFor(relativePath: string): CustomizationDoc | null {
  const normalized = String(relativePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
  return (
    (Object.keys(CUSTOMIZATION_DOCS) as CustomizationDoc[]).find(
      (doc) => CUSTOMIZATION_DOCS[doc] === normalized
    ) ?? null
  )
}

/** Which service panel each phone-editable key belongs to, for re-seeding. */
const MOBILE_KEY_SERVICE: Record<string, string | undefined> = {
  sttModel: 'stt',
  sttLanguage: 'stt',
  ttsVoice: 'tts',
  ttsSpeed: 'tts',
  ttsVoiceReplies: 'tts',
  browserScreenshotMaxWidth: 'browserExtension',
  browserScreenshotFormat: 'browserExtension',
  browserScreenshotQuality: 'browserExtension'
}

/**
 * Persist a reflection patch and fan the change out — one path however the
 * change arrives (settings IPC or the phone's tunnel RPC). The renderer
 * broadcast keeps an open ReflectionPanel current, and doubles (via the
 * generic hook in broadcast()) as the config.changed push that tells the
 * phone to refresh.
 */
async function applyReflectionPatch(
  patch: import('@main/workspace/workspace').ReflectionPatch
): Promise<import('@main/workspace/workspace').ReflectionConfig> {
  const updated = await persistReflectionConfig(patch)
  const cfg = normalizeReflectionConfig(updated.reflection)
  agent.brainstem.setReflectionConfig(cfg)
  broadcast('reflection:changed', {})
  return cfg
}

/**
 * The desktop's socket to the org bridge — started and stopped with the
 * cloud session below (a socket needs a token, and a signed-out machine has
 * no phone to talk to). The channel registers its handlers on it.
 */
const mobileBridge = new BridgeClient({
  identity: { name: os.hostname(), platform: process.platform, appVersion: app.getVersion() },
  log: (line) => wlog.info('mobile', line),
  debug: (line) => wlog.debug('mobile', line)
})

const mobileChannel = new MobileChannel({
  agent,
  runner: turnRunner,
  bridge: mobileBridge,
  // Pairing and the paired-phone list are the org's: an offer is minted
  // there, the phone claims it there, and revoking a phone's sessions there
  // is what unpairing means.
  pairing: {
    offer: async () => {
      const wire = await cloudSession.withAccessToken((token) => offerPairing(token))
      return {
        id: wire.id,
        code: wire.code,
        qr: wire.qr,
        expiresAt: Date.parse(wire.expires_at) || Date.now() + 180_000
      }
    },
    status: (id) => cloudSession.withAccessToken((token) => pairingStatus(token, id)),
    withdraw: (id) => cloudSession.withAccessToken((token) => withdrawPairing(token, id))
  },
  devices: {
    list: () => cloudSession.withAccessToken((token) => listDevices(token)),
    revoke: (id) => cloudSession.withAccessToken((token) => revokeDevice(token, id))
  },
  // Files the phone uploaded straight to the org, materialized here on
  // demand — and the diagnostic archive going the other way.
  hydrateBlob: (rel, sha) => hydrateBlob(rel, sha),
  uploadWorkspaceFile: (rel, mime) => ensureFileUploaded(rel, mime),
  serializeCapabilities: () => mobileSerializeCapabilities(),
  // The phone's reflection controls write through to the same config the
  // settings panel edits; run-now rides the same brainstem queue.
  applyReflectionConfig: async (patch) => applyReflectionPatch(patch),
  runReflectionJob: async (kind) =>
    kind === 'deepClean' ? agent.brainstem.runDeepCleanNow() : agent.brainstem.runReflectionNow(),
  // The phone's capability toggle takes the exact same path as a click in
  // this app's own settings panel — write, guards, broadcast and all.
  applyCapability: (name, enabled) => mobileSetCapabilityEnabled(name, enabled),
  applySettings: (settings) => applyMobileSettings(settings),
  // Variables from the phone persist through the same save the panel's IPC
  // uses, renderer broadcast included — one path, whoever wrote.
  applyVariables: (variables) => saveVariablesEverywhere(variables),
  // No range filter: the phone aggregates the whole ledger locally, exactly
  // as the desktop Usage panel does. agent.usage folds the same per-line
  // cache the panel reads, so the two screens can never disagree.
  usageDays: () => agent.usage.getDays(),
  // The org's web-search lane, for the phone's Brave card: on = the org has
  // the lane switched on and a key set; there is no key to edit anywhere.
  searchLane: () => braveService.getStatus(),
  dataAnalytics: () => getDataAnalytics(),
  projects: () => listProjects(),
  compactionRuns: () => agent.brainstem.getCompactionRuns(),
  // What the OS has ACTUALLY registered, not the stored intent — the two
  // disagree whenever a registration failed, which on Linux used to be always.
  launchAtStartupActive: async () => (await readAutostartStatus()).active,
  // Deliberately lazy: extensionServer is constructed a few statements below,
  // and this closure only runs once a phone asks for a snapshot.
  extensionStatus: async () => extensionServer.getStatus(),
  // The model's notify_phone gate, persisted with the rest of the workspace
  // config so "off" survives restarts.
  loadNotificationsEnabled: async () => (await getMobileChannelConfig()).notifications !== false,
  saveNotificationsEnabled: async (enabled) => {
    await persistMobileChannelConfig({ notifications: enabled })
  },
  // The phone's feed preference, persisted beside it. Both keys ride the
  // config snapshot to the phone and come back through applyMobileSettings,
  // so the two devices edit one value rather than two drifting copies.
  loadVerbose: async () => (await getMobileChannelConfig()).verbose === true,
  saveVerbose: async (verbose) => {
    await persistMobileChannelConfig({ verbose })
  },
  onStatus: (status) => broadcast('mobile:statusChange', status),
  // A project re-file made on the phone is a write to this app's own
  // conversation file, so the rail, History and the Projects page re-read on
  // the very signal a re-file made here fires.
  onConversationChanged: (id) => broadcast('conversation:changed', { id }),
  // Connection logging is unconditional — a link that will not form is
  // exactly when the record is needed, and it lands in the workspace log
  // beside every other channel's, rotated per day like the rest.
  log: (line) => wlog.info('mobile', line),
  // The same file, one level down: served RPCs, pushes, per-frame counters.
  // `grep -v DEBUG` on the day's log gives back the ordinary story.
  debug: (line) => wlog.debug('mobile', line)
})
// Live-mirror in-flight channel turns into the in-app view: a terminal or phone
// run streams throttled assistant-message snapshots to the renderer so an open
// conversation reflects it AS IT HAPPENS, instead of the whole transcript
// appearing at once only after the end-of-turn disk save. The snapshot's stable
// id matches the message the same turn later persists, so the renderer upserts
// by id (never a duplicate). Payload-targeted (unlike the id-less
// conversation:changed) so the renderer only touches the named conversation.
const mirrorMessageToRenderer = (
  conversationId: string,
  message: ConversationMessage | null,
  userMessage?: ConversationMessage
): void => {
  // Best-effort UI mirror. The channel invokes this from inside the turn's
  // render chain (which also drives the outbound bot sends + the persist), so
  // a throw here — e.g. webContents.send on a window torn down mid-send — must
  // never propagate back and wedge the turn. Same contract as the turn
  // lifecycle listener.
  try {
    // The renderer reads its prompt off disk (channel turns persist the user
    // message before running), so only the assistant half concerns it, and a
    // prompt-only tick has nothing for it at all.
    if (message) broadcast('conversation:messageMirror', { conversationId, message })
  } catch {
    // a broken renderer bridge must never affect the channel turn
  }
  try {
    // The phone gets the same in-flight snapshot the renderer does, so a
    // terminal run is visible there while it is still writing —
    // as the FULL message (prose + segments, stable id), which the phone
    // upserts into its cached body. Upsert, not refetch-per-tick: the
    // payload IS the state, so tool and task cards render mid-turn and the
    // end-of-turn save replaces the snapshot under the same id.
    //
    // The prompt rides along. It IS on disk for a channel turn, but the phone
    // deliberately does not re-read the body mid-turn, so without this the
    // message being answered is invisible there until the turn ends.
    mobileChannel.pushMessageAppended(conversationId, message ?? undefined, userMessage)
  } catch {
    // and neither must a broken tunnel
  }
}

/**
 * Turn lifecycle → the phone. `started` lets it show the conversation as
 * running; the terminal phases tell it the stored body is now behind, which
 * is what makes a run started elsewhere land on the phone without the user
 * doing anything.
 *
 * The metadata rides EVERY phase, `started` included: an autonomous run saves
 * its conversation shell before its lifecycle fires (that ordering is what
 * puts it in this app's own rail the moment it starts), and channel turns
 * persist their prompt the same way — so the phone's list can show the real
 * title, icon and origin from the first instant instead of synthesizing a row
 * from the live turn until the run ends. A conversation with no file yet (an
 * in-app first message, saved when the turn folds) simply pushes nothing.
 */
function pushTurnToMobile(ev: {
  phase: string
  conversationId: string | null
  channel?: string
}): void {
  if (!ev.conversationId) return
  try {
    mobileChannel.pushTurnStatus(ev.conversationId, ev.phase, ev.channel ?? null)
    void pushConversationToMobile(ev.conversationId)
  } catch {
    // never let a dead tunnel disturb a turn
  }
}
// Automations and procedures mirror the same way. Their conversation is
// created and saved BEFORE the run starts, so it can be opened while it works
// — and this is what makes that feed fill in live instead of sitting on the
// prompt until the run ends.
agent.setAutonomousMessageMirror(mirrorMessageToRenderer)
// Phone-run turns mirror INTO the renderer — the last quarter of the mirror
// matrix, and the one that was missing: a turn started on the phone streamed
// to the phone alone, so the desktop's own window showed a thinking shimmer
// over a blank conversation for the whole run and the transcript landed all
// at once at the end-of-turn save. Renderer half only — the phone half is the
// mobile channel's own sink, and routing through mirrorMessageToRenderer
// would push every snapshot to the phone twice.
mobileChannel.setMessageMirror((conversationId, message) => {
  try {
    if (message) broadcast('conversation:messageMirror', { conversationId, message })
  } catch {
    // a broken renderer bridge must never affect the phone's turn
  }
})
// In-app turns mirror the OTHER way: their renderer already streams
// (chat:segment), so the snapshot goes only to the paired phone — as a FULL
// message (prose + segments, stable id) the phone upserts into its cached
// body. That is what makes a desktop-chat run, its task cards included,
// appear on the phone while it is still writing instead of all at once at
// the end-of-turn save. Text rides the same payload, so no message.delta
// bubble is emitted for these turns — one rendering path, no duplicates.
electronChannel.setMessageMirror((conversationId, message, userMessage) => {
  try {
    // `message` is null on the prompt-only tick this channel emits at send,
    // which reaches the phone as a nudge carrying the user message — the one
    // copy of an in-app prompt that exists anywhere but the renderer's feed
    // until the turn folds to disk.
    mobileChannel.pushMessageAppended(conversationId, message ?? undefined, userMessage)
  } catch {
    // a broken tunnel must never affect the in-app turn
  }
})
const extensionServer = new ExtensionServer()

// MCP server connections. Each connected server registers an in-process
// cerebellum capability (`mcp-<slug>`), so its tools reach the Brain and
// workflow agents through the exact same per-turn selection path as
// every other capability — connect/disconnect just adds/removes the
// registration. All lifecycle noise stays inside the manager.
const mcpManager = new McpManager({
  register: (capability, plugin) =>
    agent.cerebellum.registerInProcessCapability(capability, plugin),
  unregister: (name) => agent.cerebellum.unregisterInProcessCapability(name),
  openExternal: (url) => void shell.openExternal(url),
  appVersion: app.getVersion(),
  onStatusChange: (snapshots) => broadcast('mcp:statusChange', snapshots),
  takenCapabilityNames: () => new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
})

agent.amygdala.setApprovalBridge((req) => turnRouter.dispatchApproval(req))
agent.cerebellum.setAskBridge((req) => turnRouter.dispatchAskUser(req))
// Wire the agent-management bridge the `workflow` capability's plugin
// receives in its init context. It forwards to the Agent's active workflow
// session — the single source of truth for a turn's live subagents.
agent.cerebellum.setWorkflowHost(agent.workflowHost())
// Wire the MCP-management bridge the `mcp` capability's plugin receives in its
// init context. It forwards to the McpManager — the exact same methods the
// Settings → MCP IPC handlers call — so an agent-driven add/test/remove
// reflects in the UI (via mcp:statusChange) exactly like a manual one.
agent.cerebellum.setMcpHost({
  list: () => mcpManager.snapshot(),
  add: (input) => mcpManager.add(input),
  test: (id) => mcpManager.test(id),
  remove: (id) => mcpManager.remove(id),
  setEnabled: (id, enabled) => mcpManager.setEnabled(id, enabled),
  authorize: (id) => mcpManager.authorize(id)
})
// Wire the retrieval bridge the `introspect` capability's plugin receives in
// its init context. It queries the SAME cortex index the ambient context
// assembly reads, so memory_search / conversation_list / usage_report and the
// prompt's memory section can never disagree about what wfc knows.
agent.cerebellum.setCortexHost({
  searchRecords: (query, opts) => agent.cortex.searchRecords(query, opts),
  getRecordsByRef: (refPrefix, limit) => agent.cortex.getRecordsByRef(refPrefix, limit),
  recordsByDate: (date, sources, limit) => agent.cortex.recordsByDate(date, sources, limit),
  listConversations: (opts) => agent.cortex.listConversations(opts),
  usageSummary: (opts) => agent.cortex.usageSummary(opts),
  searchArtifacts: (opts) => agent.cortex.searchArtifacts(opts),
  coverage: () => agent.cortex.coverage(),
  saveKnowledge: async (file, fact, topic) => {
    // Exact-line dedup here: promoteToKnowledge is append-only by design, so
    // the bridge is where "don't save what's already saved" lives.
    const trimmed = fact.trim()
    const filed = Boolean(topic?.trim())
    if (!trimmed) return { ok: false, deduped: false, filed }
    const line = trimmed.startsWith('-') ? trimmed : `- ${trimmed}`
    let newTopic = filed
    try {
      const { readFile } = await import('node:fs/promises')
      const p = join(workspaceRoot(), 'brain', 'hippocampus', 'knowledge', `${file}.md`)
      const existing = await readFile(p, 'utf8').catch(() => '')
      if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
        return { ok: true, deduped: true, filed }
      }
      if (filed) {
        const heading = `## ${topic?.trim()}`.toLowerCase()
        newTopic = !existing.split(/\r?\n/).some((l) => l.trim().toLowerCase() === heading)
      }
    } catch {
      // a failed dedup probe must not block the save
    }
    await agent.hippocampus.promoteToKnowledge(file, trimmed, topic)
    // A note filed under a topic that didn't exist yet ADDS a `##` heading, and
    // the memory map (which carries only headings) is cached per calendar day —
    // without this the new topic would stay invisible until midnight. Filing
    // into an existing topic changes no heading, so it costs no cache break.
    if (newTopic) agent.prefrontal.invalidateMemoryMap()
    return { ok: true, deduped: false, filed }
  }
})
// Wire the amend surface the `knowledge` capability's plugin receives. The
// store owns the allowlist, the structure invariants and the .bak safety net;
// this bridge only validates the target name (a plugin arg is untrusted input)
// and hands the memory map a targeted invalidation when topics change.
const knowledgeStore = new KnowledgeStore({
  workspaceRoot: workspaceRoot(),
  corpus: agent.corpus,
  onKnowledgeTopicsChanged: () => agent.prefrontal.invalidateMemoryMap()
})
{
  const badTarget = (target: string): { ok: false; error: string } => ({
    ok: false,
    error: `Unknown target "${target}" — pick one of: ${KNOWLEDGE_TARGETS.join(', ')}.`
  })
  agent.cerebellum.setKnowledgeHost({
    targets: () => [...KNOWLEDGE_TARGETS],
    list: () => knowledgeStore.list(),
    read: async (target) => {
      if (!isKnowledgeTarget(target)) return badTarget(target)
      const { rel, content } = await knowledgeStore.read(target)
      return { ok: true as const, rel, content }
    },
    add: async (target, entry, opts) =>
      isKnowledgeTarget(target)
        ? knowledgeStore.add(target, entry, {
            section: opts.section,
            source: opts.source as EntrySource | undefined
          })
        : badTarget(target),
    edit: async (target, find, replace) =>
      isKnowledgeTarget(target) ? knowledgeStore.edit(target, find, replace) : badTarget(target),
    forget: async (target, find) =>
      isKnowledgeTarget(target) ? knowledgeStore.forget(target, find) : badTarget(target),
    rewrite: async (target, content) =>
      isKnowledgeTarget(target) ? knowledgeStore.rewrite(target, content) : badTarget(target),
    restore: async (target) =>
      isKnowledgeTarget(target) ? knowledgeStore.restore(target) : badTarget(target)
  })
}
// Feed live channel connectivity to the introspect capability so the agent can
// check which channels are reachable (via `channel_status` / `wolffish_status`)
// and tell the user how to reconnect a disconnected one.
agent.cerebellum.setChannelStatusProvider(() =>
  collectChannelStatus({ mobile: () => mobileChannel.getStatus() })
)
// Rolling prefix summarizer: fires after conversation persistence (channel
// post-turn saves + the conversation:save IPC). The onUpdated push tells the
// renderer to fold {summary, mark} into its in-memory conversation so its
// next whole-file save preserves rather than clobbers the summary.
configureSummarizer({
  thalamus: agent.thalamus,
  onUpdated: (update) => broadcast('conversation:summaryUpdated', update)
})

function currentThemeState(): ThemeState {
  return {
    themeSource: nativeTheme.themeSource as ThemeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  }
}

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f0f4f8'
}

let tray: Tray | null = null

// --- Custom Windows tray popup menu -----------------------------------------
// Native Win32 tray context menus are sized by the OS, so Electron can't make
// them bigger. On Windows we instead draw our own menu in a small frameless,
// transparent popup window (see src/preload/trayMenu.ts) scaled ~30% larger.
// The window size is fixed to that popup's CSS: a 244px card plus a 14px
// transparent margin on every side for the drop shadow.
const TRAY_POPUP_WIDTH = 272
const TRAY_POPUP_HEIGHT = 136

let trayPopup: BrowserWindow | null = null
let trayPopupShownAt = 0
let trayMenuLocale: Locale = 'en'

// The main app window — never the tray popup. Adding the popup means a bare
// `getAllWindows()[0]` could grab the wrong window, so restore/show paths use
// this helper instead.
function mainBrowserWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => w !== trayPopup && !w.isDestroyed()) ?? null
}

function restoreMainWindow(): void {
  const win = mainBrowserWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    showDock()
  } else {
    createWindow()
    showDock()
  }
}

function buildTrayPopup(): BrowserWindow {
  const popup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/trayMenu.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  popup.setMenu(null)
  // Dismiss on click-away. Ignore the blur that can fire as the window first
  // takes focus, otherwise it would hide itself the instant it opens.
  popup.on('blur', () => {
    if (Date.now() - trayPopupShownAt > 120) popup.hide()
  })
  void popup.loadURL(
    'data:text/html;charset=UTF-8,' +
      encodeURIComponent(
        '<!doctype html><html><head><meta charset="utf-8"><title>Wolffish Cloud</title></head><body></body></html>'
      )
  )
  return popup
}

function showTrayPopup(bounds: Electron.Rectangle): void {
  const popup = trayPopup ?? (trayPopup = buildTrayPopup())
  const state = { locale: trayMenuLocale, dark: nativeTheme.shouldUseDarkColors }

  const area = screen.getDisplayMatching(bounds).workArea
  // Anchor to the tray icon: right-aligned, opening upward from a bottom
  // taskbar (downward if the tray sits in the top half of the screen).
  let x = Math.round(bounds.x + bounds.width - TRAY_POPUP_WIDTH)
  const openUp = bounds.y + bounds.height / 2 > area.y + area.height / 2
  let y = openUp ? Math.round(bounds.y - TRAY_POPUP_HEIGHT) : Math.round(bounds.y + bounds.height)
  x = Math.min(Math.max(x, area.x), area.x + area.width - TRAY_POPUP_WIDTH)
  y = Math.min(Math.max(y, area.y), area.y + area.height - TRAY_POPUP_HEIGHT)
  popup.setBounds({ x, y, width: TRAY_POPUP_WIDTH, height: TRAY_POPUP_HEIGHT })

  const sendState = (): void => popup.webContents.send('tray-menu:render', state)
  if (popup.webContents.isLoading()) popup.webContents.once('did-finish-load', sendState)
  else sendState()

  trayPopupShownAt = Date.now()
  popup.show()
  popup.focus()
}

// The tray artwork (icon_transparent.png) sits on a large transparent canvas —
// the fish fills only ~79% of the width and ~65% of the height — so at tray
// size it rendered noticeably smaller than neighboring app icons. Trim to the
// opaque content and pad back out to a centered square so Windows draws the
// logo edge-to-edge like other apps, without distorting its aspect ratio.
function trayIconImage(size: number): Electron.NativeImage {
  const source = nativeImage.createFromPath(trayIconDefault)
  const { width, height } = source.getSize()
  const bitmap = source.toBitmap() // BGRA, 4 bytes per pixel; we only read alpha
  const ALPHA = 16
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] > ALPHA) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  let cropped = source
  if (maxX >= minX && maxY >= minY) {
    // Square holding the content + a little breathing room so the outline
    // isn't clipped, centered on the content's midpoint and clamped to canvas.
    const side = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.03)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const x = Math.max(0, Math.min(Math.round(cx - side / 2), width - side))
    const y = Math.max(0, Math.min(Math.round(cy - side / 2), height - side))
    const clamped = Math.min(side, width - x, height - y)
    cropped = source.crop({ x, y, width: clamped, height: clamped })
  }
  return cropped.resize({ width: size, height: size })
}

function createTray(locale: Locale = 'en'): void {
  if (tray) return
  const isAr = locale === 'ar'
  trayMenuLocale = locale
  let img: Electron.NativeImage
  if (process.platform === 'darwin') {
    // Unified with Windows/Linux: show the transparent colored logo (not the white template),
    // keeping the existing 22pt menu-bar size (22x22 @1x, 44x44 @2x for retina).
    const base = nativeImage.createFromPath(trayIconDefault)
    img = nativeImage.createEmpty()
    img.addRepresentation({
      scaleFactor: 1,
      width: 22,
      height: 22,
      buffer: base.resize({ width: 22, height: 22 }).toPNG()
    })
    img.addRepresentation({
      scaleFactor: 2,
      width: 44,
      height: 44,
      buffer: base.resize({ width: 44, height: 44 }).toPNG()
    })
  } else {
    img = trayIconImage(32)
  }
  tray = new Tray(img)
  tray.setToolTip('Wolffish Cloud')

  if (process.platform === 'win32') {
    // Windows: open the custom, larger popup on right-click instead of the
    // un-resizable native menu. Left/double click still restore the window.
    ipcMain.on('tray-menu:action', (_event, action: 'show' | 'quit') => {
      trayPopup?.hide()
      if (action === 'quit') {
        isQuittingFromTray = true
        app.quit()
      } else {
        restoreMainWindow()
      }
    })
    ipcMain.on('tray-menu:close', () => trayPopup?.hide())
    tray.on('right-click', (_event, bounds) => showTrayPopup(bounds))
  } else {
    // macOS/Linux keep the OS-native context menu (on macOS it also handles
    // left-click).
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isAr ? 'إظهار وولفيش' : 'Show Wolffish',
        click: () => restoreMainWindow()
      },
      { type: 'separator' },
      {
        label: isAr ? 'إغلاق' : 'Quit',
        click: () => {
          isQuittingFromTray = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
  }

  // On Windows/Linux a single left-click restores the window (standard tray
  // behavior); macOS routes clicks through the context menu above.
  if (process.platform !== 'darwin') {
    tray.on('click', restoreMainWindow)
  }
  tray.on('double-click', restoreMainWindow)
}

function showDock(): void {
  if (process.platform !== 'darwin') return
  void app.dock?.show().then(() => {
    if (is.dev) app.dock?.setIcon(dockIcon)
  })
}

let isQuittingFromTray = false

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1280,
    minHeight: 860,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      plugins: true,
      // Enables the <webview> tag used by the in-chat page viewer to render a
      // fetched website inline (borderless, isolated 'pageviewer' partition).
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.on('show', () => {
    mainWindow.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {})
  })

  // Windows shutdown / restart / log-off. `query-session-end` fires first and
  // is the only warning we get; `session-end` follows and cannot be stopped.
  // Neither goes through before-quit's drain, so an in-flight turn would
  // otherwise die exactly where it stood — which is how a forty-minute run
  // came back as nothing but the prompt the titler shell wrote before it
  // started. Both flush; the checkpointer's no-op guard makes the second free.
  // We do NOT preventDefault: the user asked the machine to restart, and the
  // periodic checkpoint means there is at most a few seconds of prose at risk.
  const flushForSessionEnd = (): void => {
    wlog.info('[quit]', 'windows session ending — flushing in-flight turns')
    void electronChannel
      .flushCheckpoints()
      .then(() => flushOutbox(SHUTDOWN_SYNC_FLUSH_MS))
      .catch(() => undefined)
  }
  mainWindow.on('query-session-end', flushForSessionEnd)
  mainWindow.on('session-end', flushForSessionEnd)

  mainWindow.on('close', (event) => {
    if (isQuittingFromTray || isShuttingDown) {
      if (quitInProgress) {
        event.preventDefault()
        return
      }
      if (hasInflightWork()) {
        event.preventDefault()
        quitInProgress = true
        broadcast('app:closingPending', { tasks: pendingBackgroundTasks })
        void drainAndQuit()
      }
      return
    }
    event.preventDefault()
    mainWindow.hide()
    if (process.platform === 'darwin') app.dock?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Spellcheck. Chromium underlines misspellings for free (webPreferences.spellcheck
  // defaults to true). The engine is per-OS: macOS uses the native OS spellchecker
  // (auto language, offline, and the setters below are no-ops), while Windows/Linux
  // use Hunspell — which needs a language set and downloads its dictionaries from a
  // CDN on first use — so only configure it off macOS.
  if (process.platform !== 'darwin') {
    try {
      const ses = mainWindow.webContents.session
      const available = ses.availableSpellCheckerLanguages
      const wanted = [app.getLocale(), 'en-US'].filter((l, i, a) => !!l && a.indexOf(l) === i)
      const langs = wanted.filter((l) => available.includes(l))
      if (langs.length) ses.setSpellCheckerLanguages(langs)
    } catch (err) {
      console.error('[spellcheck] language setup failed:', err)
    }
  }

  // The misspelled word and its suggestions live ONLY in this main-process event —
  // the DOM 'contextmenu' event the renderer sees carries none of it. Relay the
  // spellcheck fields so the renderer's own styled menu can offer corrections and
  // call back into webContents.replaceMisspelling(). Fires for every right-click the
  // page doesn't preventDefault; the renderer decides whether to surface a menu.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('spellcheck:contextMenu', {
      isEditable: params.isEditable,
      misspelledWord: params.misspelledWord,
      dictionarySuggestions: params.dictionarySuggestions
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function broadcastThemeUpdate(): void {
  const state = currentThemeState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('theme:updated', state)
  }
}

/**
 * Push one conversation's metadata to the phone. Metadata only, matching the
 * index: the phone fetches the body when the user opens it.
 *
 * Reads the one file it describes rather than listing the whole directory —
 * this now runs at every turn START as well as every end, and a walk of the
 * full history per turn is real I/O for a single row's worth of fields.
 */
async function pushConversationToMobile(id: string): Promise<void> {
  try {
    const conv = await loadConversation(id)
    if (!conv) return
    mobileChannel.pushConversationUpserted({
      id: conv.id,
      title: conv.title,
      model: null,
      channel: conv.channel ?? null,
      icon: conv.icon ?? null,
      projectId: conv.projectId ?? null,
      sealed: false,
      createdAt: conv.updatedAt,
      updatedAt: conv.updatedAt,
      messageCount: conv.messages?.length ?? 0,
      stats: null,
      summary: null
    })
  } catch {
    // A push that cannot be built must never disturb the desktop's own save.
  }
}

/**
 * Renderer broadcasts that are NOT a change to desktop-owned configuration.
 *
 * A denylist, deliberately, not an allowlist: the phone mirrors the whole
 * settings surface, and a setting added next month must reach it without
 * anyone remembering to wire a push. Anything not named here is assumed to
 * have moved config, which costs one cheap snapshot fetch and can never leave
 * the phone stale. Named here are the high-frequency streams and the signals
 * that already have their own targeted mobile push.
 */
const MOBILE_CONFIG_SILENT = new Set([
  'app:closingPending',
  // A conversation's plan-mode stance — the phone gets its own push.
  'chat:planMode',
  'automations:copyProgress',
  'procedures:copyProgress',
  'chat:turnState',
  'conversation:changed',
  'conversation:deleted',
  'conversation:hydrationProgress',
  'conversation:messageMirror',
  'conversation:summaryUpdated',
  'diagnostics:progress',
  'heartbeat:jobLog',
  'mobile:statusChange',
  // 'model:catalogChanged' is deliberately NOT here: the catalog rides the
  // phone's snapshot (snapshot.ts llm.models) as the list its model chips are
  // drawn from, so an admin policy edit — or the first fetch after launch
  // filling a cold cache — has to reach the phone the same way a setting does.
  // It fires only when the list actually CHANGED (catalogSync's sameCatalog
  // guard), so the five-minute revalidations cost nothing.
  'model:pullProgress',
  'projects:copyProgress',
  'reindex:progress'
])

/**
 * Autostart, dispatched by platform.
 *
 * macOS/Windows keep using Electron's login item — that path works and there
 * is no reason to replace it. Linux goes through the autostart module, because
 * `setLoginItemSettings` is `@platform darwin,win32` and has never done
 * anything at all there: the app shipped a toggle that wrote a preference and
 * registered nothing. `active` below is what is REGISTERED, never what was
 * asked for, which is what makes that visible.
 */
type AutostartFacts = Pick<AutostartStatus, 'active' | 'mechanism' | 'warning' | 'location'>

function usesElectronLoginItem(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Turn autostart on or off. THE one writer — the Wolffish tab's toggle lands
 * here, and it moves both halves together: the stored intent, then the OS
 * registration. Splitting them (one screen writing the preference, another
 * writing the unit) is how the two end up disagreeing, and nothing surfaces
 * the disagreement until a reboot.
 */
async function setAutostart(value: boolean): Promise<AutostartFacts> {
  await persistLaunchAtStartup(value)
  if (usesElectronLoginItem()) {
    app.setLoginItemSettings({ openAtLogin: value })
    return {
      active: app.getLoginItemSettings().openAtLogin,
      mechanism: 'loginItem',
      warning: null,
      location: null
    }
  }
  const status = value ? await installAutostart(app.getPath('exe')) : await uninstallAutostart()
  return {
    active: status.active,
    mechanism: status.mechanism,
    warning: status.warning,
    location: status.location
  }
}

/**
 * Re-register autostart only if the OS has lost it. Called once at boot for an
 * install whose stored preference is an explicit yes.
 *
 * Deliberately NOT `setAutostart(true)`: that would rewrite the preference on
 * every launch (a disk write for a value that never changed) and re-run the
 * installer's shell-outs — `systemctl enable`, `launchctl bootstrap` — even
 * when nothing is wrong. Reading the status first makes the healthy path free.
 */
async function reassertAutostart(): Promise<void> {
  const current = await readAutostartStatus()
  if (current.active) return
  const repaired = await setAutostart(true)
  wlog.info(
    '[autostart]',
    repaired.active
      ? `re-registered via ${repaired.mechanism}`
      : `could not re-register via ${repaired.mechanism}${repaired.warning ? ` — ${repaired.warning}` : ''}`
  )
}

async function readAutostartStatus(): Promise<AutostartFacts> {
  if (usesElectronLoginItem()) {
    return {
      active: app.getLoginItemSettings().openAtLogin,
      mechanism: 'loginItem',
      warning: null,
      location: null
    }
  }
  const status = await autostartStatus()
  return {
    active: status.active,
    mechanism: status.mechanism,
    warning: status.warning,
    location: status.location
  }
}

/** Coalesces a burst of config broadcasts into one push. */
let mobileConfigPushTimer: ReturnType<typeof setTimeout> | null = null

function broadcast<T>(channel: string, payload: T): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
  // Same signal, second audience. Saving a setting fires one of these on
  // every path there is, so hooking here covers them all at once instead of
  // one remembered push per handler.
  if (!MOBILE_CONFIG_SILENT.has(channel)) {
    if (mobileConfigPushTimer) clearTimeout(mobileConfigPushTimer)
    mobileConfigPushTimer = setTimeout(() => {
      mobileConfigPushTimer = null
      // Guarded twice over: an unconnected phone means there is no work worth
      // doing, and a throw escaping a timer callback takes the main process
      // with it — this runs on every settings change, so it must be inert
      // when anything about the tunnel is wrong.
      // Every config change also rewrites the phone's snapshot file, which
      // syncs to the org like any workspace file — so a phone whose desktop
      // is asleep still reads the settings as they last stood. The same
      // snapshot rides the push while a phone is on the bridge, so it lands
      // without a round trip.
      void writePhoneSnapshot()
        .then((snapshot) => {
          if (mobileChannel.hasPeer) mobileChannel.pushConfigChanged(channel, snapshot ?? undefined)
        })
        .catch(() => {
          // a dead link is not the settings save's problem
        })
    }, 300)
  }
}

/**
 * The phone's config snapshot, written where the org will pick it up
 * (brain/mobile/snapshot.json — under a synced root). Built by the same
 * function the phone's RPC is served from, so the file and the live answer
 * can never disagree. Coalesced: one build per burst of config broadcasts.
 */
let snapshotWriteInFlight: Promise<Record<string, unknown> | null> | null = null
let snapshotWriteAgain = false
function writePhoneSnapshot(): Promise<Record<string, unknown> | null> {
  if (snapshotWriteInFlight) {
    snapshotWriteAgain = true
    return snapshotWriteInFlight
  }
  snapshotWriteInFlight = (async () => {
    let last: Record<string, unknown> | null = null
    try {
      do {
        snapshotWriteAgain = false
        const status = cloudSession.getState().status
        if (status !== 'ready' && status !== 'locked') {
          // Not an error — a signed-out desktop has no org to write for. Said
          // out loud because it is otherwise indistinguishable, from the
          // outside, from a snapshot that failed: both leave the phone on the
          // last copy the org holds.
          wlog.debug('mobile', `phone snapshot skipped — session is ${status}`)
          return null
        }
        const snapshot = await mobileChannel.buildSnapshot()
        // Usage is the org's record and the phone reads it from the API;
        // it would make this file churn on every turn for nothing.
        delete snapshot.usage
        const abs = join(workspaceRoot(), SNAPSHOT_PATH)
        await mkdir(dirname(abs), { recursive: true })
        const tmp = `${abs}.tmp`
        await writeFile(tmp, JSON.stringify(snapshot))
        await rename(tmp, abs)
        last = snapshot
        // The one line that makes "is the phone's copy current?" answerable
        // from the log alone — the question that took a filesystem timestamp
        // to answer the first time this path stalled.
        wlog.debug('mobile', `phone snapshot written (${Object.keys(snapshot).length} sections)`)
      } while (snapshotWriteAgain)
    } catch (err) {
      wlog.warn('mobile', 'phone snapshot write failed:', err)
    } finally {
      snapshotWriteInFlight = null
    }
    return last
  })()
  return snapshotWriteInFlight
}

/**
 * Tell the phone its own two channel settings moved.
 *
 * Needed because `mobile:statusChange` — the broadcast those setters fire — is
 * on the silent list above, and must stay there: the same payload carries the
 * live tunnel frame counters, so pushing on it would turn a settings hook into
 * a per-frame heartbeat. This is the narrow, deliberate exception: called from
 * the two IPC handlers that actually change a setting, never from the status
 * stream. Best-effort, like every other push — a dead tunnel is not a settings
 * save's problem, and the reconcile on reconnect settles it either way.
 */
function pushMobileChannelConfig(): void {
  try {
    if (mobileChannel.hasPeer) mobileChannel.pushConfigChanged('channels')
  } catch {
    // nothing — the phone re-pulls the snapshot when the link comes back
  }
}

/**
 * The one save path for variables, whatever the origin. The settings panel's
 * IPC and the phone's tunnel RPC both land here, so a save persists once and
 * every other surface hears about it in the same breath: open renderer panels
 * through 'variables:changed', and the phone through the config.changed push
 * broadcast() already schedules for any non-silent channel. Writes apply in
 * arrival order under the config lock — last write wins, both screens
 * converge on it.
 */
async function saveVariablesEverywhere(variables: Variable[]): Promise<void> {
  await persistVariables(variables)
  broadcast('variables:changed', { variables })
  // The phone gets the array itself, now — not just the debounced "something
  // changed" hint broadcast() schedules. Same guard shape as that path: a
  // push is best-effort and a dead tunnel is not the save's problem.
  try {
    if (mobileChannel.hasPeer) mobileChannel.pushVariablesChanged(variables)
  } catch {
    // nothing — config.changed still follows and the phone converges there
  }
}

/**
 * How long a quit will wait for the in-flight turns' sync push. Long enough
 * for one round trip on a working network, short enough that a broken one
 * doesn't hold the app open.
 */
const SHUTDOWN_SYNC_FLUSH_MS = 5_000

async function shutdownGracefully(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  // Write every in-flight turn to disk BEFORE aborting it. abort() drops the
  // accumulators on the floor, and until this landed a quit (or an update
  // install) mid-run threw away the whole turn — the renderer folds the
  // transcript only at chat:done, which an aborted turn never reaches.
  await electronChannel.flushCheckpoints().catch(() => undefined)
  electronChannel.abort()
  // Those writes armed a sync push. Drain it on the way out rather than
  // leaving the run on this device only: ~/.wfc is a cache, and a machine
  // that doesn't come back should still have handed the turn to the org.
  //
  // Raced against a hard wall rather than trusted to its own deadline:
  // flushOutbox only checks the clock BETWEEN requests, and one request can
  // sit on a 30s fetch timeout, so its 5s would not have been 5s on a bad
  // network. A shutdown that hangs is worse than a push deferred — nothing is
  // lost by giving up, the outbox is durable and the next launch's digest
  // sweep re-pushes whatever this missed.
  await Promise.race([
    flushOutbox(SHUTDOWN_SYNC_FLUSH_MS).catch(() => false),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SYNC_FLUSH_MS).unref?.())
  ])
  await extensionServer.stop().catch(() => undefined)
  await mcpManager.stop().catch(() => undefined)
  await agent.stop().catch(() => undefined)
}

// Counts async work (title generation, save) that fired after a turn
// finished. The renderer treats these as fire-and-forget, so without
// tracking them here a Cmd+Q or window-X mid-flight would tear the
// process down before the file hit disk and the conversation would be
// lost. before-quit waits on this counter to drain before exiting.
let pendingBackgroundTasks = 0
let pendingDrainResolvers: Array<() => void> = []
// Held high from the moment the user requests quit until the drain
// finishes. While it's true, every quit/close attempt is blocked —
// otherwise a spammed Cmd+Q would let the second event slip past the
// in-progress drain and kill the process anyway.
let quitInProgress = false

async function trackBackgroundTask<T>(work: () => Promise<T>): Promise<T> {
  pendingBackgroundTasks += 1
  try {
    return await work()
  } finally {
    pendingBackgroundTasks -= 1
    if (pendingBackgroundTasks === 0) {
      const resolvers = pendingDrainResolvers
      pendingDrainResolvers = []
      for (const r of resolvers) r()
    }
  }
}

function waitForBackgroundDrain(): Promise<void> {
  if (pendingBackgroundTasks === 0) return Promise.resolve()
  return new Promise((resolve) => pendingDrainResolvers.push(resolve))
}

function hasInflightWork(): boolean {
  return electronChannel.hasActiveTurn() || pendingBackgroundTasks > 0
}

async function drainAndQuit(): Promise<void> {
  await shutdownGracefully()
  await waitForBackgroundDrain()
  // Drop the gate so our own app.quit() below isn't blocked. The
  // recursive before-quit will see quitInProgress=false and
  // hasInflightWork=false and let the default action through, which
  // lets will-quit fire and release the workspace lockfile.
  quitInProgress = false
  app.quit()
}

/**
 * macOS and Linux GUI apps inherit launchd/XDG environment, which
 * typically lacks user-specific PATH entries (Homebrew, nvm, cargo,
 * pyenv, etc.). Spawn the user's login shell once to capture their
 * real PATH and merge it into process.env so every child_process.spawn
 * downstream (shell plugin, npm install, dependency checks) sees the
 * same binaries the user's terminal would. Windows resolves PATH from
 * the registry at process start, so no fixup is needed there.
 */
function resolveShellPath(): void {
  if (process.platform === 'win32') return
  const userShell = process.env.SHELL || '/bin/sh'
  try {
    const raw = execFileSync(userShell, ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const resolved = raw.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
    if (resolved && resolved.includes(':')) process.env.PATH = resolved
  } catch {
    // best-effort — keep the existing PATH if the shell fails
  }
}

/**
 * Stop everything holding workspace handles or exclusive side effects, so a
 * relaunch (factory reset, restore-applied, account switch) starts clean.
 * app.exit() skips before-quit/will-quit, so children must die here.
 */
/**
 * The cache leaves with the session: after an explicit sign-out (outbox
 * drained) or a PIN lockout, the workspace is purged and the app relaunches
 * to the sign-in screen. The next sign-in restores it from the org — the
 * same path a fresh install takes — and a different user signing in on this
 * machine never finds the previous user's data on disk.
 */
async function purgeCacheAfterSignOut(reason: string): Promise<void> {
  wlog.info('sync', `${reason}: purging the local cache and relaunching`)
  await teardownForRelaunch(reason)
  await purgeWorkspace().catch((err) => wlog.warn('sync', 'cache purge failed:', err))
  relaunchApp(reason)
}

/**
 * Restart the app to pick up boot-read state (restore applied, account
 * switch, factory reset, sign-out purge). The destructive work is already
 * done by the time we get here; all that is left is the process bounce.
 *
 * `electron-vite dev` spawns Electron as a child and wires
 * `ps.on('close', process.exit)` — so `app.exit()` does not merely restart
 * the app under the dev server, it takes the dev server (and the terminal
 * job running it) down too, which reads as a crash on sign-in. In dev we
 * therefore stay alive and tell the developer to restart by hand; the
 * on-disk work has landed either way.
 */
function relaunchApp(reason: string): void {
  if (is.dev) {
    wlog.warn(
      'sync',
      `${reason}: skipping the relaunch under electron-vite dev (exiting would kill the dev server) — restart \`npm run dev\` to come up on the new state`
    )
    return
  }
  app.relaunch()
  app.exit(0)
}

async function teardownForRelaunch(reason: string): Promise<void> {
  wlog.info('sync', `tearing down for relaunch: ${reason}`)
  electronChannel.abort()
  await mcpManager.stop().catch(() => undefined)
  await agent.stop().catch(() => undefined)
  if (lockAcquired) {
    releaseLockSync(lockfilePath())
    lockAcquired = false
  }
}

/**
 * Apply an adopted server config to the RUNNING app — the subset that can
 * change live without a restart: theme, model, mode, safety toggles,
 * locale-bound prompts, capability sets, and the brainstem schedules.
 * Channels and MCP stay boot-read (they hold sockets and child processes);
 * the restore path relaunches for those, and a steady-state adoption gets
 * them at the next launch. The renderer is pinged to re-read its settings.
 */
function applyAdoptedConfig(cfg: WorkspaceConfig): void {
  try {
    nativeTheme.themeSource = cfg.theme ?? 'system'
    broadcastThemeUpdate()
    thalamus.setModel(cfg.llm?.model ?? null)
    agent.setMode(cfg.llm?.mode ?? 'single')
    agent.amygdala.setBypassPermissions(cfg.safety?.bypassPermissions ?? false)
    turnRunner.setBlockCredentials(cfg.safety?.blockCredentials ?? false)
    turnRunner.setLocale(cfg.locale ?? 'en')
    sudoSession.setLocale(cfg.locale ?? 'en')
    agent.cerebellum.setDisabled(cfg.disabledCapabilities ?? [])
    agent.cerebellum.setPinnedCapabilities(cfg.pinnedCapabilities ?? [])
    if (cfg.compaction) agent.brainstem.setCompactionConfig(cfg.compaction)
    agent.brainstem.setReflectionConfig(normalizeReflectionConfig(cfg.reflection))
    broadcast('workspace:configAdopted', null)
  } catch (err) {
    wlog.warn('sync', 'live apply of adopted config failed (relaunch will):', err)
  }
}

app.whenReady().then(async () => {
  // Must stay identical to `appId` in electron-builder.yml: the NSIS installer
  // stamps that value onto the Start Menu and Desktop shortcuts, and Windows
  // only matches a running window to its own shortcut — and only raises toasts
  // at all — when the two agree. A YAML file cannot import this constant, so the
  // two are kept in sync by hand.
  electronApp.setAppUserModelId('cloud.wolffi.sh')

  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(dockIcon)
  }

  resolveShellPath()
  await ensureWorkspace()
  // The cloud session gates every screen: initialize it early and mirror
  // every transition to the renderer. Init is non-blocking (it may touch
  // the network to rotate the refresh token) — the renderer shows a splash
  // while status is 'initializing'.
  // The runtime's one lane authenticates with the session's access token;
  // this seam keeps electron out of the runtime import graph.
  connectCloudProvider({
    apiBase: API_BASE,
    getToken: () => cloudSession.withAccessToken(async (token) => token)
  })
  // The same seam for capability plugins: the web-search plugin routes every
  // search through the org's /v1/search lane with the session token — the
  // org's Brave key never leaves the edge (see main/brave.ts for the status).
  agent.cerebellum.setCloudHost({
    apiBase: API_BASE,
    withAccessToken: (fn) => cloudSession.withAccessToken(fn)
  })
  // Sync registers its own onState listener — BEFORE init() so the very
  // first ready (silent resume at launch) also restores and sweeps.
  initCloudSync({
    getUserId: () => cloudSession.getUserId(),
    getDeviceId: () => cloudSession.getDeviceId(),
    // The org's usage table landed rows in the local ledger (a rebuild
    // after restore, or the user's other devices' calls) — re-read it so
    // the usage panel and the phone show the org's record.
    onUsageLedgerChanged: () => {
      void agent.usage
        .sync()
        .then(() => mobileChannel.pushUsageChanged())
        .catch(() => undefined)
    },
    // A restore into a fresh workspace delivered the user's real setup —
    // relaunch so every boot-read subsystem (channels, MCP, theme, model,
    // conversation list) comes up on the restored config. restore_done is
    // already durable, so the relaunched instance goes straight to sweep.
    onRestored: (summary: RestoreSummary) => {
      wlog.info(
        'sync',
        `workspace restored (${summary.conversations} conversations, ${summary.files} files) — relaunching to apply`
      )
      void (async () => {
        await teardownForRelaunch('restore complete')
        relaunchApp('restore complete')
      })()
    },
    // The workspace on disk belongs to a DIFFERENT user than the session.
    // Cloud-first semantics: the local folder is a cache of one user's
    // record — reset it and let the relaunch restore this user's own.
    // Never sweep user A's data into user B's account.
    onForeignWorkspace: (ownerUserId: string) => {
      wlog.warn(
        'sync',
        `workspace cache belongs to user ${ownerUserId} — resetting for the signed-in account`
      )
      void (async () => {
        await teardownForRelaunch('account switch')
        await purgeWorkspace().catch(() => undefined)
        relaunchApp('account switch')
      })()
    },
    // A server config row replaced the local file (restore, launch
    // reconciliation, or the 2-minute steady-state pull): apply what can
    // change live and ping the renderer to re-read.
    onConfigAdopted: (cfg) => applyAdoptedConfig(cfg),
    // On-open media hydration ticks → the chat's download banner.
    onHydrationProgress: (progress: HydrationProgress) =>
      broadcast('conversation:hydrationProgress', progress),
    // A conversation's records reached the org — the phone may read its
    // body from the API now and find the turn it just watched in it.
    onConversationPushed: (id, updatedAt) => mobileChannel.pushConversationSynced(id, updatedAt),
    // The catch-up pull applied work done on the user's OTHER machine. The
    // list re-reads either way; a removed conversation is announced by id
    // as well, because a chat open on this screen right now has to close
    // rather than keep rendering a transcript the org no longer has.
    onLockedKeysChanged: (keys) => broadcast('workspace:lockedConfigKeys', { keys }),
    onConversationsPulled: ({ removed }) => {
      for (const id of removed) broadcast('conversation:deleted', { id })
      broadcast('conversation:changed', {})
    }
  })
  // Avatar cache revalidations land here: updated/removed photos reach
  // every open surface without a refetch.
  cloudSession.onAvatar((dataUrl) => {
    broadcast('auth:avatarChanged', dataUrl)
  })
  // The renderer holds the catalog from launch instead of fetching it on
  // every picker open, so a refresh that lands a different list (session
  // ready, a stale-copy revalidation, an admin policy edit) is pushed.
  onCatalogChanged((models) => broadcast('model:catalogChanged', { models }))
  /**
   * A phone just appeared on the bridge — hand it this machine's settings
   * without being asked.
   *
   * The phone has been away for anything between a screen lock and a week,
   * and every setting it shows is a copy of this desktop's. It does pull on
   * reconnect, but that pull fires when its SOCKET opens, which is before the
   * org has told it this desktop is present — so it reads the copy last
   * synced to the org and settles there. Nothing asked again once this
   * machine appeared, which is how a phone ends up showing a model this
   * desktop stopped using hours ago.
   *
   * Pushing on the appear edge closes it from this side, and does not depend
   * on the phone's version: `config.changed` carrying a snapshot is a signal
   * every paired build already applies. One rebuild per appearance, not per
   * presence frame — `phones` also changes when a second device joins.
   */
  let phonesPresent = 0
  mobileBridge.onState((state) => {
    const present = state.phones.length
    const appeared = phonesPresent === 0 && present > 0
    phonesPresent = present
    if (!appeared) return
    void writePhoneSnapshot()
      .then((snapshot) => {
        if (!mobileChannel.hasPeer) return
        mobileChannel.pushConfigChanged('reconnect', snapshot ?? undefined)
        wlog.debug('mobile', 'pushed settings to a phone that just appeared')
      })
      .catch(() => {
        // A phone that vanished again between the frame and the push is not
        // this path's problem — its next appearance pushes again.
      })
  })
  // The bridge socket lives exactly as long as the session holds tokens.
  // A signed-out desktop has nothing to park for; a fresh sign-in dials
  // straight away and re-lists the paired phones.
  let bridgeUp = false
  cloudSession.onState((state) => {
    const authenticated = state.status === 'ready' || state.status === 'locked'
    if (authenticated && !bridgeUp) {
      bridgeUp = true
      mobileBridge.start()
      void mobileChannel.sessionReady().catch(() => undefined)
      void writePhoneSnapshot()
    } else if (!authenticated && bridgeUp) {
      bridgeUp = false
      mobileBridge.stop()
      mobileChannel.sessionGone()
    }
  })
  cloudSession.onState((state) => {
    broadcast('auth:changed', state)
    // 'locked' still holds live tokens — the PIN screen is UI-only privacy,
    // so catalog and model adoption never wait behind it.
    if (state.status === 'ready' || state.status === 'locked') {
      // Fresh session → fresh catalog, and a working default model with
      // zero clicks: when nothing is selected yet, adopt the org default.
      void refreshCatalog()
        .then(async (models) => {
          const current = (await readConfig())?.llm.model ?? null
          const stillListed = current !== null && models.some((m) => m.id === current)
          if (current !== null && stillListed) return
          const fallback = models.find((m) => m.default) ?? models[0]
          if (!fallback) return
          const updated = await persistModel(fallback.id)
          thalamus.setModel(updated.llm.model)
          broadcast('provider:updated', { id: 'cloud' })
        })
        .catch(() => undefined)
    }
  })
  void cloudSession.init().catch((err) => {
    console.error('cloudSession.init failed:', err)
  })
  agent.init().catch((err) => {
    console.error('agent.init failed:', err)
  })

  // Workspace config is the single source of truth for persisted preferences.
  // Read it once at startup to apply the theme and restore the selected model.
  const cfg = await readConfig()
  nativeTheme.themeSource = cfg?.theme ?? 'system'
  thalamus.setModel(cfg?.llm.model ?? null)

  agent.amygdala.setBypassPermissions(cfg?.safety?.bypassPermissions ?? false)
  agent.setMode(cfg?.llm.mode ?? 'single')
  turnRunner.setBlockCredentials(cfg?.safety?.blockCredentials ?? false)
  turnRunner.setLocale(cfg?.locale ?? 'en')
  sudoSession.setLocale(cfg?.locale ?? 'en')
  agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
  agent.cerebellum.setPinnedCapabilities(cfg?.pinnedCapabilities ?? [])

  // Compaction schedule from config. Brainstem.init() will call
  // startCompactionScheduler() using whatever config is set here.
  if (cfg?.compaction) {
    agent.brainstem.setCompactionConfig(cfg.compaction)
  }

  // Reflection schedule config. normalize merges partial stored values over
  // the defaults, so a pre-feature config still yields a complete
  // ReflectionConfig.
  agent.brainstem.setReflectionConfig(normalizeReflectionConfig(cfg?.reflection))

  // Auto-launch: REPAIR a registration the user already asked for — never
  // create one they didn't.
  //
  // `=== true`, not `!== false`: only an explicit yes counts. (In practice
  // these are the same test, since defaultConfig() has always written the key
  // — but the intent should be readable without knowing that.)
  //
  // Repair, because a registration can go missing without the preference
  // changing: the app moved between folders, macOS reset its login items, a
  // cleanup tool deleted the .desktop entry, an update changed the binary
  // path. Without this, the toggle keeps saying On while nothing is
  // registered — the exact silent-lie the active-vs-intent split exists to
  // expose. It re-registers only when the OS says nothing is there, so a
  // healthy install pays one status read and no shell-outs.
  //
  // Through the dispatcher, not app.setLoginItemSettings directly: that call
  // does nothing on Linux, where a .desktop entry is the real mechanism.
  //
  // Skipped in dev — registering the dev binary as a login item brings the
  // Electron debug menu back on restart instead of the production app.
  if (!is.dev && cfg?.launchAtStartup === true) {
    void reassertAutostart().catch((err) =>
      wlog.warn('[autostart]', `re-assert failed: ${err instanceof Error ? err.message : err}`)
    )
  }

  {
    const extCfg = cfg?.browserExtension ?? { port: 23152 }
    extensionServer.setStatusChangeHandler((status) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('extension:statusChange', status)
      }
    })
    void extensionServer
      .start({ port: extCfg.port })
      .catch((err) => console.error('extension server start failed:', err))
    agent.corpus.on('conversation.changed', (payload) => {
      extensionServer.setConversationId(payload.conversationId, payload.title)
    })
  }

  const lock = await acquireLock(lockfilePath())
  if (lock.acquired) lockAcquired = true

  // MCP connections start only in the instance that owns the workspace
  // lock: stdio servers are real child processes with exclusive side
  // effects (ports, database locks, OAuth token refresh writes), and a
  // dev + packaged instance pair sharing ~/.wfc must not both
  // spawn them. Channels predate this concern; MCP doesn't inherit it.
  if (lock.acquired) {
    mcpManager.start(cfg?.mcp)
  } else {
    wlog.warn('[mcp]', `connections not started — workspace owned by pid ${lock.runningPid}`)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Spellcheck corrections — the renderer's context menu calls these after the
  // main-process 'context-menu' event handed it the misspelled word + suggestions.
  // replaceMisspelling swaps the word currently selected by the right-click; it's a
  // native edit command, so undo works and controlled React inputs re-sync via input.
  handle('spellcheck:replace', (e, word: string) => {
    e.sender.replaceMisspelling(word)
  })
  handle('spellcheck:addToDictionary', (e, word: string) => {
    // Persists to the app's custom dictionary (and the OS dictionary on macOS/
    // Windows). The default session is persistent, so this is never a no-op here.
    e.sender.session.addWordToSpellCheckerDictionary(word)
  })

  // Theme
  handle('theme:get', () => currentThemeState())
  handle('theme:set', async (_e, source: ThemeSource) => {
    nativeTheme.themeSource = source
    await persistTheme(source)
    return currentThemeState()
  })

  // Locale
  handle('locale:get', async (): Promise<Locale> => {
    const config = await readConfig()
    return config?.locale ?? 'en'
  })
  handle('locale:set', async (_e, locale: Locale) => {
    await persistLocale(locale)
    turnRunner.setLocale(locale)
    sudoSession.setLocale(locale)
    return locale
  })

  // Runtime — Wolffish-specific toggles. Persist to config.json and
  // mirror into the live amygdala / thalamus instances so the change
  // takes effect on the next turn without a restart.
  handle('runtime:setBypassPermissions', async (_e, value: boolean) => {
    await persistBypassPermissions(value)
    agent.amygdala.setBypassPermissions(value)
    // Announced like every other settings save: other windows re-seed, and
    // the broadcast hook's config.changed push tells a paired phone now
    // rather than on its next screen focus.
    broadcast('preferences:changed', { bypassPermissions: value })
    return { value }
  })
  handle('runtime:setBlockCredentials', async (_e, value: boolean) => {
    await persistBlockCredentials(value)
    turnRunner.setBlockCredentials(value)
    broadcast('preferences:changed', { blockCredentials: value })
    return { value }
  })
  handle('runtime:setThinkingMode', async (_e, model: string, mode: string) => {
    await persistThinkingMode(model, mode)
    broadcast('preferences:changed', { thinkingMode: { model, mode } })
  })

  /**
   * Which reasoning modes a given provider+model actually honours, and what is
   * stored for it now.
   *
   * The renderer works this out through the thalamus it shares by import.
   * Reading it here keeps ONE registry (reasoning.ts) answering for every
   * surface, the phone's settings screens included.
   */
  handle(
    'runtime:reasoningModes',
    async (
      _e,
      payload: { provider: string; model: string }
    ): Promise<{ modes: string[]; current: string }> => {
      const cfg = await readConfig()
      const modes = reasoningModesFor('cloud', payload.model)
      const stored = cfg?.llm.thinkingModes?.[payload.model]
      return { modes, current: normalizeReasoningMode(stored, modes) }
    }
  )

  handle('runtime:setLaunchAtStartup', async (_e, value: boolean) => {
    const status = await setAutostart(value)
    broadcast('preferences:changed', { launchAtStartup: value })
    // `active` is what the OS actually registered, which is NOT always what
    // was asked for — the panel renders both so a failed registration reads as
    // "On · Inactive" instead of a success.
    return { value, active: status.active, mechanism: status.mechanism, warning: status.warning }
  })

  handle('runtime:getLaunchAtStartupStatus', () => readAutostartStatus())

  handle('variables:list', async (): Promise<Variable[]> => {
    return getVariables()
  })
  handle('variables:save', async (_e, variables: Variable[]): Promise<{ ok: true }> => {
    await saveVariablesEverywhere(variables)
    return { ok: true }
  })

  // In-app (desktop) chat — the primary renderer feed, not a remote relay
  // channel. Only a display preference (verbose) to persist; no lifecycle,
  // no restart. After a write we broadcast the new config so an open chat
  // window re-renders its feed immediately, the same way the channel panels
  // react to status changes.
  handle('inapp:getConfig', (): Promise<InAppConfig> => getInAppConfig())

  handle(
    'inapp:setConfig',
    async (_e, patch: Partial<InAppConfig>): Promise<{ ok: true; config: InAppConfig }> => {
      const updated = await persistInAppConfig(patch)
      const next = updated.inapp ?? EMPTY_INAPP
      // broadcast(), not a bare window send: the same signal has to reach an
      // attached terminal and the paired phone (through the config.changed
      // hook), or a flip made here stays a secret to every surface but this
      // window's own chat feed.
      broadcast('inapp:configChange', next)
      return { ok: true as const, config: next }
    }
  )

  // MCP server connections. All lifecycle mechanics live in McpManager;
  // these handlers are thin passthroughs. Status flows to the renderer
  // via the 'mcp:statusChange' broadcast wired at manager construction.
  handle('mcp:list', () => mcpManager.snapshot())

  handle('mcp:add', (_e, input: McpAddInput) => mcpManager.add(input))

  handle('mcp:remove', (_e, id: string) => mcpManager.remove(id))

  handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => mcpManager.setEnabled(id, enabled))

  handle('mcp:setHeaders', (_e, id: string, headers: McpHeader[]) =>
    mcpManager.setHeaders(id, headers)
  )

  handle('mcp:test', (_e, id: string) => mcpManager.test(id))

  handle('mcp:authorize', (_e, id: string) => mcpManager.authorize(id))

  // Brave Search — provided by the organization: one key behind the API's
  // /v1/search lane, never on this device. The web-search capability's
  // plugin calls that lane through the cerebellum's cloud host; this
  // handler is the status the settings panel renders (org switch, this
  // user's allowance, plan price and rate limit).
  handle(
    'brave:status',
    (_e, opts?: { refresh?: boolean }): Promise<BraveStatus> =>
      braveService.getStatus(Boolean(opts?.refresh))
  )

  // Computer Use — desktop automation. The plugin reads config.json directly;
  // this handler is the read side only. There is deliberately no setter:
  // screenshot resolution and format are chosen by the agent per capture
  // (`max_width` / `format` on computer_screenshot), so the stored values are
  // a fallback default that no UI — desktop or phone — writes.
  handle('computerUse:getConfig', (): Promise<ComputerUseConfig> => getComputerUseConfig())

  handle(
    'computerUse:checkPermissions',
    (): {
      platform: string
      hint: string | null
      accessibility: boolean
      screenRecording: boolean
    } => {
      const platform = process.platform

      if (platform === 'darwin') {
        const accessibility = systemPreferences.isTrustedAccessibilityClient(true)
        const screenStatus = systemPreferences.getMediaAccessStatus('screen')
        const screenRecording = screenStatus === 'granted'

        const missing: string[] = []
        if (!accessibility) missing.push('Accessibility')
        if (!screenRecording) missing.push('Screen Recording')

        return {
          platform,
          accessibility,
          screenRecording,
          hint:
            missing.length > 0
              ? `Grant ${missing.join(' and ')} in System Settings → Privacy & Security, then restart Wolffish.`
              : null
        }
      }

      if (platform === 'linux') {
        return {
          platform,
          accessibility: true,
          screenRecording: true,
          hint: 'Linux requires X11. Wayland is not supported by the automation library.'
        }
      }

      return { platform, accessibility: true, screenRecording: true, hint: null }
    }
  )

  // Browser Extension — WebSocket server for the Wolffish browser extension.
  handle(
    'browserExtension:getConfig',
    (): Promise<BrowserExtensionConfig> => getBrowserExtensionConfig()
  )

  handle(
    'browserExtension:setConfig',
    async (
      _e,
      patch: Partial<BrowserExtensionConfig>
    ): Promise<{ ok: true; config: BrowserExtensionConfig }> => {
      await persistBrowserExtensionConfig(patch)
      const next = await getBrowserExtensionConfig()
      if (patch.port !== undefined) {
        extensionServer.sendPortUpdate(next.port)
        await extensionServer.stop()
        await extensionServer.start({ port: next.port })
      }
      broadcast('services:changed', { service: 'browserExtension' })
      return { ok: true as const, config: next }
    }
  )

  handle('browserExtension:status', () => extensionServer.getStatus())

  handle('browserExtension:openExtensionFolder', () => {
    shell.showItemInFolder(extensionFolderPath())
  })

  handle('browserExtension:getExtensionPath', () => {
    return extensionFolderPath()
  })

  handle('browserExtension:updateExtension', async (_e, target?: string | null) => {
    await extensionServer.requestReload(target ?? null)
    return { ok: true }
  })

  handle('browserExtension:testConnection', (_e, target?: string | null) =>
    extensionServer.runTestScenario(target ?? null)
  )

  handle('browserExtension:openExtensionsPage', () => {
    const url = 'chrome://extensions'
    if (process.platform === 'darwin') {
      const browsers = ['Google Chrome', 'Brave Browser', 'Chromium']
      for (const browser of browsers) {
        try {
          execFileSync('open', ['-a', browser, url], { stdio: 'ignore' })
          return
        } catch {
          continue
        }
      }
    } else if (process.platform === 'win32') {
      try {
        execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
        return
      } catch {
        /* fallthrough */
      }
    } else {
      try {
        execFileSync('xdg-open', [url], { stdio: 'ignore' })
        return
      } catch {
        /* fallthrough */
      }
    }
  })

  // STT/TTS — persisted defaults the cerebellum plugins read on every
  // tool call, so users' panel choices override the plugin's
  // hard-coded fallbacks without restarting anything. Both stay
  // optional in config.json: an empty string means "use the plugin's
  // own default," which is what every existing config will have until
  // the user touches the panel.
  handle('mic:checkAccess', (): 'granted' | 'denied' | 'not-determined' | 'restricted' => {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      return status === 'unknown' ? 'granted' : status
    }
    return 'granted'
  })

  handle('mic:requestAccess', async (): Promise<boolean> => {
    if (process.platform === 'darwin') {
      return systemPreferences.askForMediaAccess('microphone')
    }
    return true
  })

  handle('stt:getConfig', (): Promise<SttConfig> => getSttConfig())
  handle(
    'stt:setConfig',
    async (_e, patch: Partial<SttConfig>): Promise<{ ok: true; config: SttConfig }> => {
      const updated = await persistSttConfig(patch)
      broadcast('services:changed', { service: 'stt' })
      // Normalized field-by-field: a pre-`language` config.json on disk must
      // not hand the renderer a shape missing the field the type promises.
      return {
        ok: true as const,
        config: {
          defaultModel: updated.stt?.defaultModel ?? '',
          language: updated.stt?.language ?? ''
        }
      }
    }
  )
  handle(
    'stt:transcribe',
    async (
      _e,
      payload: { filePath: string; conversationId?: string }
    ): Promise<
      { ok: true; transcript: string; language?: string } | { ok: false; error: string }
    > => {
      try {
        // Whisper decodes audio through ffmpeg. On a fresh machine ffmpeg is
        // absent, so transcription would dead-end with a long install-it-yourself
        // error. This IPC path calls the tool directly (bypassing the agent
        // loop's dependency resolution), so ensure ffmpeg here first — it
        // self-installs silently and continues.
        await agent.cerebellum.ensureSystemTool('ffmpeg')
        // Conversation id rides the ALS scope (not the imperative global) so
        // this out-of-turn call can't clobber the conversation a concurrent
        // turn published.
        const transcribe = (): Promise<Awaited<ReturnType<typeof agent.cerebellum.executeTool>>> =>
          agent.cerebellum.runWithConversation(payload.conversationId ?? null, () =>
            agent.cerebellum.executeTool('stt_transcribe', {
              filePath: payload.filePath
            })
          )
        let result = await transcribe()
        // Belt-and-suspenders: if it still failed on ffmpeg (e.g. a stale PATH),
        // ensure once more and retry exactly once.
        if (!result.success && /ffmpeg/i.test(result.error ?? '')) {
          await agent.cerebellum.ensureSystemTool('ffmpeg')
          result = await transcribe()
        }
        if (!result.success) {
          // Keep the toast to one line — collapse the multi-line plugin message
          // (which spells out manual brew/winget steps) into a short summary.
          const raw = result.error ?? 'Transcription failed'
          const error = /ffmpeg/i.test(raw)
            ? 'Couldn’t set up ffmpeg automatically — please install it and try again.'
            : raw.split('\n')[0]
          return { ok: false, error }
        }
        const raw = result.output ?? ''
        const match =
          raw.match(/"transcript"\s*:\s*"([^"]*)"/) ?? raw.match(/"text"\s*:\s*"([^"]*)"/)
        const transcript = match ? match[1] : raw.replace(/[{}"\n]/g, '').trim()
        if (!transcript) {
          return { ok: false, error: 'Transcription returned empty' }
        }
        // Whisper's detected language (ISO 639-1) — surfaced so the renderer
        // can tag the <voice_note lang="…"> history entry, giving the model a
        // deterministic reply-language signal instead of guessing.
        const language = raw.match(/"language"\s*:\s*"([^"]*)"/)?.[1] ?? ''
        return { ok: true, transcript, language }
      } catch (err) {
        if (payload.conversationId) {
          agent.cerebellum.setCurrentConversationId(null)
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle('tts:getConfig', (): Promise<TtsConfig> => getTtsConfig())
  handle(
    'tts:setConfig',
    async (_e, patch: Partial<TtsConfig>): Promise<{ ok: true; config: TtsConfig }> => {
      const updated = await persistTtsConfig(patch)
      broadcast('services:changed', { service: 'tts' })
      return {
        ok: true as const,
        config: {
          defaultVoice: updated.tts?.defaultVoice ?? '',
          defaultSpeed: updated.tts?.defaultSpeed ?? '',
          voiceReplies: updated.tts?.voiceReplies !== false
        }
      }
    }
  )

  // Local voice-engine provisioning, surfaced to the Settings panels so users
  // can install Kokoro (TTS) / faster-whisper (STT) on demand with a progress
  // bar — and so the panels can gate voice/model selection until ready. Install
  // is idempotent and converges with the plugins' lazy first-use install.
  handle('tts:installStatus', (): Promise<EngineStatus> => ttsStatus())
  handle('tts:getInstallState', (): EngineRuntimeState => getTtsInstallState())
  handle('stt:getInstallState', (): EngineRuntimeState => getSttInstallState())
  // Progress (and the terminal 'done') is BROADCAST to every window, not just
  // the invoking sender. A panel that remounted mid-install — or a renderer that
  // fully reloaded (its original sender is now dead) — must still receive live
  // updates and the terminal signal, otherwise it can stick on "Installing".
  // The terminal 'done' fires after the install settles (success OR failure), so
  // a non-initiating panel also stops showing "Installing" (idempotent duplicate
  // on the success path, which already emits its own 'done').
  const broadcastEngineProgress = (channel: string, payload: EngineInstallProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(channel, payload)
    }
  }
  // One install path per engine, shared by the panel's button (the IPC handlers
  // below) and by the agent (the voice host further down). Whoever starts it,
  // progress reaches every window and the terminal 'done' fires, so the panel's
  // card tracks an agent-triggered install exactly as it tracks its own — and
  // installTts/installStt dedupe against an in-flight run, so a click landing
  // mid-agent-install (or the reverse) joins that run instead of starting a
  // second one.
  const runTtsInstall = async (): Promise<EngineInstallResult> => {
    const res = await installTts(
      (p: EngineInstallProgress) => broadcastEngineProgress('tts:installProgress', p),
      { ensureFfmpeg: () => agent.cerebellum.ensureSystemTool('ffmpeg').then(() => undefined) }
    )
    broadcastEngineProgress('tts:installProgress', { phase: 'done', percent: 100 })
    return res
  }
  const runSttInstall = async (): Promise<EngineInstallResult> => {
    const res = await installStt((p: EngineInstallProgress) =>
      broadcastEngineProgress('stt:installProgress', p)
    )
    broadcastEngineProgress('stt:installProgress', { phase: 'done', percent: 100 })
    return res
  }
  handle('tts:install', (): Promise<EngineInstallResult> => runTtsInstall())
  handle('stt:installStatus', (): Promise<EngineStatus> => sttStatus())
  handle('stt:install', (): Promise<EngineInstallResult> => runSttInstall())

  // The agent's own hand on these two panels. Every setter is the one the
  // panel's IPC handler calls, broadcast included, so a change the model makes
  // re-seeds an open TTS/STT panel and pushes to the paired phone through the
  // same channel a click here would — no second write path, no surface left
  // holding a stale value. Validation of WHICH values are acceptable lives in
  // the plugins, against the catalogs the panels render.
  agent.cerebellum.setVoiceHost({
    getTts: () => getTtsConfig(),
    setTts: async (patch) => {
      const updated = await persistTtsConfig(patch)
      broadcast('services:changed', { service: 'tts' })
      return {
        defaultVoice: updated.tts?.defaultVoice ?? '',
        defaultSpeed: updated.tts?.defaultSpeed ?? '',
        voiceReplies: updated.tts?.voiceReplies !== false
      }
    },
    getStt: () => getSttConfig(),
    setStt: async (patch) => {
      const updated = await persistSttConfig(patch)
      broadcast('services:changed', { service: 'stt' })
      return {
        defaultModel: updated.stt?.defaultModel ?? '',
        language: updated.stt?.language ?? ''
      }
    },
    ttsInstalled: async () => (await ttsStatus()).installed,
    sttInstalled: async () => (await sttStatus()).installed,
    installTts: () => runTtsInstall(),
    installStt: () => runSttInstall(),
    ttsInstalling: () => getTtsInstallState().installing,
    sttInstalling: () => getSttInstallState().installing
  })

  // Real Kokoro preview for the TTS panel: synthesize a short sample with the
  // selected voice/speed and hand back the audio file path for the renderer to
  // play. Gated in the UI behind an installed engine, so this is fast.
  handle(
    'tts:preview',
    async (
      _e,
      payload: { text?: string; voice?: string; speed?: string }
    ): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> => {
      try {
        await agent.cerebellum.ensureSystemTool('ffmpeg')
        const result = await agent.cerebellum.executeTool('voice_generate', {
          text: payload.text?.trim() || 'Hello! This is a preview of how this voice sounds.',
          voice: payload.voice,
          speed: payload.speed
        })
        if (!result.success) {
          return { ok: false, error: (result.error ?? 'Preview failed').split('\n')[0] }
        }
        const raw = result.output ?? ''
        // voice_generate returns pure JSON; JSON.parse unescapes Windows paths
        // natively. Fall back to a regex only if the shape ever changes.
        let filePath: string | undefined
        try {
          filePath = (JSON.parse(raw) as { filePath?: string }).filePath
        } catch {
          filePath = raw.match(/"filePath"\s*:\s*"([^"]*)"/)?.[1]?.replace(/\\\\/g, '\\')
        }
        if (!filePath) return { ok: false, error: 'Preview produced no audio' }
        return { ok: true, filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  nativeTheme.on('updated', () => broadcastThemeUpdate())

  // System
  handle('system:getInfo', (): Promise<SystemInfo> => detectSystem())

  // Cloud auth — the session (and every token) lives in the main process;
  // the renderer sees only the redacted AuthState.
  handle('auth:getState', (): AuthState => cloudSession.getState())
  handle('auth:login', (_e, email: string, password: string) => cloudSession.login(email, password))
  handle('auth:changePassword', (_e, newPassword: string) =>
    cloudSession.completePasswordChange(newPassword)
  )
  handle('auth:setPin', (_e, pin: string) => cloudSession.setPin(pin))
  handle('auth:unlock', async (_e, pin: string) => {
    const state = await cloudSession.unlock(pin)
    // Five misses degraded the quick lock to the password door: the session
    // is already revoked; the cache goes with it (see purgeCacheAfterSignOut).
    if (state.status === 'loggedOut' && state.lastError === 'pin_lockout') {
      void purgeCacheAfterSignOut('pin lockout')
    }
    return state
  })
  // Sign out = revoke the session AND wipe this machine's cache. The
  // workspace is a cache of the org's record, so nothing is lost — provided
  // the outbox is empty. A final bounded drain runs first; if it cannot
  // finish (offline), the cache stays for the next sign-in and says so.
  // The admin layer's handlers live in their own module: they are the one
  // group that must never write to disk (see admin-ipc.ts).
  registerAdminIpc()

  handle('auth:signOut', async () => {
    const drained = await flushOutbox(20_000).catch(() => false)
    const state = await cloudSession.signOut()
    if (drained) void purgeCacheAfterSignOut('sign out')
    else
      wlog.warn(
        'sync',
        'sign-out: outbox not fully drained — local cache kept for the next sign-in'
      )
    return state
  })
  handle('auth:lock', () => cloudSession.lock())
  handle('auth:changePin', (_e, currentPin: string, nextPin: string) =>
    cloudSession.changePin(currentPin, nextPin)
  )
  handle('auth:profileGet', () => cloudSession.getProfile())
  handle(
    'auth:profileUpdate',
    (_e, patch: { name?: string; phone?: string; position?: string; bio?: string }) =>
      cloudSession.updateProfile(patch)
  )
  handle('auth:passwordChangeSelf', (_e, currentPassword: string, newPassword: string) =>
    cloudSession.changePasswordSelf(currentPassword, newPassword)
  )
  handle('auth:resetRequest', (_e, email: string) => cloudSession.requestPasswordReset(email))
  handle('auth:activateRequest', (_e, email: string) => cloudSession.requestActivation(email))
  handle('auth:activateConfirm', (_e, email: string, code: string, newPassword: string) =>
    cloudSession.confirmActivation(email, code, newPassword)
  )
  handle('auth:resetConfirm', (_e, email: string, code: string, newPassword: string) =>
    cloudSession.confirmPasswordReset(email, code, newPassword)
  )
  handle('auth:avatarGet', () => cloudSession.getAvatar())
  handle('auth:avatarSet', (_e, bytes: ArrayBuffer, mime: string) =>
    cloudSession.setAvatar(bytes, mime)
  )
  handle('auth:avatarRemove', () => cloudSession.removeAvatar())

  // Workspace
  handle('workspace:getStatus', (): Promise<WorkspaceStatus> => getStatus())
  // Which config paths the organization owns. The values are already
  // enforced server-side; this is what lets a settings control render as
  // "set by your organization" instead of silently reverting.
  handle('workspace:lockedConfigKeys', (): string[] => lockedConfigKeys())
  handle('workspace:completeOnboarding', () => markOnboardingComplete())

  // Wipe all data on disk but preserve API keys, model selection, locale,
  // theme, and runtime toggles. The relaunch ensures no stale handles
  // (cortex.db, brainstem watcher, corpus flush timer) survive the wipe.
  handle('app:factoryReset', async () => {
    await teardownForRelaunch('factory reset')
    // "Wipe my data" means the org copy too — tombstone the cloud record
    // first (best-effort: offline resets still reset locally; the marker
    // below keeps the survivors from resurrecting either way).
    await wipeCloudData().catch((err) =>
      wlog.warn('sync', 'cloud wipe during factory reset failed:', err)
    )
    await factoryReset().catch(() => undefined)
    // Stamp the fresh workspace as already-restored: a factory reset must
    // never be followed by a restore that pulls the erased data back.
    await markWorkspaceReset(cloudSession.getUserId()).catch(() => undefined)
    relaunchApp('factory reset')
  })

  handle('data:getAnalytics', (): Promise<DataAnalytics> => getDataAnalytics())

  // Official = org-managed: materialized by capability sync into a
  // dot-prefixed folder (or built into the process). The old signal —
  // presence in the app bundle — died when capabilities moved to the
  // cloud registry.
  const officialCapability = (cap: { dir?: string; inProcess?: boolean }): boolean =>
    Boolean(cap.inProcess) || basename(cap.dir ?? '').startsWith('.')

  // The mobile channel needs the same list; publish the closure so it can be
  // called from outside this scope rather than reimplementing the mapping.
  const serializeCapabilities = async (): Promise<
    Array<{
      name: string
      description: string
      status: 'ok' | 'error'
      hasPlugin: boolean
      toolCount: number
      triggers: string[]
      requires: string[]
      official: boolean
      core: boolean
      wolffish: boolean
      tested: boolean
      enabled: boolean
      error?: string
    }>
  > => {
    return agent.cerebellum
      .getCapabilities()
      .filter((c) => !c.inProcess)
      .map((c) => ({
        name: c.name,
        description: c.description,
        status: c.status,
        hasPlugin: c.hasPlugin,
        toolCount: c.tools.length,
        triggers: c.triggers.keywords,
        requires: c.requires,
        official: officialCapability(c),
        core: LOCKED_CAPABILITIES.has(c.name),
        wolffish: c.author === WOLFFISH_AUTHOR,
        // `tested` is tracked only for Wolffish-authored plugin skills; for
        // everything else the concept doesn't apply, so it reads as true.
        tested: c.tested !== false,
        enabled: !agent.cerebellum.isDisabled(c.name),
        error: c.error
      }))
  }

  mobileSerializeCapabilities = serializeCapabilities

  /**
   * The one implementation of "flip a capability". The settings IPC below,
   * the skills plugin's host bridge and the paired phone all call this, so a
   * toggle behaves identically whoever asked for it: the locked-core guard,
   * the config write, the live cerebellum update, and one broadcast that
   * refreshes every audience at once — this app's own panel directly, and the
   * phone via the broadcast hook's config.changed push. Returns the enabled
   * state that actually holds, which is how a refused write answers.
   *
   * The disabled set is computed inside patchConfig's lock, against the
   * config actually on disk: two toggles racing (a click here while the phone
   * flips something else) must merge, not overwrite each other.
   */
  const setCapabilityEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    // Refused before anything persists: every caller toggles names it was
    // just shown, so an unknown one is a stale screen, not a request.
    if (!agent.cerebellum.getCapabilities().some((c) => c.name === name)) {
      throw new Error(`unknown capability: ${name}`)
    }
    // Locked core capabilities can never be disabled — refuse the write so a
    // stray call can't persist a disabled entry the runtime would ignore anyway.
    if (!enabled && LOCKED_CAPABILITIES.has(name)) return true
    const next = await patchConfig((c) => {
      const disabled = new Set(c.disabledCapabilities ?? [])
      if (enabled) disabled.delete(name)
      else disabled.add(name)
      return { ...c, disabledCapabilities: [...disabled] }
    })
    agent.cerebellum.setDisabled(next.disabledCapabilities ?? [])
    broadcast('cerebellum:capabilitiesChanged', await serializeCapabilities())
    return enabled
  }

  mobileSetCapabilityEnabled = setCapabilityEnabled

  // ---------------------------------------------------------------- mobile
  handle('mobile:status', () => mobileChannel.getStatus())
  handle('mobile:offerQr', () => mobileChannel.offerQr())
  handle('mobile:offerCode', () => mobileChannel.offerCode())
  handle('mobile:unpair', (_event, deviceId?: string) =>
    mobileChannel.unpair(typeof deviceId === 'string' && deviceId ? deviceId : undefined)
  )
  // Both of these settings live on two screens — this panel and the phone's
  // own Channels page — so each one tells the other side. The phone's writes
  // come back through applyMobileSettings and are announced by the broadcast
  // there; a change made HERE needs the push spelled out, because
  // mobile:statusChange is (rightly) on the silent list: it also carries the
  // per-frame tunnel counters, and pushing on those would be a heartbeat.
  handle('mobile:setVerbose', async (_event, verbose: boolean) => {
    const status = await mobileChannel.setVerbose(Boolean(verbose))
    pushMobileChannelConfig()
    return status
  })
  handle('mobile:setNotifications', async (_event, enabled: boolean) => {
    const status = await mobileChannel.setNotificationsEnabled(Boolean(enabled))
    pushMobileChannelConfig()
    return status
  })
  handle('mobile:cancelOffer', () => mobileChannel.cancelOffer())

  // Restore a stored pairing so a phone that was connected yesterday
  // reconnects without anyone touching either device.
  void mobileChannel.start().catch(() => undefined)

  // Keep the phone's list live: the same corpus signals that refresh this
  // app's own list are forwarded over the tunnel.
  agent.corpus.on('conversation.changed', (event) => {
    if (event?.conversationId) void pushConversationToMobile(event.conversationId)
  })
  agent.corpus.on('conversation.deleted', (event) => {
    if (event?.id) mobileChannel.pushConversationDeleted(event.id)
  })
  // Every recorded turn moves the ledger — from ANY channel, not just runs
  // the phone can see.
  agent.corpus.on('usage.recorded', () => mobileChannel.pushUsageChanged())
  // Brainstem runs rewrite the last-run records the phone's Knowledge screen
  // shows; the generic broadcast hook never sees them (no renderer IPC fires).
  agent.corpus.on('brainstem.jobCompleted', () => mobileChannel.pushConfigChanged('brainstem'))
  // A Wolffish-authored skill just passed its first real call — refresh the
  // capabilities panel so its Untested badge clears live, mid-turn, without
  // waiting for a manual resync.
  agent.corpus.on('capability.tested', () => {
    void serializeCapabilities().then((caps) => broadcast('cerebellum:capabilitiesChanged', caps))
  })

  handle('cerebellum:listCapabilities', async () => {
    await agent.init()
    return serializeCapabilities()
  })

  handle('cerebellum:reload', async () => {
    await agent.cerebellum.reload()
    return serializeCapabilities()
  })

  handle('cerebellum:toggleCapability', async (_e, name: string, enabled: boolean) => {
    await setCapabilityEnabled(name, enabled)
  })

  // Import a user-supplied capability (SKILL.md / folder / .zip) into
  // brain/cerebellum/. Validation + staging + copy all happen in the
  // importCapability module; on success the renderer calls cerebellum:reload
  // to pick up the new folder and refresh the list.
  handle('cerebellum:importCapability', async (_e, sourcePath: string) => {
    await agent.init()
    const existingNames = new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
    const result = await importCapability({
      sourcePath,
      cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
      existingNames
    })
    // A successful import is a user-scoped capability: push it to the org
    // registry so the user's other devices materialize it too.
    if (result.ok) scheduleCapabilitySync()
    return result
  })

  // Native picker for the import dropzone's "browse" affordance. On macOS the
  // dialog accepts a file (SKILL.md/.zip) or a folder; on Windows only files
  // (folders still arrive via drag-and-drop). Returns null when canceled.
  handle(
    'cerebellum:pickImport',
    async (_e, options?: { title?: string; filterName?: string }): Promise<string | null> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return null
      // Labels are localized in the renderer and passed in; English fallbacks
      // keep the dialog sane if the call ever arrives without them.
      const result = await dialog.showOpenDialog(mainWin, {
        title: options?.title ?? 'Import capability',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: options?.filterName ?? 'Capability', extensions: ['md', 'zip'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }
  )

  // Delete a user-imported capability — cleanly nuke its folder. Official
  // (bundled) and built-in in-process capabilities are refused so a stray
  // click can't wipe a core feature. A path-containment guard ensures we only
  // ever remove a direct child of brain/cerebellum/, never a folder reached
  // through a crafted path. Returns the refreshed list on success.
  handle('cerebellum:deleteCapability', async (_e, name: string) => {
    await agent.init()
    const cap = agent.cerebellum.getCapabilities().find((c) => c.name === name)
    if (!cap) return { ok: false as const, error: `Capability "${name}" not found.` }

    const outcome = await deleteCapabilityFolder({
      name,
      dir: cap.dir,
      cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
      isOfficial: officialCapability(cap),
      isInProcess: Boolean(cap.inProcess)
    })
    if (!outcome.ok) return outcome
    // Propagate: tombstone the user-scoped registry entry so other devices
    // remove it too (queued locally, so offline deletes still stick).
    void queueUserCapabilityDelete(basename(cap.dir))

    // Forget any disabled-toggle for the gone capability, then reload so the
    // in-memory cerebellum (and the plugin's destroy hook) reflect the removal.
    await patchConfig((c) => ({
      ...c,
      disabledCapabilities: (c.disabledCapabilities ?? []).filter((n) => n !== name)
    }))
    await agent.cerebellum.reload()
    const cfg = await readConfig()
    agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
    return { ok: true as const, capabilities: await serializeCapabilities() }
  })

  // Capability-management bridge handed to the `skills` capability's plugin
  // via its init context. Every method mirrors a `cerebellum:*` IPC handler
  // above so the agent manages skills through the exact same atomic config
  // writes, official-capability guards, and reload path the settings panel
  // uses — there is one implementation of "disable a skill", not two.
  agent.cerebellum.setPluginHost({
    listCapabilities: async () => {
      return agent.cerebellum.getCapabilities().map((c) => ({
        name: c.name,
        description: c.description,
        triggers: c.triggers.keywords,
        tools: c.tools.map((t) => ({ name: t.name, description: t.description })),
        hasPlugin: c.hasPlugin,
        status: c.status,
        enabled: !agent.cerebellum.isDisabled(c.name),
        official: officialCapability(c),
        core: LOCKED_CAPABILITIES.has(c.name),
        wolffish: c.author === WOLFFISH_AUTHOR,
        tested: c.tested !== false,
        inProcess: Boolean(c.inProcess),
        dir: c.dir,
        error: c.error
      }))
    },
    setCapabilityEnabled: async (name, enabled) => {
      await setCapabilityEnabled(name, enabled)
    },
    deleteCapability: async (name) => {
      const cap = agent.cerebellum.getCapabilities().find((c) => c.name === name)
      if (!cap) return { ok: false, error: `Capability "${name}" not found.` }
      const outcome = await deleteCapabilityFolder({
        name,
        dir: cap.dir,
        cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
        isOfficial: officialCapability(cap),
        isInProcess: Boolean(cap.inProcess)
      })
      if (!outcome.ok) return outcome
      void queueUserCapabilityDelete(basename(cap.dir))
      await patchConfig((c) => ({
        ...c,
        disabledCapabilities: (c.disabledCapabilities ?? []).filter((n) => n !== name)
      }))
      await agent.cerebellum.reload()
      const cfg = await readConfig()
      agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
      return { ok: true }
    },
    importCapability: async (sourcePath) => {
      const existingNames = new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
      const result = await importCapability({
        sourcePath,
        cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
        existingNames
      })
      if (result.ok) scheduleCapabilitySync()
      return result
    },
    reload: async () => {
      await agent.cerebellum.reload()
      const cfg = await readConfig()
      agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
    }
  })

  // Cloud-first capabilities: the org registry (R2 + D1 behind the API) is
  // the source of truth; this wiring is its mirror. A pass fires on session
  // ready, after a local import/delete, and on a slow interval; downloads
  // stage silently, and the folder swaps land only while no runs are active
  // (capabilitySync defers and retries until the app goes quiet).
  initCapabilitySync({
    apiBase: API_BASE,
    withAccessToken: (fn) => cloudSession.withAccessToken(fn),
    cerebellumDir: () => join(workspaceRoot(), 'brain', 'cerebellum'),
    runsActive: () => turnRunner.activeRuns().length > 0 || agent.activeAutonomousRuns().length > 0,
    onApplied: async () => {
      await agent.cerebellum.reload()
      const cfg = await readConfig()
      agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
      broadcast('cerebellum:capabilitiesChanged', await serializeCapabilities())
    },
    log: (m) => console.log(m)
  })
  cloudSession.onState((state) => {
    if (state.status === 'ready' || state.status === 'locked') scheduleCapabilitySync()
  })
  {
    const status = cloudSession.getState().status
    if (status === 'ready' || status === 'locked') scheduleCapabilitySync()
  }

  // Automation-management bridge handed to the `automations` capability's
  // plugin via its init context. Every method runs over the live Brainstem so
  // the agent edits the same heartbeat.md the scheduler reads, validates a
  // schedule with the exact parser that registers it, and reloads through the
  // one serialized path the file-watcher uses — there is one source of truth
  // for "what automations exist and when they fire", not two.
  const heartbeatPath = (): string => join(workspaceRoot(), 'brain', 'brainstem', 'heartbeat.md')
  const snapshotAutomations = (): import('@main/runtime/cerebellum').AutomationJobInfo[] => {
    const runningIds = new Set(agent.brainstem.getRunningJobs().map((r) => r.id))
    const statuses = agent.brainstem.getJobStatuses()
    return agent.brainstem.getActiveJobs().map((j) => {
      const preview = previewSchedule(j.label)
      const status = statuses[j.label]
      return {
        id: j.id,
        kind: j.type,
        cron: j.cron,
        label: j.label,
        body: j.body,
        human: preview.ok ? preview.human : '(unrecognized schedule)',
        running: runningIds.has(j.id),
        lastRunAt: status?.lastRunAt ?? null,
        lastStatus: status?.lastStatus ?? null,
        ...(status?.lastError ? { lastError: status.lastError } : {}),
        mode: j.mode
      }
    })
  }
  agent.cerebellum.setAutomationsHost({
    getGlobalMode: async () =>
      (await readConfig().catch(() => null))?.llm.mode === 'workflow' ? 'workflow' : 'single',
    readHeartbeat: async () => {
      const { readFile } = await import('node:fs/promises')
      try {
        return await readFile(heartbeatPath(), 'utf8')
      } catch {
        return ''
      }
    },
    writeHeartbeat: async (raw) => {
      try {
        await diskWriter.writeFileAtomic(heartbeatPath(), raw)
      } catch (err) {
        return {
          ok: false,
          jobs: snapshotAutomations(),
          error: err instanceof Error ? err.message : String(err)
        }
      }
      // Apply live in the same turn rather than waiting on the chokidar watcher,
      // so the agent can verify the new job list immediately. The watcher's
      // own reload on this write is harmless — reloadScheduler is serialized.
      await agent.brainstem.reloadScheduler()
      return { ok: true, jobs: snapshotAutomations() }
    },
    listJobs: () => snapshotAutomations(),
    previewSchedule: (heading) => previewSchedule(heading),
    getRunningJobs: () => agent.brainstem.getRunningJobs(),
    runJobNow: (idOrLabel) => agent.brainstem.runJobNow(idOrLabel)
  })

  // Procedures — the same store the renderer/IPC use, plus a detached run that
  // fires a procedure's prompt through the Brainstem's bounded run pool so it
  // runs exactly like a triggered automation (sealed conversation, in history).
  agent.cerebellum.setProjectsHost({
    list: () => listProjects(),
    create: (payload) => createProject(payload),
    update: (id, patch) => updateProject({ id, ...patch }),
    delete: async (id) => {
      await deleteProject(id)
      return { ok: true as const }
    },
    attachFiles: (projectId, paths) => attachFilesToProject(projectId, paths),
    conversationsFor: async (projectId) => {
      const metas = await listConversations()
      return metas
        .filter((m) => m.projectId === projectId)
        .map((m) => ({
          id: m.id,
          title: m.title,
          updatedAt: m.updatedAt,
          messageCount: m.messageCount
        }))
    }
  })

  agent.cerebellum.setProceduresHost({
    list: () => listProcedures(),
    create: (title, prompt) => createProcedure({ title, prompt }),
    update: (id, patch) => updateProcedure({ id, ...patch }),
    delete: async (id) => {
      await deleteProcedure(id)
      return { ok: true as const }
    },
    run: async (id) => {
      const proc = (await listProcedures()).find((p) => p.id === id)
      if (!proc) return { ok: false, started: false, error: 'Procedure not found.' }
      if (proc.prompt.trim().length === 0) {
        return {
          ok: false,
          started: false,
          error: `Procedure "${proc.title}" has no prompt to run.`
        }
      }
      return agent.brainstem.runDetached(
        proc.prompt,
        proc.title || 'Procedure',
        `procedure:${proc.id}`,
        proc.mode ?? null,
        proc.icon || '📋',
        proc.projectId ?? null,
        // A detached run gets exactly what a Play run gets: the attached files
        // as a model-led list, and a fresh listing of every working folder.
        (proc.files ?? []).map((f) => f.path),
        proc.directories ?? []
      )
    }
  })

  // Voice — read TTS-generated audio files for the renderer's AudioPlayer
  // (source="voice"), download via save dialog, and check existence for
  // past conversations.
  handle('voice:readFile', async (_e, filePath: string): Promise<Buffer> => {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath)
  })
  handle('voice:download', async (_e, filePath: string): Promise<{ ok: boolean }> => {
    const { basename } = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const result = await dialog.showSaveDialog(mainWin, {
      defaultPath: basename(filePath),
      filters: [{ name: 'Audio', extensions: ['mp3'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false }
    const { writeFile } = await import('node:fs/promises')
    const data = await readFile(filePath)
    await writeFile(result.filePath, data)
    return { ok: true }
  })
  handle('voice:revealInFolder', (_e, filePath: string): { ok: boolean } => {
    if (!filePath) return { ok: false }
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
  handle('voice:exists', async (_e, filePath: string): Promise<boolean> => {
    const { access, constants } = await import('node:fs/promises')
    try {
      await access(filePath, constants.F_OK)
      return true
    } catch {
      return false
    }
  })

  // Uploads — file picker, copy-to-workspace, read for renderer playback,
  // existence check for past conversations, metadata for "deleted"
  // placeholders. All paths returned to the renderer are relative to
  // workspace root so the same conversation file plays back identically
  // when the workspace is moved (rare, but the cost of doing it right is
  // zero).
  handle('upload:pickFile', async (): Promise<string[]> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return []
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'All supported',
          extensions: [
            'jpg',
            'jpeg',
            'png',
            'gif',
            'webp',
            'pdf',
            'docx',
            'xlsx',
            'xls',
            'csv',
            'tsv',
            'txt',
            'md',
            'json',
            'pptx',
            'html',
            'htm',
            'zip',
            'mp3',
            'wav',
            'ogg',
            'm4a',
            'flac',
            'webm',
            'mp4',
            'mov',
            'avi',
            'mkv',
            'm4v',
            'wmv',
            'flv'
          ]
        },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        {
          name: 'Documents',
          extensions: [
            'pdf',
            'docx',
            'xlsx',
            'xls',
            'csv',
            'tsv',
            'txt',
            'md',
            'json',
            'pptx',
            'html',
            'htm'
          ]
        },
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'] },
        { name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  handle('upload:pickFolder', async (): Promise<string | null> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return null
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Select working folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle(
    'upload:saveFile',
    async (
      _e,
      payload: { conversationId: string; sourcePath: string; progressId?: string }
    ): Promise<UploadedFileMetadata> => {
      if (!payload?.conversationId) throw new Error('conversationId is required')
      if (!payload?.sourcePath) throw new Error('sourcePath is required')
      // The renderer stages a chip the moment the user picks the file and
      // correlates these ticks to it by progressId — a big copy is not
      // instant, and without them the composer sits blank until it lands.
      const progressId = payload.progressId
      const meta = await saveUpload(
        payload.conversationId,
        payload.sourcePath,
        progressId
          ? (copiedBytes, totalBytes) =>
              broadcast('upload:copyProgress', { progressId, copiedBytes, totalBytes })
          : undefined
      )
      agent.corpus.emit('upload.completed', {
        filePath: meta.filePath,
        type: meta.type,
        sizeBytes: meta.sizeBytes
      })
      return meta
    }
  )

  handle(
    'upload:saveBuffer',
    async (
      _e,
      payload: { conversationId: string; buffer: ArrayBuffer; fileName: string }
    ): Promise<UploadedFileMetadata> => {
      if (!payload?.conversationId) throw new Error('conversationId is required')
      if (!payload?.buffer) throw new Error('buffer is required')
      if (!payload?.fileName) throw new Error('fileName is required')
      const meta = await saveUploadFromBuffer(
        payload.conversationId,
        Buffer.from(payload.buffer),
        payload.fileName
      )
      agent.corpus.emit('upload.completed', {
        filePath: meta.filePath,
        type: meta.type,
        sizeBytes: meta.sizeBytes
      })
      return meta
    }
  )

  handle('upload:readFile', async (_e, relativePath: string): Promise<Buffer | null> => {
    return readUpload(relativePath)
  })

  handle('upload:exists', async (_e, relativePath: string): Promise<boolean> => {
    return uploadExists(relativePath)
  })

  handle(
    'upload:getMetadata',
    async (
      _e,
      relativePath: string
    ): Promise<{ sizeBytes: number; mtimeMs: number; mimeType: string } | null> => {
      const stat = await statUpload(relativePath)
      if (!stat) return null
      const { mimeType } = classifyFile(relativePath)
      return { ...stat, mimeType }
    }
  )

  handle('upload:isSupported', (_e, fileName: string): boolean => {
    return isSupportedExtension(fileName) || categorizeFile(fileName) !== 'unknown'
  })

  handle(
    'upload:validate',
    (
      _e,
      payload: {
        fileName: string
        sizeBytes: number
        currentCount: number
        currentTotalBytes: number
      }
    ): ValidationError | null => {
      return validateFile(
        payload.fileName,
        payload.sizeBytes,
        payload.currentCount,
        payload.currentTotalBytes
      )
    }
  )

  handle(
    'upload:openExternal',
    async (_e, relativePath: string): Promise<{ ok: boolean; error?: string }> => {
      const abs = resolveUploadPath(relativePath)
      if (!abs) return { ok: false, error: 'invalid path' }
      try {
        const error = await shell.openPath(abs)
        if (error) return { ok: false, error }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Stat a path the assistant mentioned in chat so the renderer can decide
  // whether to show a card (and which kind). Resolves a leading ~. Not
  // workspace-scoped: assistant-referenced paths live anywhere on the user's
  // own machine, and this only reads existence/type, never contents.
  handle(
    'upload:statPath',
    async (_e, p: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
      const abs = resolveDevicePath(p)
      if (!abs) return { exists: false, isDirectory: false }
      try {
        const { stat } = await import('node:fs/promises')
        const st = await stat(abs)
        return { exists: true, isDirectory: st.isDirectory() }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
  )

  // List the immediate (top-level) contents of a directory so the chat can
  // attach a working folder's structure to each turn's context. Resolves a
  // leading ~. Not workspace-scoped — working folders are arbitrary absolute
  // paths the user picked. Directories sort first, then alphabetical; the entry
  // count is capped so a huge directory can't blow up the prompt.
  handle(
    'upload:listFolder',
    async (
      _e,
      p: string
    ): Promise<{
      entries: { name: string; isDirectory: boolean }[]
      truncated: boolean
      omittedDirectories?: number
      omittedFiles?: number
      error?: string
    }> => {
      const abs = resolveDevicePath(p)
      if (!abs) return { entries: [], truncated: false, error: 'invalid path' }
      try {
        const { readdir } = await import('node:fs/promises')
        const dirents = await readdir(abs, { withFileTypes: true })
        const sorted = dirents
          .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        const LIMIT = 200
        const omitted = sorted.slice(LIMIT)
        const omittedDirectories = omitted.filter((e) => e.isDirectory).length
        return {
          entries: sorted.slice(0, LIMIT),
          truncated: omitted.length > 0,
          omittedDirectories,
          omittedFiles: omitted.length - omittedDirectories
        }
      } catch (err) {
        return {
          entries: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  // Reveal a path in the OS file manager: a directory opens directly, a file is
  // revealed in its parent folder (selected), like "Reveal in Finder". Resolves
  // a leading ~. Intentionally not workspace-scoped — see statPath.
  handle('upload:revealPath', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const abs = resolveDevicePath(p)
    if (!abs) return { ok: false, error: 'invalid path' }
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(abs)
      if (st.isDirectory()) {
        const error = await shell.openPath(abs)
        if (error) return { ok: false, error }
      } else {
        shell.showItemInFolder(abs)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('upload:download', async (_e, relativePath: string): Promise<{ ok: boolean }> => {
    const abs = resolveUploadPath(relativePath)
    if (!abs) return { ok: false }
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const { basename } = await import('node:path')
    const result = await dialog.showSaveDialog(mainWin, {
      defaultPath: basename(abs)
    })
    if (result.canceled || !result.filePath) return { ok: false }
    const { copyFile } = await import('node:fs/promises')
    await copyFile(abs, result.filePath)
    return { ok: true }
  })

  // Save a copy of a device path (a file the assistant read/wrote anywhere on
  // the user's machine) to a location the user picks. Device counterpart to
  // upload:download — intentionally not workspace-scoped, same as revealPath.
  handle('upload:downloadPath', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const abs = resolveDevicePath(p)
    if (!abs) return { ok: false, error: 'invalid path' }
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false, error: 'no window' }
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(abs)
      if (!st.isFile()) return { ok: false, error: 'not a file' }
      const { basename, resolve } = await import('node:path')
      const result = await dialog.showSaveDialog(mainWin, { defaultPath: basename(abs) })
      if (result.canceled || !result.filePath) return { ok: false }
      // Saving back onto the source is a no-op — skip the copy so we never
      // risk clobbering the original (the file is already where they asked).
      if (resolve(result.filePath) === resolve(abs)) return { ok: true }
      const { copyFile } = await import('node:fs/promises')
      await copyFile(abs, result.filePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('upload:revealInFolder', (_e, relativePath: string): { ok: boolean } => {
    const abs = resolveUploadPath(relativePath)
    if (!abs) return { ok: false }
    shell.showItemInFolder(abs)
    return { ok: true }
  })

  handle('runtime:setLastSettingsState', async (_e, patch: Record<string, string>) => {
    await patchConfig((c) => ({
      ...c,
      lastSettingsState: { ...c.lastSettingsState, ...patch }
    }))
  })

  handle('runtime:setWeekStartsOn', async (_e, value: WeekStartsOn) => {
    await persistWeekStartsOn(value)
    broadcast('preferences:changed', { weekStartsOn: value })
    return { value }
  })
  handle('runtime:getCompactionConfig', async () => {
    return getCompactionConfig()
  })
  handle('runtime:getCompactionRuns', async () => {
    return agent.brainstem.getCompactionRuns()
  })
  handle(
    'runtime:setCompactionConfig',
    async (_e, patch: Partial<import('@main/workspace/workspace').CompactionConfig>) => {
      const updated = await persistCompactionConfig(patch)
      const cfg = updated.compaction!
      agent.brainstem.setCompactionConfig(cfg)
      // Announced like every other settings save: an open panel in another
      // window re-seeds, the floating run card re-reads its visibility, and
      // the generic hook in broadcast() pushes config.changed to the phone.
      broadcast('compaction:configChanged', cfg)
      return cfg
    }
  )
  handle('runtime:getReflectionConfig', async () => {
    return getReflectionConfig()
  })
  handle(
    'runtime:setReflectionConfig',
    async (_e, patch: import('@main/workspace/workspace').ReflectionPatch) => {
      // Shared with the phone's tunnel RPC — persist, reschedule, announce.
      return applyReflectionPatch(patch)
    }
  )
  handle('runtime:runReflectionNow', async () => {
    return agent.brainstem.runReflectionNow()
  })
  handle('runtime:runDeepCleanNow', async () => {
    return agent.brainstem.runDeepCleanNow()
  })
  // Viewer — read-only tree + read/write of individual workspace files.
  handle('viewer:readTree', (): Promise<ViewerTreeNode[]> => readViewerTree())
  handle('viewer:resync', (): Promise<ViewerTreeNode[]> => readViewerTree())
  handle(
    'viewer:readFile',
    (_e, relativePath: string): Promise<string> => readViewerFile(relativePath)
  )
  handle('viewer:writeFile', async (_e, relativePath: string, content: string): Promise<void> => {
    await writeViewerFile(relativePath, content)
    // Saving Soul, User or Agents — from their own pages or from the
    // Workspace file tree — is a change a paired phone mirrors. The
    // announcement reaches other windows directly and the phone through
    // broadcast()'s generic config.changed hook, which is why there is no
    // second push to remember here. Scoped to the three: every other
    // workspace file is desktop-only, and announcing those would make the
    // phone refetch a snapshot that cannot have moved.
    const doc = customizationDocFor(relativePath)
    if (doc) broadcast('customization:changed', { doc, path: CUSTOMIZATION_DOCS[doc] })
  })
  handle(
    'viewer:hasDefault',
    (_e, relativePath: string): Promise<boolean> => hasBundledDefault(relativePath)
  )
  handle(
    'viewer:readDefault',
    (_e, relativePath: string): Promise<string> => readBundledDefault(relativePath)
  )
  handle(
    'viewer:stat',
    (_e, relativePath: string): Promise<{ mtimeMs: number }> => statViewerFile(relativePath)
  )
  handle(
    'viewer:readBinaryFile',
    (_e, relativePath: string): Promise<Buffer> => readViewerBinaryFile(relativePath)
  )
  handle('viewer:download', async (_e, relativePath: string): Promise<{ ok: boolean }> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const fileName = relativePath.split('/').pop() ?? relativePath
    const result = await dialog.showSaveDialog(mainWin, { defaultPath: fileName })
    if (result.canceled || !result.filePath) return { ok: false }
    const buf = await readViewerBinaryFile(relativePath)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(result.filePath, buf)
    return { ok: true }
  })

  handle('viewer:revealInFolder', (_e, relativePath: string): { ok: boolean } => {
    const abs = resolveViewerPath(relativePath)
    if (!abs) return { ok: false }
    shell.showItemInFolder(abs)
    return { ok: true }
  })

  // Heartbeat
  handle('heartbeat:getJobs', () => {
    const jobs = agent.brainstem.getActiveJobs()
    const now = Date.now()
    return jobs.map((j) => ({
      ...j,
      nextRunMs: j.cron ? nextCronMs(j.cron, now) : null
    }))
  })

  // Live run-pool snapshot: up to 3 concurrent runs plus the FIFO overflow.
  // The Automations page's play-button gating renders from this seed + the
  // heartbeat:runsChanged pushes below.
  handle('heartbeat:getRuns', () => ({
    running: agent.brainstem.getRunningJobs(),
    queued: agent.brainstem.getQueuedJobs()
  }))

  // Run an automation on demand from the Heartbeat page's run button. Goes
  // through the same run pool a cron fire uses (up to 3 at once, overflow
  // queued FIFO), and coalesces if the job is already running or queued.
  handle('heartbeat:runJob', (_event, idOrLabel: string) => {
    return agent.brainstem.runJobNow(idOrLabel)
  })

  // Per-job "Edited …" stamps (label → epoch ms), maintained writer-agnostically
  // by the brainstem's reload diff; adoptMeta is the one-shot donation of the
  // legacy renderer-localStorage stamps.
  handle('heartbeat:getMeta', () => agent.brainstem.getHeartbeatEditStamps())
  handle('heartbeat:adoptMeta', (_event, stamps: Record<string, number>) =>
    agent.brainstem.adoptHeartbeatEditStamps(stamps ?? {})
  )

  // An automation's attached files and working directories. Both are stored as
  // marker lines in heartbeat.md — the page owns that write — so these handlers
  // only do the parts that need main: the native pickers, the copy into the
  // workspace, and the deletion of a copy we own. `existing` is the automation's
  // current file list, which is how attachFilesToAutomation finds the dir it
  // already owns instead of minting a second one.
  handle('automations:pickFiles', async (_event, existing: string[] | undefined) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Copying starts only once the picker closes, so these ticks double as the
    // dialog's "the copy is running now" signal — it shows its bar on the first
    // one rather than while the user is still browsing.
    return attachFilesToAutomation(existing ?? [], result.filePaths, (progress) =>
      broadcast('automations:copyProgress', progress)
    )
  })
  handle('paths:pickDirectories', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })
  handle('automations:removeFile', async (_event, filePath: string) => {
    await removeAutomationFile(filePath)
    return { ok: true as const }
  })

  agent.brainstem.setListener({
    onJobStarted: (info) => broadcast('heartbeat:jobStarted', info),
    onJobEnded: (payload) => broadcast('heartbeat:jobEnded', payload),
    onJobLog: (entry) => broadcast('heartbeat:jobLog', entry),
    onRunsChanged: (snapshot) => {
      broadcast('heartbeat:runsChanged', snapshot)
      // The phone's Automations cards gate their play button on the same pool,
      // so the two screens agree about what is already running.
      if (mobileChannel.hasPeer) mobileChannel.pushAutomationRuns(snapshot)
    },
    onCompactionRun: () => broadcast('compaction:changed', {})
  })
  // Every scheduler reload = the heartbeat file changed (any writer: card
  // editor, markdown save, the agent's automation_* tools, once-job
  // self-deletes). Push it so an open Automations page re-fetches jobs and
  // edit stamps instead of showing them stale until re-entry.
  agent.corpus.on('brainstem.schedulerReloaded', () => {
    broadcast('heartbeat:changed', {})
    if (mobileChannel.hasPeer) mobileChannel.pushAutomationsChanged()
  })

  // Procedures — saved prompts the user runs on demand from the Procedures page.
  // Plain CRUD over a JSON file. The store pushes procedures:changed on every
  // committed write, so a page left open re-fetches when the agent's
  // procedure_* tools mutate it outside any renderer action.
  setProceduresChangedListener(() => {
    broadcast('procedures:changed', {})
    // Fires on EVERY committed write — this app's page, the agent's
    // procedure_* tools, or the phone's own editor echoing back. The phone
    // re-lists on it exactly as an open page here re-fetches.
    if (mobileChannel.hasPeer) mobileChannel.pushProceduresChanged()
  })
  handle('procedures:list', () => listProcedures())
  handle(
    'procedures:create',
    (
      _event,
      payload: {
        title: string
        prompt: string
        mode?: 'single' | 'workflow'
        icon?: string
        projectId?: string
      }
    ) => createProcedure(payload)
  )
  handle(
    'procedures:update',
    (
      _event,
      payload: {
        id: string
        title?: string
        prompt?: string
        mode?: 'single' | 'workflow'
        icon?: string
        projectId?: string
        files?: ProcedureFileRef[]
        directories?: string[]
      }
    ) => updateProcedure(payload)
  )
  handle('procedures:delete', async (_event, id: string) => {
    await deleteProcedure(id)
    return { ok: true as const }
  })
  // Pick + COPY in one step, exactly like projects:pickFiles: chosen files are
  // copied into the procedure's uploads/procedure-<id>/ dir and attached;
  // returns the updated procedure, or null on cancel.
  handle('procedures:pickFiles', async (_event, procedureId: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const attached = await attachFilesToProcedure(procedureId, result.filePaths, (progress) =>
      broadcast('procedures:copyProgress', { procedureId, ...progress })
    )
    return attached.procedure
  })

  // Projects — same inert-data shape as procedures (flat JSON list, same
  // projects:changed push); the file picker runs main-side because only main
  // has dialog.
  setProjectsChangedListener(() => {
    broadcast('projects:changed', {})
    if (mobileChannel.hasPeer) {
      mobileChannel.pushProjectsChanged()
      // Projects also ride the config snapshot — the phone's chat project
      // picker reads them from there — so the section that mirrors it has to
      // be refreshed too, not just the Projects screen.
      mobileChannel.pushConfigChanged('projects')
    }
  })
  handle('projects:list', () => listProjects())
  handle(
    'projects:create',
    (_event, payload: { title: string; icon?: string; instructions?: string }) =>
      createProject(payload)
  )
  handle(
    'projects:update',
    (
      _event,
      payload: {
        id: string
        title?: string
        icon?: string
        instructions?: string
        files?: ProjectFileRef[]
        directories?: string[]
      }
    ) => updateProject(payload)
  )
  handle('projects:delete', async (_event, id: string) => {
    await deleteProject(id)
    return { ok: true as const }
  })
  // Pick + COPY in one step: chosen files are copied into the project's
  // uploads/project-<id>/ dir (uniform with conversation uploads) and
  // attached; returns the updated project, or null on cancel.
  handle('projects:pickFiles', async (_event, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Copying starts only once the picker closes, so these ticks double as
    // the dialog's "the copy is running now" signal — it shows its bar on
    // the first one rather than while the user is still browsing.
    const attached = await attachFilesToProject(projectId, result.filePaths, (progress) =>
      broadcast('projects:copyProgress', { projectId, ...progress })
    )
    return attached.project
  })

  // Memory reindex — the cortex search index is rebuilt from scratch after an
  // app update (and on launch). On a large workspace that takes a while, so we
  // surface a blocking overlay with live progress, mirroring the heartbeat one.
  handle('reindex:getStatus', () => agent.cortex.getReindexStatus())
  // The phone gets the same three edges as a card in its overlay stack rather
  // than a takeover — a phone that cannot be used at all while an index
  // rebuilds is a phone that looks broken. Each one re-reads the cortex instead
  // of translating its own payload, so the wire carries the same object the
  // desktop's own overlay renders, and the end fires `null`, which is what
  // retires the card. The channel throttles the progress ticks; start and end
  // go through unthrottled.
  const mirrorReindex = (): void => {
    if (mobileChannel.hasPeer) mobileChannel.pushReindexStatus(agent.cortex.getReindexStatus())
  }
  agent.corpus.on('index.reindexStarted', (p) => {
    broadcast('reindex:started', p)
    mirrorReindex()
  })
  agent.corpus.on('index.reindexProgress', (p) => {
    broadcast('reindex:progress', p)
    mirrorReindex()
  })
  agent.corpus.on('index.reindexed', (p) => {
    broadcast('reindex:ended', p)
    mirrorReindex()
  })

  // Per-conversation diagnostic export — bundles everything relevant to one
  // conversation into a zip under workspace/diagnostics/ for the developer.
  // Serialized behind a single in-flight guard: the collectors read the same
  // log files, and two overlapping runs would only fight over IO.
  //
  // A caller that arrives while a run is in flight ATTACHES to it rather than
  // being turned away. The overlay is remounted by things that have nothing to
  // do with the export (switching session and back re-evaluates its render
  // gate), and a fresh mount that got "already running" would show a failure
  // card for a run that is still going and about to succeed. Same conversation
  // means the same bundle either way; a DIFFERENT conversation is a real
  // conflict and still gets told so.
  //
  // The guard is shared with the PHONE, which asks for the same bundle over
  // the tunnel (Rpc.diagnosticsExport). One collector, one archive, whichever
  // screen pressed the button: two of these running at once would read the
  // same log files and write into the same folder, and the second would only
  // slow the first down.
  let diagnosticsRunning: { conversationId: string; run: Promise<DiagnosticResult> } | null = null
  const runDiagnosticExport = async (
    conversationId: string,
    /** Where progress goes for THIS caller, on top of the renderer broadcast. */
    onProgress?: (progress: DiagnosticProgress) => void
  ): Promise<DiagnosticResult> => {
    if (diagnosticsRunning) {
      if (diagnosticsRunning.conversationId === conversationId) {
        return await diagnosticsRunning.run
      }
      return {
        ok: false,
        error: 'another diagnostic export is already running',
        conversationId,
        conversationTitle: '',
        fileName: '',
        zipPath: '',
        relativePath: '',
        sizeBytes: 0,
        fileCount: 0,
        durationMs: 0,
        modelOpinion: false,
        groups: [],
        warnings: []
      }
    }
    const run = (async (): Promise<DiagnosticResult> => {
      const config = await readConfig()
      const provider = agent.thalamus.getActiveProvider()
      // No model selected → the diagnostic opinion is skipped outright.
      const cloud = provider !== null
      return await exportConversationDiagnostics({
        conversationId,
        env: {
          appVersion: app.getVersion(),
          packaged: app.isPackaged,
          provider,
          model: agent.thalamus.getActiveModel(),
          chatMode: config?.llm.mode ?? 'single',
          locale: config?.locale ?? null
        },
        llm: cloud ? agent.thalamus : null,
        toolCapability: (tool) => agent.cerebellum.getToolCapability(tool),
        capabilities: agent.cerebellum.getCapabilities().map((c) => ({ name: c.name, dir: c.dir })),
        // The renderer always hears it — its overlay may be open for the same
        // conversation — and the caller that asked hears it too.
        onProgress: (p) => {
          broadcast('diagnostics:progress', p)
          onProgress?.(p)
        }
      })
    })()
    // Published before the first await inside `run` can yield, so a caller
    // arriving mid-run always finds it.
    diagnosticsRunning = { conversationId, run }
    try {
      return await run
    } finally {
      diagnosticsRunning = null
    }
  }
  handle(
    'diagnostics:export',
    async (_e, payload: { conversationId: string }): Promise<DiagnosticResult> =>
      await runDiagnosticExport(payload.conversationId)
  )
  // The phone's button, through the same runner. Registered on the channel so
  // the tunnel's handler table stays in one place.
  mobileChannel.setDiagnosticExporter(runDiagnosticExport)

  // "Save a copy" on the confirmation card — the archive already lives in the
  // workspace; this only duplicates it wherever the user points.
  handle(
    'diagnostics:saveCopy',
    async (
      _e,
      payload: { zipPath: string; fileName: string }
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return { ok: false, error: 'no window' }
      const result = await dialog.showSaveDialog(mainWin, {
        defaultPath: join(app.getPath('downloads'), payload.fileName),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        await copyDiagnosticArchive(payload.zipPath, result.filePath)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle('diagnostics:reveal', (_e, zipPath: string): { ok: boolean } => {
    if (!zipPath) return { ok: false }
    shell.showItemInFolder(zipPath)
    return { ok: true }
  })

  // Conversations
  handle('conversation:list', async (): Promise<ConversationMeta[]> => {
    // Fast path: the cortex conversations table answers in <1ms vs the
    // legacy JSON.parse-every-file scan (~140ms today, linear in history).
    // Fall back to the scan when the index is cold/empty (first boot,
    // rebuild in flight) so History is never blank.
    try {
      // A full rebuild DELETEs the conversations table then re-inserts in
      // event-loop-yielded batches — mid-rebuild the table is non-empty but
      // INCOMPLETE, and the >0-rows check below would happily return the
      // partial list. Prefer the disk scan for the rebuild's duration
      // (~140ms per call, rare: schema bumps + explicit rebuilds only).
      if (agent.cortex.getReindexStatus()) return listConversations()
      // No window: this is the full Conversations list, and it has to agree
      // with what the phone shows — the phone reads the same workspace.
      const rows = agent.cortex.listConversations({ limit: Number.MAX_SAFE_INTEGER })
      if (rows.length > 0) {
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          updatedAt: r.updatedAt,
          channel: r.channel as ConversationMeta['channel'],
          projectId: r.projectId,
          icon: r.icon,
          messageCount: r.messageCount
        }))
      }
    } catch {
      // index not ready — fall through
    }
    return listConversations()
  })
  handle('conversation:load', (_e, id: string): Promise<ConversationFile | null> => {
    // Opening a conversation is what triggers its media download (nothing
    // is predownloaded at restore) — fire-and-forget; progress reaches the
    // renderer through conversation:hydrationProgress, and the explicit
    // conversation:hydrate call below dedupes into the same flight.
    void hydrateConversationFiles(id).catch(() => undefined)
    return loadConversation(id)
  })
  handle(
    'conversation:hydrate',
    (_e, id: string): Promise<HydrationProgress> => hydrateConversationFiles(id)
  )
  handle('conversation:save', (_e, conv: ConversationFile): Promise<{ ok: true }> => {
    return trackBackgroundTask(async () => {
      // Titling is done up front by the TurnRunner (a pure LLM call that
      // persists the title before processing), so there's nothing to generate
      // here — just persist. Merge-write: the renderer's copy owns
      // messages/stats, but the disk holds the LLM title and any rolling
      // summary the summarizer advanced since the renderer last synced — a
      // blind whole-file save would clobber those.
      let effectiveTitle = conv.title
      await updateConversation(conv.id, (disk) => {
        const merged = mergeConversationOnto(disk, conv)
        effectiveTitle = merged.title
        return merged
      })
      extensionServer.updateTitle(conv.id, effectiveTitle)
      // Post-persist rolling-summary check (fire-and-forget). When it writes
      // a summary, the onUpdated push folds it into the renderer's in-memory
      // conversation so the NEXT whole-file save keeps it.
      queueConversationSummarization(conv.id)
      return { ok: true as const }
    })
  })
  handle('conversation:delete', async (_e, id: string): Promise<{ ok: boolean }> => {
    // Deleting a conversation whose turn is still running would race the
    // end-of-turn persist and resurrect the file (or strand a live stream
    // with no home). The sidebar disables delete for processing rows; this
    // is the authoritative backstop. Automation/procedure runs now own a real
    // conversation for their whole lifetime, so they need the same guard.
    if (turnRunner.isConversationActive(id) || agent.isAutonomousRunActive(id)) {
      return { ok: false }
    }
    await deleteConversation(id)
    agent.corpus.emit('conversation.deleted', { id })
    return { ok: true }
  })
  handle(
    'conversation:create',
    (_e, model: string | null): ConversationFile => createConversation(model)
  )

  // Active-model capability check used by the renderer to decide whether
  // to allow image uploads: the org catalog's vision flag (vision.ts), with
  // the well-known-family name markers as the cold-cache fallback. Returns
  // false when no model is available at all so the renderer can dim the
  // upload button.
  handle(
    'model:capabilities',
    async (): Promise<{
      provider: string | null
      model: string | null
      supportsVision: boolean
      contextWindow: number
      compactionAt: number
    }> => {
      const contextWindow = await agent.thalamus.resolveActiveContextWindow()
      // Real auto-compaction trigger point for the active model, in tokens —
      // the meter draws it as a tick so the visible % and the compaction
      // trigger share one denominator story.
      const compactionAt = Math.floor(agent.thalamus.getContextBudget() * COMPACTION_THRESHOLD)
      const provider = agent.thalamus.getActiveProvider()
      if (!provider)
        return { provider: null, model: null, supportsVision: false, contextWindow, compactionAt }
      const model = agent.thalamus.getActiveModel()
      const supportsVision = model !== null && cloudModelSupportsVision(provider, model)
      return { provider, model, supportsVision, contextWindow, compactionAt }
    }
  )

  // The org catalog from the main cache: answered at once, a stale copy
  // revalidated behind the answer (a changed list reaches the renderer as
  // model:catalogChanged). The picker renders exactly this list — admin
  // edits the policy, the list changes, the picker follows.
  handle('model:catalog', async () => {
    const models = await getCatalog()
    return { models }
  })

  // Model selection — one lane. Selecting persists to config.json and
  // updates the live runtime, exactly as the old Brain picker did.
  handle('model:select', async (_e, model: string | null): Promise<{ ok: true }> => {
    const updated = await persistModel(model)
    thalamus.setModel(updated.llm.model)
    broadcast('provider:updated', { id: model ? 'cloud' : null })
    return { ok: true }
  })

  handle('provider:setMode', async (_e, mode: 'single' | 'workflow'): Promise<{ ok: true }> => {
    await persistMode(mode === 'workflow' ? 'workflow' : 'single')
    agent.setMode(mode === 'workflow' ? 'workflow' : 'single')
    broadcast('provider:updated', { id: null })
    return { ok: true }
  })

  // Chat — delegated to ElectronChannel. The handler returns the turnId
  // synchronously so the renderer can register listeners before any
  // segment fires. Streaming continues in the background inside the
  // channel.
  handle(
    'chat:send',
    (
      e,
      payload: {
        history: ChatHistoryMessage[]
        conversationId?: string | null
        userMessageId?: string
        assistantMessageId?: string
        workingFolders?: string[]
        contextFiles?: string[]
        thinkingMode?: string
        modeOverride?: 'single' | 'workflow'
        projectId?: string | null
      }
    ) => electronChannel.send(e.sender, payload)
  )

  handle('chat:cancel', async (_e, payload?: { conversationId?: string | null }) => {
    const conversationId = payload?.conversationId ?? null
    const result = await electronChannel.cancel(conversationId)
    // Nothing in-app owned that conversation — it's a terminal, phone (or
    // automation) run the user is watching from the app, so abort it through
    // the runner. Without this the Stop button on a mirrored channel run
    // would be a dead control.
    if (!result.canceled && conversationId) {
      if (turnRunner.cancelConversation(conversationId)) return { canceled: true }
      // Last stop: an automation/procedure run, which never enters the runner
      // — the agent owns those controllers.
      return { canceled: agent.cancelAutonomousRun(conversationId) }
    }
    return result
  })

  // Cold-start snapshot of every conversation currently running, on ANY
  // channel. chat:turnState only broadcasts transitions, so a window opened
  // (or reopened from the tray) mid-run has no way to learn about it —
  // this is how the renderer seeds its live run state.
  // Plan mode per conversation — held in main (runtime/plan-mode) so the
  // composer chip and the paired phone's switch read one stance. A set from
  // either side fans out to every window and to the phone.
  handle('chat:planModeGet', (_e, conversationId: string): boolean =>
    getPlanMode(String(conversationId ?? ''))
  )
  handle(
    'chat:planModeSet',
    (_e, payload: { conversationId: string; planMode: boolean }): boolean =>
      setPlanMode(String(payload?.conversationId ?? ''), payload?.planMode === true)
  )
  onPlanModeChange((change) => broadcast('chat:planMode', change))

  handle('chat:activeRuns', (): ActiveRun[] => [
    ...turnRunner.activeRuns(),
    // Autonomous runs (automations, procedures) bypass the runner entirely,
    // so they carry their own registry — without them a window opened while an
    // automation works would render its conversation idle and editable.
    ...agent.activeAutonomousRuns()
  ])

  // The turn-so-far for one running conversation — the newest live-mirror
  // snapshot of the assistant message being written. chat:activeRuns says a
  // run EXISTS; this says what it has produced. A window opened (or reloaded)
  // mid-run seeds its feed from it instead of showing a bare thinking bubble
  // until the next mirror tick, which across a long tool call is minutes
  // away. Served from the mobile channel's mirror cache, which every
  // channel's mirror feeds — a run started on the phone or by an
  // automation both answer here.
  handle('chat:turnMirror', (_e, conversationId: string) =>
    mobileChannel.turnMirrorFor(String(conversationId ?? ''))
  )

  handle('chat:approvalRespond', (_e, payload: { id: string; decision: ApprovalDecision }) =>
    electronChannel.respondApproval(payload)
  )

  handle('chat:askRespond', (_e, payload: { id: string; response: AskUserResponse }) =>
    electronChannel.respondAsk(payload)
  )

  // Export the current conversation as a paginated PDF. The renderer builds a
  // self-contained transcript HTML (content + print stylesheet); main renders
  // it in a hidden, script-less window and prints it via Chromium's print
  // pipeline — same engine as the browser's "Save as PDF", so page-break CSS
  // in the stylesheet drives clean pagination. The HTML goes through a temp
  // file because data: URLs cap out below real conversation sizes.
  handle(
    'chat:exportPdf',
    async (
      _e,
      payload: { html: string; fileName: string }
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return { ok: false, error: 'no window' }
      const safeName = payload.fileName.replace(/[\\/:*?"<>|]/g, '-')
      const result = await dialog.showSaveDialog(mainWin, {
        defaultPath: join(app.getPath('downloads'), safeName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }

      const { writeFile, unlink } = await import('node:fs/promises')
      const tmpPath = join(app.getPath('temp'), `wfc-chat-export-${Date.now()}.html`)
      let printWin: BrowserWindow | null = null
      try {
        await writeFile(tmpPath, payload.html, 'utf8')
        printWin = new BrowserWindow({
          show: false,
          webPreferences: {
            javascript: false,
            nodeIntegration: false,
            contextIsolation: true
          }
        })
        await printWin.loadFile(tmpPath)
        const pdf = await printWin.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate:
            '<div style="width:100%;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#9ca3af;">' +
            '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
          margins: { top: 0.55, bottom: 0.65, left: 0.55, right: 0.55 }
        })
        await writeFile(result.filePath, pdf)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        printWin?.destroy()
        void unlink(tmpPath).catch(() => undefined)
      }
    }
  )

  // Usage — aggregated token & cost data from markdown files.
  // Fire-and-forget load so the cache is warm by the time the user opens
  // the usage tab. Does not block window creation.
  void agent.usage.load().catch(() => undefined)

  /**
   * Same fast-path/fallback split as conversation:list above, for the same
   * reason: the cortex conversations table answers a COUNT in microseconds,
   * where the legacy scan reads and JSON.parses every conversation file
   * (~300ms over the current corpus, linear in history) to look at one number
   * in each. Falls back to the scan whenever the index can't be trusted —
   * mid-rebuild the table is DELETEd and refilled in yielded batches, and
   * unlike a partial list a wrong COUNT looks perfectly plausible.
   */
  const countConversations = async (cutoffMs: number): Promise<number> => {
    try {
      if (!agent.cortex.getReindexStatus()) {
        const n = agent.cortex.countConversationsSince(cutoffMs)
        if (n !== null) return n
      }
    } catch {
      // Index unusable — fall through to the scan.
    }
    return countConversationsSince(cutoffMs)
  }

  handle('usage:getSummary', async (_e, range: UsageTimeRange) => {
    return agent.usage.getSummary(range)
  })
  handle('usage:getStats', async (_e, range: UsageTimeRange) => {
    const stats = await agent.usage.getStats(range)
    const cutoffMs = rangeCutoffMs(range)
    return { ...stats, conversations: await countConversations(cutoffMs) }
  })
  handle('usage:getDaily', async (_e, year: number) => {
    return agent.usage.getDaily(year)
  })
  handle('usage:sync', async () => {
    await agent.usage.sync()
    return { ok: true as const }
  })

  // The org leaderboard. A pass-through, deliberately: the ranking, the
  // paging and the search all belong to the server (one cached board for
  // the whole org), so nothing here caches, sorts or filters a second time.
  handle(
    'leaderboard:list',
    async (_e, params: { limit?: number; offset?: number; q?: string } = {}) =>
      cloudSession.withAccessToken((token) => fetchLeaderboard(token, params))
  )

  // Inline images in transcripts and the browser capability's screenshot
  // links: `wolffish-media://<workspace-relative path>`, served from the
  // workspace. The parser is shared with the renderer's scheme constant.
  protocol.handle('wolffish-media', (request) => {
    const relativePath = workspaceMediaPath(request.url)
    if (!relativePath) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(join(workspaceRoot(), relativePath)).href)
  })

  createTray(cfg?.locale ?? 'en')
  createWindow()

  app.on('activate', () => {
    const win = mainBrowserWindow()
    if (win) {
      win.show()
      showDock()
    } else {
      createWindow()
      showDock()
    }
  })
})

app.on('before-quit', (event) => {
  isQuittingFromTray = true
  if (quitInProgress) {
    event.preventDefault()
    return
  }
  if (isShuttingDown || !hasInflightWork()) return

  wlog.info('[quit]', 'inflight work — draining before quit')
  event.preventDefault()
  quitInProgress = true
  broadcast('app:closingPending', { tasks: pendingBackgroundTasks })
  void drainAndQuit()
})

app.on('will-quit', () => {
  // Last-resort synchronous sweep for stdio MCP children: the idle quit
  // path never runs the async drain, and Node does not kill children on
  // parent exit — a server that ignores stdin EOF would orphan.
  mcpManager.killAllSync()
  if (lockAcquired) {
    releaseLockSync(lockfilePath())
    lockAcquired = false
  }
})

app.on('window-all-closed', () => {
  // Keep the app alive in the tray on all platforms
})

function rangeCutoffMs(range: UsageTimeRange): number {
  const now = new Date()
  switch (range) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    case 'this_month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    case '3_months':
      return new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime()
    case '6_months':
      return new Date(now.getFullYear(), now.getMonth() - 6, 1).getTime()
    case 'ytd':
      return new Date(now.getFullYear(), 0, 1).getTime()
    case 'all_time':
      return 0
  }
}
