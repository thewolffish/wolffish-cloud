import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

let sharp = null
let getConversationId = () => null
let screenshotCounter = 0
let lastScreenshotSize = null

async function loadSharp() {
  if (sharp) return sharp
  try {
    sharp = (await import('sharp')).default
    return sharp
  } catch {
    return null
  }
}

function getBridge() {
  return globalThis.__wolffishExtensionBridge ?? null
}

// One stale-extension reload request per window, not one per failing call: a
// task that hits several unsupported commands in a burst must not bounce the
// extension over and over while it is already reloading.
let lastStaleReloadAt = 0
function requestStaleReload(bridge) {
  const now = Date.now()
  if (now - lastStaleReloadAt < 60_000) return
  lastStaleReloadAt = now
  try {
    bridge.requestReload?.()
  } catch {
    // an older desktop bridge without requestReload — nothing to do
  }
}

function stripDataUrl(dataUrl) {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

/**
 * Map plugin tool names (ext_*) to extension command names (browser_*).
 * This mapping lets the SKILL.md use clean ext_ prefixed names while
 * the extension's service worker expects browser_ commands.
 */
function toCommand(toolName) {
  if (toolName.startsWith('ext_')) {
    return 'browser_' + toolName.slice(4)
  }
  return toolName
}

let workspaceRoot = ''

// ─── Launching a browser ────────────────────────────────────────────────────
// The extension can only connect from a running browser, so when nothing is
// connected the recovery is to start one. Everything below is best-effort and
// per-platform: detect the user's default browser, fall back to the first
// supported one that is actually installed, launch it detached, then wait for
// the extension to call home.

const BROWSERS = [
  {
    slug: 'chrome',
    name: 'Google Chrome',
    darwin: { app: 'Google Chrome', bundleId: 'com.google.chrome' },
    win32: { exes: ['Google\\Chrome\\Application\\chrome.exe'], progIds: ['chromehtml'] },
    linux: { bins: ['google-chrome', 'google-chrome-stable'], desktops: ['google-chrome.desktop'] }
  },
  {
    slug: 'edge',
    name: 'Microsoft Edge',
    darwin: { app: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
    win32: { exes: ['Microsoft\\Edge\\Application\\msedge.exe'], progIds: ['msedgehtm', 'msedgedhtml'] },
    linux: { bins: ['microsoft-edge', 'microsoft-edge-stable'], desktops: ['microsoft-edge.desktop'] }
  },
  {
    slug: 'brave',
    name: 'Brave',
    darwin: { app: 'Brave Browser', bundleId: 'com.brave.browser' },
    win32: { exes: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], progIds: ['bravehtml'] },
    linux: { bins: ['brave-browser', 'brave'], desktops: ['brave-browser.desktop', 'brave.desktop'] }
  },
  {
    slug: 'arc',
    name: 'Arc',
    darwin: { app: 'Arc', bundleId: 'company.thebrowser.browser' },
    win32: { exes: ['Arc\\app\\Arc.exe'], progIds: ['archtml'] },
    linux: null
  },
  {
    slug: 'vivaldi',
    name: 'Vivaldi',
    darwin: { app: 'Vivaldi', bundleId: 'com.vivaldi.vivaldi' },
    win32: { exes: ['Vivaldi\\Application\\vivaldi.exe'], progIds: ['vivaldihtm'] },
    linux: { bins: ['vivaldi', 'vivaldi-stable'], desktops: ['vivaldi-stable.desktop'] }
  },
  {
    slug: 'opera',
    name: 'Opera',
    darwin: { app: 'Opera', bundleId: 'com.operasoftware.opera' },
    win32: { exes: ['Opera\\launcher.exe'], progIds: ['operastable'] },
    linux: { bins: ['opera'], desktops: ['opera.desktop'] }
  },
  {
    slug: 'chromium',
    name: 'Chromium',
    darwin: { app: 'Chromium', bundleId: 'org.chromium.chromium' },
    win32: { exes: ['Chromium\\Application\\chrome.exe'], progIds: ['chromiumhtm'] },
    linux: { bins: ['chromium', 'chromium-browser'], desktops: ['chromium.desktop', 'chromium-browser.desktop'] }
  },
  {
    slug: 'firefox',
    name: 'Firefox',
    darwin: { app: 'Firefox', bundleId: 'org.mozilla.firefox' },
    win32: { exes: ['Mozilla Firefox\\firefox.exe'], progIds: ['firefoxurl'] },
    linux: { bins: ['firefox', 'firefox-esr'], desktops: ['firefox.desktop', 'firefox-esr.desktop'] }
  }
]

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Where this browser is installed on this machine, or null. */
async function findInstall(entry) {
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
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'],
      process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Programs') : null
    ].filter(Boolean)
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

/** The OS's registered https handler, in whatever id the platform speaks. */
async function detectDefaultBrowserId() {
  const platform = os.platform()
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileP('defaults', [
        'read',
        'com.apple.LaunchServices/com.apple.launchservices.secure'
      ])
      for (const block of stdout.split('}')) {
        if (!/LSHandlerURLScheme\s*=\s*https\s*;/.test(block)) continue
        const match = block.match(/LSHandlerRoleAll\s*=\s*"?([^";]+)"?\s*;/)
        if (match) return match[1].trim().toLowerCase()
      }
      return null
    }
    if (platform === 'win32') {
      const { stdout } = await execFileP('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
        '/v',
        'ProgId'
      ])
      const match = stdout.match(/ProgId\s+REG_SZ\s+(\S+)/i)
      return match ? match[1].trim().toLowerCase() : null
    }
    const { stdout } = await execFileP('xdg-settings', ['get', 'default-web-browser'])
    return stdout.trim().toLowerCase() || null
  } catch {
    return null
  }
}

function matchesDefaultId(entry, defaultId) {
  if (!defaultId) return false
  const platform = os.platform()
  if (platform === 'darwin') return entry.darwin?.bundleId === defaultId
  if (platform === 'win32') return (entry.win32?.progIds ?? []).includes(defaultId)
  return (entry.linux?.desktops ?? []).includes(defaultId)
}

async function launchInstall(installPath) {
  if (os.platform() === 'darwin') {
    await execFileP('open', ['-a', installPath])
    return
  }
  const child = spawn(installPath, [], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function waitForExtension(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      if (getBridge()?.isConnected?.()) return true
    } catch {
      // bridge appears only once the extension server is up
    }
  }
  return false
}

async function launchBrowser(args) {
  const requested = String(args?.browser ?? '').trim().toLowerCase()
  const waitMs = Number.isFinite(args?.wait_ms) ? Math.max(0, Math.min(120000, args.wait_ms)) : 30000

  if (!requested && getBridge()?.isConnected?.()) {
    return {
      success: true,
      output: 'A browser is already connected through the Wolffish extension — nothing to launch.'
    }
  }

  const candidates = requested
    ? BROWSERS.filter((b) => b.slug === requested || b.name.toLowerCase().includes(requested))
    : BROWSERS
  if (candidates.length === 0) {
    return {
      success: false,
      error: `Unknown browser "${args?.browser}". Known: ${BROWSERS.map((b) => b.slug).join(', ')}.`
    }
  }

  const installed = []
  for (const entry of candidates) {
    const install = await findInstall(entry)
    if (install) installed.push({ entry, install })
  }
  if (installed.length === 0) {
    return {
      success: false,
      error: requested
        ? `${candidates[0].name} does not appear to be installed on this ${os.platform()} machine.`
        : `No supported browser found on this ${os.platform()} machine (looked for ${BROWSERS.map((b) => b.name).join(', ')}).`
    }
  }

  // Prefer the user's own default browser; otherwise the first supported one
  // that exists, in the order listed above.
  const defaultId = requested ? null : await detectDefaultBrowserId()
  const chosen = installed.find(({ entry }) => matchesDefaultId(entry, defaultId)) ?? installed[0]
  const wasDefault = matchesDefaultId(chosen.entry, defaultId)

  try {
    await launchInstall(chosen.install)
  } catch (err) {
    return { success: false, error: `Failed to launch ${chosen.entry.name}: ${err?.message || String(err)}` }
  }

  const label = `${chosen.entry.name}${wasDefault ? ' (your default browser)' : ''}`
  if (waitMs === 0) {
    return { success: true, output: `Launched ${label}. Not waiting for the extension to connect.` }
  }

  const connected = await waitForExtension(waitMs)
  return {
    success: true,
    output: connected
      ? `Launched ${label} and the Wolffish extension connected. Browser tools are ready.`
      : `Launched ${label}, but the Wolffish extension has not connected within ${Math.round(waitMs / 1000)}s. It may not be installed in this browser, or it may still be starting — check ext_browsers, or ask the user to install the extension.`
  }
}

const toolDefinitions = [
  { name: 'ext_navigate', description: 'Navigate to a URL in the Wolffish tab (created inside the Wolffish tab group on first use — the user\'s own tabs are never touched). Pass newTab: true to start the task in a fresh Wolffish tab.', parameters: { type: 'object', properties: { url: { type: 'string' }, waitUntil: { type: 'string' }, newTab: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['url'] } },
  { name: 'ext_back', description: 'Navigate back in browser history.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_forward', description: 'Navigate forward in browser history.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_reload', description: 'Reload the current page.', parameters: { type: 'object', properties: { hard: { type: 'boolean' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_click', description: 'Click an element by CSS selector, or text=<visible text> to target an element by its text.', parameters: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_type', description: 'Type text into an input element.', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, clearFirst: { type: 'boolean' }, humanize: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['selector', 'text'] } },
  { name: 'ext_select', description: 'Select a dropdown value.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'value'] } },
  { name: 'ext_hover', description: 'Hover over an element.', parameters: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_scroll', description: 'Scroll the page or element.', parameters: { type: 'object', properties: { direction: { type: 'string' }, amount: { type: 'number' }, selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['direction'] } },
  { name: 'ext_focus', description: 'Focus an element.', parameters: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_keypress', description: 'Press a key or shortcut.', parameters: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'string' }, tabId: { type: 'number' } }, required: ['key'] } },
  { name: 'ext_drag_drop', description: 'Drag and drop elements.', parameters: { type: 'object', properties: { sourceSelector: { type: 'string' }, targetSelector: { type: 'string' }, tabId: { type: 'number' } }, required: ['sourceSelector', 'targetSelector'] } },
  { name: 'ext_file_upload', description: 'Upload files to an input.', parameters: { type: 'object', properties: { selector: { type: 'string' }, files: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'files'] } },
  { name: 'ext_set_value', description: 'Set an input/textarea/contenteditable value reliably and instantly using the framework-safe native setter (+ input/change events). Use this to fill forms — React/SPA apps register it correctly where synthetic ext_type does not. Pair with ext_submit_form to post.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'value'] } },
  { name: 'ext_submit_form', description: 'Submit the form containing the selector (or a form selector, or the focused field). Uses form.requestSubmit() — the reliable replacement for hunting and clicking a submit/post button. Falls back to clicking the submit control.', parameters: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_read_page', description: 'Extract page content as text, markdown, or HTML.', parameters: { type: 'object', properties: { format: { type: 'string' }, selector: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_query_selector', description: 'Query DOM elements by CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, attributes: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_get_attribute', description: 'Read element attributes.', parameters: { type: 'object', properties: { selector: { type: 'string' }, attributes: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'attributes'] } },
  { name: 'ext_get_value', description: 'Read form field value.', parameters: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_get_url', description: 'Get current URL and title.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_get_page_info', description: 'Get page metadata, links, headings, forms.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_tabs_list', description: 'List all open tabs. Each entry reports wolffish: true for tabs in the Wolffish tab group (yours to drive) and false for the user\'s own tabs.', parameters: { type: 'object', properties: { windowId: { type: 'number' } }, required: [] } },
  { name: 'ext_tab_open', description: 'Open a new tab inside the Wolffish tab group and make it the current target.', parameters: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } }, required: [] } },
  { name: 'ext_tab_close', description: 'Close a tab.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'ext_tab_switch', description: 'Switch to a tab.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'ext_tab_duplicate', description: 'Duplicate a tab.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'ext_tab_move', description: 'Move a tab.', parameters: { type: 'object', properties: { tabId: { type: 'number' }, index: { type: 'number' }, windowId: { type: 'number' } }, required: ['tabId', 'index'] } },
  { name: 'ext_windows_list', description: 'List all windows.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'ext_window_open', description: 'Open a new browser window. Its tab sits outside the Wolffish tab group, so use the returned tabId to address it — prefer ext_tab_open unless a separate window is really needed.', parameters: { type: 'object', properties: { url: { type: 'string' }, incognito: { type: 'boolean' }, width: { type: 'number' }, height: { type: 'number' } }, required: [] } },
  { name: 'ext_window_close', description: 'Close a window.', parameters: { type: 'object', properties: { windowId: { type: 'number' } }, required: ['windowId'] } },
  { name: 'ext_window_resize', description: 'Resize or reposition a window.', parameters: { type: 'object', properties: { windowId: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, left: { type: 'number' }, top: { type: 'number' }, state: { type: 'string' } }, required: ['windowId'] } },
  { name: 'ext_screenshot', description: 'Screenshot the page or an element.', parameters: { type: 'object', properties: { format: { type: 'string' }, quality: { type: 'number' }, fullPage: { type: 'boolean' }, selector: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_pdf', description: 'Save the page as PDF.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_cookies_get', description: 'Get cookies for a domain.', parameters: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } }, required: ['domain'] } },
  { name: 'ext_cookies_set', description: 'Set a cookie.', parameters: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, expires: { type: 'number' }, httpOnly: { type: 'boolean' }, secure: { type: 'boolean' } }, required: ['url', 'name', 'value'] } },
  { name: 'ext_cookies_remove', description: 'Remove a cookie.', parameters: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url', 'name'] } },
  { name: 'ext_storage_get', description: 'Read localStorage or sessionStorage.', parameters: { type: 'object', properties: { type: { type: 'string' }, keys: { type: 'string' }, tabId: { type: 'number' } }, required: ['type'] } },
  { name: 'ext_storage_set', description: 'Write to localStorage or sessionStorage.', parameters: { type: 'object', properties: { type: { type: 'string' }, data: { type: 'string' }, tabId: { type: 'number' } }, required: ['type', 'data'] } },
  { name: 'ext_clipboard_read', description: 'Read clipboard text.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'ext_clipboard_write', description: 'Write text to clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'ext_download', description: 'Download a file from a URL.', parameters: { type: 'object', properties: { url: { type: 'string' }, filename: { type: 'string' } }, required: ['url'] } },
  { name: 'ext_execute_js', description: 'Execute JavaScript in the page.', parameters: { type: 'object', properties: { code: { type: 'string' }, tabId: { type: 'number' }, world: { type: 'string' } }, required: ['code'] } },
  { name: 'ext_wait', description: 'Generic wait. With a selector: wait for that element to appear (up to timeout_ms). Without: sleep for ms/timeout_ms milliseconds — no cap, you decide (omit the duration and it returns immediately, no minimum). A wait cannot be interrupted once in flight, so split very long waits into several ext_wait calls rather than one giant sleep. type can force selector|navigation|network_idle|timeout.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['selector', 'navigation', 'network_idle', 'timeout'] }, selector: { type: 'string' }, ms: { type: 'number' }, timeout_ms: { type: 'number' }, visible: { type: 'boolean' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_wait_for', description: 'Wait for an element to appear (CSS selector or text=<visible text>).', parameters: { type: 'object', properties: { selector: { type: 'string' }, timeout: { type: 'number' }, visible: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'ext_wait_for_navigation', description: 'Wait for page navigation.', parameters: { type: 'object', properties: { timeout: { type: 'number' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_wait_for_network_idle', description: 'Wait for network to settle.', parameters: { type: 'object', properties: { timeout: { type: 'number' }, idleTime: { type: 'number' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_notify', description: 'Show a browser notification.', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' }, iconUrl: { type: 'string' } }, required: ['title', 'message'] } },
  { name: 'ext_debugger_attach', description: 'Attach Chrome debugger to a tab for trusted input events.', parameters: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'ext_debugger_detach', description: 'Detach the debugger from the currently attached tab.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'ext_debugger_status', description: 'Check whether the debugger is attached and to which tab.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'ext_mouse_move', description: 'Move cursor to coordinates along a bezier curve path.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'ext_mouse_click', description: 'Click at viewport coordinates (x,y) OR a selector. button: left|right|middle (default left). double: true for double-click. Trusted input in debugger mode; use coordinates for canvas/maps/SVG/games where no CSS selector exists.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, button: { type: 'string' }, double: { type: 'boolean' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_mouse_down', description: 'Press and HOLD a mouse button at coordinates (x,y) or a selector. Compose with ext_mouse_move + ext_mouse_up for custom gestures (drawing, sliders, press-and-hold). Best in debugger mode.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, button: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_mouse_up', description: 'Release a held mouse button at coordinates (x,y) or a selector.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, button: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_mouse_drag', description: 'Drag from a start point to an end point (press → move with button held → release). Provide startX/startY + endX/endY, or sourceSelector + targetSelector. Far more reliable than ext_drag_drop for canvas, kanban, sliders — especially in debugger mode.', parameters: { type: 'object', properties: { startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, sourceSelector: { type: 'string' }, targetSelector: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_element_from_point', description: 'Describe the topmost element at viewport coordinates (x,y) — tag, text, attributes, rect. Pair with ext_screenshot to learn what is under a pixel before clicking it.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'ext_get_interactive_elements', description: 'List visible interactive elements (links, buttons, inputs, role=button, etc.) with center coordinates, rect, text label, and attributes — the map for clicking and moving through a web app.', parameters: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_humanize', description: 'Inject a random human micro-action between real actions.', parameters: { type: 'object', properties: { intensity: { type: 'string' }, tabId: { type: 'number' } }, required: [] } },
  { name: 'ext_browsers', description: 'List the browsers currently connected through the Wolffish extension (name, version, signed-in profile email, selection key). Two profiles of the same browser are two separate entries — the profile email tells them apart. With one browser connected every ext_* tool targets it automatically; with several, pick one per conversation via ext_use_browser.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'ext_set_activity', description: 'Label the Wolffish tab group with an emoji and a few words for what you are doing — the only thing the user sees while you work. Leave the default "Wolffish" for one-off basics (opening a page, a single lookup). Set a label for anything that is a real task — several steps, more than one page, or more than a moment — so it is clear what their browser is doing, e.g. emoji "🔎", text "Comparing flights". Update it as the work moves between phases; call it with no arguments to reset.', parameters: { type: 'object', properties: { emoji: { type: 'string', description: 'A single emoji for the current activity.' }, text: { type: 'string', description: 'A few words describing the activity. Keep it under about 24 characters — tab groups are narrow.' } }, required: [] } },
  { name: 'ext_launch_browser', description: 'Start a browser on the user\'s machine so the Wolffish extension can connect. Use this when no browser is connected (ext_* tools report "not connected") — it opens the default browser, or the first supported one installed, and waits for the extension to come online. Works on macOS, Windows and Linux.', parameters: { type: 'object', properties: { browser: { type: 'string', description: 'Optional: launch this browser specifically (chrome, edge, brave, arc, vivaldi, opera, chromium, firefox). Omit to use the user\'s default browser.' }, wait_ms: { type: 'number', description: 'How long to wait for the extension to connect, in milliseconds. Default 30000, 0 to return immediately.' } }, required: [] } },
  { name: 'ext_use_browser', description: 'Choose which connected browser this conversation drives (e.g. "chrome", "edge", "brave", "firefox", or a profile email fragment like "work@"). Required before other ext_* tools when several browsers are connected. Pick it yourself when the user named a browser or context makes it obvious; otherwise ask the user first. Tabs, cookies and logins are separate per browser.', parameters: { type: 'object', properties: { browser: { type: 'string', description: 'Selection key, slug, name, or profile-email fragment of a connected browser (see ext_browsers).' } }, required: ['browser'] } }
]

const plugin = {
  name: 'browser-extension',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? ''
    if (context?.getCurrentConversationId) {
      getConversationId = context.getCurrentConversationId
    }
  },

  async execute(toolName, args) {
    // Launching a browser is the one tool that exists *because* nothing is
    // connected, so it runs ahead of the connection guard.
    if (toolName === 'ext_launch_browser') {
      try {
        return await launchBrowser(args ?? {})
      } catch (err) {
        return { success: false, error: err?.message || String(err) }
      }
    }

    const bridge = getBridge()
    if (!bridge) {
      return {
        success: false,
        error: 'Browser extension is not connected. Install and connect the Wolffish browser extension to use ext_* tools, or call ext_launch_browser to start a browser.'
      }
    }
    if (!bridge.isConnected()) {
      return {
        success: false,
        error: 'Browser extension is not connected. The browser may be closed — call ext_launch_browser to start one, or check the side panel.'
      }
    }

    if (toolName === 'ext_browsers') {
      const browsers = bridge.listBrowsers?.() ?? []
      return {
        success: true,
        output: JSON.stringify({
          browsers: browsers.map((b) => ({
            key: b.key,
            name: b.name,
            browser: b.browser,
            browserVersion: b.browserVersion,
            os: b.os,
            profileEmail: b.profileEmail ?? undefined,
            extensionVersion: b.version,
            connectedAt: b.connectedAt
          }))
        })
      }
    }

    if (toolName === 'ext_use_browser') {
      try {
        const picked = bridge.useBrowser(String(args?.browser ?? ''), getConversationId())
        const version = picked.browserVersion ? ' ' + picked.browserVersion.split('.')[0] : ''
        const profile = picked.profileEmail ? ` (${picked.profileEmail})` : ''
        return {
          success: true,
          output: `Now driving ${picked.name}${version}${profile} [${picked.key}] for this conversation. Tabs, cookies and logins are specific to this browser.`
        }
      } catch (err) {
        return { success: false, error: err?.message || String(err) }
      }
    }

    const commandName = toCommand(toolName)

    try {
      const response = await bridge.sendCommand(commandName, args, {
        conversationId: getConversationId()
      })

      if (!response.success) {
        // "Unknown command" from the extension means the browser is running a
        // STALE build: the desktop only ever sends commands the current
        // extension defines, but Chrome keeps an unpacked extension's old
        // service worker alive across app updates — even when its manifest
        // version still matches. Ask the browser to reload the extension
        // (rate-limited; the reload takes about a second) and answer in a way
        // the agent can act on. For ext_set_activity — a cosmetic tab-group
        // label — a hard failure retried three times was the 2026-08-22
        // failure mode; skipping the label is the correct outcome.
        if (/^Unknown command:/i.test(response.error ?? '')) {
          requestStaleReload(bridge)
          if (toolName === 'ext_set_activity') {
            return {
              success: true,
              output:
                'Activity label skipped: this browser is running an outdated build of the Wolffish extension (a reload was just requested). Do not retry — carry on with the task.'
            }
          }
          return {
            success: false,
            error: `${toolName} is not supported by the outdated Wolffish extension build loaded in this browser. A reload was just requested — retry once in a few seconds. If it still fails, ask the user to reload the Wolffish extension from their browser's extensions page.`
          }
        }
        return { success: false, error: response.error ?? 'Extension command failed' }
      }

      if (toolName === 'ext_screenshot' && response.data) {
        const { image, width, height } = response.data
        const rawBase64 = stripDataUrl(image)
        const inputBuffer = Buffer.from(rawBase64, 'base64')

        const cfg = await bridge.getConfig?.() ?? {}
        const maxWidth = cfg.screenshotMaxWidth || 1280
        const format = cfg.screenshotFormat || 'jpeg'
        const quality = cfg.screenshotQuality || 80

        const sharpLib = await loadSharp()
        if (sharpLib) {
          let pipeline = sharpLib(inputBuffer)
          if (width > maxWidth) {
            pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true })
          }
          const finalWidth = width > maxWidth ? maxWidth : width
          const finalHeight = Math.round(height * (finalWidth / width))

          lastScreenshotSize = { width: finalWidth, height: finalHeight }

          let buffer, mediaType
          if (format === 'png') {
            buffer = await pipeline.png().toBuffer()
            mediaType = 'image/png'
          } else {
            buffer = await pipeline.jpeg({ quality }).toBuffer()
            mediaType = 'image/jpeg'
          }

          const base64 = buffer.toString('base64')
          const ext = format === 'png' ? 'png' : 'jpg'

          let savedPath = ''
          try {
            const root = workspaceRoot || path.join(os.homedir(), '.wolffish', 'workspace')
            const convId = getConversationId()
            const safe = (convId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
            const dir = path.join(root, 'screenshots', `conv-${safe}`)
            await fs.mkdir(dir, { recursive: true })
            screenshotCounter++
            const filename = `shot-${Date.now()}-${screenshotCounter}.${ext}`
            const filePath = path.join(dir, filename)
            await fs.writeFile(filePath, buffer)
            savedPath = filePath
          } catch {
            // Non-fatal — image still returned inline via base64
          }

          const pathLine = savedPath ? `\n${savedPath}` : ''
          return {
            success: true,
            output: `Screenshot captured (${finalWidth}x${finalHeight}, ${format}). Viewport coordinates: x 0–${finalWidth}, y 0–${finalHeight}.${pathLine}`,
            images: [{ mediaType, data: base64 }]
          }
        }

        // sharp failed to load — still persist the raw PNG so a later
        // size-cap drop on the wire leaves a path the model can re-read
        // instead of re-shooting in a loop.
        lastScreenshotSize = { width, height }
        let savedPath = ''
        try {
          const root = workspaceRoot || path.join(os.homedir(), '.wolffish', 'workspace')
          const convId = getConversationId()
          const safe = (convId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
          const dir = path.join(root, 'screenshots', `conv-${safe}`)
          await fs.mkdir(dir, { recursive: true })
          screenshotCounter++
          const filename = `shot-${Date.now()}-${screenshotCounter}.png`
          const filePath = path.join(dir, filename)
          await fs.writeFile(filePath, inputBuffer)
          savedPath = filePath
        } catch {
          // Non-fatal — image still returned inline via base64
        }
        const pathLine = savedPath ? `\n${savedPath}` : ''
        return {
          success: true,
          output: `Screenshot captured (${width}x${height}). Viewport coordinates: x 0–${width}, y 0–${height}.${pathLine}`,
          images: [{ mediaType: 'image/png', data: rawBase64 }]
        }
      }

      if (toolName === 'ext_pdf' && response.data) {
        const pdfData = response.data.data
        const pdfBuffer = Buffer.from(pdfData, 'base64')
        const root = workspaceRoot || path.join(os.homedir(), '.wolffish', 'workspace')
        const convId = getConversationId()
        const safe = (convId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
        const dir = path.join(root, 'downloads', `conv-${safe}`)
        await fs.mkdir(dir, { recursive: true })
        const filename = `page-${Date.now()}.pdf`
        const filePath = path.join(dir, filename)
        await fs.writeFile(filePath, pdfBuffer)
        return {
          success: true,
          output: JSON.stringify({ path: filePath, size: pdfBuffer.length })
        }
      }

      return { success: true, output: JSON.stringify(response.data ?? {}) }
    } catch (err) {
      return { success: false, error: err?.message || String(err) }
    }
  }
}

export default plugin
