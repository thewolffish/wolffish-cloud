/**
 * Builds the config snapshot the phone renders.
 *
 * The shape is `ConfigSnapshot` in wolffish-mobile (`src/state/demoConfig.ts`)
 * — the exact object demo mode already ingests. Serving the same shape live is
 * what lets every settings screen on the phone work in paired mode without a
 * single change: the phone calls `applySnapshot()` either way and cannot tell
 * a downloaded demo bundle from a live desktop.
 *
 * Every optional field in that contract is genuinely optional ("absent in
 * bundles published before X shipped"), so a section this builder cannot
 * resolve is omitted rather than faked, and the phone falls back to its
 * documented default instead of rendering an invented number.
 *
 * The reference artifact for the contract is the committed demo snapshot
 * (wolffish-mobile/demo-data/config-snapshot.json): every key below exists
 * there in the same shape. Field names come from WorkspaceConfig
 * (workspace/workspace.ts) — the real ones, not paraphrases: `screenshotMaxWidth`
 * not `width`, `runCards` not `cards`. Getting one wrong does
 * not error anywhere; it renders a silent default on the phone forever.
 */
import type { Agent } from '@main/runtime/agent'
import { catalogModels } from '@main/cloud/catalog'
import { readViewerFile } from '@main/viewer'
import { readConfig } from '@main/workspace/workspace'
import { app } from 'electron'

/** Mirrors wolffish-mobile's ConfigSnapshot. Kept structural on purpose: the
 * phone owns the canonical type, and over-typing it here would mean editing
 * two repos for every field the phone learns to render. */
export type ConfigSnapshot = Record<string, unknown>

/** Untyped JSON read from the workspace: every access goes through a coercion
 * helper below, so the shape is deliberately loose rather than a lie. */
type Cfg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type CapabilitySerializer = () => Promise<
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
>

export type SnapshotSources = {
  agent: Agent
  /** index.ts already has this closure for the settings IPC; reuse it rather
   * than reaching into cerebellum a second way. */
  serializeCapabilities: CapabilitySerializer
  /** Optional extras — omitted from the snapshot when they throw or are absent. */
  dataAnalytics?: () => Promise<Record<string, unknown>>
  /** The org's web-search lane (main/brave.ts): its state feeds the phone's
   * Brave switch as read-only status — the key lives at the edge, not here. */
  searchLane?: () => Promise<{ state: string }>
  usageDays?: () => Promise<unknown[]>
  /** brain/projects.json — the store the Projects page edits, NOT config.json. */
  projects?: () => Promise<unknown[]>
  /** Brainstem last-run records, for the phone's Knowledge cards. */
  compactionRuns?: () => Promise<Record<string, unknown>>
  /** Live browser-extension server state — which browsers are connected now.
   * Structural (readonly unknown[]) so the server's own interface assigns
   * without an index signature; each row is coerced field by field below. */
  extensionStatus?: () => Promise<{
    status?: string
    port?: number
    extensionVersion?: string | null
    browsers?: readonly unknown[]
  }>
  /**
   * Whether autostart is ACTUALLY registered with the OS right now. Optional
   * because it shells out (systemctl / launchctl / schtasks) and a snapshot
   * must never fail on it — absent simply omits the field.
   */
  launchAtStartupActive?: () => Promise<boolean>
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

const int = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** What the phone's Updates/Data cards print — a name, not a node constant. */
const platformLabel = (platform: NodeJS.Platform): string =>
  platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
      ? 'Windows'
      : platform === 'linux'
        ? 'Linux'
        : platform

/**
 * How long any one section may take before the snapshot goes without it.
 *
 * Generous on purpose — these are local reads and one cached API status, and
 * a section that needs longer than this is not slow, it is stuck.
 */
const SOURCE_TIMEOUT_MS = 5_000

/**
 * Never let one unavailable section fail — or STALL — the whole snapshot.
 *
 * The timeout is the load-bearing half. Every source here is a promise from
 * somewhere else in the app (a token refresh, an API status, a workspace
 * scan, an OS query), and a single one that never settles used to take the
 * entire snapshot with it: the phone's `configSnapshot` RPC never answered,
 * the file the phone reads when this desktop is away was never rewritten, and
 * the in-flight latch below never cleared — so every later config change
 * coalesced into a promise that would never resolve. Silently, with no error
 * to log, until the app was restarted. A phone that quietly stops seeing this
 * machine's settings is the worst possible failure here, and it is exactly
 * what an unbounded await produces.
 *
 * Losing one section costs the phone one card's worth of freshness — the
 * documented "absent means fall back" contract every optional field already
 * has — while losing the snapshot costs it every screen at once.
 */
async function attempt<T>(fn: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!fn) return undefined
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SOURCE_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Thinking modes the desktop stores per model. Exported because both
 * directions consult it: the snapshot below refuses to send a stored value
 * outside the set, and applyMobileSettings (index.ts) refuses to persist one
 * — so a phone and a desktop that disagree about what counts as a mode fail
 * loudly instead of storing junk.
 */
export const THINKING_MODES = new Set(['off', 'on', 'high', 'max'])

/**
 * May the phone select this model?
 *
 * The catalog it picks from is the one this snapshot sent, so the honest guard
 * is the same list: a phone that has been asleep since an admin narrowed the
 * policy would otherwise write a withdrawn model here and leave every turn
 * failing upstream until someone noticed and re-picked. Refusing is cheap and
 * self-correcting — applyMobileSettings throws, and the phone answers a
 * refusal by re-pulling the snapshot, which puts the real model back under the
 * user's thumb.
 *
 * An EMPTY catalog allows anything, deliberately: empty means "not fetched
 * yet" (a cold cache, a signed-out session), never "nothing is allowed", and
 * turning a missing local cache into a refusal would break selection on the
 * one path — a phone driving a desktop that just launched — where it has to
 * work. The API stays the authority either way; this only stops a write the
 * desktop can already see is stale.
 */
export function modelSelectable(id: string): boolean {
  const catalog = catalogModels()
  return catalog.length === 0 || catalog.some((model) => model.id === id)
}

/**
 * The three hand-written documents that shape the agent — the desktop's Soul,
 * User and Agents pages (pages/Soul.tsx, User.tsx, Agents.tsx), which are all
 * one MarkdownEditorPage over one workspace file.
 *
 * Declared once, here, because BOTH directions index into it: the snapshot
 * below reads these paths, and applyMobileSettings (index.ts) writes them from
 * the `<key>Markdown` config keys the phone sends. A path typo split across
 * two files would read one document and write another.
 *
 * The runtime only ever READS them (prefrontal.ts assembles them into the
 * system prompt) and the launch migrations deliberately skip them ("custom
 * agent instructions belong in brain/prefrontal/agents.md, which we never
 * overwrite"), so the desktop's editor and the phone are the only writers —
 * which is what lets a broadcast on each write be a complete change signal.
 */
export const CUSTOMIZATION_DOCS = {
  soul: 'brain/identity/soul.md',
  user: 'brain/identity/user.md',
  agents: 'brain/prefrontal/agents.md'
} as const

export type CustomizationDoc = keyof typeof CUSTOMIZATION_DOCS

/**
 * How much of one document may ride the wire.
 *
 * Whole snapshots and whole config writes are single RPC frames, and the relay
 * drops any record over 1 MiB. Without a ceiling here one oversized soul.md
 * would not merely degrade the Customization screen — it would break EVERY
 * settings screen, because they all render the one snapshot it rides in.
 *
 * 64 KiB is ~12x the largest bundled default (soul.md, 5.5 KB) and roughly ten
 * thousand words, while leaving the rest of a real snapshot — capabilities and
 * the model catalog at ~9 KB each, a usage ledger that grows for years — a
 * budget that cannot be squeezed by what someone typed into an identity file.
 */
export const CUSTOMIZATION_MAX_BYTES = 64 * 1024

/**
 * The three documents as the phone renders them.
 *
 * A missing or unreadable file is '' — the same "nothing written yet" the
 * desktop's own editor shows — while a file too large to send is OMITTED and
 * named in `oversized`. The distinction is load-bearing: the phone must never
 * be handed a truncated document it could save back over the real one, so an
 * oversized doc gets no text at all and the screen turns read-only.
 */
async function readCustomizationDocs(): Promise<{
  soul?: string
  user?: string
  agents?: string
  oversized?: string[]
}> {
  const docs: Record<string, string> = {}
  const oversized: string[] = []
  await Promise.all(
    (Object.keys(CUSTOMIZATION_DOCS) as CustomizationDoc[]).map(async (doc) => {
      let text: string
      try {
        text = await readViewerFile(CUSTOMIZATION_DOCS[doc])
      } catch {
        // Never written, or unreadable — an empty editor, not a broken screen.
        docs[doc] = ''
        return
      }
      if (Buffer.byteLength(text, 'utf8') > CUSTOMIZATION_MAX_BYTES) oversized.push(doc)
      else docs[doc] = text
    })
  )
  return { ...docs, ...(oversized.length ? { oversized: oversized.sort() } : {}) }
}

export async function buildConfigSnapshot(sources: SnapshotSources): Promise<ConfigSnapshot> {
  const config = ((await readConfig()) ?? {}) as Cfg
  // Through `attempt` like every other source: the capability serializer walks
  // the cerebellum's plugins, and at boot it can be mid-load. A `.catch` alone
  // covers a rejection but not a hang.
  const capabilities = (await attempt(sources.serializeCapabilities)) ?? []
  const launchAtStartupActive = await attempt(sources.launchAtStartupActive)

  const llm = (config.llm ?? {}) as Cfg
  const mobile = (config.mobile ?? {}) as Cfg
  const stt = (config.stt ?? {}) as Cfg
  const tts = (config.tts ?? {}) as Cfg
  const computerUse = (config.computerUse ?? {}) as Cfg
  const browserExtension = (config.browserExtension ?? {}) as Cfg
  const mcp = (config.mcp ?? {}) as Cfg
  const compaction = (config.compaction ?? {}) as Cfg
  const reflection = (config.reflection ?? {}) as Cfg
  const safety = (config.safety ?? {}) as Cfg

  const [data, usageDays, projects, compactionRuns, extension] = await Promise.all([
    attempt(sources.dataAnalytics),
    attempt(sources.usageDays),
    attempt(sources.projects),
    attempt(sources.compactionRuns),
    attempt(sources.extensionStatus)
  ])

  // Not an `attempt`: the reader already answers '' per unreadable document,
  // so there is no failure mode that should cost the section as a whole.
  const customization = await readCustomizationDocs()

  // Per-model thinking mode for the current Brain. Absent unless the user has
  // actually chosen one for this model — the phone falls back to its default
  // rather than this side inventing a choice the desktop never made.
  const thinkingModes = (llm.thinkingModes ?? {}) as Record<string, unknown>
  const thinkingMode = thinkingModes[str(llm.model)]

  // The org catalog, straight from main's cache (cloud/catalog.ts) — a
  // synchronous read, never a fetch: a snapshot must not wait 15s behind
  // /v1/models on a cold start, and it must not fail when the session is
  // signed out. An empty cache OMITS the list rather than sending [], which
  // the phone reads as "no catalog yet" and answers with the current model
  // alone; the refresh that fills the cache fires model:catalogChanged, and
  // that broadcast rebuilds and re-pushes this snapshot (see index.ts).
  const catalog = catalogModels()

  const snapshot: Record<string, unknown> = {
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      enabled: capability.enabled,
      official: capability.official,
      core: capability.core,
      hasPlugin: capability.hasPlugin,
      toolCount: capability.toolCount,
      requires: capability.requires
    })),

    // The phone renders name + enabled only; server definitions (commands,
    // headers, oauth state — all secrets) stay desktop-side.
    mcpServers: Array.isArray(mcp.servers)
      ? (mcp.servers as Cfg[]).map((server) => ({
          name: str(server?.name, str(server?.slug, 'server')),
          enabled: bool(server?.enabled, true)
        }))
      : [],

    // Variable[] verbatim minus nothing: the Variables page renders name,
    // value and the sensitive flag (masked display). The tunnel is end-to-end
    // sealed, and both devices are the same person's.
    variables: (Array.isArray(config.variables) ? config.variables : [])
      .filter((variable: Cfg) => typeof variable?.name === 'string' && variable.name)
      .map((variable: Cfg) => ({
        name: variable.name,
        value: str(variable?.value),
        sensitive: bool(variable?.sensitive)
      })),

    // Soul, User and Agents — the markdown the phone's Customization screen
    // edits, verbatim. Full text rather than a size or a preview: the screen
    // shows the document and writes it back, and a half-loaded document is a
    // document that cannot be edited safely.
    customization,

    services: {
      // Web search is the org's lane: "on" means the org has it switched on
      // with a key at the edge. Sent as '' rather than omitted — an omitted
      // key makes the phone show its demo placeholder, and a phone write to
      // either field is refused by applyMobileSettings.
      braveEnabled: (await attempt(sources.searchLane))?.state === 'ready',
      braveApiKey: '',
      sttModel: str(stt.defaultModel, 'small'),
      // Pinned transcription language ('auto' = Whisper detection). The 'en'
      // fallback mirrors the plugin's own default for an unset config.
      sttLanguage: str(stt.language, 'en'),
      ttsVoice: str(tts.defaultVoice, 'af_bella'),
      ttsSpeed: str(tts.defaultSpeed, '1.0'),
      // Voice prompts get spoken replies — absent-means-on.
      ttsVoiceReplies: tts.voiceReplies !== false,
      screenshotMaxWidth: str(computerUse.screenshotMaxWidth, '1280'),
      screenshotFormat: str(computerUse.screenshotFormat, 'jpeg'),
      browserExtension: {
        port: int(browserExtension.port, 23152),
        screenshotMaxWidth: int(browserExtension.screenshotMaxWidth, 1280),
        screenshotFormat: str(browserExtension.screenshotFormat, 'jpeg'),
        screenshotQuality: int(browserExtension.screenshotQuality, 80),
        connected: extension?.status === 'connected',
        browsers: (extension?.browsers ?? []).map((entry) => {
          const browser = (entry ?? {}) as Cfg
          return {
            browser: str(browser.browser),
            name: str(browser.name, 'Browser'),
            browserVersion: str(browser.browserVersion) || null,
            os: str(browser.os) || null,
            profileEmail: str(browser.profileEmail) || null,
            extensionVersion: str(browser.version) || null,
            connectedAt: typeof browser.connectedAt === 'number' ? browser.connectedAt : null
          }
        })
      },
      // Computer use is this app driving this machine's screen and input —
      // present by construction while the desktop runs. The row exists so the
      // phone reports it as this machine's, not a hardcoded guess.
      computerUse: {
        connected: true,
        connections: [{ label: platformLabel(process.platform), detail: 'screen + input' }]
      }
    },

    channels: {
      inapp: {
        verbose: bool(config.inapp?.verbose),
        // Whether a running automation cards over the DESKTOP's chat. The
        // phone renders and edits it as that machine's setting, exactly as it
        // does the in-app feed switch beside it; its own copy of the question
        // is `mobile.runCards` below.
        runCards: bool(config.inapp?.runCards),
        // Whether the thinking card renders at all. One workspace answer for
        // both surfaces (the phone obeys the same key), off by default.
        reasoning: bool(config.inapp?.reasoning)
      },
      // The phone's own channel — the two settings the Mobile panel here
      // carries, so the phone can render and edit them rather than being the
      // one device that cannot see what it is set to. Notifications default
      // ON (MobileChannelConfig), the feed defaults clean.
      mobile: {
        notifications: bool(mobile.notifications, true),
        verbose: bool(mobile.verbose),
        // The phone's own floating automation cards. Off by default, and the
        // phone is the surface that obeys it — the desktop only stores it.
        runCards: bool(mobile.runCards)
      }
    },

    // One lane: the selected model is an id from the org's catalog. The
    // phone's Model screen shows it and picks another from `models` below
    // (brainModel is the writable key); there are no provider keys and no
    // local models.
    llm: {
      brainProvider: 'cloud',
      brainModel: str(llm.model),
      chatMode: str(llm.mode, 'single'),
      ...(typeof thinkingMode === 'string' && THINKING_MODES.has(thinkingMode)
        ? { thinkingMode }
        : {}),
      // Every model this user is allowed, in the API's own order — the same
      // list this app's composer picker renders, so the phone's chips and the
      // desktop's rows can never offer different models. Prices are left out
      // deliberately: the ledger already carries what a turn actually cost,
      // and a per-model rate is the one number here that goes stale silently.
      ...(catalog.length
        ? {
            models: catalog.map((model) => ({
              id: model.id,
              name: model.name,
              reasoning: model.reasoning,
              vision: model.vision,
              contextWindow: model.contextWindow,
              default: model.default
            }))
          }
        : {})
    },

    preferences: {
      launchAtStartup: bool(config.launchAtStartup, true),
      // What is ACTUALLY registered with the OS, which is not the same
      // question as what the user asked for. They disagree whenever the
      // registration failed or was never possible — the state Linux was
      // silently in for as long as the app used Electron's login-item API
      // there. Surfaced so a settings row can say "On · Inactive" instead of
      // claiming success. Undefined when the caller didn't supply the probe.
      ...(launchAtStartupActive === undefined
        ? {}
        : { launchAtStartupActive: launchAtStartupActive }),
      theme: str(config.theme, 'system'),
      locale: str(config.locale, 'en'),
      bypassPermissions: bool(safety.bypassPermissions),
      blockCredentials: bool(safety.blockCredentials, true),
      weekStartsOn: config.weekStartsOn === 0 ? 0 : 1
    },

    desktop: {
      version: app.getVersion(),
      platform: platformLabel(process.platform),
      // IANA zone the schedules below fire in. The phone renders this
      // machine's clock and next-run countdowns from it instead of quietly
      // assuming the two devices share a timezone.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      syncedAt: new Date().toISOString()
    },

    // Defaults mirror DEFAULT_REFLECTION (3 / 12), not invented ones — an
    // unset config must read the same on both screens.
    reflection: {
      hour: int(reflection.hour, 3),
      quietHours: int(reflection.quietHours, 12),
      // Floating run cards for the nightly review and the deep clean — one
      // switch for both surfaces, defaulting off like the compaction twin.
      cards: bool(reflection.cards)
    },

    compaction: {
      // Defaults mirror CompactionConfig's own (23 / Sunday / 23), not
      // invented ones — an unset schedule must read the same on both screens.
      dailyHour: int(compaction.dailyHour, 23),
      weeklyDay: int(compaction.weeklyDay, 0),
      weeklyHour: int(compaction.weeklyHour, 23),
      // Floating run cards for the daily/weekly passes — both surfaces, off by
      // default: housekeeping that finished is what the last-run cards report.
      cards: bool(compaction.cards),
      ...(compactionRuns
        ? {
            runs: {
              daily: compactionRuns.daily ?? null,
              weekly: compactionRuns.weekly ?? null,
              // The reflection jobs report through the same brainstem meta
              // file; the phone's Knowledge screen renders all four cards.
              reflection: compactionRuns.reflection ?? null,
              deepClean: compactionRuns.deepClean ?? null
            }
          }
        : {})
    }
  }

  if (data) snapshot.data = data
  if (Array.isArray(usageDays)) snapshot.usage = { days: usageDays }

  if (Array.isArray(projects)) {
    snapshot.projects = (projects as Cfg[]).map((project) => ({
      id: str(project?.id),
      title: str(project?.title),
      icon: str(project?.icon),
      instructions: str(project?.instructions),
      files: (Array.isArray(project?.files) ? project.files : []).map((file: Cfg) => ({
        path: str(file?.path),
        name: str(file?.name)
      })),
      // Absolute desktop paths, verbatim — the phone shows them and cannot
      // resolve them, which is the point of showing the whole path.
      directories: (Array.isArray(project?.directories) ? project.directories : []).map((dir) =>
        str(dir)
      ),
      createdAt: int(project?.createdAt, 0),
      updatedAt: int(project?.updatedAt, 0)
    }))
  }

  return snapshot
}
