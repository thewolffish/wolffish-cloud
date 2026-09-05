import type { UsageDay } from '@/lib/usage/stats'
import type { AutomationJob, SyncProcedure } from '@/lib/bridge/protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useEffect, useState } from 'react'
import {
  captureOutboxState,
  markOutboxEdited,
  outboxIsDirty,
  outboxKeysToKeepLocal,
  pushVariables,
  settleOutboxKey
} from '@/lib/sync/outbox'
import { bridgeClient } from '@/lib/cloud/bridge'
import { Rpc } from '@/lib/bridge/protocol'
import { fetchConfigSnapshot } from '@/lib/sync/snapshot'
import { useAppStore } from '@/state/appStore'

/**
 * Demo-mode mirror of the desktop's config.json (workspace.ts
 * WorkspaceConfig). Fully offline: every edit persists locally — when the
 * live Durable Object sync lands, this store becomes the cached copy that
 * renders instantly and refreshes in the background.
 *
 * Performance contract: values are FLAT keys edited through one generic
 * `setValue`, and every row subscribes via `useConfigValue(key)` — a
 * single-field zustand selector. Flipping one switch re-renders exactly one
 * row, never a panel tree, and there is no JSON parse on the edit path.
 */

export type ChatMode = 'single' | 'workflow'
export type ThinkingLevel = 'off' | 'on' | 'high' | 'max'

export type DemoVariable = { name: string; value: string; sensitive: boolean }

export type ServiceConnection = { label: string; detail: string }

/**
 * A project — the desktop's Project (main/projects.ts) minus the file bytes:
 * a maintained set of instructions conversations are spawned from. Carried in
 * the config snapshot because it is workspace state, not conversation state;
 * conversations bind to one by the `projectId` stamped on their file.
 */
export type DemoProject = {
  id: string
  title: string
  /** Emoji icon, exactly as the desktop stores it. */
  icon: string
  instructions: string
  files: Array<{ path: string; name: string }>
  /** Working folders on the desktop; absent in bundles built before the field. */
  directories?: string[]
  createdAt: number
  updatedAt: number
}

export type ServiceStatus = {
  /** i18n key suffix under settings.services.items */
  key: string
  connected: boolean
  connections: ServiceConnection[]
}

/**
 * Last completed run of a compaction job — the desktop's CompactionRunRecord
 * (main/runtime/brainstem.ts) verbatim. Skipped fires never overwrite it, so
 * the card always describes a run that actually produced output.
 */
export type CompactionRunRecord = {
  /** Epoch ms when the run finished. */
  at: number
  durationMs: number
  /** Null for the weekly digest — that pass makes no LLM call. */
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** The run's raw output: daily summary text / weekly digest line. */
  output: string
}

export type CompactionRuns = {
  daily: CompactionRunRecord | null
  weekly: CompactionRunRecord | null
  /** Nightly reflection pass — optional so persisted pre-feature stores parse. */
  reflection?: CompactionRunRecord | null
  /** Monthly deep reflection (internally `deepClean`). */
  deepClean?: CompactionRunRecord | null
}

/**
 * One model in the organization's catalog, as the desktop's snapshot carries
 * it (`llm.models` — the API's GET /v1/models, in its own order).
 *
 * The same list the desktop's own composer picker renders, which is the point:
 * both surfaces offer exactly the models the org allows this user, and neither
 * can invent one. Prices are not carried — the usage ledger already knows what
 * a turn cost, and a per-model rate is the field that would go stale in silence.
 */
export type ModelCatalogEntry = {
  id: string
  /** Display name from the catalog; falls back to the id when absent. */
  name: string
  reasoning: boolean
  vision: boolean
  /** Input-token window, 0 when the catalog did not say. */
  contextWindow: number
  /** The org's default pick — the model a fresh desktop adopts. */
  default: boolean
}

/**
 * Coerce the snapshot's model list field by field. It arrives from the paired
 * desktop, and a row missing `id` is not a model — it would render an unnamed
 * chip that writes an empty selection.
 */
function sanitizeModelCatalog(rows: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const models: ModelCatalogEntry[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
      reasoning: entry.reasoning === true,
      vision: entry.vision === true,
      contextWindow:
        typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow)
          ? Math.max(0, Math.round(entry.contextWindow))
          : 0,
      default: entry.default === true
    })
  }
  return models
}

/** Model catalog for the demo — the models actually seen in the imported data. */
export const DEMO_MODELS: Array<{ provider: string; model: string }> = [
  { provider: 'anthropic', model: 'claude-opus-4-8' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'deepseek', model: 'deepseek-v4-pro' },
  { provider: 'kimi', model: 'kimi-k2.5' },
  { provider: 'zai', model: 'glm-5' },
  { provider: 'xai', model: 'grok-5' },
  { provider: 'qwen', model: 'qwen4-max' },
  { provider: 'openai', model: 'gpt-5.6' },
  { provider: 'local', model: 'qwen4:8b' }
]

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'on', 'high', 'max']

/** Model-name prefixes → provider, for readings that predate provider stamps. */
const MODEL_PREFIXES: Array<[string, string]> = [
  ['claude', 'anthropic'],
  ['gpt', 'openai'],
  ['o1', 'openai'],
  ['deepseek', 'deepseek'],
  ['kimi', 'kimi'],
  ['glm', 'zai'],
  ['grok', 'xai'],
  ['qwen', 'qwen'],
  ['step', 'stepfun'],
  ['minimax', 'minimax'],
  ['mimo', 'mimo']
]

/**
 * Best-effort provider for a model name. The demo catalog answers first; the
 * imported dataset also carries models it never listed (kimi-k3, glm-5.2), so
 * the prefix table catches those rather than dropping the brand mark.
 */
export function providerForModel(model: string | null | undefined): string | null {
  if (!model) return null
  const known = DEMO_MODELS.find((entry) => entry.model === model)
  if (known) return known.provider
  const lower = model.toLowerCase()
  return MODEL_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null
}

const READ_ONLY_SERVICES: ServiceStatus[] = [
  {
    key: 'computerUse',
    connected: true,
    connections: [{ label: 'macOS', detail: 'screen + input' }]
  },
  {
    key: 'browserExtension',
    connected: false,
    connections: [{ label: 'Chrome extension', detail: 'port 23151' }]
  }
]

/** Cerebellum capabilities seen in the workspace — togglable like the desktop. */
const DEFAULT_CAPABILITIES: Record<string, boolean> = {
  'web-search': true,
  'browser-automation': true,
  'document-builder': true,
  'chart-forge': true,
  'daily-notes': true,
  'news-butler': true,
  'email-digest': true,
  'screen-watch': false
}

/** MCP servers from the desktop config — enable/disable only, no add/OAuth. */
const DEFAULT_MCP_SERVERS: Record<string, boolean> = {
  'notion-mcp': true,
  'github-mcp': true,
  'filesystem-mcp': false
}

/** The editable config surface — flat keys for single-field subscriptions. */
export type DemoConfigValues = {
  // --- llm / brain ---
  /**
   * The org lane's current model, as the desktop reports it. One lane in the
   * cloud edition — no local engine, no per-provider keys — so these two are
   * the whole model surface. The provider id is whatever the desktop stamps:
   * display only, it never travels back.
   */
  brainProvider: string
  brainModel: string
  chatMode: ChatMode
  thinkingMode: ThinkingLevel
  // --- preferences ---
  launchAtStartup: boolean
  bypassPermissions: boolean
  blockCredentials: boolean
  weekStartsOn: 0 | 1
  // --- channels ---
  /** inapp.verbose — what the DESKTOP feed displays, not this device's. */
  inappVerbose: boolean
  /**
   * inapp.runCards — whether a running automation OR procedure draws its
   * floating card on the DESKTOP. Its own copy of the same question is
   * `mobileRunCards` below; the two are deliberately separate, because a card
   * worth having on the desk is not automatically one worth having in a
   * pocket. Both default off.
   */
  inappRunCards: boolean
  /**
   * inapp.reasoning — whether the model's thinking renders as a card. One
   * workspace answer for BOTH surfaces (unlike the run cards above): this
   * phone's feed and the desktop's obey the same key. Off by default, and
   * display-only — the reasoning is still streamed and still stored.
   */
  inappReasoning: boolean
  /**
   * mobile.notifications — whether the model's notify_phone tool may reach
   * THIS phone. Off makes the desktop withdraw the tool entirely, so it is
   * the one channel setting on this screen that changes what a run can do.
   */
  mobileNotifications: boolean
  /** mobile.verbose — what this phone's feed shows mid-turn: off (default)
   *  is the clean feed, on relays every tool call and activity card. */
  mobileVerbose: boolean
  /**
   * mobile.runCards — whether an automation or procedure running on the
   * desktop draws its card over whatever screen THIS phone is on. Off by
   * default; the pushes still arrive either way, so nothing but the
   * interruption changes.
   */
  mobileRunCards: boolean
  // --- services (remotely controllable values) ---
  /**
   * Web search is the organization's lane — one key at the API edge, none on
   * any device. Status only: the desktop reports whether the lane is ready
   * and refuses a phone write to it, so the row renders as state, never as a
   * switch or a key field.
   */
  braveEnabled: boolean
  sttModel: string
  /** Pinned transcription language — a Whisper code, or 'auto' for detection. */
  sttLanguage: string
  ttsVoice: string
  ttsSpeed: string
  /** Voice prompts get spoken replies (default on). A model directive — synced, never enforced. */
  ttsVoiceReplies: boolean
  screenshotMaxWidth: string
  screenshotFormat: 'jpeg' | 'png'
  /** browserExtension.* — the pairing port and its own screenshot settings. */
  browserExtensionPort: string
  browserScreenshotMaxWidth: string
  browserScreenshotFormat: 'jpeg' | 'png'
  browserScreenshotQuality: string
  // --- knowledge ---
  compactionDailyHour: number
  compactionWeeklyDay: number
  compactionWeeklyHour: number
  reflectionHour: number
  reflectionQuietHours: number
  /**
   * compaction.cards / reflection.cards — whether a running compaction or
   * reflection job draws its floating card. One switch per family, obeyed by
   * BOTH surfaces (unlike the automation pair above): this is housekeeping
   * either device can watch, not a per-device taste. Both default off.
   */
  compactionCards: boolean
  reflectionCards: boolean
  // --- customization ---
  /**
   * The three hand-written documents that shape the agent, verbatim — the
   * desktop's Soul, User and Agents pages, which are one markdown editor over
   * one workspace file each (brain/identity/soul.md, brain/identity/user.md,
   * brain/prefrontal/agents.md).
   *
   * Flat string keys like every other editable setting on purpose: that is
   * what buys them the whole write path for free — the outbox's dirty window
   * and epoch guard, the configSet round trip, and the snapshot merge that
   * refuses to overwrite a document being edited on this phone.
   */
  soulMarkdown: string
  userMarkdown: string
  agentsMarkdown: string
  // --- collections ---
  capabilities: Record<string, boolean>
  mcpServers: Record<string, boolean>
  variables: DemoVariable[]
  projects: DemoProject[]
}

/**
 * The demo workspace's three customization documents.
 *
 * Fallbacks, not fixtures: a paired phone replaces all three from the desktop's
 * snapshot, and a demo bundle that carries a `customization` section replaces
 * them too. They exist so demo mode — and a bundle published before this
 * section shipped — shows the Customization screen doing its job on real-shaped
 * markdown instead of three empty cards. A fake workspace's real-looking
 * content, written for the demo persona
 * (Younes Alharbi, Riyadh, Sadeem) so nothing here contradicts the bundled
 * conversations.
 */
const DEMO_SOUL_MD = `# Soul

You are Wolffish — Younes's own agent, not a product demo of one.

## Voice
- Answer first, then the reasoning. Never open with a restatement of the question.
- Short sentences. No filler, no "great question", no apologising for limits.
- Arabic in, Arabic out — match the language of the message, not of this file.

## Rules
- Say "I don't know" rather than producing a plausible-looking guess.
- Never invent a number, a date, or a file path. Look it up or say it's unchecked.
- Money, calendar invites and messages to other people: confirm before acting.
- When a task turns out to be bigger than asked, do it and say what changed.

## Humor
Dry, occasional, never at the user's expense. Skip it entirely when something
is actually broken.
`

const DEMO_USER_MD = `# User

- Name: Younes Alharbi
- Location: Riyadh (Asia/Riyadh)
- Works at: Sadeem — builds and ships mobile + desktop apps
- Languages: Arabic (native), English (fluent) — code and commits in English

## Preferences
- Work hours 9:00–18:00; do not schedule anything before 09:00.
- Prefers being shown the diff over being told about the diff.
- Hates half-answers: finish the whole task, then name what was left out.
- Coffee order worth remembering: flat white, no sugar.

## Standing facts
- Mom: Reem — SMS forwarder set up on her phone, checks in most evenings.
- Brother handles the family car paperwork; do not duplicate those reminders.
`

const DEMO_AGENTS_MD = `# Agents

Overrides for this workspace. These win over the built-in procedures.

- Before any release: run the full test suite, then the simulator smoke pass.
- Never push straight to \`main\` — branch, then open a PR.
- Screenshots for issues go in \`~/Desktop/wolffish-issues/\`, dated folders.
- When summarising a long thread, lead with what changed since the last summary.
`

const DEFAULTS: DemoConfigValues = {
  brainProvider: 'anthropic',
  brainModel: 'claude-opus-4-8',
  chatMode: 'single',
  thinkingMode: 'high',
  launchAtStartup: false,
  bypassPermissions: true,
  blockCredentials: false,
  weekStartsOn: 1,
  inappVerbose: false,
  inappRunCards: false,
  inappReasoning: false,
  mobileNotifications: true,
  mobileVerbose: false,
  mobileRunCards: false,
  braveEnabled: true,
  sttModel: 'large-v3-turbo',
  sttLanguage: 'en',
  ttsVoice: 'af_heart',
  ttsSpeed: '1.0',
  ttsVoiceReplies: true,
  screenshotMaxWidth: '1280',
  screenshotFormat: 'jpeg',
  browserExtensionPort: '23151',
  browserScreenshotMaxWidth: '1280',
  browserScreenshotFormat: 'jpeg',
  browserScreenshotQuality: '80',
  compactionDailyHour: 23,
  compactionWeeklyDay: 0,
  compactionWeeklyHour: 23,
  // Desktop DEFAULT_REFLECTION: 3 AM, 12 h quiet.
  reflectionHour: 3,
  reflectionQuietHours: 12,
  // Floating run cards, all off — the desktop's own defaults.
  compactionCards: false,
  reflectionCards: false,
  soulMarkdown: DEMO_SOUL_MD,
  userMarkdown: DEMO_USER_MD,
  agentsMarkdown: DEMO_AGENTS_MD,
  capabilities: DEFAULT_CAPABILITIES,
  mcpServers: DEFAULT_MCP_SERVERS,
  variables: [
    { name: 'HOME_CITY', value: 'Riyadh', sensitive: false },
    { name: 'WORK_HOURS', value: '9:00-18:00', sensitive: false },
    { name: 'NOTION_FINANCE_DB', value: 'a1b2c3d4e5f647899abcdef012345678', sensitive: true }
  ],
  // Filled by the config snapshot on demo entry; empty until then.
  projects: []
}

/**
 * The paired desktop app itself — what is running Wolffish on the other end.
 * Every field is null until a snapshot lands: this device knows nothing about
 * a desktop it has never synced with, and a plausible-looking placeholder
 * version would be worse than an em dash.
 */
export type DesktopInfo = {
  /** The desktop app's version, e.g. '1.0.232'. */
  version: string | null
  /** Where it runs — 'macOS', 'Windows', 'Linux'. */
  platform: string | null
  /**
   * IANA zone the desktop's schedules fire in (e.g. 'Asia/Riyadh'). Null
   * until a snapshot carries it — schedule cards then fall back to phone-
   * local time rather than claiming a zone nobody reported.
   */
  timezone: string | null
  /** ISO timestamp the snapshot was taken: how fresh this mirror is. */
  syncedAt: string | null
}

/**
 * The desktop Data panel's numbers as of the last snapshot — disk free/total,
 * the workspace region sizes, and the app process's RAM/CPU. All null until a
 * snapshot lands, and each field renders as an em dash until then: these are
 * that machine's real figures or nothing.
 */
export type DesktopData = {
  freeDiskBytes: number | null
  totalDiskBytes: number | null
  workspaceBytes: number | null
  hippocampusBytes: number | null
  corpusBytes: number | null
  prefrontalBytes: number | null
  ramBytes: number | null
  totalRamBytes: number | null
  /** Share of ONE core, as the desktop samples it — divide by cpuCount. */
  cpuPercent: number | null
  cpuCount: number | null
}

/** The real-workspace snapshot the demo pipeline emits (secrets excluded). */
export type ConfigSnapshot = {
  capabilities: Array<{
    name: string
    description: string
    enabled: boolean
    official: boolean
    /** Locked built-in (desktop's LOCKED_CAPABILITIES). Absent in bundles
     *  published before the capability badges shipped. */
    core?: boolean
    /** Ships a plugin/ runtime. Absent in bundles published before the
     *  tools/plugin chips shipped, as are the two fields below. */
    hasPlugin?: boolean
    /** How many tools the SKILL.md frontmatter declares. */
    toolCount?: number
    /** Capability names this one depends on (frontmatter `requires`). */
    requires?: string[]
  }>
  mcpServers: Array<{ name: string; enabled: boolean }>
  variables: DemoVariable[]
  /** Absent in bundles published before projects shipped. */
  projects?: DemoProject[]
  /**
   * The workspace's saved procedures (desktop: `brain/procedures.json`).
   *
   * Carried for exactly the reason `projects` is: the Procedures screen is
   * workspace content, not a knob, and an unpaired phone has to render it from
   * something. A paired phone never reads this — `Rpc.proceduresList` answers
   * first and every write goes there — so a real desktop omitting the section
   * costs nothing (lib/sync/procedures falls back only when there is no
   * tunnel).
   */
  procedures?: SyncProcedure[]
  /**
   * The heartbeat as the Automations screen needs it: the file, the
   * scheduler's live view of the ACTIVE jobs in it, and the per-label edit
   * stamps. Same contract as `procedures` above — snapshot copy for the
   * unpaired case, ignored entirely once a tunnel can answer
   * `Rpc.automationsRead`.
   *
   * The run pool is deliberately NOT here: a run is something happening right
   * now on a machine this one cannot see, and a bundled one would be a claim
   * with no evidence behind it (see lib/sync/overlays).
   */
  automations?: {
    /** heartbeat.md verbatim. */
    markdown?: string
    jobs?: AutomationJob[]
    /** label → epoch ms of its last edit. */
    stamps?: Record<string, number>
  }
  services: {
    /**
     * Whether the organization's web-search lane is ready. Status only: the
     * key lives at the API edge, and the desktop refuses a phone write to
     * either field. Older bundles also carry a `braveApiKey` — not read.
     */
    braveEnabled: boolean
    sttModel: string
    /** Absent on desktops from before the language pin shipped. */
    sttLanguage?: string
    ttsVoice: string
    ttsSpeed: string
    /** Absent on desktops from before voice replies shipped. */
    ttsVoiceReplies?: boolean
    screenshotMaxWidth: string
    screenshotFormat: string
    /**
     * Computer use on the desktop — present by construction while the app
     * runs there. Absent in bundles/desktops published before the service
     * card synced; those keep the previous always-connected rendering.
     */
    computerUse?: {
      connected?: boolean
      connections?: ServiceConnection[]
    }
    /** Absent in bundles published before the extension settings shipped. */
    browserExtension?: {
      port?: number
      screenshotMaxWidth?: number
      screenshotFormat?: string
      screenshotQuality?: number
      /** Absent in bundles published before multi-browser shipped. */
      connected?: boolean
      browsers?: Array<{
        browser?: string
        name?: string
        browserVersion?: string
        os?: string
        profileEmail?: string
        extensionVersion?: string
        /** Epoch ms; absent on desktops from before the connection card. */
        connectedAt?: number | null
      }>
    }
  }
  channels: {
    /** Absent in bundles published before the in-app feed setting shipped;
     *  `runCards` is later still and falls back to off. */
    inapp?: { verbose?: boolean; runCards?: boolean; reasoning?: boolean }
    /** This phone's own channel. Absent in bundles (and on desktops) from
     *  before these two settings reached the snapshot; notifications then
     *  falls back to ON and the feed to clean, as the desktop defaults them. */
    mobile?: { notifications?: boolean; verbose?: boolean; runCards?: boolean }
  }
  /**
   * The org lane: the current model and the two behavior knobs, nothing else.
   * The personal edition's `localOnly`, `restrictPowerfulModels`, `local` and
   * `providers` are gone from the cloud desktop's snapshot; a bundle or an
   * older desktop still carrying them is read without them.
   */
  llm: {
    brainProvider: string
    brainModel: string
    chatMode: ChatMode
    /**
     * The Brain model's thinking level, when one has been chosen on the
     * desktop. Absent in bundles published before thinking synced — those
     * keep the device's last value rather than inventing a choice.
     */
    thinkingMode?: string
    /**
     * Every model this user may pick, in the API's order. Absent from bundles
     * published before the phone could pick one, and from a live desktop whose
     * catalog cache has not been filled yet (it omits rather than sending an
     * empty list) — both read as "no catalog", and the picker then offers the
     * current model alone until the desktop pushes one.
     */
    models?: ModelCatalogEntry[]
  }
  /** Same tolerance as `llm`: `updatesEnabled` and `ollamaModelsFolder` no
   *  longer ride here and are not read when they do. */
  preferences: {
    launchAtStartup: boolean
    bypassPermissions: boolean
    blockCredentials: boolean
    weekStartsOn: 0 | 1
  }
  /**
   * The desktop app on the other end. Absent in bundles published before the
   * Updates screen's desktop card shipped.
   */
  desktop?: {
    version?: string | null
    platform?: string | null
    /** Absent in bundles/desktops from before the timezone rode along. */
    timezone?: string | null
    syncedAt?: string | null
  }
  /**
   * The desktop Data panel's numbers at snapshot time. Absent in bundles
   * published before the Data screen's desktop card shipped — those render
   * em dashes rather than inventing a machine.
   */
  data?: {
    freeDiskBytes?: number | null
    totalDiskBytes?: number | null
    workspaceBytes?: number
    hippocampusBytes?: number
    corpusBytes?: number
    prefrontalBytes?: number
    ramBytes?: number
    totalRamBytes?: number
    cpuPercent?: number
    cpuCount?: number
  }
  /**
   * Compaction schedule + the brainstem's last-run records. Absent in bundles
   * published before the last-run cards shipped, so every field falls back.
   */
  compaction?: {
    dailyHour?: number
    weeklyDay?: number
    weeklyHour?: number
    /** Floating run cards. Absent on desktops from before they shipped. */
    cards?: boolean
    runs?: {
      daily?: CompactionRunRecord | null
      weekly?: CompactionRunRecord | null
      /** The reflection jobs report through the same brainstem meta file.
       *  Absent in bundles/desktops from before reflection shipped. */
      reflection?: CompactionRunRecord | null
      deepClean?: CompactionRunRecord | null
    }
  }
  /**
   * Reflection schedule. Absent in bundles or desktops from before
   * reflection shipped — those render the desktop's own defaults (3 AM,
   * 12 h quiet), which is exactly what an unset config means upstream.
   */
  reflection?: {
    hour?: number
    quietHours?: number
    /** Floating run cards. Absent on desktops from before they shipped. */
    cards?: boolean
  }
  /**
   * The workspace usage ledger folded per (day × provider × model) — what the
   * Usage screen aggregates on device (lib/usage/stats). Absent in bundles
   * published before the desktop-parity Usage screen shipped; those render
   * zeros and an empty activity grid rather than inventing spend.
   */
  usage?: { days?: UsageDay[] }
  /**
   * The desktop app's own release notes — which months exist, newest first.
   * Bodies deliberately do NOT ride the snapshot: the full set is hundreds of
   * KB, so the phone fetches one month at a time (Rpc.changelogRead) when the
   * reader actually opens it. Absent in bundles/desktops from before desktop
   * notes synced; those render the What's-new desktop tab's empty state.
   */
  changelog?: { months?: string[] }
  /**
   * The three hand-written documents behind the Customization screen, verbatim
   * (desktop: brain/identity/soul.md, brain/identity/user.md,
   * brain/prefrontal/agents.md).
   *
   * Three states, all meaningful and all different:
   * - a string (including '') — the document as it stands upstream, editable;
   * - the key absent while `oversized` names it — too large to ride one RPC
   *   frame, so no text was sent at all and the card stays read-only. Never a
   *   truncated body: this phone writes what it holds back over the real file,
   *   and a half-document saved is a document destroyed;
   * - the whole section absent — a bundle or desktop from before customization
   *   synced, which falls back to the demo documents like every other
   *   later-added field.
   */
  customization?: {
    soul?: string
    user?: string
    agents?: string
    oversized?: string[]
  }
}

/**
 * How a snapshot lands. `keepLocal` names keys whose local value must survive
 * this application — the phone holds edits for them that the desktop has not
 * acknowledged yet, or the fetch raced a write (lib/sync/outbox decides).
 * Desktop truth for those keys returns on the next quiet refresh.
 */
export type ApplySnapshotOptions = {
  keepLocal?: ReadonlyArray<keyof DemoConfigValues>
}

/** One connected browser, as the desktop's extension panel shows it. */
export type ExtensionBrowser = {
  /** Slug for the logo: chrome / brave / edge / chromium / firefox / safari. */
  browser: string
  name: string
  browserVersion: string | null
  os: string | null
  profileEmail: string | null
  extensionVersion: string | null
  connectedAt: number | null
}

export type DemoConfigState = DemoConfigValues & {
  /** Read-only service surface state (desktop-managed). */
  services: ServiceStatus[]
  /**
   * The org model catalog from the snapshot — desktop-managed and display-only
   * in the sense that this device cannot ADD to it; which entry is selected is
   * `brainModel`, and that one IS editable from here.
   *
   * Empty when the snapshot carried no list, which is a real state and not an
   * error: an older desktop, a demo bundle from before models were pickable, or
   * a live desktop whose catalog has not landed yet. The picker answers it by
   * showing the current model alone rather than an empty row.
   */
  modelCatalog: ModelCatalogEntry[]
  /**
   * Live browser-extension connections — desktop-managed, display only, the
   * rows behind the Services screen's browser cards.
   */
  extensionBrowsers: ExtensionBrowser[]
  /** Capability descriptions from the real workspace's SKILL.md files. */
  capabilityInfo: Record<
    string,
    {
      description: string
      official: boolean
      core: boolean
      hasPlugin: boolean
      toolCount: number
      requires: string[]
    }
  >
  /**
   * Last completed daily/weekly compaction — desktop-managed, display only.
   * Not part of DemoConfigValues: nothing here is editable on this device.
   */
  compactionRuns: CompactionRuns
  /**
   * The usage ledger rows from the snapshot — desktop-managed, display only,
   * same contract as compactionRuns. Empty until a snapshot lands.
   */
  usage: UsageDay[]
  /** The paired desktop app's own version and platform — display only. */
  desktop: DesktopInfo
  /**
   * The desktop Data panel's numbers — desktop-managed, display only, same
   * contract as `desktop`: this device cannot measure that machine, so the
   * figures travel in the snapshot instead of being probed here.
   */
  desktopData: DesktopData
  /**
   * Months the desktop's own release notes cover, newest first — the What's
   * new screen's desktop tab. Display-only like `desktop`: the notes belong
   * to that app's build, so the list travels in the snapshot and the bodies
   * are fetched on demand (lib/changelog readDesktopChangelog).
   */
  desktopChangelogMonths: string[]
  /**
   * Customization documents the desktop refused to send whole — 'soul',
   * 'user', 'agents'. Desktop-managed and display-only: this device has no
   * copy of an oversized document, so its card shows the size problem and
   * offers no editor rather than an editor over text it does not have.
   */
  customizationOversized: string[]
  /**
   * The snapshot's procedures and heartbeat — desktop-managed and display-only
   * here, exactly like `compactionRuns`. They are NOT in DemoConfigValues
   * because this device cannot edit them without a desktop to write to; the
   * two sync modules read them only when there is no tunnel to ask.
   */
  snapshotProcedures: SyncProcedure[]
  snapshotAutomations: { markdown: string; jobs: AutomationJob[]; stamps: Record<string, number> }
  /** The one write path — updates a single flat key. */
  setValue: <K extends keyof DemoConfigValues>(key: K, value: DemoConfigValues[K]) => void
  /** Toggle one entry inside a Record<string, boolean> collection. */
  setMapEntry: (key: 'capabilities' | 'mcpServers', name: string, enabled: boolean) => void
  /** Ingest the real-workspace snapshot — the demo's "sync" moment. */
  applySnapshot: (snapshot: ConfigSnapshot, opts?: ApplySnapshotOptions) => void
  /** The org's usage ledger, folded per day (lib/usage/ledger) — the paired
   *  source of the Usage screen's rows; demo bundles carry theirs in the
   *  snapshot. */
  setUsageDays: (days: UsageDay[]) => void
  /**
   * Back to factory defaults, including this device's own edits. Used when a
   * republished bundle replaces the dataset (lib/demo/reset): applySnapshot
   * only writes the keys a snapshot carries, so without this a value the new
   * bundle dropped — a capability, a project, a variable, a toggle flipped on
   * this phone — would survive the refresh and describe a workspace that no
   * longer exists.
   */
  reset: () => void
}

/**
 * Keep only well-formed ledger rows, sorted by date. The builder controls the
 * data, so this is belt-and-braces against a hand-edited or truncated bundle —
 * a malformed row must cost itself, not the whole Usage screen.
 */
function sanitizeUsageDays(days: unknown): UsageDay[] {
  if (!Array.isArray(days)) return []
  const clean: UsageDay[] = []
  for (const day of days as Array<Partial<UsageDay>>) {
    if (typeof day?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue
    const models = Array.isArray(day.models)
      ? day.models.filter(
          (row) =>
            typeof row?.provider === 'string' &&
            typeof row?.model === 'string' &&
            Number.isFinite(row?.inputTokens) &&
            Number.isFinite(row?.outputTokens) &&
            Number.isFinite(row?.cost) &&
            Number.isFinite(row?.entries)
        )
      : []
    const braveQueries = Number.isFinite(day.braveQueries) ? (day.braveQueries as number) : 0
    if (models.length === 0 && braveQueries === 0) continue
    clean.push({ date: day.date, models, braveQueries })
  }
  return clean.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Keep a DesktopData field only when it is a real, non-negative number. The
 * builder controls the data, so this is the same belt-and-braces as
 * sanitizeUsageDays: a hand-edited bundle must cost the one figure it
 * corrupted, not the whole desktop card.
 */
function sanitizeDesktopData(data: ConfigSnapshot['data']): DesktopData {
  const num = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    freeDiskBytes: num(data?.freeDiskBytes),
    totalDiskBytes: num(data?.totalDiskBytes),
    workspaceBytes: num(data?.workspaceBytes),
    hippocampusBytes: num(data?.hippocampusBytes),
    corpusBytes: num(data?.corpusBytes),
    prefrontalBytes: num(data?.prefrontalBytes),
    ramBytes: num(data?.ramBytes),
    totalRamBytes: num(data?.totalRamBytes),
    cpuPercent: num(data?.cpuPercent),
    cpuCount: num(data?.cpuCount)
  }
}

/**
 * Months the snapshot's changelog section names, cleaned to `YYYY-MM` keys,
 * deduped, newest first. Same belt-and-braces as the sanitizers above: a
 * malformed month must cost itself, not the whole What's-new tab.
 */
function sanitizeChangelogMonths(months: unknown): string[] {
  if (!Array.isArray(months)) return []
  const clean = months.filter(
    (month): month is string => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)
  )
  return [...new Set(clean)].sort().reverse()
}

/** The customization docs, in the order the screen renders them. */
export const CUSTOMIZATION_DOCS = ['soul', 'user', 'agents'] as const

export type CustomizationDoc = (typeof CUSTOMIZATION_DOCS)[number]

/** Which flat store key holds each document's markdown. */
export const CUSTOMIZATION_KEYS: Record<
  CustomizationDoc,
  'soulMarkdown' | 'userMarkdown' | 'agentsMarkdown'
> = {
  soul: 'soulMarkdown',
  user: 'userMarkdown',
  agents: 'agentsMarkdown'
}

/**
 * How much markdown may ride one RPC frame — the desktop's own
 * CUSTOMIZATION_MAX_BYTES (channels/mobile/snapshot.ts), mirrored so this side
 * stops an oversized save before it becomes a rejected round trip. Counted in
 * UTF-8 bytes, not characters: the ceiling exists for the wire, and one Arabic
 * document is roughly twice its length in bytes.
 */
export const CUSTOMIZATION_MAX_BYTES = 64 * 1024

/** UTF-8 byte length, without allocating a Buffer/TextEncoder per keystroke. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair — one 4-byte code point, counted once.
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * Which documents the desktop declared too large to send. Sanitized to the
 * three known names so a malformed list can only ever cost the card it names.
 */
function sanitizeOversized(oversized: unknown): string[] {
  if (!Array.isArray(oversized)) return []
  return CUSTOMIZATION_DOCS.filter((doc) => oversized.includes(doc))
}

/**
 * Desktop-sent variable rows folded onto this phone's list — the one shape
 * both ingest paths share (the full snapshot and the targeted
 * variables.changed push), so the two can never render differently.
 *
 * Tolerates one protocol generation of drift ({key, value} rows), and keeps
 * this phone's nameless draft rows: added here but not yet named, so the
 * desktop cannot hold them (its own panel refuses a nameless save, and the
 * outbox never sends one). They ride along at the end instead of vanishing
 * mid-compose.
 */
function mergeVariablesFromDesktop(
  rows: ConfigSnapshot['variables'] | undefined,
  local: DemoVariable[]
): DemoVariable[] {
  return [
    ...(rows ?? [])
      .map((variable) => ({
        name: variable.name ?? (variable as { key?: string }).key ?? '',
        value: variable.value ?? '',
        sensitive: variable.sensitive === true
      }))
      .filter((variable) => variable.name),
    ...local.filter((variable) => !variable.name.trim())
  ]
}

/**
 * Keys a v2 (personal edition) persisted state may carry that this store no
 * longer has — see the persist `migrate` below.
 */
/** Keys the cloud edition retired with the desktop's service integrations. */
const DROPPED_IN_V4 = [
  'telegramEnabled',
  'telegramAllowedUserIds',
  'telegramVerbose',
  'telegramAutoRefresh',
  'telegramStaleHours',
  'telegramHideAutomations',
  'whatsappEnabled',
  'whatsappAllowedNumbers',
  'whatsappVerbose',
  'whatsappAutoRefresh',
  'whatsappStaleHours',
  'whatsappHideAutomations',
  'memesEnabled',
  'imgflipUsername',
  'imgflipPassword',
  'giphyApiKey'
] as const

const DROPPED_IN_V3 = [
  'localOnly',
  'localEnabled',
  'localModel',
  'localModels',
  'ollamaModelsFolder',
  'ollamaRunning',
  'providers',
  'restrictPowerfulModels',
  'updatesEnabled',
  'braveApiKey',
  'videoApiKey'
] as const

/** The store's initial, pre-snapshot shape — DEFAULTS plus what a snapshot fills. */
const INITIAL_STATE = {
  ...DEFAULTS,
  services: READ_ONLY_SERVICES,
  modelCatalog: [] as ModelCatalogEntry[],
  extensionBrowsers: [] as ExtensionBrowser[],
  capabilityInfo: {} as DemoConfigState['capabilityInfo'],
  compactionRuns: { daily: null, weekly: null } as CompactionRuns,
  usage: [] as UsageDay[],
  desktop: { version: null, platform: null, timezone: null, syncedAt: null } as DesktopInfo,
  desktopData: sanitizeDesktopData(undefined),
  desktopChangelogMonths: [] as string[],
  customizationOversized: [] as string[],
  snapshotProcedures: [] as SyncProcedure[],
  snapshotAutomations: {
    markdown: '',
    jobs: [] as AutomationJob[],
    stamps: {} as Record<string, number>
  }
}

export const useDemoConfig = create<DemoConfigState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,
      reset: () => set(() => INITIAL_STATE),
      setValue: (key, value) => set({ [key]: value } as Partial<DemoConfigState>),
      setMapEntry: (key, name, enabled) =>
        set((state) => ({ [key]: { ...state[key], [name]: enabled } }) as Partial<DemoConfigState>),
      setUsageDays: (days) => set({ usage: sanitizeUsageDays(days) }),
      applySnapshot: (snapshot, opts) =>
        set((state) => {
          const capabilities: Record<string, boolean> = {}
          const capabilityInfo: DemoConfigState['capabilityInfo'] = {}
          for (const capability of snapshot.capabilities) {
            const core = capability.core === true
            // A locked capability is on by definition upstream — never let a
            // stale snapshot entry render one as inactive with no way back.
            capabilities[capability.name] = core || capability.enabled
            capabilityInfo[capability.name] = {
              description: capability.description,
              official: capability.official,
              core,
              hasPlugin: capability.hasPlugin === true,
              toolCount: capability.toolCount ?? 0,
              requires: capability.requires ?? []
            }
          }
          const mcpServers: Record<string, boolean> = {}
          for (const server of snapshot.mcpServers) mcpServers[server.name] = server.enabled
          const { services } = snapshot
          const compaction = snapshot.compaction
          const applied: Partial<DemoConfigState> = {
            capabilities,
            capabilityInfo,
            mcpServers,
            compactionDailyHour: compaction?.dailyHour ?? DEFAULTS.compactionDailyHour,
            compactionWeeklyDay: compaction?.weeklyDay ?? DEFAULTS.compactionWeeklyDay,
            compactionWeeklyHour: compaction?.weeklyHour ?? DEFAULTS.compactionWeeklyHour,
            compactionCards: compaction?.cards ?? DEFAULTS.compactionCards,
            reflectionCards: snapshot.reflection?.cards ?? DEFAULTS.reflectionCards,
            reflectionHour: snapshot.reflection?.hour ?? DEFAULTS.reflectionHour,
            reflectionQuietHours: snapshot.reflection?.quietHours ?? DEFAULTS.reflectionQuietHours,
            compactionRuns: {
              daily: compaction?.runs?.daily ?? null,
              weekly: compaction?.runs?.weekly ?? null,
              reflection: compaction?.runs?.reflection ?? null,
              deepClean: compaction?.runs?.deepClean ?? null
            },
            // The paired snapshot carries no usage (the org's ledger is read
            // separately — setUsageDays); a bundle carries its own. Absent
            // keeps what is here rather than blanking the Usage screen.
            usage:
              snapshot.usage?.days === undefined
                ? state.usage
                : sanitizeUsageDays(snapshot.usage.days),
            desktop: {
              version: snapshot.desktop?.version ?? null,
              platform: snapshot.desktop?.platform ?? null,
              timezone: snapshot.desktop?.timezone ?? null,
              syncedAt: snapshot.desktop?.syncedAt ?? null
            },
            desktopData: sanitizeDesktopData(snapshot.data),
            desktopChangelogMonths: sanitizeChangelogMonths(snapshot.changelog?.months),
            customizationOversized: sanitizeOversized(snapshot.customization?.oversized),
            // A document the source omitted keeps what is already here: an
            // oversized one has no text to send, and a whole missing section
            // means a bundle or desktop from before this shipped. Both cases
            // must leave the card showing something rather than blanking a
            // document that exists upstream. '' is a real value and lands.
            soulMarkdown: snapshot.customization?.soul ?? state.soulMarkdown,
            userMarkdown: snapshot.customization?.user ?? state.userMarkdown,
            agentsMarkdown: snapshot.customization?.agents ?? state.agentsMarkdown,
            variables: mergeVariablesFromDesktop(snapshot.variables, state.variables),
            projects: snapshot.projects ?? [],
            snapshotProcedures: Array.isArray(snapshot.procedures) ? snapshot.procedures : [],
            snapshotAutomations: {
              markdown:
                typeof snapshot.automations?.markdown === 'string'
                  ? snapshot.automations.markdown
                  : '',
              jobs: Array.isArray(snapshot.automations?.jobs) ? snapshot.automations.jobs : [],
              stamps:
                snapshot.automations?.stamps && typeof snapshot.automations.stamps === 'object'
                  ? snapshot.automations.stamps
                  : {}
            },
            // The org lane: the desktop's current model and mode. Tolerant by
            // omission — the personal edition's `localOnly`, `local` and
            // `providers` are simply not read, so a bundle still carrying
            // them lands exactly as a desktop that dropped them does.
            brainProvider: snapshot.llm.brainProvider,
            brainModel: snapshot.llm.brainModel,
            // Replaced outright, never merged: the catalog IS the policy, so a
            // model the org withdrew has to leave this list in the same beat
            // the desktop stops offering it. An absent list clears it for the
            // same reason — a picker must not keep offering models from a
            // snapshot that no longer claims to know any.
            modelCatalog: sanitizeModelCatalog(snapshot.llm.models),
            chatMode: snapshot.llm.chatMode,
            ...(THINKING_LEVELS.includes(snapshot.llm.thinkingMode as ThinkingLevel)
              ? { thinkingMode: snapshot.llm.thinkingMode as ThinkingLevel }
              : {}),
            inappVerbose: snapshot.channels.inapp?.verbose ?? DEFAULTS.inappVerbose,
            inappRunCards: snapshot.channels.inapp?.runCards ?? DEFAULTS.inappRunCards,
            inappReasoning: snapshot.channels.inapp?.reasoning ?? DEFAULTS.inappReasoning,
            mobileNotifications:
              snapshot.channels.mobile?.notifications ?? DEFAULTS.mobileNotifications,
            mobileVerbose: snapshot.channels.mobile?.verbose ?? DEFAULTS.mobileVerbose,
            mobileRunCards: snapshot.channels.mobile?.runCards ?? DEFAULTS.mobileRunCards,
            launchAtStartup: snapshot.preferences.launchAtStartup,
            bypassPermissions: snapshot.preferences.bypassPermissions,
            blockCredentials: snapshot.preferences.blockCredentials,
            weekStartsOn: snapshot.preferences.weekStartsOn,
            braveEnabled: services.braveEnabled,
            sttModel: services.sttModel,
            sttLanguage: services.sttLanguage ?? DEFAULTS.sttLanguage,
            ttsVoice: services.ttsVoice,
            ttsSpeed: services.ttsSpeed,
            ttsVoiceReplies: services.ttsVoiceReplies ?? DEFAULTS.ttsVoiceReplies,
            screenshotMaxWidth: services.screenshotMaxWidth,
            screenshotFormat: services.screenshotFormat === 'png' ? 'png' : 'jpeg',
            browserExtensionPort: `${services.browserExtension?.port ?? DEFAULTS.browserExtensionPort}`,
            browserScreenshotMaxWidth: `${services.browserExtension?.screenshotMaxWidth ?? DEFAULTS.browserScreenshotMaxWidth}`,
            browserScreenshotFormat:
              services.browserExtension?.screenshotFormat === 'png' ? 'png' : 'jpeg',
            browserScreenshotQuality: `${services.browserExtension?.screenshotQuality ?? DEFAULTS.browserScreenshotQuality}`,
            // Raw connection entries for the desktop-style browser cards —
            // slug for the logo, the identity lines, and when it connected.
            extensionBrowsers: (services.browserExtension?.browsers ?? []).map((browser) => ({
              browser: browser.browser ?? '',
              name: browser.name ?? 'Browser',
              browserVersion: browser.browserVersion ?? null,
              os: browser.os ?? null,
              profileEmail: browser.profileEmail ?? null,
              extensionVersion: browser.extensionVersion ?? null,
              connectedAt: typeof browser.connectedAt === 'number' ? browser.connectedAt : null
            })),
            services: [
              {
                key: 'browserExtension',
                connected:
                  services.browserExtension?.connected ??
                  (services.browserExtension?.browsers?.length ?? 0) > 0,
                connections: services.browserExtension?.browsers?.length
                  ? services.browserExtension.browsers.map((browser) => ({
                      label: browser.name ?? 'Browser',
                      detail:
                        [
                          browser.profileEmail ?? null,
                          browser.browserVersion
                            ? `v${browser.browserVersion.split('.')[0]}`
                            : null,
                          browser.os ?? null
                        ]
                          .filter(Boolean)
                          .join(' · ') ||
                        `port ${services.browserExtension?.port ?? DEFAULTS.browserExtensionPort}`
                    }))
                  : [
                      {
                        label: 'Chrome extension',
                        detail: `port ${services.browserExtension?.port ?? DEFAULTS.browserExtensionPort}`
                      }
                    ]
              },
              {
                key: 'computerUse',
                // Synced when the desktop sends it; the historical constant
                // otherwise, so old demo bundles render exactly as before.
                connected: services.computerUse?.connected ?? true,
                connections: services.computerUse?.connections ?? []
              }
            ]
          }
          // Keys mid-edit on this phone keep their local value — a snapshot
          // that raced a write must not undo it under the user's thumb. The
          // outbox names them (see refreshConfigSnapshot); desktop truth for
          // those keys returns on the next quiet refresh.
          for (const key of opts?.keepLocal ?? []) {
            ;(applied as Record<string, unknown>)[key] = state[key]
          }
          return applied
        })
    }),
    {
      name: 'wolffish.demo-config',
      storage: createJSONStorage(() => AsyncStorage),
      version: 4,
      // v3 is the cloud edition: the personal edition's local-engine,
      // provider-key, Brave-key and desktop-updates fields left the store. v4
      // retired the desktop's service integrations (the messaging bridges,
      // memes, the speech engines, computer use). An older state persisted by
      // an earlier build still carries those keys — the demo's fake
      // credentials included — and persist would merge them straight back
      // into memory on rehydrate, so they are dropped here instead.
      migrate: (persisted) => {
        const state = { ...(persisted as Record<string, unknown>) }
        for (const key of DROPPED_IN_V3) delete state[key]
        for (const key of DROPPED_IN_V4) delete state[key]
        return state as DemoConfigState
      },
      // Editable values + snapshot-derived metadata persist; functions and
      // the rebuilt-on-apply services array do not.
      partialize: (state) => {
        const persisted: Record<string, unknown> = {
          capabilityInfo: state.capabilityInfo,
          // Held across launches like the rest of the mirror: the picker paints
          // its chips on the first frame after a cold start, instead of
          // collapsing to a single model until the desktop's next push lands.
          modelCatalog: state.modelCatalog,
          extensionBrowsers: state.extensionBrowsers,
          compactionRuns: state.compactionRuns,
          usage: state.usage,
          desktop: state.desktop,
          desktopData: state.desktopData,
          desktopChangelogMonths: state.desktopChangelogMonths,
          customizationOversized: state.customizationOversized,
          snapshotProcedures: state.snapshotProcedures,
          snapshotAutomations: state.snapshotAutomations
        }
        for (const key of Object.keys(DEFAULTS) as Array<keyof DemoConfigValues>) {
          persisted[key] = state[key]
        }
        return persisted as Partial<DemoConfigState>
      }
    }
  )
)

/** Single-field subscription — a row re-renders only when ITS value changes. */
export function useConfigValue<K extends keyof DemoConfigValues>(key: K): DemoConfigValues[K] {
  return useDemoConfig((state) => state[key])
}

export function setConfigValue<K extends keyof DemoConfigValues>(
  key: K,
  value: DemoConfigValues[K]
): void {
  // Paired settings belong to the desktop: this store is a copy of its
  // snapshot, and the next refresh overwrites whatever was set here. Offline
  // that refresh cannot happen, so an edit would sit on screen looking
  // applied until the connection returned and silently undid it. Refusing is
  // the honest answer — see useSettingsReadOnly, which says so in the UI.
  if (settingsAreReadOnly()) return
  useDemoConfig.getState().setValue(key, value)
  // Variables burst per keystroke and need coalescing plus echo protection —
  // they travel through the outbox (whole array, debounced, one in flight),
  // not the per-toggle path below. Demo mode has no tunnel; the outbox
  // no-ops and the edit stays local, exactly as before.
  if (key === 'variables') {
    pushVariables(value as DemoVariable[])
    return
  }
  void pushToDesktop(key, value)
}

/**
 * The settings the desktop accepts from this device — the Rpc.configSet
 * whitelist, mirrored. Every key here is written through the same desktop
 * setters its own panel uses, so a flip on this screen and a flip there are
 * the same change. Keys outside this set stay purely local (demo mode), or
 * are desktop-owned mirrors a snapshot refresh will overwrite.
 */
const DESKTOP_EDITABLE: ReadonlySet<keyof DemoConfigValues> = new Set<keyof DemoConfigValues>([
  'bypassPermissions',
  'blockCredentials',
  'weekStartsOn',
  // This phone's own two channel settings. The desktop routes them through
  // the mobile channel's setters, not a bare config write — notifications
  // registers or withdraws the model's notify_phone tool — so a flip here is
  // in force for the next turn, and moves the desktop panel's control too.
  'mobileNotifications',
  'mobileVerbose',
  // This phone's own floating automation cards, through the same channel
  // setter — so flipping it here moves the desktop Mobile panel's control too.
  'mobileRunCards',
  // Services — the editable surface of that screen. Two absences are
  // deliberate on both sides: the extension PORT (moving it restarts the
  // desktop's local pairing server) and web search (`braveEnabled` is the
  // organization's lane, and the desktop refuses a phone write to it).
  'sttModel',
  'sttLanguage',
  'ttsVoice',
  'ttsSpeed',
  'ttsVoiceReplies',
  // Computer-use screenshot width/format are absent on purpose: the agent
  // picks them per capture, so neither app has a control for them.
  'browserScreenshotMaxWidth',
  'browserScreenshotFormat',
  'browserScreenshotQuality',
  // Customization — the three markdown documents, written on the desktop
  // through the exact call its own Soul/User/Agents pages' Save button makes.
  'soulMarkdown',
  'userMarkdown',
  'agentsMarkdown',
  // The composer's control cluster and the model. Each maps onto the exact
  // handler its desktop control calls (provider:setMode,
  // runtime:setThinkingMode, model:select), so a pick on either screen is
  // the same act. `brainModel` is the org lane's one choice — the API is the
  // authority on validity — and the provider id is display-only, never sent.
  'chatMode',
  'thinkingMode',
  'brainModel',
  // Channels — every editable row.
  'inappVerbose',
  // The desktop's floating automation cards — that machine's setting, edited
  // from here exactly as the feed switch above it is.
  'inappRunCards',
  // The thinking card — the workspace's answer, so flipping it here changes
  // this phone's feed and the desktop's in the same act.
  'inappReasoning',
  // The MCP switches, as one name→enabled map — the desktop diffs it against
  // its server list and toggles through the same path its own panel uses.
  // Adding servers, headers and OAuth remain desktop tasks.
  'mcpServers',
  // The compaction schedule. Reflection's settings ride their own RPC
  // (lib/sync/reflection); these three are Knowledge's generic-path keys.
  'compactionDailyHour',
  'compactionWeeklyDay',
  'compactionWeeklyHour',
  // Compaction's floating run cards. Reflection's twin is NOT here: it rides
  // the reflection RPC with the rest of that config.
  'compactionCards'
])

/**
 * Write one edited setting through to the paired desktop.
 *
 * The local set has already happened (the row must move under the finger);
 * this makes it true on the machine that owns it. Confirmation is the
 * desktop's own config.changed push — it announces the write exactly as it
 * announces an edit made in its panel, and the phone refetches the snapshot
 * on that signal, so both screens converge on what the desktop persisted.
 *
 * On error the optimistic value is a lie this mirror must not keep telling:
 * re-pull the snapshot so the row snaps back to the desktop's truth. If even
 * that fails the link is gone, and the reconcile that runs on every reconnect
 * settles it the same way.
 */
async function pushToDesktop<K extends keyof DemoConfigValues>(
  key: K,
  value: DemoConfigValues[K]
): Promise<void> {
  if (!DESKTOP_EDITABLE.has(key)) return
  const tunnel = bridgeClient.active
  if (!tunnel) return
  // Dirty from this very tick: a snapshot request already in the air was
  // answered before the desktop saw this write, and without the epoch moving
  // it would put the old value back under the user's thumb — the flip would
  // snap back for the second it takes the desktop's own confirmation push to
  // arrive. Settled in both outcomes; the failure path's refresh IS desktop
  // truth, so the key must be free to accept it.
  markOutboxEdited(key)
  try {
    await tunnel.rpc(Rpc.configSet, { settings: { [key]: value } })
    settleOutboxKey(key)
  } catch {
    settleOutboxKey(key)
    try {
      // Guarded, not raw: the revert must not also clobber some OTHER key
      // the outbox still has in flight (a variables edit mid-typing, say).
      await refreshConfigSnapshot()
    } catch {
      // Disconnected mid-revert — the on-reconnect reconcile pulls a fresh
      // snapshot and corrects this row along with everything else.
    }
  }
}

/**
 * Save one setting and wait for the desktop to accept it — the explicit path
 * for credential fields, where the row shows the same saved/failed
 * confirmation the desktop's own panels show. The fire-and-forget
 * setConfigValue path is for switches and selects, whose confirmation is the
 * value simply holding; a typed secret deserves an answer.
 *
 * Resolves true when the value is safely on the machine that owns it (or in
 * demo mode, where local IS the whole truth); false reverts the row to
 * desktop truth via the snapshot re-pull.
 */
export async function saveDesktopSetting<K extends keyof DemoConfigValues>(
  key: K,
  value: DemoConfigValues[K]
): Promise<boolean> {
  if (settingsAreReadOnly()) return false
  useDemoConfig.getState().setValue(key, value)
  const { paired } = useAppStore.getState()
  if (!paired) return true
  if (!DESKTOP_EDITABLE.has(key)) return false
  const tunnel = bridgeClient.active
  if (!tunnel || !bridgeClient.connected) return false
  // Same in-flight guard as pushToDesktop: dirty for the round trip, so a
  // racing snapshot cannot undo the row while the desktop's answer is due.
  markOutboxEdited(key)
  try {
    await tunnel.rpc(Rpc.configSet, { settings: { [key]: value } })
    settleOutboxKey(key)
    return true
  } catch {
    settleOutboxKey(key)
    try {
      await refreshConfigSnapshot()
    } catch {
      // Disconnected mid-revert — the on-reconnect reconcile settles it.
    }
    return false
  }
}

/**
 * Save one customization document — Soul, User or Agents.
 *
 * A thin, deliberate wrapper over saveDesktopSetting rather than a path of its
 * own: these are ordinary editable settings, so they get the ordinary write
 * (optimistic local set, outbox dirty window for the round trip, snapshot
 * re-pull on refusal). All this adds is the doc → key mapping and the size
 * ceiling, checked here so an oversized document is refused with a reason on
 * screen instead of as an opaque failed RPC.
 *
 * `'too-large'` never writes anything, locally or upstream: a document the
 * desktop would reject must not be left sitting in this mirror looking saved.
 */
export async function saveCustomizationDoc(
  doc: CustomizationDoc,
  text: string
): Promise<'saved' | 'too-large' | 'failed'> {
  if (utf8Bytes(text) > CUSTOMIZATION_MAX_BYTES) return 'too-large'
  return (await saveDesktopSetting(CUSTOMIZATION_KEYS[doc], text)) ? 'saved' : 'failed'
}

/**
 * Fetch the desktop's snapshot and apply it with the outbox consulted: the
 * epochs are captured before the fetch, and any key edited, acknowledged, or
 * abandoned while the fetch was in the air — plus any key still dirty — keeps
 * its local value this round. Every paired-mode snapshot application belongs
 * here (lib/sync wraps this; the raw applySnapshot is for the demo pipeline,
 * which has no outbox to race).
 *
 * Lives beside the store rather than in lib/sync because both need it and
 * only this module sits below the two of them in the import graph.
 */
export async function refreshConfigSnapshot(): Promise<void> {
  const before = captureOutboxState()
  // The desktop itself while it is on the bridge, the org's synced copy
  // otherwise (lib/sync/snapshot) — either way the same object.
  const snapshot = (await fetchConfigSnapshot()) as ConfigSnapshot | null
  if (!snapshot) return
  const keepLocal = outboxKeysToKeepLocal(before) as Array<keyof DemoConfigValues>
  useDemoConfig.getState().applySnapshot(snapshot, keepLocal.length ? { keepLocal } : undefined)
}

/**
 * A snapshot that arrived WITH its change push — no fetch window to
 * bracket, so the instantaneous dirty set is the whole guard: a push
 * landing mid-edit loses to the edit, and the ack that settles it is what
 * lets the next push land desktop truth.
 */
export function applyPushedSnapshot(snapshot: ConfigSnapshot): void {
  const before = captureOutboxState()
  const keepLocal = outboxKeysToKeepLocal(before) as Array<keyof DemoConfigValues>
  useDemoConfig.getState().applySnapshot(snapshot, keepLocal.length ? { keepLocal } : undefined)
}

/**
 * A targeted variables push landed — the desktop sent the array itself, so it
 * goes straight into the store and onto the screen, no snapshot round trip.
 *
 * The instantaneous outbox check is the whole race story here: mid-edit the
 * local array wins (this phone's write is already on its way to the desktop,
 * whose arrival order decides), and once the edit is acknowledged the next
 * push or refresh lands desktop truth. Same drift tolerance and draft
 * preservation as the snapshot path, via the shared merge.
 */
export function applyVariablesPush(rows: unknown): void {
  if (!Array.isArray(rows)) return
  if (outboxIsDirty('variables')) return
  useDemoConfig.setState((state) => ({
    variables: mergeVariablesFromDesktop(rows as ConfigSnapshot['variables'], state.variables)
  }))
}

/**
 * Settings are the desktop's to change, and only reachable while connected.
 * Demo mode owns its own config outright, so it is always writable.
 */
export function settingsAreReadOnly(): boolean {
  const { paired } = useAppStore.getState()
  return paired && !bridgeClient.connected
}

/** Reactive form of the above, for screens that need to disable their controls. */
export function useSettingsReadOnly(): boolean {
  const paired = useAppStore((state) => state.paired)
  const [connected, setConnected] = useState(bridgeClient.connected)
  useEffect(() => bridgeClient.subscribe((state) => setConnected(state.status === 'connected')), [])
  return paired && !connected
}

/**
 * The org catalog to pick from. Empty is a legitimate answer (see
 * `modelCatalog`), and callers render the current model rather than an empty
 * row when it is.
 */
export function useModelCatalog(): ModelCatalogEntry[] {
  return useDemoConfig((state) => state.modelCatalog)
}

/** The last daily/weekly compaction runs — null until one has actually run. */
export function useCompactionRuns(): CompactionRuns {
  return useDemoConfig((state) => state.compactionRuns)
}

/** The snapshot's usage ledger rows — empty until a snapshot has landed. */
export function useUsageDays(): UsageDay[] {
  return useDemoConfig((state) => state.usage)
}

/** The paired desktop app — all-null until a config snapshot has landed. */
export function useDesktopInfo(): DesktopInfo {
  return useDemoConfig((state) => state.desktop)
}

/** The desktop's Data-panel numbers — all-null until a snapshot has landed. */
export function useDesktopData(): DesktopData {
  return useDemoConfig((state) => state.desktopData)
}

/** Desktop release-note months, newest first — empty until a snapshot lands. */
export function useDesktopChangelogMonths(): string[] {
  return useDemoConfig((state) => state.desktopChangelogMonths)
}

/**
 * One customization document's markdown — the single-field subscription the
 * store's performance contract asks for, so typing in Soul never re-renders
 * the User and Agents cards beside it.
 */
export function useCustomizationDoc(doc: CustomizationDoc): string {
  return useDemoConfig((state) => state[CUSTOMIZATION_KEYS[doc]])
}

/** Is this document too large for the desktop to have sent it at all? */
export function useCustomizationOversized(doc: CustomizationDoc): boolean {
  return useDemoConfig((state) => state.customizationOversized.includes(doc))
}

/**
 * Resolve a conversation's `projectId` to the project it belongs to. Returns
 * null for an unbound conversation, and for an id whose project the snapshot
 * no longer carries (deleted upstream) — callers fall back to the raw id.
 */
export function useProject(projectId: string | null | undefined): DemoProject | null {
  return useDemoConfig((state) =>
    projectId ? (state.projects.find((project) => project.id === projectId) ?? null) : null
  )
}
