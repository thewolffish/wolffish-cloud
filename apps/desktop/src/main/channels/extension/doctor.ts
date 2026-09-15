/**
 * Browser-extension readiness: collectors gather raw facts about this
 * machine and the connected extension, a PURE composer turns them into a
 * ranked list of findings the user can act on, and a fix executor runs the
 * one-click repairs.
 *
 * Layering matters here. `composeFindings` does no I/O at all — it is the
 * part unit tests exercise with hand-built facts, and the part the model's
 * `ext_doctor` output is derived from, so it must be deterministic. The
 * collectors are the only thing that touches disk, processes, Electron or
 * the extension. `electron` and the workspace module are imported LAZILY
 * inside the collectors so this file loads under plain `tsx` (no Electron
 * binary) for the composer tests.
 *
 * Copy in `title` / `detail` / `steps` is written for the USER, in plain
 * English, using Chrome's own labels ("Site access", "On all sites",
 * "Developer mode", "Load unpacked", "Allow in Incognito", "Allow access to
 * file URLs") so a step can be followed by matching the words on screen.
 */
import type { ExtensionBrowserInfo, ExtensionServerStatus } from '@main/channels/extension/server'
import type { ExtensionLastSeen } from '@main/workspace/workspace'
import { execFile, spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ─── Types (contract §6) ────────────────────────────────────────────────────

export type FindingSeverity = 'blocker' | 'degraded' | 'note'
export type FixKind = 'auto' | 'one-click' | 'guided' | 'none'

export interface Finding {
  /** Stable snake_case id — the renderer translates by id, the model relays title + steps. */
  id: string
  severity: FindingSeverity
  title: string
  /** One sentence: why it matters for what the user asked. */
  detail: string
  fix: { kind: FixKind; action?: string; steps: string[]; url?: string }
  /** What a re-probe checks to confirm the fix landed. */
  verify: string
  /** Selection key when the finding is about one connected browser. */
  browser?: string
}

export type DoctorTier = 'full' | 'degraded' | 'managed' | 'none'

export interface DoctorReport {
  ready: boolean
  tier: DoctorTier
  findings: Finding[]
  /** One line the model can paste. */
  summary: string
  facts: Record<string, unknown>
}

/** The extension's own `browser_doctor` answer (contract §1). */
export interface BrowserDoctorProbe {
  extension: {
    id: string
    version: string
    manifestPermissions: string[]
    hostPermissions: string[]
  }
  siteAccessAllUrls: boolean | null
  incognitoAllowed: boolean | null
  fileSchemeAllowed: boolean | null
  notifications: 'granted' | 'denied' | null
  installType: string | null
  enabled: boolean | null
  mayDisable: boolean | null
  apis: {
    debugger: boolean
    tabGroups: boolean
    sidePanel: boolean
    scripting: boolean
    downloads: boolean
  }
  debuggerAttachedTabs: number[]
  scriptable: { tabId: number; ok: boolean; error?: string; url?: string } | null
  policyBlocked: boolean
}

export interface InstalledBrowser {
  slug: string
  name: string
  /** App bundle (mac), exe (win) or resolved binary (linux). */
  path: string
}

export interface DevToolsPortState {
  present: boolean
  port?: number
}

export interface MacPermissions {
  accessibility: boolean | null
  screenRecording: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | null
  /** Automation (AppleScript) is granted per target app and has no probe; null = unknown. */
  automation: boolean | null
}

/** Everything the composer reasons over. Raw probe values, no judgement. */
export interface DoctorFacts {
  platform: NodeJS.Platform
  at: number
  server: { status: ExtensionServerStatus['status']; error: string | null; port: number }
  browsers: ExtensionBrowserInfo[]
  /** The browser the extension probe ran against (null when none connected). */
  target: ExtensionBrowserInfo | null
  lastSeen: Record<string, ExtensionLastSeen>
  installed: InstalledBrowser[]
  /** Slugs of supported browsers with a main process running right now. */
  running: string[]
  bundledVersion: string | null
  runtimeVersion: string | null
  bridgeTokenConfigured: boolean
  /** Last handshake refused for a wrong token, if recent. */
  tokenMismatch: { at: number; browser: string } | null
  /** Last `browser_debugger_attach` failure text, if recent. */
  attachError: { at: number; error: string } | null
  /** slug → DevToolsActivePort presence in that browser's default profile dir. */
  devtools: Record<string, DevToolsPortState>
  mac: MacPermissions | null
  /** Linux XDG_SESSION_TYPE (wayland / x11); null elsewhere. */
  sessionType: string | null
  probe: BrowserDoctorProbe | null
  probeError: string | null
}

export interface DoctorOptions {
  target?: string | null
  conversationId?: string | null
  tabId?: number
  /** Skip the extension round-trip — used by the cheap readiness path. */
  probe?: boolean
}

/** The slice of the server the collectors need — narrow so tests can fake it. */
export interface DoctorServerView {
  getStatus(): ExtensionServerStatus
  /** Runs `browser_doctor` on the resolved browser; throws with the routing error when none matches. */
  probeExtension(
    opts: DoctorOptions
  ): Promise<{ browser: ExtensionBrowserInfo; probe: BrowserDoctorProbe }>
  lastTokenMismatch(): { at: number; browser: string } | null
  lastAttachError(): { at: number; error: string } | null
}

export interface FixResult {
  ok: boolean
  message: string
  steps?: string[]
}

export interface FixOptions {
  target?: string | null
  /** open_system_settings: which macOS pane. */
  pane?: 'accessibility' | 'screenRecording' | 'automation' | string
  /** open_extension_details: the exact url from the finding, when the caller has it. */
  url?: string
  extensionId?: string | null
}

export interface FixDeps {
  restartServer(port: number): Promise<void>
  sendPortUpdate(port: number): void
  requestReload(target?: string | null): Promise<void>
  /** Extension id of the connected (or last known) browser, for chrome://extensions/?id= links. */
  extensionId?: string | null
}

// ─── Browser table (TS port of the plugin's BROWSERS) ───────────────────────
// Kept in lock-step with browser-extension/plugin/index.mjs: same slugs, same
// install locations. The extra `profile` column is the default user-data dir
// where Chromium writes DevToolsActivePort while remote debugging is on.

export interface BrowserEntry {
  slug: string
  name: string
  darwin: { app: string; bundleId: string } | null
  win32: { exes: string[]; progIds: string[] } | null
  linux: { bins: string[]; desktops: string[]; procs: string[] } | null
  /** Default profile dir relative to the platform's app-data root; null for non-Chromium. */
  profile: { darwin: string | null; win32: string | null; linux: string | null } | null
}

export const BROWSERS: BrowserEntry[] = [
  {
    slug: 'chrome',
    name: 'Google Chrome',
    darwin: { app: 'Google Chrome', bundleId: 'com.google.chrome' },
    win32: { exes: ['Google\\Chrome\\Application\\chrome.exe'], progIds: ['chromehtml'] },
    linux: {
      bins: ['google-chrome', 'google-chrome-stable'],
      desktops: ['google-chrome.desktop'],
      procs: ['chrome', 'google-chrome', 'google-chrome-stable']
    },
    profile: {
      darwin: 'Google/Chrome',
      win32: 'Google\\Chrome\\User Data',
      linux: 'google-chrome'
    }
  },
  {
    slug: 'edge',
    name: 'Microsoft Edge',
    darwin: { app: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
    win32: {
      exes: ['Microsoft\\Edge\\Application\\msedge.exe'],
      progIds: ['msedgehtm', 'msedgedhtml']
    },
    linux: {
      bins: ['microsoft-edge', 'microsoft-edge-stable'],
      desktops: ['microsoft-edge.desktop'],
      procs: ['msedge', 'microsoft-edge']
    },
    profile: {
      darwin: 'Microsoft Edge',
      win32: 'Microsoft\\Edge\\User Data',
      linux: 'microsoft-edge'
    }
  },
  {
    slug: 'brave',
    name: 'Brave',
    darwin: { app: 'Brave Browser', bundleId: 'com.brave.browser' },
    win32: {
      exes: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      progIds: ['bravehtml']
    },
    linux: {
      bins: ['brave-browser', 'brave'],
      desktops: ['brave-browser.desktop', 'brave.desktop'],
      procs: ['brave', 'brave-browser']
    },
    profile: {
      darwin: 'BraveSoftware/Brave-Browser',
      win32: 'BraveSoftware\\Brave-Browser\\User Data',
      linux: 'BraveSoftware/Brave-Browser'
    }
  },
  {
    slug: 'arc',
    name: 'Arc',
    darwin: { app: 'Arc', bundleId: 'company.thebrowser.browser' },
    win32: { exes: ['Arc\\app\\Arc.exe'], progIds: ['archtml'] },
    linux: null,
    profile: { darwin: 'Arc/User Data', win32: 'Arc\\User Data', linux: null }
  },
  {
    slug: 'vivaldi',
    name: 'Vivaldi',
    darwin: { app: 'Vivaldi', bundleId: 'com.vivaldi.vivaldi' },
    win32: { exes: ['Vivaldi\\Application\\vivaldi.exe'], progIds: ['vivaldihtm'] },
    linux: {
      bins: ['vivaldi', 'vivaldi-stable'],
      desktops: ['vivaldi-stable.desktop'],
      procs: ['vivaldi-bin', 'vivaldi']
    },
    profile: { darwin: 'Vivaldi', win32: 'Vivaldi\\User Data', linux: 'vivaldi' }
  },
  {
    slug: 'opera',
    name: 'Opera',
    darwin: { app: 'Opera', bundleId: 'com.operasoftware.opera' },
    win32: { exes: ['Opera\\launcher.exe'], progIds: ['operastable'] },
    linux: { bins: ['opera'], desktops: ['opera.desktop'], procs: ['opera'] },
    profile: {
      darwin: 'com.operasoftware.Opera',
      win32: 'Opera Software\\Opera Stable',
      linux: 'opera'
    }
  },
  {
    slug: 'chromium',
    name: 'Chromium',
    darwin: { app: 'Chromium', bundleId: 'org.chromium.chromium' },
    win32: { exes: ['Chromium\\Application\\chrome.exe'], progIds: ['chromiumhtm'] },
    linux: {
      bins: ['chromium', 'chromium-browser'],
      desktops: ['chromium.desktop', 'chromium-browser.desktop'],
      procs: ['chromium', 'chromium-browser', 'chrome']
    },
    profile: { darwin: 'Chromium', win32: 'Chromium\\User Data', linux: 'chromium' }
  },
  {
    slug: 'firefox',
    name: 'Firefox',
    darwin: { app: 'Firefox', bundleId: 'org.mozilla.firefox' },
    win32: { exes: ['Mozilla Firefox\\firefox.exe'], progIds: ['firefoxurl'] },
    linux: {
      bins: ['firefox', 'firefox-esr'],
      desktops: ['firefox.desktop', 'firefox-esr.desktop'],
      procs: ['firefox', 'firefox-bin', 'firefox-esr']
    },
    profile: null
  }
]

/** Slugs whose extension runtime is Chromium — the only ones the debugger lane and chrome:// pages apply to. */
const CHROMIUM_SLUGS = new Set(BROWSERS.filter((b) => b.profile !== null).map((b) => b.slug))

/** Same URLs computer-use's access.mjs opens — one place per pane. */
export const MAC_SETTINGS: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
}

/**
 * Ports the rotate_port fix may move to. 23152 is THIS edition's default and
 * stays reserved for it, and 23151 belongs to the personal edition — a machine
 * running both must not have one of them rotate onto the other's socket.
 */
const PORT_RANGE = { from: 23153, to: 23199 }

/** A token mismatch or attach failure older than this is history, not a finding. */
const RECENT_MS = 5 * 60_000

// ─── Collectors (I/O) ───────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Where this browser is installed on this machine, or null. */
async function findInstall(entry: BrowserEntry): Promise<string | null> {
  const platform = os.platform()
  if (platform === 'darwin') {
    if (!entry.darwin) return null
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const app = path.join(dir, `${entry.darwin.app}.app`)
      if (await exists(app)) return app
    }
    return null
  }
  if (platform === 'win32') {
    if (!entry.win32) return null
    const local = process.env['LOCALAPPDATA']
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      local,
      local ? path.join(local, 'Programs') : null
    ].filter((r): r is string => Boolean(r))
    for (const root of roots) {
      for (const rel of entry.win32.exes) {
        const exe = path.join(root, rel)
        if (await exists(exe)) return exe
      }
    }
    return null
  }
  if (!entry.linux) return null
  for (const bin of entry.linux.bins) {
    try {
      const { stdout } = await execFileP('which', [bin])
      const resolved = stdout.trim()
      if (resolved) return resolved
    } catch {
      // not on PATH
    }
  }
  return null
}

/** Supported browsers present on this machine, in table order. */
export async function installedBrowsers(): Promise<InstalledBrowser[]> {
  const found: InstalledBrowser[] = []
  for (const entry of BROWSERS) {
    const install = await findInstall(entry)
    if (install) found.push({ slug: entry.slug, name: entry.name, path: install })
  }
  return found
}

/**
 * Slugs of supported browsers with a MAIN process alive. One process
 * listing per call (not one pgrep per browser): the readiness path runs
 * this on every mobile snapshot. Helper/renderer processes are excluded by
 * matching the exact main-process name, so a Chrome that is quitting but
 * still tearing down helpers does not count as running.
 */
export async function runningBrowsers(): Promise<string[]> {
  const platform = os.platform()
  let names: string[] = []
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true })
      names = stdout
        .split(/\r?\n/)
        .map((line) => line.split('","')[0]?.replace(/^"/, '') ?? '')
        .filter(Boolean)
        .map((n) => n.toLowerCase())
    } else {
      const { stdout } = await execFileP('ps', ['-axo', 'comm='], { maxBuffer: 8 * 1024 * 1024 })
      names = stdout
        .split('\n')
        .map((line) => path.basename(line.trim()))
        .filter(Boolean)
    }
  } catch {
    return []
  }
  const set = new Set(names)
  const running: string[] = []
  for (const entry of BROWSERS) {
    let hit = false
    if (platform === 'darwin') hit = Boolean(entry.darwin && set.has(entry.darwin.app))
    else if (platform === 'win32')
      hit = Boolean(
        entry.win32?.exes.some((exe) => set.has(path.win32.basename(exe).toLowerCase()))
      )
    else hit = Boolean(entry.linux?.procs.some((p) => set.has(p)))
    if (hit) running.push(entry.slug)
  }
  return running
}

/** Default user-data dir for a Chromium browser on this platform, or null. */
export function defaultProfileDir(slug: string): string | null {
  const entry = BROWSERS.find((b) => b.slug === slug)
  if (!entry?.profile) return null
  const platform = os.platform()
  if (platform === 'darwin') {
    const rel = entry.profile.darwin
    return rel ? path.join(os.homedir(), 'Library', 'Application Support', rel) : null
  }
  if (platform === 'win32') {
    const rel = entry.profile.win32
    const local = process.env['LOCALAPPDATA']
    return rel && local ? path.join(local, rel) : null
  }
  const rel = entry.profile.linux
  return rel ? path.join(os.homedir(), '.config', rel) : null
}

/**
 * Whether the browser's default profile is exposing a DevTools endpoint.
 * Chromium writes `DevToolsActivePort` (line 1 = port, line 2 = the
 * browser-target path) while `--remote-debugging-port` / chrome://inspect
 * remote debugging is on, and removes it on exit — presence is the lane.
 */
export async function devtoolsActivePortPresent(slug: string): Promise<DevToolsPortState> {
  const dir = defaultProfileDir(slug)
  if (!dir) return { present: false }
  try {
    const raw = await readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')
    const port = Number.parseInt(raw.split('\n')[0]?.trim() ?? '', 10)
    return Number.isFinite(port) ? { present: true, port } : { present: true }
  } catch {
    return { present: false }
  }
}

/** macOS TCC grants Wolffish holds — the ones a browser task crossing into computer use needs. */
export async function macPermissions(): Promise<MacPermissions | null> {
  if (os.platform() !== 'darwin') return null
  try {
    const { systemPreferences } = await import('electron')
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus('screen'),
      automation: null
    }
  } catch {
    return { accessibility: null, screenRecording: null, automation: null }
  }
}

/** Gather every fact the composer needs. Each probe is independent and best-effort. */
export async function collectFacts(
  server: DoctorServerView,
  opts: DoctorOptions = {}
): Promise<DoctorFacts> {
  const workspace = await import('@main/workspace/workspace')
  const status = server.getStatus()
  const [installed, running, bundledVersion, runtimeVersion, config, mac] = await Promise.all([
    installedBrowsers().catch(() => [] as InstalledBrowser[]),
    runningBrowsers().catch(() => [] as string[]),
    workspace.getBundledExtensionVersion().catch(() => null),
    workspace.getRuntimeExtensionVersion().catch(() => null),
    workspace.getBrowserExtensionConfig(),
    macPermissions()
  ])

  const devtools: Record<string, DevToolsPortState> = {}
  await Promise.all(
    installed
      .filter((b) => CHROMIUM_SLUGS.has(b.slug))
      .map(async (b) => {
        devtools[b.slug] = await devtoolsActivePortPresent(b.slug)
      })
  )

  let target: ExtensionBrowserInfo | null = null
  let probe: BrowserDoctorProbe | null = null
  let probeError: string | null = null
  if (opts.probe !== false && status.browsers.length > 0) {
    try {
      const result = await server.probeExtension(opts)
      target = result.browser
      probe = result.probe
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    platform: os.platform(),
    at: Date.now(),
    server: { status: status.status, error: status.error, port: status.port },
    browsers: status.browsers,
    target,
    lastSeen: config.lastSeen ?? {},
    installed,
    running,
    bundledVersion,
    runtimeVersion,
    bridgeTokenConfigured: Boolean(config.bridgeToken),
    tokenMismatch: server.lastTokenMismatch(),
    attachError: server.lastAttachError(),
    devtools,
    mac,
    sessionType: os.platform() === 'linux' ? (process.env['XDG_SESSION_TYPE'] ?? null) : null,
    probe,
    probeError
  }
}

// ─── Composer (pure) ────────────────────────────────────────────────────────

const EMPTY_FACTS: DoctorFacts = {
  platform: 'darwin',
  at: 0,
  server: { status: 'stopped', error: null, port: 23152 },
  browsers: [],
  target: null,
  lastSeen: {},
  installed: [],
  running: [],
  bundledVersion: null,
  runtimeVersion: null,
  bridgeTokenConfigured: false,
  tokenMismatch: null,
  attachError: null,
  devtools: {},
  mac: null,
  sessionType: null,
  probe: null,
  probeError: null
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocker: 0, degraded: 1, note: 2 }

/** "Google Chrome 152" → the short label the summary line uses. */
function browserLabel(b: ExtensionBrowserInfo | null): string {
  if (!b) return 'browser'
  const name = b.browser === 'chrome' ? 'Chrome' : b.name
  const major = b.browserVersion ? ` ${b.browserVersion.split('.')[0]}` : ''
  return `${name}${major}`
}

function displayName(slug: string): string {
  return BROWSERS.find((b) => b.slug === slug)?.name ?? slug
}

/** Mid-sentence casing for a title: "The extension's…" → "the extension's…", but "Google Chrome…" stays. */
function lowerFirst(s: string): string {
  const first = s.split(' ')[0]
  return ['The', 'No', 'Port', 'Browser', 'Elevated', 'Wayland'].includes(first)
    ? s.charAt(0).toLowerCase() + s.slice(1)
    : s
}

/**
 * Turn facts into findings. Pure and deterministic: the same facts always
 * give the same report. Findings come back blockers first, in the order the
 * user should tackle them (a busy port before a missing browser before a
 * restricted extension), so "walk them through the first blocker" is a
 * meaningful instruction.
 */
export function composeFindings(input: Partial<DoctorFacts>): DoctorReport {
  const facts: DoctorFacts = { ...EMPTY_FACTS, ...input }
  const findings: Finding[] = []
  const add = (f: Finding): void => {
    findings.push(f)
  }

  const connected = facts.browsers.length > 0
  const target = facts.target ?? facts.browsers[0] ?? null
  const probe = facts.probe
  const recent = (at: number): boolean => facts.at === 0 || facts.at - at <= RECENT_MS
  const runningSupported = facts.running.filter((slug) =>
    facts.installed.some((b) => b.slug === slug)
  )
  const seenSlugs = new Set(Object.values(facts.lastSeen).map((s) => s.browser))

  // ── Server ──────────────────────────────────────────────────────────
  const portBusy = facts.server.status === 'error'
  if (portBusy) {
    add({
      id: 'port_busy',
      severity: 'blocker',
      title: `Port ${facts.server.port} is taken by another program`,
      detail: `The extension connects to Wolffish on port ${facts.server.port}; while something else holds it, no browser can reach Wolffish at all.`,
      fix: {
        kind: 'auto',
        action: 'rotate_port',
        steps: [
          'Wolffish will move to a free port and tell connected extensions the new one.',
          'If the extension does not reconnect within a few seconds, reload it from chrome://extensions.'
        ]
      },
      verify: 'The extension server reports "listening" and a browser reconnects.'
    })
  }

  // ── Connection ─────────────────────────────────────────────────────
  if (!connected && !portBusy) {
    if (facts.installed.length === 0) {
      add({
        id: 'browser_not_installed',
        severity: 'blocker',
        title: 'No supported browser is installed',
        detail:
          'The Wolffish extension runs inside Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium or Firefox; none of them is installed on this computer.',
        fix: {
          kind: 'guided',
          steps: [
            'Install Google Chrome (or another supported browser) from its official site.',
            'Open it once, then come back here and run the browser check again.'
          ],
          url: 'https://www.google.com/chrome/'
        },
        verify: 'A supported browser shows up as installed.'
      })
    } else if (runningSupported.length > 0 && runningSupported.some((s) => seenSlugs.has(s))) {
      // A browser that has run the extension before is open right now and
      // is NOT connected: the extension was turned off, removed, or
      // Developer mode got switched off (which unloads unpacked extensions).
      const slug = runningSupported.find((s) => seenSlugs.has(s)) ?? runningSupported[0]
      add({
        id: 'extension_disabled_or_devmode_off',
        severity: 'blocker',
        title: `${displayName(slug)} is open but the Wolffish extension is not running in it`,
        detail:
          'This browser has connected before, so the extension is probably switched off, removed, or unloaded because Developer mode was turned off.',
        fix: {
          kind: 'guided',
          action: 'open_extensions_page',
          steps: [
            'Open chrome://extensions in that browser.',
            'Turn on "Developer mode" (top right).',
            'Find "Wolffish" and make sure its switch is on. If it is missing, click "Load unpacked" and choose the Wolffish extension folder (Settings → Services → Browser extension → Open folder).'
          ],
          url: 'chrome://extensions'
        },
        verify: 'The browser appears in the connected list.',
        browser: slug
      })
    } else if (runningSupported.length === 0) {
      add({
        id: 'no_browser_connected',
        severity: 'blocker',
        title: 'No browser is connected',
        detail: `${displayName(facts.installed[0].slug)} is installed but not running, so there is nothing for the extension to run in.`,
        fix: {
          kind: 'auto',
          action: 'launch_browser',
          steps: [
            `Wolffish will start ${displayName(facts.installed[0].slug)} and wait for the extension to connect.`,
            'If nothing connects, the extension is not loaded in that browser yet — see the next step of this check.'
          ]
        },
        verify: 'A browser appears in the connected list.'
      })
    } else {
      const slug = runningSupported[0]
      add({
        id: 'no_browser_connected',
        severity: 'blocker',
        title: 'No browser is connected',
        detail: `${displayName(slug)} is running but the Wolffish extension has never connected from it, so it is probably not loaded there yet.`,
        fix: {
          kind: 'guided',
          action: 'open_extensions_page',
          steps: [
            'Open chrome://extensions in that browser.',
            'Turn on "Developer mode" (top right).',
            'Click "Load unpacked" and choose the Wolffish extension folder (Settings → Services → Browser extension → Open folder).',
            'The Wolffish icon appears in the toolbar and the browser connects within a few seconds.'
          ],
          url: 'chrome://extensions'
        },
        verify: 'A browser appears in the connected list.',
        browser: slug
      })
    }
  }

  // ── Extension folder + versions ───────────────────────────────────
  if (
    facts.bundledVersion &&
    facts.runtimeVersion &&
    facts.bundledVersion !== facts.runtimeVersion
  ) {
    add({
      id: 'extension_folder_stale',
      severity: 'degraded',
      title: 'The extension folder is out of date',
      detail: `The folder the browser loads is version ${facts.runtimeVersion}, but this Wolffish ships ${facts.bundledVersion}; newer browser tools will answer "Unknown command" until it is refreshed.`,
      fix: {
        kind: 'auto',
        action: 'resync_extension',
        steps: [
          'Wolffish will rewrite the extension folder from its bundled copy and reload the extension.'
        ]
      },
      verify: `The folder's manifest reads ${facts.bundledVersion}.`
    })
  }
  for (const b of facts.browsers) {
    const expected = facts.runtimeVersion
    if (expected && b.version && b.version !== expected) {
      add({
        id: 'extension_version_stale',
        severity: 'degraded',
        title: `${b.name} is running an older copy of the extension`,
        detail: `It reports ${b.version} while the folder holds ${expected}; some browser tools may be missing until it reloads.`,
        fix: {
          kind: 'auto',
          action: 'reload_extension',
          steps: ['Wolffish will ask the extension to reload itself.']
        },
        verify: `The browser reconnects reporting ${expected}.`,
        browser: b.key
      })
    }
  }
  if (facts.tokenMismatch && recent(facts.tokenMismatch.at) && !connected) {
    add({
      id: 'bridge_token_mismatch',
      severity: 'blocker',
      title: `${displayName(facts.tokenMismatch.browser)} presented the wrong pairing token`,
      detail:
        'The browser is loading a copy of the extension that was not synced by this Wolffish (a second install, or a folder from another machine), so it was refused.',
      fix: {
        kind: 'auto',
        action: 'resync_extension',
        steps: [
          'Wolffish will rewrite the extension folder with the current pairing token and reload the extension.',
          'If it still does not connect, remove any other "Wolffish" entries on chrome://extensions and load the one from the Wolffish folder.'
        ]
      },
      verify: 'The browser connects and is not flagged as legacy.',
      browser: facts.tokenMismatch.browser
    })
  }

  // ── Extension probe (connected browser) ────────────────────────────
  if (probe && target) {
    const detailsUrl = `chrome://extensions/?id=${probe.extension.id}`
    if (probe.policyBlocked) {
      add({
        id: 'policy_blocked',
        severity: 'blocker',
        title: `${target.name} is managed by a policy that blocks the extension`,
        detail:
          'An organisation policy (ExtensionSettings) prevents Wolffish from reading or driving pages in this browser; nothing on this computer can override it.',
        fix: {
          kind: 'none',
          steps: [
            'Use a browser profile that is not managed by your organisation, or ask its administrator to allow the Wolffish extension.',
            'For the pages that matter, computer use can still drive the browser window from the outside.'
          ]
        },
        verify: 'The extension probe stops reporting a policy block.',
        browser: target.key
      })
    }
    if (probe.siteAccessAllUrls === false && !probe.policyBlocked) {
      add({
        id: 'site_access_restricted',
        severity: 'blocker',
        title: "The extension's site access is restricted",
        detail:
          'Wolffish can only read and click on pages the extension is allowed to touch; with site access limited, most tabs answer "Cannot access contents of the page".',
        fix: {
          kind: 'one-click',
          action: 'open_extension_details',
          steps: [
            'Open the Wolffish extension details page.',
            'Under "Site access", choose "On all sites".'
          ],
          url: detailsUrl
        },
        verify: 'The extension reports access to all sites.',
        browser: target.key
      })
    }
    if (probe.apis.debugger === false) {
      add({
        id: 'debugger_unavailable',
        severity: 'note',
        title: `${target.name} has no debugger API`,
        detail:
          'Trusted mouse input, network and console capture, emulation and full-page screenshots need the Chrome debugger; this browser only offers the page-script tools.',
        fix: {
          kind: 'none',
          steps: ['Use Chrome, Edge, Brave or another Chromium browser for those.']
        },
        verify: 'n/a',
        browser: target.key
      })
    }
    if (
      probe.scriptable &&
      probe.scriptable.ok === false &&
      !probe.policyBlocked &&
      probe.siteAccessAllUrls !== false
    ) {
      const url = probe.scriptable.url ?? ''
      const internal =
        /^(chrome|edge|brave|vivaldi|opera|devtools|chrome-extension|about):/i.test(url) ||
        /^https:\/\/chromewebstore\.google\.com/i.test(url)
      add({
        id: 'screenshot_blocked',
        severity: 'note',
        title: internal
          ? 'The current tab is a browser page'
          : 'The current tab cannot be read by the extension',
        detail: internal
          ? `${url || 'This tab'} belongs to the browser itself; extensions cannot read, screenshot or click browser pages.`
          : `The extension could not run in ${url || 'the current tab'}${probe.scriptable.error ? ` (${probe.scriptable.error})` : ''}.`,
        fix: {
          kind: 'none',
          steps: [
            'Open a normal web page in the Wolffish tab, or use computer use for the browser page itself.'
          ]
        },
        verify: 'The probe tab reports scriptable: ok.',
        browser: target.key
      })
    }
    if (probe.incognitoAllowed === false) {
      add({
        id: 'incognito_not_allowed',
        severity: 'note',
        title: 'The extension is not allowed in Incognito',
        detail: 'Incognito windows are invisible to Wolffish until the extension is allowed there.',
        fix: {
          kind: 'guided',
          action: 'open_extension_details',
          steps: ['Open the Wolffish extension details page.', 'Turn on "Allow in Incognito".'],
          url: detailsUrl
        },
        verify: 'The extension reports Incognito access.',
        browser: target.key
      })
    }
    if (probe.fileSchemeAllowed === false) {
      add({
        id: 'file_scheme_not_allowed',
        severity: 'note',
        title: 'The extension cannot open local files',
        detail:
          'file:// pages (local HTML, PDFs on disk) stay out of reach until file access is allowed.',
        fix: {
          kind: 'guided',
          action: 'open_extension_details',
          steps: [
            'Open the Wolffish extension details page.',
            'Turn on "Allow access to file URLs".'
          ],
          url: detailsUrl
        },
        verify: 'The extension reports file URL access.',
        browser: target.key
      })
    }
    if (probe.notifications === 'denied') {
      add({
        id: 'notifications_off',
        severity: 'note',
        title: 'Browser notifications from Wolffish are off',
        detail: 'ext_notify will do nothing in this browser until notifications are allowed.',
        fix: {
          kind: 'guided',
          steps: [
            "Open the browser's Settings → Privacy and security → Site settings → Notifications.",
            'Allow notifications for the Wolffish extension.'
          ]
        },
        verify: 'The extension reports notifications granted.',
        browser: target.key
      })
    }
    if (probe.apis.tabGroups === false) {
      add({
        id: 'tab_groups_unsupported',
        severity: 'note',
        title: `${target.name} does not support tab groups`,
        detail:
          'Wolffish keeps its own tabs in a blue "Wolffish" group; here they will sit among your tabs instead.',
        fix: { kind: 'none', steps: [] },
        verify: 'n/a',
        browser: target.key
      })
    }
  } else if (connected && facts.probeError) {
    // "Unknown command" is the one failure that really does mean an old build.
    // Anything else has its own cause, and calling it staleness sends the user
    // to reload an extension that was never the problem.
    const stale = /unknown command/i.test(facts.probeError)
    add({
      id: stale ? 'extension_version_stale' : 'probe_failed',
      severity: 'degraded',
      title: stale
        ? 'The connected extension is an older build that cannot self-check'
        : 'The extension did not answer the readiness probe',
      detail: stale
        ? `${facts.probeError} — this build predates the readiness check.`
        : `${facts.probeError} Everything else in this report still holds; only the browser-side checks (site access, incognito, file access) are missing.`,
      fix: stale
        ? {
            kind: 'auto',
            action: 'reload_extension',
            steps: ['Wolffish will ask the extension to reload itself.']
          }
        : {
            kind: 'guided',
            steps: ['Try again; if it persists, reload the extension from the browser panel.']
          },
      verify: 'The probe returns a report.'
    })
  }

  // ── Debugger ───────────────────────────────────────────────────────
  if (facts.attachError && recent(facts.attachError.at) && connected) {
    add({
      id: 'another_debugger_attached',
      severity: 'degraded',
      title: 'DevTools (or another debugger) is attached to the tab',
      detail:
        'Only one debugger can hold a tab; while DevTools is open there, trusted input, network capture and emulation fall back to page scripts.',
      fix: {
        kind: 'guided',
        steps: ['Close DevTools on the tab Wolffish is driving, then retry.']
      },
      verify: 'ext_debugger_attach succeeds.'
    })
  }

  // ── DevTools lane ──────────────────────────────────────────────────
  for (const b of facts.browsers) {
    if (!CHROMIUM_SLUGS.has(b.browser)) continue
    const state = facts.devtools[b.browser]
    if (!state || state.present) continue
    add({
      id: 'devtools_lane_off',
      severity: 'note',
      title: `${b.name} is not exposing a DevTools endpoint`,
      detail:
        'Optional: with remote debugging on, Wolffish has a second lane into the browser that survives extension reloads.',
      fix: {
        kind: 'guided',
        action: 'open_inspect_page',
        steps: [
          'Open chrome://inspect/#remote-debugging in that browser.',
          'Turn on remote debugging and accept the prompt.'
        ],
        url: 'chrome://inspect/#remote-debugging'
      },
      verify: 'DevToolsActivePort appears in the browser profile.',
      browser: b.key
    })
  }

  // ── OS permissions (the computer-use side of a mixed task) ─────────
  if (facts.mac) {
    if (facts.mac.screenRecording !== null && facts.mac.screenRecording !== 'granted') {
      add({
        id: 'screen_recording_missing',
        severity: 'note',
        title: 'Wolffish has no Screen Recording permission',
        detail:
          "Screenshots of dialogs, file pickers and the browser's own chrome (everything outside the page) need it; page reads through the extension do not.",
        fix: {
          kind: 'one-click',
          action: 'open_system_settings',
          steps: [
            'System Settings → Privacy & Security → Screen Recording → turn on Wolffish.',
            'Restart Wolffish afterwards — macOS only applies this grant to a fresh process.'
          ],
          url: MAC_SETTINGS.screenRecording
        },
        verify: 'getMediaAccessStatus("screen") reports granted.'
      })
    }
    if (facts.mac.accessibility === false) {
      add({
        id: 'accessibility_missing',
        severity: 'note',
        title: 'Wolffish has no Accessibility permission',
        detail:
          'Clicking and typing outside the page (native dialogs, the browser toolbar) need it; page actions through the extension do not.',
        fix: {
          kind: 'one-click',
          action: 'open_system_settings',
          steps: ['System Settings → Privacy & Security → Accessibility → turn on Wolffish.'],
          url: MAC_SETTINGS.accessibility
        },
        verify: 'isTrustedAccessibilityClient reports true.'
      })
    }
    if (facts.mac.automation === false) {
      add({
        id: 'automation_missing',
        severity: 'note',
        title: 'Wolffish is not allowed to control the browser with Automation',
        detail:
          'Opening browser menus and windows from outside the page needs the Automation grant.',
        fix: {
          kind: 'one-click',
          action: 'open_system_settings',
          steps: [
            'System Settings → Privacy & Security → Automation → allow Wolffish for the browser.'
          ],
          url: MAC_SETTINGS.automation
        },
        verify: 'An AppleScript to the browser succeeds.'
      })
    }
  }
  if (facts.platform === 'win32' && connected) {
    add({
      id: 'windows_elevation_limit',
      severity: 'note',
      title: 'Elevated browser windows are out of reach',
      detail:
        'On Windows, computer use cannot click into a browser that runs as administrator; the extension inside the page is unaffected.',
      fix: {
        kind: 'none',
        steps: ['Run the browser as a normal user when a task mixes page and window work.']
      },
      verify: 'n/a'
    })
  }
  if (facts.platform === 'linux' && facts.sessionType === 'wayland') {
    add({
      id: 'wayland_limits',
      severity: 'note',
      title: 'Wayland limits computer use around the browser',
      detail:
        'Background input to the browser window is unavailable on most Wayland compositors; page actions through the extension are unaffected.',
      fix: {
        kind: 'none',
        steps: [
          'For mixed tasks, sign in to an X11 session, or let Wolffish use foreground input (your pointer moves briefly).'
        ]
      },
      verify: 'n/a'
    })
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  const blockers = findings.filter((f) => f.severity === 'blocker')
  const degraded = findings.filter((f) => f.severity === 'degraded')
  const ready = blockers.length === 0
  const tier: DoctorTier = probe?.policyBlocked
    ? 'managed'
    : !connected
      ? 'none'
      : degraded.length > 0
        ? 'degraded'
        : 'full'

  let summary: string
  if (blockers.length > 0) {
    const first = blockers[0]
    summary = `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: ${lowerFirst(first.title)} — ${first.detail}`
  } else if (tier === 'degraded') {
    summary = `Browser is usable but degraded (${browserLabel(target)}): ${lowerFirst(degraded[0].title)}.`
  } else {
    summary = `Browser is ready (${browserLabel(target)}, full tier).`
  }

  return { ready, tier, findings, summary, facts: facts as unknown as Record<string, unknown> }
}

// ─── Fixes ──────────────────────────────────────────────────────────────────

/** First free TCP port on loopback in [from, to], or null when the whole range is taken. */
async function findFreePort(from: number, to: number): Promise<number | null> {
  for (let port = from; port <= to; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true))
      })
    })
    if (free) return port
  }
  return null
}

/**
 * Open a URL in a supported browser. Moved here from the
 * `browserExtension:openExtensionsPage` IPC handler so every doctor fix
 * that lands on a chrome:// page shares one opener. Order of preference:
 * a Chromium browser that is running now (the one the user is looking at),
 * then any installed one, then the OS default opener — chrome:// URLs only
 * mean something to a Chromium browser, so the default handler is the last
 * resort, not the first.
 */
export async function openBrowserUrl(url: string, prefer?: string | null): Promise<boolean> {
  const platform = os.platform()
  const [installed, running] = await Promise.all([installedBrowsers(), runningBrowsers()])
  const chromium = installed.filter((b) => CHROMIUM_SLUGS.has(b.slug))
  const ordered = [
    ...chromium.filter((b) => b.slug === prefer),
    ...chromium.filter((b) => b.slug !== prefer && running.includes(b.slug)),
    ...chromium.filter((b) => b.slug !== prefer && !running.includes(b.slug))
  ]

  for (const browser of ordered) {
    try {
      if (platform === 'darwin') {
        await execFileP('open', ['-a', browser.path, url])
      } else {
        const child = spawn(browser.path, [url], { detached: true, stdio: 'ignore' })
        child.unref()
      }
      return true
    } catch {
      continue
    }
  }
  try {
    if (platform === 'darwin') await execFileP('open', [url])
    else if (platform === 'win32')
      await execFileP('cmd', ['/c', 'start', '', url], { windowsHide: true })
    else await execFileP('xdg-open', [url])
    return true
  } catch {
    return false
  }
}

/**
 * Run one repair. Every branch returns a user-readable message; `steps`
 * carry the manual part when the fix is only guided on this platform.
 */
export async function applyFix(
  action: string,
  deps: FixDeps,
  opts: FixOptions = {}
): Promise<FixResult> {
  const workspace = await import('@main/workspace/workspace')
  switch (action) {
    case 'launch_browser':
      // The plugin owns launching (it has the default-browser detection and
      // the wait-for-connect loop); the bridge only reports so the caller
      // knows to run it there.
      return {
        ok: false,
        message:
          'launch_browser runs in the browser-extension plugin (ext_launch_browser), not through the bridge.'
      }

    case 'reload_extension':
      await deps.requestReload(opts.target ?? null)
      return {
        ok: true,
        message: 'Asked the extension to reload. It reconnects within a few seconds.'
      }

    case 'resync_extension': {
      await workspace.ensureBundledExtension()
      await workspace.ensureBridgeToken()
      await deps.requestReload(opts.target ?? null)
      const version = await workspace.getRuntimeExtensionVersion()
      return {
        ok: true,
        message: `Rewrote the extension folder${version ? ` (version ${version})` : ''} with the current pairing token and asked the extension to reload.`
      }
    }

    case 'rotate_port': {
      const port = await findFreePort(PORT_RANGE.from, PORT_RANGE.to)
      if (port === null) {
        return {
          ok: false,
          message: `No free port between ${PORT_RANGE.from} and ${PORT_RANGE.to}.`,
          steps: [
            'Close the programs holding those ports, or set a port by hand in Settings → Services → Browser extension.'
          ]
        }
      }
      await workspace.setBrowserExtensionConfig({ port })
      // Tell the extensions the new port BEFORE the old socket dies — the
      // port_update event is the only way they learn where to reconnect.
      deps.sendPortUpdate(port)
      await deps.restartServer(port)
      return {
        ok: true,
        message: `Moved the extension server to port ${port}. Connected extensions were told; a browser that does not reconnect needs the extension reloaded once.`
      }
    }

    case 'open_extensions_page': {
      const ok = await openBrowserUrl('chrome://extensions', opts.target ?? null)
      return ok
        ? { ok, message: 'Opened chrome://extensions.' }
        : {
            ok,
            message: 'Could not open a browser.',
            steps: ['Open chrome://extensions in your browser by hand.']
          }
    }

    case 'open_extension_details': {
      const id = opts.extensionId ?? deps.extensionId ?? null
      const url = opts.url ?? (id ? `chrome://extensions/?id=${id}` : 'chrome://extensions')
      const ok = await openBrowserUrl(url, opts.target ?? null)
      return ok
        ? { ok, message: `Opened ${url}.` }
        : {
            ok,
            message: 'Could not open a browser.',
            steps: [`Open ${url} in your browser by hand.`]
          }
    }

    case 'open_inspect_page': {
      const url = 'chrome://inspect/#remote-debugging'
      const ok = await openBrowserUrl(url, opts.target ?? null)
      return ok
        ? { ok, message: `Opened ${url}.` }
        : {
            ok,
            message: 'Could not open a browser.',
            steps: [`Open ${url} in your browser by hand.`]
          }
    }

    case 'open_system_settings': {
      const pane = opts.pane ?? 'screenRecording'
      const steps: Record<string, string[]> = {
        accessibility: ['System Settings → Privacy & Security → Accessibility → turn on Wolffish.'],
        screenRecording: [
          'System Settings → Privacy & Security → Screen Recording → turn on Wolffish.',
          'Restart Wolffish afterwards.'
        ],
        automation: [
          'System Settings → Privacy & Security → Automation → allow Wolffish for the browser.'
        ]
      }
      if (os.platform() !== 'darwin') {
        return {
          ok: false,
          message: 'There is no permission pane to open on this platform.',
          steps:
            os.platform() === 'win32'
              ? [
                  'Run the browser as a normal (non-administrator) user for mixed page-and-window tasks.'
                ]
              : [
                  'On Wayland, sign in to an X11 session for background input, or accept foreground input.'
                ]
        }
      }
      const url = MAC_SETTINGS[pane]
      if (!url) return { ok: false, message: `Unknown settings pane "${pane}".` }
      try {
        const { shell, systemPreferences } = await import('electron')
        if (pane === 'accessibility') {
          try {
            // prompt:true also registers Wolffish in the pane's list, so the
            // user finds a switch to flip instead of a "+" button.
            systemPreferences.isTrustedAccessibilityClient(true)
          } catch {
            // The pane still opens.
          }
        }
        await shell.openExternal(url)
        return { ok: true, message: 'Opened System Settings.', steps: steps[pane] ?? [] }
      } catch (err) {
        return {
          ok: false,
          message: `Could not open System Settings: ${err instanceof Error ? err.message : String(err)}`,
          steps: steps[pane] ?? []
        }
      }
    }

    default:
      return { ok: false, message: `Unknown fix action "${action}".` }
  }
}
