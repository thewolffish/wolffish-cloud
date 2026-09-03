/**
 * Every scalar setting the desktop panels expose, described as data.
 *
 * Three things already exist and are reused verbatim rather than restated:
 *
 *  1. CURRENT VALUES come from `buildConfigSnapshot()`, the phone's config
 *     snapshot. It already assembles every panel's state for a non-renderer
 *     client. A second reader would be a second thing to keep true.
 *  2. WRITES go through the app's own IPC channels — the exact handlers the
 *     desktop panels call. Nothing here writes config.json.
 *  3. LABELS and descriptions are plain English, written here. The terminal
 *     is an English surface — no locale bundles, no key indirection, nothing
 *     that can print `chat.mode` when a lookup misses. The text mirrors what
 *     the desktop cards say; only the desktop translates it.
 *
 * What did NOT exist is the BINDING between the first two and the words. That
 * table is this file. A setting added here is immediately listable, readable,
 * writable and documented in the CLI, with no further wiring.
 *
 * THE SHAPE IS THE WINDOW'S SHAPE: page → card → row. The desktop nav has a
 * tab (`CLI_SETTING_GROUPS`), the tab has cards (`CLI_SETTING_SECTIONS`), and
 * a card holds rows. Flattening that away is not a simplification — it is what
 * produced a terminal listing with "Verbose task results" four times and no
 * way to tell which was the phone's. Labels are card-scoped in the app
 * ("Task results" inside a Mobile card is unambiguous), so a row's label is only
 * meaningful UNDER ITS SECTION, and a label never repeats the channel name
 * the section heading already prints.
 *
 * LIST-SHAPED state is deliberately absent: capabilities, variables, MCP
 * servers, channel pairing. A table row is a poor way to edit a list, and
 * each of those has an interactive flow instead (see the CLI's ACTIONS, which
 * are registered against these same group + section ids so they land on the
 * card the user is already looking at).
 */

export type CliSettingKind = 'boolean' | 'enum' | 'number' | 'string' | 'secret'

export type CliSettingOption = {
  value: string
  label: string
}

export type CliSetting = {
  /** What the user types: `wfc settings set wfc.bypassPermissions on`. */
  id: string
  group: CliSettingGroup
  /** The card this row sits in — a `CLI_SETTING_SECTIONS` id. */
  section: string
  /** The row's name, as the desktop card says it. Card-scoped, English. */
  label: string
  /** A sentence or two under the label — what the setting does. */
  description?: string
  kind: CliSettingKind
  options?: CliSettingOption[]
  /** Dot path into the config snapshot holding the current value. */
  read: string
  /** The IPC channel that writes it. */
  channel: string
  /**
   * How the value reaches the handler. `null` = passed bare
   * (`runtime:setBypassPermissions(true)`); a dotted string = wrapped into that shape
   * (`'a.b'` → `[{ a: { b: 'v' } }]`), which is how every
   * `*:setConfig` handler takes a partial.
   */
  wrap: string | null
  /** Overrides `wrap` entirely for handlers that take positional arguments. */
  argsFor?: (value: unknown) => unknown[]
  /**
   * Reported next to the value but not writable — a setting whose real state
   * lives outside config.json and can disagree with it.
   */
  actualRead?: string
  /** Units or bounds shown in the prompt, e.g. "0-23". */
  hint?: string
}

export type CliSettingGroup =
  | 'model'
  | 'channels'
  | 'services'
  | 'mcp'
  | 'variables'
  | 'capabilities'
  | 'knowledge'
  | 'usage'
  | 'data'
  | 'wfc'
  | 'appearance'

/**
 * The settings PAGES, in the desktop nav's own order (Settings.tsx `TABS`).
 *
 * `interactive` marks a page whose whole content is a flow rather than rows —
 * MCP servers, variables, capabilities, the usage report, the data tools. They
 * are pages in the window and they are pages here; leaving them out to keep
 * the table tidy would be exactly the "where did that setting go" problem the
 * CLI is supposed to end.
 */
export const CLI_SETTING_GROUPS: Array<{
  id: CliSettingGroup
  label: string
  interactive?: true
}> = [
  { id: 'channels', label: 'Channels' },
  { id: 'model', label: 'Models' },
  { id: 'services', label: 'Services' },
  { id: 'mcp', label: 'MCP', interactive: true },
  { id: 'variables', label: 'Variables', interactive: true },
  {
    id: 'capabilities',
    label: 'Capabilities',
    interactive: true
  },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'usage', label: 'Usage', interactive: true },
  { id: 'data', label: 'Data', interactive: true },
  { id: 'wfc', label: 'Preferences' },
  { id: 'appearance', label: 'Appearance' }
]

/**
 * The CARDS on each page — the desktop's sub-tabs where it has them
 * (Models → one per provider, Channels → one per channel, Services → one per
 * service, Knowledge → Compaction and Reflection), and the panel's own title
 * where the page is a single card.
 *
 * Names are the window's: a card called Mobile in the app is called
 * Mobile here, because someone who knows where a setting lives on screen
 * should not have to learn a second taxonomy.
 */
export type CliSettingSection = {
  id: string
  group: CliSettingGroup
  label: string
}

export const CLI_SETTING_SECTIONS: CliSettingSection[] = [
  // Models — the chat-wide choices. The catalog itself is the org's
  // (GET /v1/models): nothing to configure here beyond the pick.
  { id: 'model.chat', group: 'model', label: 'Chat' },

  // Channels — the desktop's four sub-tabs, in its order.
  {
    id: 'channels.inapp',
    group: 'channels',
    label: 'In-App'
  },
  { id: 'channels.cli', group: 'channels', label: 'CLI' },
  {
    id: 'channels.mobile',
    group: 'channels',
    label: 'Mobile'
  },
  {
    id: 'channels.browser',
    group: 'channels',
    label: 'Browser'
  },

  // Services — the desktop's one card.
  {
    id: 'services.brave',
    group: 'services',
    label: 'Brave Search'
  },
  {
    id: 'services.tts',
    group: 'services',
    label: 'Text-to-Speech'
  },
  {
    id: 'services.stt',
    group: 'services',
    label: 'Speech-to-Text'
  },
  {
    id: 'services.computerUse',
    group: 'services',
    label: 'Computer Use'
  },

  // Single-card pages. The card still exists so the flows registered against
  // it have somewhere to land.
  { id: 'mcp.servers', group: 'mcp', label: 'MCP' },
  {
    id: 'variables.list',
    group: 'variables',
    label: 'Variables'
  },
  {
    id: 'capabilities.list',
    group: 'capabilities',
    label: 'Capabilities'
  },
  {
    id: 'knowledge.compaction',
    group: 'knowledge',
    label: 'Compaction'
  },
  {
    id: 'knowledge.reflection',
    group: 'knowledge',
    label: 'Reflection'
  },
  { id: 'usage.report', group: 'usage', label: 'Usage' },
  { id: 'data.workspace', group: 'data', label: 'Data' },
  {
    id: 'wfc.general',
    group: 'wfc',
    label: 'Preferences'
  },
  {
    id: 'appearance.general',
    group: 'appearance',
    label: 'Appearance'
  }
]

const HOURS: CliSettingOption[] = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, '0')}:00`
}))

const DAYS: CliSettingOption[] = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' }
]

/**
 * JPEG and PNG, and nothing else.
 *
 * WebP was offered here and exists nowhere else in the app: the stored type is
 * `'jpeg' | 'png'` (workspace.ts) and the writer coerces anything that is not
 * `png` to `jpeg` (index.ts). Picking it was accepted, echoed back as WebP by
 * the enum's own label, and stored as JPEG — a setting that lies about itself
 * in both directions.
 */
const IMAGE_FORMATS: CliSettingOption[] = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' }
]

/**
 * The Kokoro voices the TTS panel offers. A closed set in the app and free
 * text here meant a typo was accepted, stored, and only discovered when the
 * agent next tried to speak.
 */
const TTS_VOICES: CliSettingOption[] = [
  { value: 'af_bella', label: 'Bella · English (US)' },
  { value: 'af_heart', label: 'Heart · English (US)' },
  { value: 'af_nicole', label: 'Nicole · English (US)' },
  { value: 'af_sarah', label: 'Sarah · English (US)' },
  { value: 'af_aoede', label: 'Aoede · English (US)' },
  { value: 'af_kore', label: 'Kore · English (US)' },
  { value: 'af_nova', label: 'Nova · English (US)' },
  { value: 'af_sky', label: 'Sky · English (US)' },
  { value: 'am_adam', label: 'Adam · English (US)' },
  { value: 'am_michael', label: 'Michael · English (US)' },
  { value: 'am_eric', label: 'Eric · English (US)' },
  { value: 'am_liam', label: 'Liam · English (US)' },
  { value: 'am_onyx', label: 'Onyx · English (US)' },
  { value: 'am_puck', label: 'Puck · English (US)' },
  { value: 'bf_emma', label: 'Emma · English (UK)' },
  { value: 'bf_isabella', label: 'Isabella · English (UK)' },
  { value: 'bf_alice', label: 'Alice · English (UK)' },
  { value: 'bf_lily', label: 'Lily · English (UK)' },
  { value: 'bm_george', label: 'George · English (UK)' },
  { value: 'bm_lewis', label: 'Lewis · English (UK)' },
  { value: 'bm_daniel', label: 'Daniel · English (UK)' },
  { value: 'bm_fable', label: 'Fable · English (UK)' }
]

const TTS_SPEEDS: CliSettingOption[] = [
  { value: '0.75', label: 'Slow' },
  { value: '1.0', label: 'Normal' },
  { value: '1.25', label: 'Fast' },
  { value: '1.5', label: 'Very fast' }
]

/**
 * Whisper's transcription languages — the renderer catalog
 * (pages/settings/whisperLanguages.ts) verbatim, 'auto' pinned first the
 * way the panel pins it. 100 languages + auto.
 */
const STT_LANGUAGES: CliSettingOption[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'af', label: 'Afrikaans' },
  { value: 'sq', label: 'Albanian' },
  { value: 'am', label: 'Amharic' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hy', label: 'Armenian' },
  { value: 'as', label: 'Assamese' },
  { value: 'az', label: 'Azerbaijani' },
  { value: 'ba', label: 'Bashkir' },
  { value: 'eu', label: 'Basque' },
  { value: 'be', label: 'Belarusian' },
  { value: 'bn', label: 'Bengali' },
  { value: 'bs', label: 'Bosnian' },
  { value: 'br', label: 'Breton' },
  { value: 'bg', label: 'Bulgarian' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'ca', label: 'Catalan' },
  { value: 'zh', label: 'Chinese' },
  { value: 'hr', label: 'Croatian' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' },
  { value: 'et', label: 'Estonian' },
  { value: 'fo', label: 'Faroese' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'gl', label: 'Galician' },
  { value: 'ka', label: 'Georgian' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'ht', label: 'Haitian Creole' },
  { value: 'ha', label: 'Hausa' },
  { value: 'haw', label: 'Hawaiian' },
  { value: 'he', label: 'Hebrew' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'is', label: 'Icelandic' },
  { value: 'id', label: 'Indonesian' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'jw', label: 'Javanese' },
  { value: 'kn', label: 'Kannada' },
  { value: 'kk', label: 'Kazakh' },
  { value: 'km', label: 'Khmer' },
  { value: 'ko', label: 'Korean' },
  { value: 'lo', label: 'Lao' },
  { value: 'la', label: 'Latin' },
  { value: 'lv', label: 'Latvian' },
  { value: 'ln', label: 'Lingala' },
  { value: 'lt', label: 'Lithuanian' },
  { value: 'lb', label: 'Luxembourgish' },
  { value: 'mk', label: 'Macedonian' },
  { value: 'mg', label: 'Malagasy' },
  { value: 'ms', label: 'Malay' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'mt', label: 'Maltese' },
  { value: 'mi', label: 'Maori' },
  { value: 'mr', label: 'Marathi' },
  { value: 'mn', label: 'Mongolian' },
  { value: 'my', label: 'Myanmar' },
  { value: 'ne', label: 'Nepali' },
  { value: 'no', label: 'Norwegian' },
  { value: 'nn', label: 'Norwegian Nynorsk' },
  { value: 'oc', label: 'Occitan' },
  { value: 'ps', label: 'Pashto' },
  { value: 'fa', label: 'Persian' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'sa', label: 'Sanskrit' },
  { value: 'sr', label: 'Serbian' },
  { value: 'sn', label: 'Shona' },
  { value: 'sd', label: 'Sindhi' },
  { value: 'si', label: 'Sinhala' },
  { value: 'sk', label: 'Slovak' },
  { value: 'sl', label: 'Slovenian' },
  { value: 'so', label: 'Somali' },
  { value: 'es', label: 'Spanish' },
  { value: 'su', label: 'Sundanese' },
  { value: 'sw', label: 'Swahili' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tl', label: 'Tagalog' },
  { value: 'tg', label: 'Tajik' },
  { value: 'ta', label: 'Tamil' },
  { value: 'tt', label: 'Tatar' },
  { value: 'te', label: 'Telugu' },
  { value: 'th', label: 'Thai' },
  { value: 'bo', label: 'Tibetan' },
  { value: 'tr', label: 'Turkish' },
  { value: 'tk', label: 'Turkmen' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'ur', label: 'Urdu' },
  { value: 'uz', label: 'Uzbek' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'cy', label: 'Welsh' },
  { value: 'yi', label: 'Yiddish' },
  { value: 'yo', label: 'Yoruba' }
]

/** faster-whisper sizes, smallest first — the panel's own list. */
const STT_MODELS: CliSettingOption[] = [
  { value: 'tiny', label: 'Tiny' },
  { value: 'base', label: 'Base' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
]

export const CLI_SETTINGS: CliSetting[] = [
  // ── Models ───────────────────────────────────────────────────────────────
  {
    id: 'model.mode',
    group: 'model',
    section: 'model.chat',
    label: 'Chat mode',
    description:
      'Single has one model answer directly — everyday questions. Workflow has many agents plan and verify — complex tasks.',
    kind: 'enum',
    options: [
      { value: 'single', label: 'Single' },
      { value: 'workflow', label: 'Workflow' }
    ],
    read: 'llm.chatMode',
    channel: 'provider:setMode',
    wrap: null
  },

  // ── Channels ─────────────────────────────────────────────────────────────
  {
    id: 'channels.inapp.verbose',
    group: 'channels',
    section: 'channels.inapp',
    label: 'Verbose task results',
    description:
      'Show every tool call and step in the chat, plus the model/provider chip. Off (the default) keeps a clean feed — only agent replies and the files it sends.',
    kind: 'boolean',
    read: 'channels.inapp.verbose',
    channel: 'inapp:setConfig',
    wrap: 'verbose'
  },
  {
    id: 'channels.inapp.runCards',
    group: 'channels',
    section: 'channels.inapp',
    label: 'Run cards',
    description:
      'Show a live card over the app while one of your automations or procedures runs. Off (the default) keeps the screen quiet — the run still happens, still logs, and still reports on its own page. Compaction and reflection have their own switches, under Knowledge.',
    kind: 'boolean',
    read: 'channels.inapp.runCards',
    channel: 'inapp:setConfig',
    wrap: 'runCards'
  },
  {
    id: 'channels.cli.verbose',
    group: 'channels',
    section: 'channels.cli',
    label: 'Verbose task results',
    description:
      'Off (default) prints a clean feed: what the agent says, the files it delivers, and anything that failed. On adds the model chip and every tool call and result, the same way the in-app verbose toggle does.',
    kind: 'boolean',
    read: 'channels.cli.verbose',
    channel: 'cli:setConfig',
    wrap: 'verbose'
  },
  {
    /**
     * Which autostart registration this machine gets. A login item needs a
     * desktop session and opens a window; a background service starts with the
     * machine and needs neither — the only setting that matters on a headless
     * box, and the one the terminal is most likely to be configuring.
     */
    id: 'channels.cli.runMode',
    group: 'channels',
    section: 'channels.cli',
    label: 'Start it as',
    description:
      'A login item starts when you log in and opens the window — it needs a desktop session. A background service starts with the machine, with no session and no window — what a server wants.',
    kind: 'enum',
    options: [
      { value: 'gui', label: 'Login item' },
      {
        value: 'headless',
        label: 'Background service'
      }
    ],
    read: 'channels.cli.runMode',
    channel: 'service:setMode',
    wrap: null
  },
  {
    id: 'channels.mobile.notifications',
    group: 'channels',
    section: 'channels.mobile',
    label: 'Phone notifications',
    description:
      'Lets the agent send a push notification to your paired phone with its notify_phone tool — when a run finishes, fails, or needs you. Nothing is ever sent automatically; the agent has to deliberately call the tool, and Off makes that tool refuse.',
    kind: 'boolean',
    read: 'channels.mobile.notifications',
    channel: 'mobile:setNotifications',
    wrap: null
  },
  {
    id: 'channels.mobile.verbose',
    group: 'channels',
    section: 'channels.mobile',
    label: 'Task results',
    description:
      "Off keeps the phone's feed clean: assistant messages, file-bearing results and errors. On relays every tool call and activity. Connection logging is always on and is not affected by this.",
    kind: 'boolean',
    read: 'channels.mobile.verbose',
    channel: 'mobile:setVerbose',
    wrap: null
  },
  {
    id: 'channels.mobile.runCards',
    group: 'channels',
    section: 'channels.mobile',
    label: 'Run cards',
    description:
      'Show a live card on the paired phone while one of your automations or procedures runs. Off (the default) keeps the phone quiet — nothing about the run itself changes.',
    kind: 'boolean',
    read: 'channels.mobile.runCards',
    channel: 'mobile:setRunCards',
    wrap: null
  },
  // Browser — the extension card, a channel on the desktop. The `read`
  // paths keep the snapshot's `services.browserExtension` shape: that is the
  // phone's wire contract, not this table's taxonomy.
  {
    id: 'channels.browser.port',
    group: 'channels',
    section: 'channels.browser',
    label: 'WebSocket Port',
    description:
      "The port the extension connects to. Default is 23152. Change only if there's a conflict.",
    kind: 'number',
    read: 'services.browserExtension.port',
    channel: 'browserExtension:setConfig',
    wrap: 'port'
  },
  {
    id: 'channels.browser.screenshotMaxWidth',
    group: 'channels',
    section: 'channels.browser',
    label: 'Screenshot resolution',
    description: 'Maximum width in pixels. Lower values use less tokens but reduce detail.',
    kind: 'number',
    hint: 'pixels',
    read: 'services.browserExtension.screenshotMaxWidth',
    channel: 'browserExtension:setConfig',
    wrap: 'screenshotMaxWidth'
  },
  {
    id: 'channels.browser.screenshotFormat',
    group: 'channels',
    section: 'channels.browser',
    label: 'Screenshot format',
    description: 'JPEG is smaller and faster. PNG is lossless and better for text-heavy screens.',
    kind: 'enum',
    options: IMAGE_FORMATS,
    read: 'services.browserExtension.screenshotFormat',
    channel: 'browserExtension:setConfig',
    wrap: 'screenshotFormat'
  },
  {
    id: 'channels.browser.screenshotQuality',
    group: 'channels',
    section: 'channels.browser',
    label: 'Screenshot quality',
    description: 'JPEG quality, 1-100. Higher is sharper and larger.',
    kind: 'number',
    hint: '1-100',
    read: 'services.browserExtension.screenshotQuality',
    channel: 'browserExtension:setConfig',
    wrap: 'screenshotQuality'
  },

  // ── Services ─────────────────────────────────────────────────────────────
  // Brave Search has no rows: it is provided by the organization (one key
  // behind the API's /v1/search lane), so the card carries only the "Check
  // the org lane" action (settings-actions.mjs) that prints the lane's status.
  {
    id: 'services.tts.voice',
    group: 'services',
    section: 'services.tts',
    label: 'Default voice',
    description: 'The voice used when Wolffish speaks.',
    kind: 'enum',
    options: TTS_VOICES,
    read: 'services.ttsVoice',
    channel: 'tts:setConfig',
    wrap: 'defaultVoice'
  },
  {
    id: 'services.tts.speed',
    group: 'services',
    section: 'services.tts',
    label: 'Speech rate',
    description: 'How fast generated speech plays.',
    kind: 'enum',
    options: TTS_SPEEDS,
    read: 'services.ttsSpeed',
    channel: 'tts:setConfig',
    wrap: 'defaultSpeed'
  },
  {
    id: 'services.stt.model',
    group: 'services',
    section: 'services.stt',
    label: 'Default model',
    description:
      'Whisper model for transcription. Larger models are more accurate and slower. Small is the default.',
    kind: 'enum',
    options: STT_MODELS,
    read: 'services.sttModel',
    channel: 'stt:setConfig',
    wrap: 'defaultModel'
  },
  {
    id: 'services.stt.language',
    group: 'services',
    section: 'services.stt',
    label: 'Language',
    description:
      'Every voice note and transcription is pinned to this language. Auto-detect can misread short recordings.',
    kind: 'enum',
    options: STT_LANGUAGES,
    read: 'services.sttLanguage',
    channel: 'stt:setConfig',
    wrap: 'language'
  },
  {
    id: 'services.computerUse.screenshotMaxWidth',
    group: 'services',
    section: 'services.computerUse',
    label: 'Screenshot resolution',
    description: 'Maximum width in pixels. Lower values use less tokens but reduce detail.',
    kind: 'number',
    hint: 'pixels',
    read: 'services.screenshotMaxWidth',
    channel: 'computerUse:setConfig',
    wrap: 'screenshotMaxWidth'
  },
  {
    id: 'services.computerUse.screenshotFormat',
    group: 'services',
    section: 'services.computerUse',
    label: 'Screenshot format',
    description: 'JPEG is smaller and faster. PNG is lossless and better for text-heavy screens.',
    kind: 'enum',
    options: IMAGE_FORMATS,
    read: 'services.screenshotFormat',
    channel: 'computerUse:setConfig',
    wrap: 'screenshotFormat'
  },

  // ── Knowledge ────────────────────────────────────────────────────────────
  {
    id: 'knowledge.compaction.dailyHour',
    group: 'knowledge',
    section: 'knowledge.compaction',
    label: 'Daily compaction',
    description: "Extracts key facts from today's conversations and saves them to knowledge files.",
    kind: 'enum',
    options: HOURS,
    read: 'compaction.dailyHour',
    channel: 'runtime:setCompactionConfig',
    wrap: 'dailyHour'
  },
  {
    id: 'knowledge.compaction.weeklyDay',
    group: 'knowledge',
    section: 'knowledge.compaction',
    label: 'Weekly consolidation',
    description: "Merges the week's episode logs into a single digest for archival.",
    kind: 'enum',
    options: DAYS,
    read: 'compaction.weeklyDay',
    channel: 'runtime:setCompactionConfig',
    wrap: 'weeklyDay'
  },
  {
    id: 'knowledge.compaction.weeklyHour',
    group: 'knowledge',
    section: 'knowledge.compaction',
    label: 'Weekly consolidation hour',
    description: 'The hour the weekly consolidation runs, on the chosen day.',
    kind: 'enum',
    options: HOURS,
    read: 'compaction.weeklyHour',
    channel: 'runtime:setCompactionConfig',
    wrap: 'weeklyHour'
  },
  {
    id: 'knowledge.compaction.cards',
    group: 'knowledge',
    section: 'knowledge.compaction',
    label: 'Compaction cards',
    description:
      'Show a live card while a compaction pass runs — over the chat in the app, and on the paired phone. Off (the default) hides the card only; the passes still run on their schedule.',
    kind: 'boolean',
    read: 'compaction.cards',
    channel: 'runtime:setCompactionConfig',
    wrap: 'cards'
  },
  {
    id: 'knowledge.reflection.hour',
    group: 'knowledge',
    section: 'knowledge.reflection',
    label: 'Nightly reflection',
    description:
      'Reviews every conversation that has settled since the last pass — automations included — scoring each one and extracting what worked, what failed, and what you liked. The lessons fold into the playbook carried into every turn. Missed fires (asleep, app closed) run on the next launch.',
    kind: 'enum',
    options: HOURS,
    read: 'reflection.hour',
    channel: 'runtime:setReflectionConfig',
    wrap: 'hour'
  },
  {
    id: 'knowledge.reflection.quietHours',
    group: 'knowledge',
    section: 'knowledge.reflection',
    label: 'Review after quiet for',
    description:
      "A conversation is only reviewed once it has been idle this long, so unfinished work isn't judged early. Anything still warm simply waits for a later night — nothing is ever skipped — and a conversation you continue after its review gets reviewed again with the new turns included.",
    kind: 'number',
    hint: 'hours',
    read: 'reflection.quietHours',
    channel: 'runtime:setReflectionConfig',
    wrap: 'quietHours'
  },
  {
    id: 'knowledge.reflection.cards',
    group: 'knowledge',
    section: 'knowledge.reflection',
    label: 'Reflection cards',
    description:
      'Show a live card while a reflection runs — over the chat in the app, and on the paired phone. Off (the default) hides the card only; the nightly review and the deep clean still run.',
    kind: 'boolean',
    read: 'reflection.cards',
    channel: 'runtime:setReflectionConfig',
    wrap: 'cards'
  },

  // ── Preferences ──────────────────────────────────────────────────────────
  {
    id: 'wfc.launchAtStartup',
    group: 'wfc',
    section: 'wfc.general',
    label: 'Launch at startup',
    description:
      'Automatically start Wolffish when you log into your computer. When enabled, Wolffish registers itself as a login item with your operating system — macOS, Windows, and Linux are all supported. This lets Wolffish be ready the moment your session begins, so you can jump straight into a conversation without opening it manually. Disable this if you prefer to launch Wolffish only when you need it.',
    kind: 'boolean',
    read: 'preferences.launchAtStartup',
    actualRead: 'preferences.launchAtStartupActive',
    channel: 'runtime:setLaunchAtStartup',
    wrap: null
  },
  {
    id: 'wfc.voiceReplies',
    group: 'wfc',
    section: 'wfc.general',
    label: 'Voice replies',
    description:
      'When you send a voice prompt, Wolffish replies with a spoken voice memo. Files and text still arrive when the work needs them — the reply just ends spoken aloud. This one switch controls whether the model is given the voice-reply instructions at all: on means every conversation carries the standing policy, off removes it entirely and voice prompts get text replies. Stored with the text-to-speech settings and synced live with the desktop Preferences page and the phone.',
    kind: 'boolean',
    read: 'services.ttsVoiceReplies',
    channel: 'tts:setConfig',
    wrap: 'voiceReplies'
  },
  {
    id: 'wfc.blockCredentials',
    group: 'wfc',
    section: 'wfc.general',
    label: 'Block sensitive data in messages',
    description:
      'When enabled, messages that appear to contain passwords, API keys, tokens, or private keys are immediately discarded — they never reach the agent, are never stored, and you get a short notification instead. Off by default so the agent can freely discuss credentials when needed. Turn it on if you want a hard guard against accidentally pasting secrets into chat.',
    kind: 'boolean',
    read: 'preferences.blockCredentials',
    channel: 'runtime:setBlockCredentials',
    wrap: null
  },
  {
    id: 'wfc.bypassPermissions',
    group: 'wfc',
    section: 'wfc.general',
    label: 'Bypass permissions mode',
    description:
      'When enabled, all tool actions auto-approve without showing the approval dialog. The amygdala still classifies every action and logs everything to the corpus event bus and feedback files exactly as before — only the human approval step is skipped. Use this for trusted environments where you want full agent autonomy. Disable it any time to restore manual approval.',
    kind: 'boolean',
    read: 'preferences.bypassPermissions',
    channel: 'runtime:setBypassPermissions',
    wrap: null
  },
  {
    id: 'wfc.weekStartsOn',
    group: 'wfc',
    section: 'wfc.general',
    label: 'Start of week',
    description:
      'Sets the day Wolffish treats as the first day of the week. Drives how the activity heatmap is laid out and how date ranges like "this week" line up in your head. Default is Monday (the ISO 8601 standard most of the world uses); pick Sunday if your calendar app and routines start there. Internal weekly memory files keep their existing ISO-week names so older summaries don\'t shift.',
    kind: 'enum',
    options: [
      { value: '1', label: 'Monday' },
      { value: '0', label: 'Sunday' }
    ],
    read: 'preferences.weekStartsOn',
    channel: 'runtime:setWeekStartsOn',
    wrap: null
  },

  // ── Appearance ───────────────────────────────────────────────────────────
  {
    id: 'appearance.theme',
    group: 'appearance',
    section: 'appearance.general',
    label: 'Theme',
    description: 'System follows the operating system; Light and Dark force one look.',
    kind: 'enum',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' }
    ],
    read: 'preferences.theme',
    channel: 'theme:set',
    wrap: null
  },
  {
    id: 'appearance.locale',
    group: 'appearance',
    section: 'appearance.general',
    label: 'Language',
    description: "The desktop app's display language. The terminal is always English.",
    kind: 'enum',
    options: [
      { value: 'en', label: 'English' },
      { value: 'ar', label: 'العربية' }
    ],
    read: 'preferences.locale',
    channel: 'locale:set',
    wrap: null
  }
]

/** Read a dot path out of the snapshot. Missing anywhere yields undefined. */
export function readPath(source: unknown, dotted: string): unknown {
  let node: unknown = source
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/**
 * Turn what a user typed into what the handler expects. Strict on booleans and
 * numbers, because a silently misinterpreted setting is worse than a refusal —
 * `--verbose maybe` should fail loudly rather than quietly meaning `false`.
 */
export function coerceSettingValue(
  setting: CliSetting,
  raw: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim()
  switch (setting.kind) {
    case 'boolean': {
      if (/^(on|true|yes|y|1|enabled)$/i.test(text)) return { ok: true, value: true }
      if (/^(off|false|no|n|0|disabled)$/i.test(text)) return { ok: true, value: false }
      return { ok: false, error: `expected on or off, got "${text}"` }
    }
    case 'number': {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: `expected a number, got "${text}"` }
      return { ok: true, value: n }
    }
    case 'enum': {
      const allowed = setting.options?.map((o) => o.value) ?? []
      if (!allowed.includes(text)) {
        const shown = allowed.length > 8 ? `${allowed.slice(0, 8).join(', ')}…` : allowed.join(', ')
        return { ok: false, error: `expected one of ${shown}, got "${text}"` }
      }
      // Numeric enums (hours, weekdays, week start) travel as numbers even
      // though the user picks them as text.
      return { ok: true, value: /^\d+$/.test(text) ? Number(text) : text }
    }
    default:
      return { ok: true, value: text }
  }
}

/**
 * Build the handler arguments. `wrap` may be dotted, so a nested partial like
 * `{ a: { b: 'v' } }` needs no special case at the call site.
 */
export function settingArgs(setting: CliSetting, value: unknown): unknown[] {
  if (setting.argsFor) return setting.argsFor(value)
  if (setting.wrap === null) return [value]
  const parts = setting.wrap.split('.')
  let payload: unknown = value
  for (let i = parts.length - 1; i >= 0; i--) payload = { [parts[i]]: payload }
  return [payload]
}
