// mobile-simulators: thin, honest wrappers over `xcrun simctl` / `xcodebuild`
// and `adb`, so a coding turn can build, install, launch, look at and log a
// mobile app without hand-assembling the commands. Screenshots come back as
// pixels (the image_view contract) so a vision model verifies UI changes.
import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

let workspaceRoot = path.join(homedir(), '.wfc', 'workspace')
const IMAGE_MAX_DIMENSION = 1024
const IMAGE_WIRE_CAP_BYTES = 3 * 1024 * 1024
const OUTPUT_TAIL_LINES = 200
const OUTPUT_TAIL_BYTES = 50 * 1024

function run(cmd, args, { cwd, timeout = 60_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, NO_COLOR: '1', ...(env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: -1, out: '', err: err?.message ?? String(err) })
      return
    }
    const chunks = []
    let errText = ''
    let done = false
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // gone
      }
      if (!done) {
        done = true
        resolve({ code: null, out: Buffer.concat(chunks).toString('utf8'), err: `timed out after ${timeout}ms` })
      }
    }, timeout)
    child.stdout.on('data', (c) => chunks.push(c))
    child.stderr.on('data', (c) => {
      chunks.push(c)
      if (errText.length < 20_000) errText += c.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (!done) {
        done = true
        resolve({ code: -1, out: '', err: e?.message ?? String(e) })
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!done) {
        done = true
        resolve({ code, out: Buffer.concat(chunks).toString('utf8'), err: errText })
      }
    })
  })
}

function tail(text, maxLines = OUTPUT_TAIL_LINES, maxBytes = OUTPUT_TAIL_BYTES) {
  const lines = text.split('\n')
  const kept = lines.slice(-maxLines)
  let joined = kept.join('\n')
  while (Buffer.byteLength(joined, 'utf8') > maxBytes && kept.length > 1) {
    kept.shift()
    joined = kept.join('\n')
  }
  return (lines.length > kept.length ? `…(${lines.length - kept.length} earlier lines omitted)\n` : '') + joined
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })))
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

async function listSimulators() {
  const { err, stdout } = await execFileP('xcrun', ['simctl', 'list', 'devices', '--json'])
  if (err) return { error: `xcrun simctl unavailable: ${err.message}` }
  let json
  try {
    json = JSON.parse(stdout)
  } catch {
    return { error: 'could not parse simctl output' }
  }
  const devices = []
  for (const [runtime, list] of Object.entries(json.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue
      devices.push({
        name: d.name,
        udid: d.udid,
        state: d.state,
        runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, '.')
      })
    }
  }
  devices.sort((a, b) => (a.state === 'Booted' ? -1 : b.state === 'Booted' ? 1 : a.name.localeCompare(b.name)))
  return { devices }
}

async function resolveDevice(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || raw === 'booted') return 'booted'
  const { devices, error } = await listSimulators()
  if (error) return raw
  const byUdid = devices.find((d) => d.udid === raw)
  if (byUdid) return byUdid.udid
  const byName = devices.filter((d) => d.name.toLowerCase() === raw.toLowerCase())
  const booted = byName.find((d) => d.state === 'Booted')
  return (booted ?? byName[0])?.udid ?? raw
}

async function simDevices() {
  const parts = []
  const sims = await listSimulators()
  if (sims.error) parts.push(`iOS Simulator: ${sims.error}`)
  else if (sims.devices.length === 0) parts.push('iOS Simulator: no devices available (install a runtime in Xcode > Settings > Components)')
  else {
    const booted = sims.devices.filter((d) => d.state === 'Booted')
    parts.push(`iOS Simulator devices (${sims.devices.length}; ${booted.length} booted):`)
    for (const d of sims.devices.slice(0, 40)) parts.push(`  ${d.state === 'Booted' ? '● ' : '  '}${d.name} — ${d.runtime} — ${d.udid}${d.state === 'Booted' ? ' (booted)' : ''}`)
    if (sims.devices.length > 40) parts.push(`  … and ${sims.devices.length - 40} more`)
  }
  const adb = await execFileP('adb', ['devices', '-l'])
  if (adb.err) parts.push(`Android (adb): not available (${adb.err.code === 'ENOENT' ? 'adb not on PATH' : adb.err.message})`)
  else {
    const rows = adb.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
    parts.push(rows.length ? `Android devices (adb):\n${rows.map((r) => `  ${r}`).join('\n')}` : 'Android (adb): no devices or emulators connected')
  }
  return { success: true, output: parts.join('\n') }
}

async function simBoot(args) {
  let udid = await resolveDevice(args?.device)
  if (udid === 'booted') {
    const { devices, error } = await listSimulators()
    if (error) return { success: false, error }
    const already = devices.find((d) => d.state === 'Booted')
    if (already) {
      await execFileP('open', ['-a', 'Simulator'])
      return { success: true, output: `${already.name} is already booted (${already.udid}).` }
    }
    const pick = devices.find((d) => /iPhone/.test(d.name)) ?? devices[0]
    if (!pick) return { success: false, error: 'No simulator devices available.' }
    udid = pick.udid
  }
  const boot = await execFileP('xcrun', ['simctl', 'boot', udid], { timeout: 90_000 })
  if (boot.err && !/already booted/i.test(boot.stderr)) return { success: false, error: `boot failed: ${(boot.stderr || boot.err.message).trim()}` }
  await execFileP('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 120_000 })
  await execFileP('open', ['-a', 'Simulator'])
  return { success: true, output: `Booted ${udid}. The Simulator window is in front; sim_screenshot shows the screen.` }
}

async function findApp(derived, configuration) {
  const dir = path.join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`)
  try {
    const entries = await readdir(dir)
    const app = entries.find((e) => e.endsWith('.app'))
    return app ? path.join(dir, app) : null
  } catch {
    return null
  }
}

async function simBuild(args) {
  const scheme = typeof args?.scheme === 'string' ? args.scheme.trim() : ''
  if (!scheme) return { success: false, error: 'scheme is required' }
  const workspace = typeof args?.workspace === 'string' && args.workspace ? args.workspace : null
  const project = typeof args?.project === 'string' && args.project ? args.project : null
  if (!workspace && !project) return { success: false, error: 'Pass workspace (.xcworkspace) or project (.xcodeproj).' }
  const device = typeof args?.device === 'string' && args.device ? args.device : 'iPhone 17'
  const configuration = args?.configuration === 'Release' ? 'Release' : 'Debug'
  const derived = path.join(workspaceRoot, 'files', 'derived-data', scheme.replace(/[^a-z0-9_-]/gi, '_'))
  await mkdir(derived, { recursive: true })
  const cwd = path.dirname(workspace ?? project)
  const xargs = [
    ...(workspace ? ['-workspace', workspace] : ['-project', project]),
    '-scheme', scheme,
    '-configuration', configuration,
    '-destination', `platform=iOS Simulator,name=${device}`,
    '-derivedDataPath', derived,
    '-quiet',
    'build'
  ]
  const startedAt = Date.now()
  const result = await run('xcodebuild', xargs, { cwd, timeout: 20 * 60_000 })
  const app = await findApp(derived, configuration)
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  if (result.code !== 0 || !app) {
    return {
      success: false,
      retryable: false,
      error: `xcodebuild ${result.code === null ? 'timed out' : `exited ${result.code}`} after ${seconds}s`,
      output: tail(result.out)
    }
  }
  return {
    success: true,
    output: `Built ${scheme} (${configuration}) for "${device}" in ${seconds}s.\nApp: ${app}\nNext: sim_install app="${app}" then sim_launch bundle_id=<from Info.plist>.\n${tail(result.out, 40)}`,
    meta: { label: 'Build', durationMs: Date.now() - startedAt, exitCode: 0 }
  }
}

async function simInstall(args) {
  const app = typeof args?.app === 'string' ? args.app.trim() : ''
  if (!app) return { success: false, error: 'app path is required' }
  const udid = await resolveDevice(args?.device)
  const r = await execFileP('xcrun', ['simctl', 'install', udid, app], { timeout: 120_000 })
  if (r.err) return { success: false, error: `install failed: ${(r.stderr || r.err.message).trim()}` }
  return { success: true, output: `Installed ${path.basename(app)} on ${udid}.` }
}

async function simLaunch(args) {
  const bundle = typeof args?.bundle_id === 'string' ? args.bundle_id.trim() : ''
  if (!bundle) return { success: false, error: 'bundle_id is required' }
  const udid = await resolveDevice(args?.device)
  await execFileP('xcrun', ['simctl', 'terminate', udid, bundle])
  const r = await execFileP('xcrun', ['simctl', 'launch', udid, bundle], { timeout: 60_000 })
  if (r.err) return { success: false, error: `launch failed: ${(r.stderr || r.err.message).trim()}` }
  return { success: true, output: `${r.stdout.trim() || `Launched ${bundle}`}. sim_screenshot to see it; sim_log process=<app name> for its output.` }
}

async function simTerminate(args) {
  const bundle = typeof args?.bundle_id === 'string' ? args.bundle_id.trim() : ''
  if (!bundle) return { success: false, error: 'bundle_id is required' }
  const udid = await resolveDevice(args?.device)
  const r = await execFileP('xcrun', ['simctl', 'terminate', udid, bundle])
  if (r.err && !/not running|found nothing/i.test(r.stderr)) return { success: false, error: (r.stderr || r.err.message).trim() }
  return { success: true, output: `Terminated ${bundle}.` }
}

async function simOpenUrl(args) {
  const url = typeof args?.url === 'string' ? args.url.trim() : ''
  if (!url) return { success: false, error: 'url is required' }
  const udid = await resolveDevice(args?.device)
  const r = await execFileP('xcrun', ['simctl', 'openurl', udid, url])
  if (r.err) return { success: false, error: (r.stderr || r.err.message).trim() }
  return { success: true, output: `Opened ${url}.` }
}

async function encodeScreenshot(pngPath, maxDimension) {
  const sharp = (await import('sharp')).default
  const meta = await sharp(pngPath).metadata()
  let edge = Number.isFinite(maxDimension) && maxDimension > 0 ? Math.round(maxDimension) : IMAGE_MAX_DIMENSION
  let buffer
  let info
  for (let attempt = 0; attempt < 4; attempt++) {
    const encoded = await sharp(pngPath).resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    buffer = encoded.data
    info = encoded.info
    if (buffer.length <= IMAGE_WIRE_CAP_BYTES) break
    edge = Math.max(256, Math.floor(Math.max(info.width, info.height) * Math.sqrt(IMAGE_WIRE_CAP_BYTES / buffer.length) * 0.9))
  }
  return { buffer, info, original: { width: meta.width ?? 0, height: meta.height ?? 0 } }
}

async function screenshotPath(prefix) {
  const dir = path.join(workspaceRoot, 'files', 'screenshots')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return path.join(dir, `${prefix}-${stamp}.png`)
}

async function simScreenshot(args) {
  const udid = await resolveDevice(args?.device)
  const file = await screenshotPath('sim')
  const r = await execFileP('xcrun', ['simctl', 'io', udid, 'screenshot', file])
  if (r.err) return { success: false, error: `screenshot failed: ${(r.stderr || r.err.message).trim()} (is a device booted? sim_devices)` }
  try {
    const { buffer, info, original } = await encodeScreenshot(file, args?.max_dimension)
    return {
      success: true,
      output: `iOS Simulator screenshot saved to ${file} (screen ${original.width}x${original.height}; sent at ${info.width}x${info.height}). The pixels are attached to this result for THIS turn. To tap or type, use computer-use on the Simulator window.`,
      images: [{ mediaType: 'image/png', data: buffer.toString('base64') }],
      meta: { label: 'Screenshot' }
    }
  } catch (err) {
    return { success: true, output: `Screenshot saved to ${file} (could not attach pixels: ${err?.message ?? err}). View it with image_view.` }
  }
}

async function simLog(args) {
  const proc = typeof args?.process === 'string' ? args.process.trim() : ''
  if (!proc) return { success: false, error: 'process is required (app binary name or bundle id)' }
  const seconds = typeof args?.seconds === 'number' && args.seconds > 0 ? Math.min(3600, Math.round(args.seconds)) : 30
  const udid = await resolveDevice(args?.device)
  const predicate = proc.includes('.') ? `subsystem CONTAINS "${proc}" OR process == "${proc.split('.').pop()}"` : `process == "${proc}"`
  const r = await run('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', `${seconds}s`, '--style', 'compact', '--predicate', predicate], { timeout: 60_000 })
  if (r.code !== 0) return { success: false, error: `log show failed: ${(r.err || r.out).trim().slice(-500)}` }
  const body = r.out.trim()
  return { success: true, output: body ? tail(body) : `No log lines for "${proc}" in the last ${seconds}s.` }
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

function adbArgs(serial, rest) {
  return serial ? ['-s', serial, ...rest] : rest
}

async function adbInstall(args) {
  const apk = typeof args?.apk === 'string' ? args.apk.trim() : ''
  if (!apk) return { success: false, error: 'apk path is required' }
  const r = await execFileP('adb', adbArgs(args?.serial, ['install', '-r', apk]), { timeout: 180_000 })
  if (r.err || /Failure/i.test(r.stdout)) return { success: false, error: (r.stderr || r.stdout || r.err?.message || 'install failed').trim() }
  return { success: true, output: `Installed ${path.basename(apk)}.` }
}

async function adbLaunch(args) {
  const pkg = typeof args?.package === 'string' ? args.package.trim() : ''
  if (!pkg) return { success: false, error: 'package is required' }
  await execFileP('adb', adbArgs(args?.serial, ['shell', 'am', 'force-stop', pkg]))
  const r = await execFileP('adb', adbArgs(args?.serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']))
  if (r.err || /No activities found/i.test(r.stdout + r.stderr)) {
    return { success: false, error: `launch failed for ${pkg}: ${(r.stderr || r.stdout || r.err?.message || '').trim().slice(-300)}` }
  }
  return { success: true, output: `Launched ${pkg}. adb_screenshot to see it; adb_log filter=${pkg} for its output.` }
}

async function adbScreenshot(args) {
  const file = await screenshotPath('android')
  const r = await run('adb', adbArgs(args?.serial, ['exec-out', 'screencap', '-p']), { timeout: 30_000 })
  if (r.code !== 0) return { success: false, error: `screencap failed: ${(r.err || '').trim()} (is a device connected? sim_devices)` }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, Buffer.from(r.out, 'utf8'))
  // run() decoded as utf8 — re-capture as bytes for a faithful PNG.
  const raw = await new Promise((resolve) => {
    const chunks = []
    const child = spawn('adb', adbArgs(args?.serial, ['exec-out', 'screencap', '-p']), { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('close', () => resolve(Buffer.concat(chunks)))
    child.on('error', () => resolve(Buffer.alloc(0)))
  })
  if (raw.length > 0) await writeFile(file, raw)
  try {
    const { buffer, info, original } = await encodeScreenshot(file, args?.max_dimension)
    return {
      success: true,
      output: `Android screenshot saved to ${file} (screen ${original.width}x${original.height}; sent at ${info.width}x${info.height}). adb_tap takes coordinates in the ORIGINAL ${original.width}x${original.height} grid. The pixels are attached for THIS turn.`,
      images: [{ mediaType: 'image/png', data: buffer.toString('base64') }],
      meta: { label: 'Screenshot' }
    }
  } catch (err) {
    return { success: true, output: `Screenshot saved to ${file} (could not attach pixels: ${err?.message ?? err}). View it with image_view.` }
  }
}

async function adbTap(args) {
  const x = Number(args?.x)
  const y = Number(args?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'x and y are required' }
  const r = await execFileP('adb', adbArgs(args?.serial, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]))
  if (r.err) return { success: false, error: (r.stderr || r.err.message).trim() }
  return { success: true, output: `Tapped (${Math.round(x)}, ${Math.round(y)}). adb_screenshot to see the result.` }
}

async function adbText(args) {
  const text = typeof args?.text === 'string' ? args.text : ''
  if (!text) return { success: false, error: 'text is required' }
  // `input text` takes a single argument; spaces become %s.
  const encoded = text.replace(/ /g, '%s')
  const r = await execFileP('adb', adbArgs(args?.serial, ['shell', 'input', 'text', encoded]))
  if (r.err) return { success: false, error: (r.stderr || r.err.message).trim() }
  return { success: true, output: `Typed ${text.length} characters.` }
}

async function adbKey(args) {
  const key = typeof args?.key === 'string' ? args.key.trim().toUpperCase() : ''
  if (!key) return { success: false, error: 'key is required' }
  const code = key.startsWith('KEYCODE_') ? key : `KEYCODE_${key}`
  const r = await execFileP('adb', adbArgs(args?.serial, ['shell', 'input', 'keyevent', code]))
  if (r.err) return { success: false, error: (r.stderr || r.err.message).trim() }
  return { success: true, output: `Pressed ${code}.` }
}

async function adbLog(args) {
  const lines = typeof args?.lines === 'number' && args.lines > 0 ? Math.min(5000, Math.round(args.lines)) : 400
  const filter = typeof args?.filter === 'string' ? args.filter.trim() : ''
  const r = await run('adb', adbArgs(args?.serial, ['logcat', '-d', '-t', String(lines)]), { timeout: 30_000 })
  if (r.code !== 0) return { success: false, error: `logcat failed: ${(r.err || r.out).trim().slice(-300)}` }
  const kept = filter ? r.out.split('\n').filter((l) => l.includes(filter)) : r.out.split('\n')
  const body = kept.join('\n').trim()
  return { success: true, output: body ? tail(body) : `No log lines${filter ? ` matching "${filter}"` : ''} in the last ${lines}.` }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const toolDefinitions = [
  'sim_devices', 'sim_boot', 'sim_build', 'sim_install', 'sim_launch', 'sim_terminate', 'sim_open_url', 'sim_screenshot', 'sim_log',
  'adb_install', 'adb_launch', 'adb_screenshot', 'adb_tap', 'adb_text', 'adb_key', 'adb_log'
].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))

const handlers = {
  sim_devices: simDevices,
  sim_boot: simBoot,
  sim_build: simBuild,
  sim_install: simInstall,
  sim_launch: simLaunch,
  sim_terminate: simTerminate,
  sim_open_url: simOpenUrl,
  sim_screenshot: simScreenshot,
  sim_log: simLog,
  adb_install: adbInstall,
  adb_launch: adbLaunch,
  adb_screenshot: adbScreenshot,
  adb_tap: adbTap,
  adb_text: adbText,
  adb_key: adbKey,
  adb_log: adbLog
}

const plugin = {
  name: 'mobile-simulators',
  tools: toolDefinitions,
  async init(context) {
    if (typeof context?.workspaceRoot === 'string' && context.workspaceRoot) workspaceRoot = context.workspaceRoot
  },
  isReadOnlyCall(toolName) {
    return ['sim_devices', 'sim_screenshot', 'sim_log', 'adb_screenshot', 'adb_log'].includes(toolName)
  },
  describeAction(toolName, args) {
    const labels = {
      sim_boot: 'Boot iOS Simulator',
      sim_build: `Build ${args?.scheme ?? ''} for the Simulator`,
      sim_install: `Install ${args?.app ?? ''}`,
      sim_launch: `Launch ${args?.bundle_id ?? ''}`,
      adb_install: `Install ${args?.apk ?? ''}`,
      adb_launch: `Launch ${args?.package ?? ''}`
    }
    return labels[toolName] ? { title: 'Mobile simulator', description: labels[toolName], risk: 'low' } : null
  },
  async execute(toolName, args) {
    const fn = handlers[toolName]
    if (!fn) return { success: false, error: `mobile-simulators: unknown tool ${toolName}` }
    try {
      return await fn(args ?? {})
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }
}

export default plugin
