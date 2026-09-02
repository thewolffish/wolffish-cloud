import fs from 'node:fs/promises'
import path from 'node:path'

let nutMouse, nutKeyboard, nutButton, nutPoint, nutStraightTo
let electronScreen, electronDesktopCapturer, electronClipboard, electronBrowserWindow
let sharp
let permissionsOK = false
let permissionError = null
let workspaceRoot = ''
let getConversationId = () => null
let screenshotCounter = 0

const DEFAULT_MAX_WIDTH = 1280
const DEFAULT_FORMAT = 'jpeg'
const JPEG_QUALITY = 85

// Magnifier patch: the close-up returned by move/click/drag so the model can
// verify exactly where the cursor landed. Sized in logical pixels, rendered
// at 3x — a 16px control becomes ~48px in the image, big enough for any
// vision model to judge whether the crosshair is truly on it.
const MAG_W = 200
const MAG_H = 125
const MAG_SCALE = 3

// Zoom output stays within a comfortable model-viewable width; when the base
// cap would leave the zoom under the useful-magnification floor, the output
// may widen up to ZOOM_WIDE_OUT to claw back toward 2x. Below 2x a zoom is
// barely better than the screenshot it came from — the aim errors that
// motivated this redesign all happened in 1.1-1.3x "zooms".
const ZOOM_MAX_OUT = 1200
const ZOOM_WIDE_OUT = 1600
const ZOOM_MAX_OUT_H = 1600
const ZOOM_MAX_FACTOR = 4
const ZOOM_TARGET_FACTOR = 2

// Click verification: fraction of pixels that must differ before/after a
// click for the plugin to report the screen visibly changed. The patch is
// the magnifier region around the cursor (diffed at native resolution so a
// toggled checkbox counts); the display check catches effects that land
// farther away (menus, dialogs, closed windows).
const CHANGE_PATCH_MIN_PCT = 0.2
const CHANGE_DISPLAY_MIN_PCT = 0.2

// The screen glow's lifecycle is 100% model-owned: computer_glow_on turns it
// on (mandated FIRST action of a session), computer_glow_off turns it off
// (mandated LAST action, success or surrender). There is no idle timer and
// no harness-side clearing — while on, it only follows the display being
// controlled.
const OVERLAY_FADE_MS = 650

/**
 * The coordinate frame the model is currently working in: the most recent
 * image this plugin returned (screenshot, zoom, or magnifier). All mouse
 * coordinates arrive in this image's pixel space and are mapped here to
 * global DIP screen space. Keyed per conversation so concurrent
 * conversations cannot trample each other's mapping.
 *
 *   scale    — logical (DIP) pixels per image pixel
 *   offsetX/offsetY — global DIP position of the image's (0,0)
 *   width/height    — image dimensions in image pixels
 *   displayId       — the display the frame was captured from
 */
const frames = new Map()

function frameKey() {
  return getConversationId() ?? 'global'
}

function currentFrame() {
  return frames.get(frameKey()) ?? null
}

function setFrame(frame) {
  frames.set(frameKey(), frame)
}

const KEY_MAP = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  insert: 'Insert',
  capslock: 'CapsLock',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
  ctrl: 'LeftControl',
  control: 'LeftControl',
  alt: 'LeftAlt',
  option: 'LeftAlt',
  opt: 'LeftAlt',
  shift: 'LeftShift',
  meta: 'LeftSuper',
  cmd: 'LeftSuper',
  command: 'LeftSuper',
  super: 'LeftSuper',
  win: 'LeftSuper',
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'LeftBracket',
  ']': 'RightBracket',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Grave',
  0: 'Num0',
  1: 'Num1',
  2: 'Num2',
  3: 'Num3',
  4: 'Num4',
  5: 'Num5',
  6: 'Num6',
  7: 'Num7',
  8: 'Num8',
  9: 'Num9'
}

function resolveKey(Key, name) {
  const trimmed = String(name).trim()
  const lower = trimmed.toLowerCase()
  const mapped = KEY_MAP[lower]
  if (mapped && Key[mapped] !== undefined) return Key[mapped]
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase()
    if (Key[upper] !== undefined) return Key[upper]
  }
  if (Key[trimmed] !== undefined) return Key[trimmed]
  return null
}

async function readConfig() {
  if (!workspaceRoot) return {}
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    return JSON.parse(raw)?.computerUse ?? {}
  } catch {
    return {}
  }
}

// The app's UI locale ('en' | 'ar'), used only for the human-facing glow
// overlay text. Cached so overlay creation can stay synchronous; refreshed
// fire-and-forget at init and on every keep-alive, matching how the rest of
// the main process treats config.json's top-level `locale`.
let appLocale = 'en'

function refreshAppLocale() {
  if (!workspaceRoot) return
  fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    .then((raw) => {
      appLocale = JSON.parse(raw)?.locale === 'ar' ? 'ar' : 'en'
    })
    .catch(() => {
      // Keep the previous (or default 'en') locale.
    })
}

async function checkPermissions() {
  try {
    await nutMouse.getPosition()
    permissionsOK = true
    permissionError = null
  } catch (err) {
    permissionsOK = false
    const msg = err?.message ?? String(err)
    if (process.platform === 'darwin') {
      permissionError =
        'Screen recording and accessibility permissions required. ' +
        'Grant them in System Settings → Privacy & Security → Screen Recording and Accessibility, then restart Wolffish.'
    } else if (process.platform === 'linux') {
      permissionError = msg.includes('X11')
        ? 'X11 is required for computer-use on Linux. Wayland is not supported by the automation library.'
        : `Permission error: ${msg}`
    } else {
      permissionError = `Permission error: ${msg}`
    }
  }
}

function requirePermissions() {
  if (!permissionsOK) {
    return {
      success: false,
      error: permissionError || 'Desktop automation permissions not granted.'
    }
  }
  return null
}

// ─── Coordinate spaces ──────────────────────────────────────────────────
//
// Three spaces are involved and only the plugin ever converts between them:
//   frame  — pixels of the latest image the model saw
//   DIP    — Electron's logical global desktop coordinates
//   native — what the OS input layer expects (macOS: DIP; Windows: physical
//            pixels; Linux/X11: physical pixels)

function frameToDip(frame, x, y) {
  // Center-of-pixel mapping: image pixel x spans [x*s, (x+1)*s) logical px;
  // floor of its midpoint clicks the middle of that span instead of its
  // left edge, which matters when one image pixel covers 2+ screen pixels.
  return {
    x: Math.floor((x + 0.5) * frame.scale + frame.offsetX),
    y: Math.floor((y + 0.5) * frame.scale + frame.offsetY)
  }
}

function dipToNative(x, y) {
  if (process.platform === 'darwin') return { x, y }
  if (process.platform === 'win32' && typeof electronScreen.dipToScreenPoint === 'function') {
    const p = electronScreen.dipToScreenPoint({ x, y })
    return { x: p.x, y: p.y }
  }
  // Linux/X11 (and a Windows fallback without dipToScreenPoint): input
  // events address physical pixels; scale DIP by the containing display's
  // factor around that display's origin.
  const display = electronScreen.getDisplayNearestPoint({ x, y })
  const f = display.scaleFactor || 1
  if (f === 1) return { x, y }
  return {
    x: Math.round(display.bounds.x * f + (x - display.bounds.x) * f),
    y: Math.round(display.bounds.y * f + (y - display.bounds.y) * f)
  }
}

function validateFrameCoords(x, y, label = 'Coordinates') {
  const frame = currentFrame()
  if (!frame) {
    return (
      `${label} (${x}, ${y}) cannot be used yet: there is no current frame. ` +
      'Take a computer_screenshot first, then give coordinates read from that image.'
    )
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return (
      `${label} (${x}, ${y}) are outside the current frame. The current frame is the LATEST image you received ` +
      `(a ${frame.width}x${frame.height} ${frame.kind}); valid range is x 0-${frame.width - 1}, y 0-${frame.height - 1}. ` +
      'Coordinates from an older image are invalid — take a fresh computer_screenshot and read new coordinates from it.'
    )
  }
  return null
}

// ─── Capture ────────────────────────────────────────────────────────────

function getDisplayByIndex(index) {
  const displays = electronScreen.getAllDisplays()
  return { displays, display: displays[index] || electronScreen.getPrimaryDisplay() }
}

async function captureNative(display) {
  const targetW = Math.round(display.size.width * display.scaleFactor)
  const targetH = Math.round(display.size.height * display.scaleFactor)
  await overlayBeforeCapture()
  let sources
  try {
    sources = await electronDesktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetW, height: targetH }
    })
  } finally {
    overlayAfterCapture()
  }
  const displayId = String(display.id)
  let source = sources.find((s) => s.display_id === displayId)
  if (!source) {
    // display_id can be empty on some platforms; fall back to matching the
    // display's position in the enumeration order.
    const displays = electronScreen.getAllDisplays()
    const index = displays.findIndex((d) => d.id === display.id)
    source = sources[index >= 0 ? index : 0]
  }
  if (!source) throw new Error('No screen source found for capture.')
  const size = source.thumbnail.getSize()
  if (size.width === 0 || size.height === 0) {
    throw new Error(
      'Screenshot returned empty image. Check Screen Recording permission in System Settings → Privacy & Security.'
    )
  }
  return { png: source.thumbnail.toPNG(), nativeW: size.width, nativeH: size.height }
}

function cursorDip() {
  try {
    return electronScreen.getCursorScreenPoint()
  } catch {
    return null
  }
}

// ─── Screen glow overlay ────────────────────────────────────────────────
//
// A soft blue border on the display the agent is working on — visible to
// the human as "the computer is being controlled here", invisible to the
// model: the window is content-protected so it never appears in captures
// (on Linux, where protection is unsupported, it hides for the instant of
// each capture instead). Click-through and non-focusable, so input synthesis
// is completely unaffected. Purely harness-side — no tool exposes it and
// the model never has to know it exists.

const overlay = {
  win: null,
  displayId: null,
  assertBounds: null,
  wantedBounds: null,
  locale: null
}

// Human-facing status line shown in the glow's pill, per app UI locale.
const OVERLAY_TEXT = {
  en: { dir: 'ltr', text: 'Wolffish is capturing your screen' },
  ar: { dir: 'rtl', text: 'وولفيش يلتقط شاشتك' }
}

function overlayHtml(locale) {
  const t = OVERLAY_TEXT[locale] ?? OVERLAY_TEXT.en
  // The glow is four edge gradients rather than one giant inset box-shadow:
  // blurred shadows on a display-sized transparent surface render per
  // compositor tile and can drop edges; plain gradients never do. The
  // breathing and pulse layers animate opacity only (pre-painted layers,
  // compositor-cheap — no per-frame shadow repaints).
  const edges = (a, b) =>
    `linear-gradient(to bottom, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to top, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to right, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to left, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0))`
  const layer =
    'position:fixed;inset:0;background-repeat:no-repeat;' +
    'background-size:100% 22px,100% 22px,22px 100%,22px 100%;' +
    'background-position:top,bottom,left,right;'
  const html =
    `<!doctype html><html dir="${t.dir}"><head><meta charset="utf-8"><style>` +
    'html,body{margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden;pointer-events:none}' +
    'body{opacity:0;animation:fi .45s ease-out forwards}' +
    'body.bye{animation:fo .6s ease-in forwards}' +
    `#base{${layer}background-image:${edges(0.4, 0.12)}}` +
    `#breathe{${layer}background-image:${edges(0.62, 0.2)};opacity:0;animation:br 3.2s ease-in-out infinite}` +
    `#pulse{${layer}background-image:${edges(0.9, 0.34)};opacity:0}` +
    '#pulse.on{animation:pu .8s ease-out}' +
    '#chip{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:8px;' +
    'padding:7px 16px;border-radius:999px;background:rgba(8,15,33,.42);' +
    'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    'border:1px solid rgba(96,165,250,.3);color:rgba(226,236,255,.62);' +
    "font:500 13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:.2px}" +
    '#dot{width:7px;height:7px;border-radius:50%;background:#60A5FA;box-shadow:0 0 8px 2px rgba(96,165,250,.55);' +
    'animation:db 2.4s ease-in-out infinite}' +
    '@keyframes fi{to{opacity:1}}' +
    '@keyframes fo{to{opacity:0}}' +
    '@keyframes br{0%,100%{opacity:.12}50%{opacity:1}}' +
    '@keyframes pu{0%{opacity:.95}100%{opacity:0}}' +
    '@keyframes db{0%,100%{opacity:.45}50%{opacity:1}}' +
    '</style></head><body>' +
    '<div id="base"></div><div id="breathe"></div><div id="pulse"></div>' +
    `<div id="chip"><div id="dot"></div><span>${t.text}</span></div>` +
    '<scr' +
    'ipt>window.pulse=function(){var p=document.getElementById("pulse");p.classList.remove("on");void p.offsetWidth;p.classList.add("on")};' +
    'window.bye=function(){document.body.classList.add("bye")}</scr' +
    'ipt></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function hideOverlay(immediate = false) {
  const win = overlay.win
  overlay.win = null
  overlay.displayId = null
  overlay.assertBounds = null
  overlay.wantedBounds = null
  overlay.locale = null
  if (!win || win.isDestroyed()) return
  const destroy = () => {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // Already gone — nothing to clean up.
    }
  }
  // Linux has no content protection, and a detached fading window is out of
  // overlayBeforeCapture's reach — it would leak into captures. Destroy
  // immediately there; the fade is macOS/Windows-only polish.
  if (immediate || process.platform === 'linux') {
    destroy()
    return
  }
  // Fade out gently, then destroy. The window is already detached from the
  // overlay state, so a new glow can appear meanwhile without conflict.
  try {
    win.webContents.executeJavaScript('window.bye && window.bye()').catch(() => {})
    const t = setTimeout(destroy, OVERLAY_FADE_MS + 150)
    if (typeof t.unref === 'function') t.unref()
  } catch {
    destroy()
  }
}

function createOverlayWindow(display) {
  const b = display.bounds
  const win = new electronBrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    title: 'wolffish-screen-glow',
    // Without this, macOS constrainFrameRect re-clamps the frameless
    // window to a screen's visible frame some time after show — verified
    // live: the overlay was shoved off the display, which is exactly why
    // the glow's bottom border went missing. This flag disables the
    // clamp; the snap-back below heals any move the OS still makes.
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  // Excluded from every capture path (macOS sharingType none / Windows
  // WDA_EXCLUDEFROMCAPTURE): the human sees the glow, screenshots don't.
  win.setContentProtection(true)
  win.loadURL(overlayHtml(appLocale))
  win.showInactive()
  const wanted = { x: b.x, y: b.y, width: b.width, height: b.height }
  const snap = () => {
    try {
      if (win.isDestroyed()) return
      const cur = win.getBounds()
      if (cur.x !== wanted.x || cur.y !== wanted.y || cur.width !== wanted.width || cur.height !== wanted.height) {
        win.setBounds(wanted)
      }
    } catch {
      // Cosmetic only.
    }
  }
  win.setBounds(wanted)
  win.on('move', snap)
  win.on('resize', snap)
  overlay.win = win
  overlay.displayId = display.id
  overlay.assertBounds = snap
  overlay.wantedBounds = wanted
  overlay.locale = appLocale
  console.log(`[computer-use] screen glow shown on display ${display.id} (${display.bounds.width}x${display.bounds.height})`)
}

/**
 * Show the glow on the given display (or move it there). Called by the
 * model-facing computer_glow_on, and by overlayFollow while the glow is on.
 * Returns whether the glow is showing. Never throws — overlay trouble must
 * not fail a tool call.
 */
function overlayShow(display) {
  try {
    if (!electronBrowserWindow || !display) return false
    refreshAppLocale()
    // Recreate rather than fight the OS when the display's geometry changed
    // (resolution or arrangement) — the snap-back listeners would otherwise
    // pin the stale bounds forever.
    const db = display.bounds
    const geometryChanged =
      overlay.wantedBounds &&
      overlay.displayId === display.id &&
      (overlay.wantedBounds.x !== db.x ||
        overlay.wantedBounds.y !== db.y ||
        overlay.wantedBounds.width !== db.width ||
        overlay.wantedBounds.height !== db.height)
    if (overlay.win && (overlay.win.isDestroyed() || overlay.displayId !== display.id || geometryChanged)) {
      hideOverlay(true)
    }
    if (!overlay.win) {
      createOverlayWindow(display)
    } else {
      if (overlay.assertBounds) {
        // Re-assert full-display coverage: cheap, and it heals any late
        // OS-side reposition that slipped past the listeners.
        overlay.assertBounds()
      }
      if (overlay.locale !== appLocale && !overlay.win.isDestroyed()) {
        // The app's UI language changed mid-session — swap the chip text in
        // place instead of waiting for the next overlay recreation.
        overlay.locale = appLocale
        const t = OVERLAY_TEXT[appLocale] ?? OVERLAY_TEXT.en
        overlay.win.webContents
          .executeJavaScript(
            `document.documentElement.setAttribute('dir', ${JSON.stringify(t.dir)});` +
              `var s = document.querySelector('#chip span'); if (s) s.textContent = ${JSON.stringify(t.text)};`
          )
          .catch(() => {})
      }
    }
    return !!overlay.win
  } catch (err) {
    // Glow is cosmetic — never let it break automation. But say why it
    // failed, or a missing glow is undiagnosable.
    console.log(`[computer-use] screen glow failed: ${err?.message ?? String(err)}`)
    return false
  }
}

/**
 * While the glow is ON (model turned it on), keep it over the display being
 * controlled. Never creates the glow — the lifecycle is 100% model-owned via
 * computer_glow_on / computer_glow_off.
 */
function overlayFollow(display) {
  if (!overlay.win) return
  overlayShow(display)
}

/** Follow onto whichever display holds the cursor (typing, key presses). */
function overlayFollowAtCursor() {
  try {
    const cur = cursorDip()
    if (!cur) return
    overlayFollow(electronScreen.getDisplayNearestPoint(cur))
  } catch {
    // Cosmetic only.
  }
}

/** One subtle brighten-and-fade pulse: feedback that a capture happened. */
function overlayPulse() {
  try {
    if (overlay.win && !overlay.win.isDestroyed()) {
      overlay.win.webContents.executeJavaScript('window.pulse && window.pulse()').catch(() => {})
    }
  } catch {
    // Cosmetic only.
  }
}

/**
 * Linux has no content protection: momentarily hide the glow while the
 * capture happens so screenshots stay clean there too. No-op elsewhere.
 */
async function overlayBeforeCapture() {
  if (process.platform !== 'linux') return
  try {
    if (overlay.win && !overlay.win.isDestroyed() && overlay.win.isVisible()) {
      overlay.win.hide()
      await sleep(90)
    }
  } catch {
    // Cosmetic only.
  }
}

function overlayAfterCapture() {
  if (process.platform !== 'linux') return
  try {
    if (overlay.win && !overlay.win.isDestroyed()) overlay.win.showInactive()
  } catch {
    // Cosmetic only.
  }
}

/**
 * Crosshair marker composited onto every returned image at the cursor
 * position: white outer ring + magenta inner ring + center dot + ticks,
 * visible on light and dark backgrounds alike.
 *
 * With `hairlines`, thin magenta lines additionally run from the image
 * edges to the ring on both axes. In aiming frames (zoom, magnifier) this
 * is what makes the cursor position unambiguous: the fat ring can visually
 * swallow a small control that is actually 10-20px away — the live failure
 * mode behind "the crosshair is on the ✕" hallucinations — while a hairline
 * either passes through the target or visibly does not.
 */
function crosshairSvg(imgW, imgH, cx, cy, hairlines = false) {
  const c = '#FF1B8D'
  const hair = hairlines
    ? `<g opacity="0.55" stroke="#FFFFFF" stroke-width="3">` +
      `<line x1="0" y1="${cy}" x2="${cx - 22}" y2="${cy}"/>` +
      `<line x1="${cx + 22}" y1="${cy}" x2="${imgW}" y2="${cy}"/>` +
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy - 22}"/>` +
      `<line x1="${cx}" y1="${cy + 22}" x2="${cx}" y2="${imgH}"/>` +
      `</g>` +
      `<g stroke="${c}" stroke-width="1.2">` +
      `<line x1="0" y1="${cy}" x2="${cx - 22}" y2="${cy}"/>` +
      `<line x1="${cx + 22}" y1="${cy}" x2="${imgW}" y2="${cy}"/>` +
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy - 22}"/>` +
      `<line x1="${cx}" y1="${cy + 22}" x2="${cx}" y2="${imgH}"/>` +
      `</g>`
    : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">` +
      `<g fill="none">` +
      hair +
      `<circle cx="${cx}" cy="${cy}" r="9" stroke="#FFFFFF" stroke-width="4" opacity="0.9"/>` +
      `<circle cx="${cx}" cy="${cy}" r="9" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx - 16}" y1="${cy}" x2="${cx - 6}" y2="${cy}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx + 6}" y1="${cy}" x2="${cx + 16}" y2="${cy}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy - 16}" x2="${cx}" y2="${cy - 6}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy + 6}" x2="${cx}" y2="${cy + 16}" stroke="${c}" stroke-width="2"/>` +
      `<circle cx="${cx}" cy="${cy}" r="1.6" fill="${c}"/>` +
      `</g></svg>`
  )
}

async function savePersistedImage(buffer, ext, prefix) {
  try {
    const convId = getConversationId()
    const safe = (convId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
    const dir = path.join(workspaceRoot, 'screenshots', `conv-${safe}`)
    await fs.mkdir(dir, { recursive: true })
    screenshotCounter++
    const filePath = path.join(dir, `${prefix}-${Date.now()}-${screenshotCounter}.${ext}`)
    await fs.writeFile(filePath, buffer)
    return filePath
  } catch {
    return ''
  }
}

/**
 * Percentage of pixels that differ between the same crop of two captures.
 * Greyscale at a reduced size with a generous per-pixel threshold, so
 * capture noise and antialiasing never register while any real UI change
 * (a closed tab, an opened menu, a toggled control) does.
 */
async function regionChangePct(prePng, postPng, crop) {
  // Patch diffs run at native resolution — a 16px checkmark toggling must
  // register, and downscaling would dilute it below any threshold. The
  // full-display diff (crop == null) downscales for speed; it only needs to
  // catch big effects like menus and closed windows.
  const prep = (png) => {
    let p = sharp(png)
    if (crop) {
      p = p.extract(crop)
      if (crop.width > 640) p = p.resize({ width: 640 })
    } else {
      p = p.resize({ width: 256 })
    }
    return p.greyscale().raw().toBuffer({ resolveWithObject: true })
  }
  const threshold = crop ? 20 : 26
  const [a, b] = await Promise.all([prep(prePng), prep(postPng)])
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return null
  const n = Math.min(a.data.length, b.data.length)
  if (n === 0) return null
  let changed = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > threshold) changed++
  }
  return (changed / n) * 100
}

/**
 * Capture a magnified close-up centered on the cursor, crosshair drawn at
 * the exact cursor pixel. Returned after move/click/drag as visual proof of
 * where the action landed, and installed as the new current frame so the
 * model can correct its aim in the close-up's own (finer) coordinates.
 *
 * When `preShot` (a captureNative result plus displayId, taken just before
 * the action) is provided, the fresh capture is also diffed against it and
 * the note reports objectively whether the screen changed — the model gets
 * hard evidence instead of having to judge a close-up it can misread.
 */
async function renderMagnifier(preShot = null) {
  const cur = cursorDip()
  if (!cur) throw new Error('Could not read cursor position.')
  const display = electronScreen.getDisplayNearestPoint(cur)
  overlayFollow(display)
  const { png, nativeW, nativeH } = await captureNative(display)

  const b = display.bounds
  const logicalW = display.size.width
  const logicalH = display.size.height
  const regW = Math.min(MAG_W, logicalW)
  const regH = Math.min(MAG_H, logicalH)
  let rx = Math.round(cur.x - b.x - regW / 2)
  let ry = Math.round(cur.y - b.y - regH / 2)
  rx = Math.max(0, Math.min(logicalW - regW, rx))
  ry = Math.max(0, Math.min(logicalH - regH, ry))

  const fx = nativeW / logicalW
  const fy = nativeH / logicalH
  const crop = {
    left: Math.max(0, Math.round(rx * fx)),
    top: Math.max(0, Math.round(ry * fy)),
    width: Math.min(nativeW, Math.round(regW * fx)),
    height: Math.min(nativeH, Math.round(regH * fy))
  }
  crop.width = Math.min(crop.width, nativeW - crop.left)
  crop.height = Math.min(crop.height, nativeH - crop.top)

  const outW = regW * MAG_SCALE
  const outH = regH * MAG_SCALE
  const cxImg = Math.round((cur.x - b.x - rx) * MAG_SCALE)
  const cyImg = Math.round((cur.y - b.y - ry) * MAG_SCALE)

  const buffer = await sharp(png)
    .extract(crop)
    .resize({ width: outW, height: outH, fit: 'fill' })
    .composite([{ input: crosshairSvg(outW, outH, cxImg, cyImg, true), left: 0, top: 0 }])
    .png()
    .toBuffer()

  setFrame({
    kind: 'magnifier',
    scale: 1 / MAG_SCALE,
    offsetX: b.x + rx,
    offsetY: b.y + ry,
    width: outW,
    height: outH,
    displayId: display.id
  })

  // Objective did-anything-change verdict, computed from pixels rather than
  // model eyesight. Patch = the magnifier region; display = the whole screen.
  let changeLine = ''
  if (preShot && preShot.displayId === display.id && preShot.nativeW === nativeW && preShot.nativeH === nativeH) {
    try {
      const [patchPct, displayPct] = await Promise.all([
        regionChangePct(preShot.png, png, crop),
        regionChangePct(preShot.png, png, null)
      ])
      if (patchPct !== null && displayPct !== null) {
        const changed = patchPct >= CHANGE_PATCH_MIN_PCT || displayPct >= CHANGE_DISPLAY_MIN_PCT
        changeLine = changed
          ? ` Screen change detected: ${patchPct.toFixed(1)}% of the area around the cursor changed` +
            ` (${displayPct.toFixed(1)}% of this display) — animation or video can also trigger this, so confirm with the` +
            ` magnifier/screenshot that it is the change YOU intended.`
          : ` NO visible change was detected on this display within ~0.4s of the click (${patchPct.toFixed(2)}% around the cursor,` +
            ` ${displayPct.toFixed(2)}% of the display). An immediate local effect (a control toggling, a menu opening, a tab closing)` +
            ` would normally register here — if you expected one, treat this as a MISS: re-locate the target (fresh screenshot →` +
            ` tight zoom → computer_mouse_move) instead of reporting success. But slow-loading results, effects on another display,` +
            ` or very small low-contrast changes can evade this check — if the effect may simply be slow (page load, form submit),` +
            ` wait and take a computer_screenshot to confirm, and NEVER re-click a side-effectful control (send, submit, buy, delete)` +
            ` on this line alone.`
      }
    } catch {
      // Diffing is best-effort — the magnifier alone is still useful.
    }
  }

  const savedPath = await savePersistedImage(buffer, 'png', 'mag')

  return {
    image: { mediaType: 'image/png', data: buffer.toString('base64') },
    changeLine,
    note:
      `The ${outW}x${outH} magnifier below (${MAG_SCALE}x zoom around the cursor) is now the current frame — ` +
      `the ring and the thin magenta hairlines running to the image edges mark the exact cursor position ` +
      `(they are drawn by the tool, not part of the UI). To adjust by a small amount, use coordinates read from ` +
      `this magnifier. For anything else, take a fresh computer_screenshot first.` +
      (savedPath ? `\n${savedPath}` : '')
  }
}

// ─── Tools ──────────────────────────────────────────────────────────────

async function takeScreenshot(args) {
  const denied = requirePermissions()
  if (denied) return denied

  try {
    const cfg = await readConfig()
    const cfgWidth = cfg.screenshotMaxWidth || DEFAULT_MAX_WIDTH
    const format = cfg.screenshotFormat || DEFAULT_FORMAT
    const displayIndex = Number(args?.display_index) || 0
    const { displays, display } = getDisplayByIndex(displayIndex)

    overlayFollow(display)
    const { png, nativeW, nativeH } = await captureNative(display)

    // Very wide displays (ultrawides) would compress unreadably at the
    // configured width; floor the overview at 1/3 of logical width so
    // compression never exceeds ~3x. Zoom still provides native detail.
    const maxWidth = Math.min(2048, Math.max(cfgWidth, Math.ceil(display.size.width / 3)))
    const outW = Math.min(nativeW, maxWidth)
    const outH = Math.round(nativeH * (outW / nativeW))

    let pipeline = sharp(png)
    if (outW < nativeW) pipeline = pipeline.resize({ width: outW, withoutEnlargement: true })

    // Frame maps image pixels to this display's logical space.
    const frame = {
      kind: 'screenshot',
      scale: display.size.width / outW,
      offsetX: display.bounds.x,
      offsetY: display.bounds.y,
      width: outW,
      height: outH,
      displayId: display.id
    }

    // Crosshair at the cursor, when the cursor is on this display.
    const cur = cursorDip()
    let cursorLine = 'Cursor is on another display.'
    if (
      cur &&
      cur.x >= display.bounds.x &&
      cur.x < display.bounds.x + display.size.width &&
      cur.y >= display.bounds.y &&
      cur.y < display.bounds.y + display.size.height
    ) {
      const cx = Math.round((cur.x - frame.offsetX) / frame.scale)
      const cy = Math.round((cur.y - frame.offsetY) / frame.scale)
      pipeline = pipeline.composite([
        { input: crosshairSvg(outW, outH, cx, cy), left: 0, top: 0 }
      ])
      cursorLine = `Cursor at (${cx}, ${cy}), marked with the magenta crosshair.`
    }

    let buffer, mediaType, ext
    if (format === 'png') {
      buffer = await pipeline.png().toBuffer()
      mediaType = 'image/png'
      ext = 'png'
    } else {
      buffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
      mediaType = 'image/jpeg'
      ext = 'jpg'
    }

    setFrame(frame)
    overlayPulse()

    const displayInfo =
      displays.length > 1
        ? `display ${displayIndex} of ${displays.length} (${display.size.width}x${display.size.height} logical)`
        : `the primary display (${display.size.width}x${display.size.height} logical)`
    const savedPath = await savePersistedImage(buffer, ext, 'shot')
    const pathLine = savedPath ? `\n${savedPath}` : ''

    const compression = frame.scale
    const compressionLine =
      compression >= 2
        ? ` This overview is compressed ${compression.toFixed(1)}x — small text and small controls are degraded in it, so do NOT locate or judge small targets from this image alone: zoom into candidate regions with computer_zoom and find them there.`
        : ''

    return {
      success: true,
      output:
        `Frame ${outW}x${outH} — screenshot of ${displayInfo}. ${cursorLine} ` +
        `Mouse coordinates must be pixel positions read from THIS image (x 0-${outW - 1}, y 0-${outH - 1}); ` +
        `they are translated to the screen automatically. For a small or crowded target, zoom in with computer_zoom before clicking.` +
        compressionLine +
        pathLine,
      images: [{ mediaType, data: buffer.toString('base64') }]
    }
  } catch (err) {
    return { success: false, error: `Screenshot failed: ${err?.message ?? String(err)}` }
  }
}

async function zoomRegion(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const x = Number(args?.x)
  const y = Number(args?.y)
  const w = Number(args?.width)
  const h = Number(args?.height)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { success: false, error: 'x, y, width, height are required (finite numbers; width/height > 0).' }
  }
  const frame = currentFrame()
  const boundsError =
    validateFrameCoords(x, y, 'Region origin') ??
    validateFrameCoords(Math.min(x + w, (frame?.width ?? 1) - 1), Math.min(y + h, (frame?.height ?? 1) - 1), 'Region corner')
  if (boundsError) return { success: false, error: boundsError }
  if (x + w > frame.width || y + h > frame.height) {
    return {
      success: false,
      error:
        `Region (${x},${y}) ${w}x${h} extends past the current ${frame.width}x${frame.height} frame. ` +
        'Shrink it to fit, or take a fresh computer_screenshot first.'
    }
  }

  try {
    // Region in global logical space.
    const lx = x * frame.scale + frame.offsetX
    const ly = y * frame.scale + frame.offsetY
    const lw = Math.max(12, w * frame.scale)
    const lh = Math.max(8, h * frame.scale)

    const display =
      electronScreen.getAllDisplays().find((d) => d.id === frame.displayId) ??
      electronScreen.getDisplayNearestPoint({ x: Math.round(lx + lw / 2), y: Math.round(ly + lh / 2) })
    const b = display.bounds

    overlayFollow(display)
    const { png, nativeW, nativeH } = await captureNative(display)
    const fx = nativeW / display.size.width
    const fy = nativeH / display.size.height
    const crop = {
      left: Math.max(0, Math.round((lx - b.x) * fx)),
      top: Math.max(0, Math.round((ly - b.y) * fy)),
      width: Math.max(1, Math.round(lw * fx)),
      height: Math.max(1, Math.round(lh * fy))
    }
    crop.width = Math.max(1, Math.min(crop.width, nativeW - crop.left))
    crop.height = Math.max(1, Math.min(crop.height, nativeH - crop.top))

    // Small regions magnify (up to 4x); a region wider than the output cap
    // is re-rendered downscaled to fit — still a fresh native-based view.
    // When the base cap would leave the zoom under 2x, widen the output up
    // to ZOOM_WIDE_OUT to claw back magnification: sub-2x zooms are where
    // small-target clicks go wrong. Tall regions are capped by height too,
    // so a narrow column can never explode into a several-thousand-pixel
    // image.
    let factor = Math.min(ZOOM_MAX_FACTOR, ZOOM_MAX_OUT / lw)
    if (factor < ZOOM_TARGET_FACTOR) {
      factor = Math.min(ZOOM_TARGET_FACTOR, ZOOM_WIDE_OUT / lw)
    }
    factor = Math.min(factor, ZOOM_MAX_OUT_H / lh)
    const outW = Math.round(lw * factor)
    const outH = Math.round(lh * factor)

    let pipeline = sharp(png).extract(crop).resize({ width: outW, height: outH, fit: 'fill' })

    const newFrame = {
      kind: 'zoom',
      scale: lw / outW,
      offsetX: lx,
      offsetY: ly,
      width: outW,
      height: outH,
      displayId: display.id
    }

    const cur = cursorDip()
    let cursorLine = ''
    if (cur && cur.x >= lx && cur.x < lx + lw && cur.y >= ly && cur.y < ly + lh) {
      const cx = Math.round((cur.x - lx) / newFrame.scale)
      const cy = Math.round((cur.y - ly) / newFrame.scale)
      pipeline = pipeline.composite([{ input: crosshairSvg(outW, outH, cx, cy, true), left: 0, top: 0 }])
      cursorLine =
        ` Cursor at (${cx}, ${cy}), marked with the crosshair and hairlines — that is only where the CURSOR sits,` +
        ` not proof it is on your target: never click the cursor's position because it "looks close"; read your` +
        ` target's own pixel coordinates from this image.`
    }

    const buffer = await pipeline.png().toBuffer()
    setFrame(newFrame)
    overlayPulse()
    const savedPath = await savePersistedImage(buffer, 'png', 'zoom')
    const pathLine = savedPath ? `\n${savedPath}` : ''

    // A weak zoom is the setup for a missed click — say so, with the exact
    // region size that would fix it (in THIS new frame's own pixels).
    // Gate at 1.95 rather than 2.0 so toFixed(1) can never render the
    // self-contradiction "this zoom is only 2.0x".
    let weakLine = ''
    if (factor < ZOOM_TARGET_FACTOR - 0.05) {
      const suggestW = Math.max(40, Math.min(outW, Math.floor(ZOOM_MAX_OUT / (3 * newFrame.scale))))
      const suggestH = Math.max(24, Math.min(outH, Math.floor(ZOOM_MAX_OUT_H / (3 * newFrame.scale))))
      weakLine =
        ` WARNING: this zoom is only ${factor.toFixed(1)}x — barely sharper than the screenshot, NOT enough to aim at` +
        ` small controls (close buttons, checkboxes, small icons). Zoom again into a narrower slice of THIS frame` +
        ` around your target — a region of at most ${suggestW}x${suggestH} gives you 3x.`
    }

    return {
      success: true,
      output:
        `Frame ${outW}x${outH} — ${factor.toFixed(1)}x zoom into the region you selected, captured fresh at native resolution.${cursorLine} ` +
        `Coordinates now refer to THIS zoomed image (x 0-${outW - 1}, y 0-${outH - 1}) — click your target using them for maximum precision. ` +
        `To act outside this region, take a fresh computer_screenshot first.` +
        weakLine +
        pathLine,
      images: [{ mediaType: 'image/png', data: buffer.toString('base64') }]
    }
  } catch (err) {
    return { success: false, error: `Zoom failed: ${err?.message ?? String(err)}` }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function moveCursorTo(x, y) {
  const frame = currentFrame()
  const dip = frameToDip(frame, x, y)
  const native = dipToNative(dip.x, dip.y)
  await nutMouse.setPosition(new nutPoint(native.x, native.y))
  await sleep(80)
  return dip
}

async function mouseMove(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const x = Number(args?.x)
  const y = Number(args?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { success: false, error: 'x and y coordinates are required (finite numbers)' }
  }
  const boundsError = validateFrameCoords(x, y)
  if (boundsError) return { success: false, error: boundsError }
  const target = typeof args?.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : null

  try {
    const dip = await moveCursorTo(x, y)
    const mag = await renderMagnifier()
    const aimWhat = target ? `"${target}"` : 'your target'
    return {
      success: true,
      output:
        `Moved cursor to (${x}, ${y}) in the previous frame → screen (${dip.x}, ${dip.y}).` +
        (target ? ` Target: "${target}".` : '') +
        ` Check the magnifier: the hairlines must pass through the CENTER of ${aimWhat} — "close" is not on it. ` +
        `If they do, click with computer_mouse_click (no coordinates). ` +
        `If they are off by any amount, move again using coordinates read from the magnifier. ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    return { success: false, error: `Mouse move failed: ${err?.message ?? String(err)}` }
  }
}

function resolveButton(name) {
  switch (String(name ?? 'left').toLowerCase()) {
    case 'right':
      return { button: nutButton.RIGHT, label: 'right' }
    case 'middle':
      return { button: nutButton.MIDDLE, label: 'middle' }
    default:
      return { button: nutButton.LEFT, label: 'left' }
  }
}

async function mouseClick(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const hasCoords = args?.x !== undefined && args?.y !== undefined
  const x = hasCoords ? Number(args.x) : null
  const y = hasCoords ? Number(args.y) : null
  const { button, label } = resolveButton(args?.button)
  const isDouble = args?.double === true
  const target = typeof args?.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : null

  if (hasCoords) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { success: false, error: 'x and y must be finite numbers (or omit both to click at the current cursor position).' }
    }
    const boundsError = validateFrameCoords(x, y)
    if (boundsError) return { success: false, error: boundsError }
  }

  try {
    let where = 'at the current cursor position'
    if (hasCoords) {
      const dip = await moveCursorTo(x, y)
      where = `at (${x}, ${y}) in the previous frame → screen (${dip.x}, ${dip.y})`
    }

    // Let hover states settle, then capture the before picture — the
    // post-click capture is diffed against it so the result can state
    // objectively whether the click changed anything on screen.
    await sleep(150)
    let preShot = null
    try {
      const cur = cursorDip()
      if (cur) {
        const preDisplay = electronScreen.getDisplayNearestPoint(cur)
        preShot = { ...(await captureNative(preDisplay)), displayId: preDisplay.id }
      }
    } catch {
      // Verification is best-effort — the click itself must still happen.
    }

    if (isDouble) {
      await nutMouse.doubleClick(button)
    } else {
      await nutMouse.click(button)
    }
    // With a before-capture in hand, give the UI a little longer to paint the
    // click's effect before sampling — quick-but-not-instant reactions
    // (ripples, row removals, dropdowns) must land inside the diff window.
    await sleep(preShot ? 300 : 120)

    const mag = await renderMagnifier(preShot)
    const clickType = isDouble ? 'Double-clicked' : 'Clicked'
    const targetLine = target ? ` Target: "${target}".` : ''
    const verifyWhat = target ? `"${target}"` : 'the target you meant'
    const changeLine =
      mag.changeLine ||
      ' Change measurement was unavailable for this click — verify the result with the magnifier and a fresh screenshot.'
    return {
      success: true,
      output:
        `${clickType} ${label} ${where}.${targetLine}${changeLine} ` +
        `Verify in the magnifier that the crosshair is on ${verifyWhat} — ` +
        `if it shows empty space or a different control under the crosshair, the target was NOT clicked: do not ` +
        `report success; re-locate it (fresh screenshot, then zoom) and click again. ` +
        `If this click should change the screen (menu, dialog, page), take a computer_screenshot to see the result. ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    return { success: false, error: `Mouse click failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseDrag(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const sx = Number(args?.start_x)
  const sy = Number(args?.start_y)
  const ex = Number(args?.end_x)
  const ey = Number(args?.end_y)
  if (![sx, sy, ex, ey].every(Number.isFinite)) {
    return { success: false, error: 'start_x, start_y, end_x, end_y are required (finite numbers).' }
  }
  const startError = validateFrameCoords(sx, sy, 'Start coordinates')
  if (startError) return { success: false, error: startError }
  const endError = validateFrameCoords(ex, ey, 'End coordinates')
  if (endError) return { success: false, error: endError }
  const { button, label } = resolveButton(args?.button)

  try {
    const frame = currentFrame()
    const startDip = await moveCursorTo(sx, sy)
    await nutMouse.pressButton(button)
    await sleep(150)
    const endDip = frameToDip(frame, ex, ey)
    const endNative = dipToNative(endDip.x, endDip.y)
    // Gradual movement (not teleport) so applications register the drag.
    await nutMouse.move(nutStraightTo(new nutPoint(endNative.x, endNative.y)))
    await sleep(120)
    await nutMouse.releaseButton(button)
    await sleep(120)

    const mag = await renderMagnifier()
    return {
      success: true,
      output:
        `Dragged with the ${label} button from (${sx}, ${sy}) to (${ex}, ${ey}) in the previous frame ` +
        `(screen ${startDip.x},${startDip.y} → ${endDip.x},${endDip.y}). The magnifier shows the release point — ` +
        `anything you dragged is now THERE, not at its original position. If the release point missed the ` +
        `destination, correct with a second, short drag: zoom into a region containing both the object's current ` +
        `position and the destination, then drag within that zoom — short drags are precise because both endpoints ` +
        `share one close-up frame. Take a computer_screenshot to verify the final result. ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    try {
      await nutMouse.releaseButton(button)
    } catch {
      // Best-effort: never leave the button held down after a failure.
    }
    return { success: false, error: `Drag failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseScroll(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const direction = String(args?.direction ?? 'down').toLowerCase()
  const amount = Math.max(1, Math.min(100, Number(args?.amount) || 3))
  const hasCoords = args?.x !== undefined && args?.y !== undefined

  if (hasCoords) {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { success: false, error: 'x and y must be finite numbers when provided.' }
    }
    const boundsError = validateFrameCoords(x, y)
    if (boundsError) return { success: false, error: boundsError }
    try {
      await moveCursorTo(x, y)
    } catch (err) {
      return { success: false, error: `Could not move to scroll position: ${err?.message ?? String(err)}` }
    }
  }

  try {
    switch (direction) {
      case 'up':
        await nutMouse.scrollUp(amount)
        break
      case 'down':
        await nutMouse.scrollDown(amount)
        break
      case 'left':
        await nutMouse.scrollLeft(amount)
        break
      case 'right':
        await nutMouse.scrollRight(amount)
        break
      default:
        return { success: false, error: `Invalid scroll direction: ${direction}` }
    }
    await sleep(150)
    const mag = await renderMagnifier()
    return {
      success: true,
      output:
        `Scrolled ${direction} by ${amount} wheel notches. The magnifier below shows the area under the cursor ` +
        `after the scroll — if the item you were scrolling toward is visible in it, click it directly using the ` +
        `magnifier's coordinates; otherwise scroll again. For the wider picture take a computer_screenshot ` +
        `(pre-scroll coordinates are stale). ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    return { success: false, error: `Scroll failed: ${err?.message ?? String(err)}` }
  }
}

const ASCII_PRINTABLE = /^[\x20-\x7E\r\n\t]*$/

async function keyboardType(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const text = String(args?.text ?? '')
  if (text.length === 0) {
    return { success: false, error: 'text is required and must be non-empty' }
  }
  overlayFollowAtCursor()

  try {
    // Short ASCII goes through real keystrokes. Anything long or non-ASCII
    // (Arabic, emoji, accents) is pasted via the clipboard — keystroke
    // synthesis mangles non-Latin text on several platforms, paste never
    // does. The user's previous clipboard text is restored afterwards.
    if (ASCII_PRINTABLE.test(text) && text.length <= 120) {
      await nutKeyboard.type(text)
      return { success: true, output: `Typed ${text.length} characters. Verify with a screenshot that the text landed in the intended field.` }
    }

    const { Key } = await import('@nut-tree-fork/nut-js')
    const previous = electronClipboard.readText()
    electronClipboard.writeText(text)
    await sleep(100)
    const pasteMod = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl
    await nutKeyboard.pressKey(pasteMod)
    await nutKeyboard.pressKey(Key.V)
    await nutKeyboard.releaseKey(Key.V)
    await nutKeyboard.releaseKey(pasteMod)
    await sleep(250)
    electronClipboard.writeText(previous)
    return {
      success: true,
      output: `Typed ${text.length} characters (pasted via clipboard for exact fidelity). Verify with a screenshot that the text landed in the intended field.`
    }
  } catch (err) {
    return { success: false, error: `Keyboard type failed: ${err?.message ?? String(err)}` }
  }
}

async function keyboardPress(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const rawKey = String(args?.key ?? '').trim()
  if (rawKey.length === 0) {
    return { success: false, error: 'key is required' }
  }
  overlayFollowAtCursor()

  // Accept both forms: key:'s' + modifiers:'cmd', and a single combo string
  // key:'cmd+s'. A bare '+' key press still works.
  let keyName = rawKey
  const comboMods = []
  if (rawKey.length > 1 && rawKey.includes('+')) {
    const parts = rawKey.split('+').map((p) => p.trim()).filter((p) => p.length > 0)
    if (parts.length > 1) {
      keyName = parts[parts.length - 1]
      comboMods.push(...parts.slice(0, -1))
    }
  }
  const modifierNames = [
    ...comboMods,
    ...String(args?.modifiers ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
  ].map((m) => m.toLowerCase())

  try {
    const { Key } = await import('@nut-tree-fork/nut-js')

    const mainKey = resolveKey(Key, keyName)
    if (mainKey === null) {
      return { success: false, error: `Unknown key: ${keyName}` }
    }
    const modKeys = []
    for (const mod of modifierNames) {
      const resolved = resolveKey(Key, mod)
      if (resolved === null) {
        return { success: false, error: `Unknown modifier: ${mod}` }
      }
      modKeys.push(resolved)
    }

    for (const mk of modKeys) {
      await nutKeyboard.pressKey(mk)
    }
    await nutKeyboard.pressKey(mainKey)
    await nutKeyboard.releaseKey(mainKey)
    for (const mk of modKeys.reverse()) {
      await nutKeyboard.releaseKey(mk)
    }

    const desc = modifierNames.length > 0 ? `${modifierNames.join('+')}+${keyName}` : keyName
    return { success: true, output: `Pressed ${desc}` }
  } catch (err) {
    return { success: false, error: `Key press failed: ${err?.message ?? String(err)}` }
  }
}

async function glowOn(args) {
  try {
    if (!electronScreen || !electronBrowserWindow) {
      return { success: false, error: 'Screen indicator unavailable (Electron APIs not loaded).' }
    }
    const displayIndex = Number(args?.display_index) || 0
    const { display } = getDisplayByIndex(displayIndex)
    if (!overlayShow(display)) {
      return { success: false, error: 'Screen indicator could not be shown — continue the task and tell the user the indicator is unavailable.' }
    }
    return {
      success: true,
      output:
        `Screen indicator ON — display ${displayIndex} now shows the blue glow and the capture notice. ` +
        `It follows your actions across displays and stays on until you call computer_glow_off, ` +
        `which MUST be your last action when you finish — or give up on — controlling the screen.`
    }
  } catch (err) {
    return { success: false, error: `Screen indicator failed: ${err?.message ?? String(err)}` }
  }
}

async function glowOff() {
  const wasOn = !!overlay.win
  hideOverlay()
  return {
    success: true,
    output: wasOn
      ? 'Screen indicator OFF — the user can see the session is over.'
      : 'Screen indicator was already off.'
  }
}

async function waitMs(args) {
  // No cap — the model decides the duration (see SKILL.md). A wait cannot be
  // interrupted once in flight, so very long waits should be split into
  // several computer_wait calls. A missing, negative, or non-finite value
  // waits 0ms.
  const requested = Number(args?.ms)
  const ms = Number.isFinite(requested) && requested > 0 ? requested : 0
  // The glow (if the model turned it on) simply stays on through the wait —
  // its lifecycle is model-owned, nothing here needs to extend it.
  await new Promise((r) => setTimeout(r, ms))
  return { success: true, output: `Waited ${ms}ms` }
}

async function listDisplays() {
  try {
    const displays = electronScreen.getAllDisplays()
    const primary = electronScreen.getPrimaryDisplay()
    const lines = displays.map((d, i) => {
      const isPrimary = d.id === primary.id ? ' (primary)' : ''
      return `Display ${i}: ${d.size.width}x${d.size.height} logical @ ${d.scaleFactor}x, position (${d.bounds.x},${d.bounds.y})${isPrimary}`
    })
    lines.push(
      'Capture any of them with computer_screenshot display_index. Coordinates are always read from the returned image — never add display offsets yourself.'
    )
    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Failed to list displays: ${err?.message ?? String(err)}` }
  }
}

const TOOL_MAP = {
  computer_glow_on: glowOn,
  computer_glow_off: glowOff,
  computer_screenshot: takeScreenshot,
  computer_zoom: zoomRegion,
  computer_list_displays: listDisplays,
  computer_mouse_move: mouseMove,
  computer_mouse_click: mouseClick,
  computer_mouse_drag: mouseDrag,
  computer_mouse_scroll: mouseScroll,
  computer_keyboard_type: keyboardType,
  computer_keyboard_press: keyboardPress,
  computer_wait: waitMs
}

// Kept in sync with the SKILL.md frontmatter, which is the model-facing
// schema; this mirror exists for tooling that inspects the plugin directly.
const toolDefinitions = [
  {
    name: 'computer_glow_on',
    description:
      'Turn ON the screen indicator (blue edge glow + centered capture notice). MUST be the FIRST action of every computer-use session, before the first screenshot. Stays on until computer_glow_off.',
    parameters: {
      type: 'object',
      properties: {
        display_index: {
          type: 'number',
          description: 'Display to show it on first (default 0). It follows your actions across displays afterwards.'
        }
      },
      required: []
    }
  },
  {
    name: 'computer_glow_off',
    description:
      'Turn OFF the screen indicator. MUST be the LAST action when you finish — or give up on — controlling the screen. Nothing turns it off automatically.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'computer_screenshot',
    description:
      'See the screen. Captures a display and returns the image; it becomes the current frame that all mouse coordinates refer to.',
    parameters: {
      type: 'object',
      properties: {
        display_index: {
          type: 'number',
          description: 'Display index (default 0 = primary). Use computer_list_displays to see all displays.'
        }
      },
      required: []
    }
  },
  {
    name: 'computer_zoom',
    description:
      'Magnify a region of the current frame at native resolution for precise clicking and reading small text. The zoom becomes the new current frame.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Region left edge in current-frame pixels' },
        y: { type: 'number', description: 'Region top edge in current-frame pixels' },
        width: { type: 'number', description: 'Region width in current-frame pixels' },
        height: { type: 'number', description: 'Region height in current-frame pixels' }
      },
      required: ['x', 'y', 'width', 'height']
    }
  },
  {
    name: 'computer_list_displays',
    description: 'List all connected displays with resolution, scale factor, and position.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'computer_mouse_move',
    description:
      'Aim without clicking: move the cursor to x,y in current-frame pixels and get back a magnified view with a crosshair at the new position.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in current-frame pixels' },
        y: { type: 'number', description: 'Y in current-frame pixels' },
        target: { type: 'string', description: 'What you are aiming at (short phrase), echoed back for verification' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_mouse_click',
    description:
      'Click at x,y in current-frame pixels (or at the current cursor position when omitted). Returns a magnified view proving where the click landed, plus an objective report of whether the screen changed.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in current-frame pixels (omit both to click in place)' },
        y: { type: 'number', description: 'Y in current-frame pixels (omit both to click in place)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
        double: { type: 'boolean', description: 'Double-click instead of single click' },
        target: { type: 'string', description: 'What you are clicking (short phrase), echoed back for verification' }
      },
      required: []
    }
  },
  {
    name: 'computer_mouse_drag',
    description:
      'Press at the start point, glide to the end point, release — drag-and-drop, sliders, text selection. Coordinates in current-frame pixels.',
    parameters: {
      type: 'object',
      properties: {
        start_x: { type: 'number', description: 'Drag start X in current-frame pixels' },
        start_y: { type: 'number', description: 'Drag start Y in current-frame pixels' },
        end_x: { type: 'number', description: 'Drag end X in current-frame pixels' },
        end_y: { type: 'number', description: 'Drag end Y in current-frame pixels' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' }
      },
      required: ['start_x', 'start_y', 'end_x', 'end_y']
    }
  },
  {
    name: 'computer_mouse_scroll',
    description: 'Scroll the mouse wheel, optionally over a specific point first.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Wheel notches (default 3)' },
        x: { type: 'number', description: 'Optional: move here first (current-frame pixels)' },
        y: { type: 'number', description: 'Optional: move here first (current-frame pixels)' }
      },
      required: ['direction']
    }
  },
  {
    name: 'computer_keyboard_type',
    description: 'Type text into the focused control. Long or non-ASCII text is pasted via the clipboard for exact fidelity.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text']
    }
  },
  {
    name: 'computer_keyboard_press',
    description: "Press a key or shortcut — either key:'enter', or a combo string like 'cmd+shift+s'.",
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "Key or combo (e.g. enter, tab, 'cmd+s')" },
        modifiers: { type: 'string', description: 'Comma-separated modifiers: ctrl, alt, shift, meta, cmd' }
      },
      required: ['key']
    }
  },
  {
    name: 'computer_wait',
    description:
      'Wait the given milliseconds before the next action. No cap — split very long waits into several calls.',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'number', description: 'Milliseconds to wait' } },
      required: ['ms']
    }
  }
]

function describeAction(toolName, args) {
  switch (toolName) {
    case 'computer_glow_on':
      return { title: 'Show screen indicator', description: 'Show the glow and capture notice on the controlled display', risk: 'low' }
    case 'computer_glow_off':
      return { title: 'Hide screen indicator', description: 'Hide the glow and capture notice', risk: 'low' }
    case 'computer_screenshot':
      return { title: 'Take screenshot', description: 'Capture the current screen', risk: 'low' }
    case 'computer_zoom':
      return {
        title: 'Zoom into screen',
        description: `Magnify screen region ${args?.width ?? '?'}x${args?.height ?? '?'} at (${args?.x ?? '?'}, ${args?.y ?? '?'})`,
        risk: 'low'
      }
    case 'computer_list_displays':
      return { title: 'List displays', description: 'List all connected displays', risk: 'low' }
    case 'computer_mouse_move': {
      const x = args?.x ?? '?'
      const y = args?.y ?? '?'
      const at = typeof args?.target === 'string' && args.target ? ` — ${args.target}` : ''
      return { title: 'Move cursor', description: `Move mouse to (${x}, ${y})${at}`, risk: 'low' }
    }
    case 'computer_mouse_click': {
      const x = args?.x ?? 'current'
      const y = args?.y ?? 'current'
      const btn = args?.button ?? 'left'
      const dbl = args?.double ? 'Double-click' : 'Click'
      const at = typeof args?.target === 'string' && args.target ? ` — ${args.target}` : ''
      return { title: `${dbl} ${btn}`, description: `${dbl} ${btn} button at (${x}, ${y})${at}`, risk: 'medium' }
    }
    case 'computer_mouse_drag':
      return {
        title: 'Drag',
        description: `Drag from (${args?.start_x ?? '?'}, ${args?.start_y ?? '?'}) to (${args?.end_x ?? '?'}, ${args?.end_y ?? '?'})`,
        risk: 'medium'
      }
    case 'computer_mouse_scroll': {
      const dir = args?.direction ?? 'down'
      const amt = args?.amount ?? 3
      return { title: `Scroll ${dir}`, description: `Scroll ${dir} by ${amt} units`, risk: 'low' }
    }
    case 'computer_keyboard_type':
      return {
        title: 'Type text',
        description: `Type ${String(args?.text ?? '').length} characters`,
        risk: 'medium'
      }
    case 'computer_keyboard_press': {
      const key = args?.key ?? '?'
      const mods = args?.modifiers ? `${args.modifiers}+` : ''
      return { title: 'Press key', description: `Press ${mods}${key}`, command: `${mods}${key}`, risk: 'medium' }
    }
    case 'computer_wait':
      return { title: 'Wait', description: `Wait ${args?.ms ?? 0}ms`, risk: 'low' }
    default:
      return null
  }
}

const plugin = {
  name: 'computer-use',
  tools: toolDefinitions,
  describeAction,

  async init(context) {
    workspaceRoot = context.workspaceRoot
    if (context.getCurrentConversationId) {
      getConversationId = context.getCurrentConversationId
    }
    // Warm the overlay-locale cache so the first glow of a session already
    // shows the right language.
    refreshAppLocale()

    // On macOS, prompt for Accessibility permission
    if (process.platform === 'darwin') {
      try {
        const { systemPreferences } = await import('electron')
        systemPreferences.isTrustedAccessibilityClient(true)
      } catch {
        // Not fatal — electron import may fail in test environments
      }
    }

    // Load Electron screen capture APIs (screenshots use desktopCapturer, not nut-js)
    try {
      const electron = await import('electron')
      electronScreen = electron.screen
      electronDesktopCapturer = electron.desktopCapturer
      electronClipboard = electron.clipboard
      electronBrowserWindow = electron.BrowserWindow

      // A plugin reload orphans any glow the previous generation left on
      // screen — with no idle timer, it would otherwise stay up forever.
      try {
        for (const w of electronBrowserWindow.getAllWindows()) {
          if (w.getTitle?.() === 'wolffish-screen-glow') w.destroy()
        }
      } catch {
        // Cosmetic only.
      }
    } catch {
      // Will fall back to error in takeScreenshot
    }

    try {
      const nut = await import('@nut-tree-fork/nut-js')
      nutMouse = nut.mouse
      nutKeyboard = nut.keyboard
      nutButton = nut.Button
      nutPoint = nut.Point
      nutStraightTo = nut.straightTo

      // nut-js ships with a 300ms delay per keystroke and slow mouse travel;
      // tighten both so actions are crisp without outrunning the OS.
      try {
        nutKeyboard.config.autoDelayMs = 15
        nutMouse.config.autoDelayMs = 25
        nutMouse.config.mouseSpeed = 2500
      } catch {
        // Config shape differs across forks — defaults still work, just slower.
      }

      sharp = (await import('sharp')).default

      await checkPermissions()
    } catch (err) {
      permissionsOK = false
      permissionError = `Failed to load computer-use dependencies: ${err?.message ?? String(err)}`
    }
  },

  async execute(toolName, args) {
    const handler = TOOL_MAP[toolName]
    if (!handler) {
      return { success: false, error: `computer-use: unknown tool ${toolName}` }
    }
    return handler(args)
  }
}

export default plugin
