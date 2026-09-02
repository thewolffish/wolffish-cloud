import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

// Most of these commands return immediately (they hand off to the OS). Power
// actions may never return because the machine is going down — short timeout +
// optimistic success is the right posture there.
const DEFAULT_TIMEOUT = 15_000

const toolDefinitions = [
  {
    name: 'app_open',
    description:
      'Open (launch) an application by name, optionally with a file or URL to open in it. Use to start an app the user names ("open Spotify", "open Notes").',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Application name, e.g. "Safari", "Visual Studio Code".'
        },
        target: {
          type: 'string',
          description:
            'Optional file path or URL to open with the app (or with the default app if name is omitted).'
        }
      },
      required: []
    }
  },
  {
    name: 'app_quit',
    description:
      'Quit (close) a running application by name. Graceful by default so the app can prompt to save; set force to kill it immediately.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name to quit, e.g. "Spotify".' },
        force: {
          type: 'boolean',
          description:
            'Force-kill instead of asking the app to quit gracefully (may lose unsaved work). Default false.'
        }
      },
      required: []
    }
  },
  {
    name: 'app_list',
    description:
      'List the applications currently open (visible GUI apps). Use before quitting something or to answer "what do I have open?".',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'open_path',
    description:
      "Open a file, folder, or URL with the operating system's default handler (file in its default app, folder in the file manager, URL in the browser). Set reveal to show a file in the file manager instead of opening it.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, ~-path, folder, or URL to open.' },
        reveal: {
          type: 'boolean',
          description:
            'Reveal/highlight the item in the file manager instead of opening it. Default false.'
        }
      },
      required: []
    }
  },
  {
    name: 'system_power',
    description:
      'Control the machine power state: restart, shutdown, sleep, lock, or logout. restart/shutdown/logout require user confirmation and will close apps.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['restart', 'shutdown', 'sleep', 'lock', 'logout'],
          description: 'Which power action to perform.'
        }
      },
      required: ['action']
    }
  }
]

// ---------------------------------------------------------------------------
// Small exec helper
// ---------------------------------------------------------------------------

async function run(cmd, args, opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: DEFAULT_TIMEOUT, ...opts })
  return (stdout ?? '').toString().trim()
}

function fail(message) {
  return { success: false, error: message }
}

function expandHome(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function isUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(www\.|mailto:)/i.test(s)
}

// AppleScript string-literal escaping for names embedded in osascript.
function osaStr(s) {
  return s.replace(/[\\"]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// app_open
// ---------------------------------------------------------------------------

async function appOpen(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  const target = typeof args?.target === 'string' ? args.target.trim() : ''
  if (!name && !target) return fail('app_open: provide a name (and/or a target file or URL).')

  const resolvedTarget = target && !isUrl(target) ? expandHome(target) : target
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      if (name && resolvedTarget) await run('open', ['-a', name, resolvedTarget])
      else if (name) await run('open', ['-a', name])
      else await run('open', [resolvedTarget])
    } else if (platform === 'win32') {
      const ps = name
        ? resolvedTarget
          ? `Start-Process -FilePath ${psQuote(name)} -ArgumentList ${psQuote(resolvedTarget)}`
          : `Start-Process -FilePath ${psQuote(name)}`
        : `Start-Process ${psQuote(resolvedTarget)}`
      await run('powershell', ['-NoProfile', '-Command', ps])
    } else {
      // linux best-effort: app via gtk-launch, target via xdg-open
      if (name) {
        try {
          await run('gtk-launch', [name])
        } catch {
          await run('nohup', [name], { detached: true }).catch(() => {})
        }
        if (resolvedTarget) await run('xdg-open', [resolvedTarget]).catch(() => {})
      } else {
        await run('xdg-open', [resolvedTarget])
      }
    }
  } catch (err) {
    return fail(`app_open failed: ${errText(err)}`)
  }

  const what = name || resolvedTarget
  const withTarget = name && resolvedTarget ? ` with ${resolvedTarget}` : ''
  return { success: true, output: `Opened ${what}${withTarget}.` }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ---------------------------------------------------------------------------
// app_quit
// ---------------------------------------------------------------------------

async function appQuit(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  const force = args?.force === true
  if (!name) return fail('app_quit: provide the application name to quit.')

  const platform = process.platform
  try {
    if (platform === 'darwin') {
      if (force) await run('killall', [name])
      else
        // Guard with `is not running` (as its own statement — AppleScript can't
        // do a single-line if/then/else here) so a graceful quit of a
        // non-running/unknown app reports failure instead of silently
        // launching-then-quitting it.
        await run('osascript', [
          '-e',
          `if application "${osaStr(name)}" is not running then error "${osaStr(name)} is not running"`,
          '-e',
          `tell application "${osaStr(name)}" to quit`
        ])
    } else if (platform === 'win32') {
      const image = /\.exe$/i.test(name) ? name : `${name}.exe`
      const a = force ? ['/F', '/IM', image] : ['/IM', image]
      await run('taskkill', a)
    } else {
      await run('pkill', force ? ['-9', '-f', name] : ['-f', name])
    }
  } catch (err) {
    return fail(`app_quit failed (is "${name}" running and spelled correctly?): ${errText(err)}`)
  }
  return { success: true, output: `${force ? 'Force-quit' : 'Quit'} ${name}.` }
}

// ---------------------------------------------------------------------------
// app_list
// ---------------------------------------------------------------------------

async function appList() {
  const platform = process.platform
  try {
    let names = []
    if (platform === 'darwin') {
      const out = await run('osascript', [
        '-e',
        'tell application "System Events" to get name of (every process whose background only is false)'
      ])
      names = out
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (platform === 'win32') {
      const out = await run('powershell', [
        '-NoProfile',
        '-Command',
        'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName -Unique'
      ])
      names = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      const out = await run('wmctrl', ['-l']).catch(() => '')
      names = out
        .split(/\r?\n/)
        .map((l) => l.split(/\s+/).slice(3).join(' ').trim())
        .filter(Boolean)
    }
    names = [...new Set(names)].sort((a, b) => a.localeCompare(b))
    if (names.length === 0) return { success: true, output: 'No foreground applications detected.' }
    return {
      success: true,
      output: `## Open applications (${names.length})\n\n${names.map((n) => `- ${n}`).join('\n')}`
    }
  } catch (err) {
    return fail(`app_list failed: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// open_path
// ---------------------------------------------------------------------------

async function openPath(args) {
  const raw = typeof args?.path === 'string' ? args.path.trim() : ''
  const reveal = args?.reveal === true
  if (!raw) return fail('open_path: provide a path or URL.')
  const target = isUrl(raw) ? raw : expandHome(raw)
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      await run('open', reveal && !isUrl(raw) ? ['-R', target] : [target])
    } else if (platform === 'win32') {
      if (reveal && !isUrl(raw)) await run('explorer', [`/select,${target}`])
      else await run('cmd', ['/c', 'start', '', target])
    } else {
      const toOpen = reveal && !isUrl(raw) ? path.dirname(target) : target
      await run('xdg-open', [toOpen])
    }
  } catch (err) {
    return fail(`open_path failed: ${errText(err)}`)
  }
  return { success: true, output: `${reveal ? 'Revealed' : 'Opened'} ${target}.` }
}

// ---------------------------------------------------------------------------
// system_power
// ---------------------------------------------------------------------------

// Resolve the concrete command per platform/action. Shared by execute() and
// describeAction() so the approval card shows exactly what will run.
function powerCommand(action) {
  const p = process.platform
  if (p === 'darwin') {
    switch (action) {
      case 'restart':
        return { cmd: 'osascript', args: ['-e', 'tell app "System Events" to restart'] }
      case 'shutdown':
        return { cmd: 'osascript', args: ['-e', 'tell app "System Events" to shut down'] }
      case 'logout':
        return { cmd: 'osascript', args: ['-e', 'tell app "System Events" to log out'] }
      case 'sleep':
        return { cmd: 'pmset', args: ['sleepnow'] }
      case 'lock':
        return {
          cmd: 'osascript',
          args: [
            '-e',
            'tell application "System Events" to keystroke "q" using {control down, command down}'
          ]
        }
    }
  } else if (p === 'win32') {
    switch (action) {
      case 'restart':
        return { cmd: 'shutdown', args: ['/r', '/t', '0'] }
      case 'shutdown':
        return { cmd: 'shutdown', args: ['/s', '/t', '0'] }
      case 'logout':
        return { cmd: 'shutdown', args: ['/l'] }
      case 'sleep':
        return { cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] }
      case 'lock':
        return { cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] }
    }
  } else {
    switch (action) {
      case 'restart':
        return { cmd: 'systemctl', args: ['reboot'] }
      case 'shutdown':
        return { cmd: 'systemctl', args: ['poweroff'] }
      case 'logout':
        return { cmd: 'loginctl', args: ['terminate-user', os.userInfo().username] }
      case 'sleep':
        return { cmd: 'systemctl', args: ['suspend'] }
      case 'lock':
        return { cmd: 'loginctl', args: ['lock-session'] }
    }
  }
  return null
}

const POWER_VERB = {
  restart: 'Restarting',
  shutdown: 'Shutting down',
  sleep: 'Putting to sleep',
  lock: 'Locking',
  logout: 'Logging out'
}

// Imperative titles for the approval card (reads better than the -ing verb).
const POWER_TITLE = {
  restart: 'Restart this machine',
  shutdown: 'Shut down this machine',
  sleep: 'Sleep this machine',
  lock: 'Lock this machine',
  logout: 'Log out of this machine'
}

async function systemPower(args) {
  const action = typeof args?.action === 'string' ? args.action.toLowerCase() : ''
  if (!POWER_VERB[action]) {
    return fail(`system_power: action must be one of restart, shutdown, sleep, lock, logout.`)
  }
  const resolved = powerCommand(action)
  if (!resolved) return fail(`system_power: ${action} is not supported on ${process.platform}.`)

  try {
    // Short timeout: restart/shutdown may never return because we're going
    // down — that's success, not failure.
    await run(resolved.cmd, resolved.args, { timeout: 6000 })
  } catch (err) {
    if (!isGoingDownError(err, action)) {
      return fail(`system_power ${action} failed: ${errText(err)}`)
    }
  }
  return { success: true, output: `${POWER_VERB[action]} the machine now.` }
}

function isGoingDownError(err, action) {
  // A killed/timed-out process on a restart/shutdown is the machine winning the
  // race — treat as success.
  return (
    (action === 'restart' || action === 'shutdown' || action === 'logout') &&
    (err?.killed || err?.signal === 'SIGTERM' || /timed out|ETIMEDOUT/i.test(errText(err)))
  )
}

// ---------------------------------------------------------------------------
// Approval card text for the gated actions
// ---------------------------------------------------------------------------

function describeAction(toolName, args) {
  if (toolName === 'system_power') {
    const action = typeof args?.action === 'string' ? args.action.toLowerCase() : ''
    const resolved = powerCommand(action)
    const command = resolved ? `${resolved.cmd} ${resolved.args.join(' ')}` : undefined
    const destructive = action === 'restart' || action === 'shutdown' || action === 'logout'
    const machine = process.platform === 'darwin' ? 'Mac' : 'machine'
    return {
      title: (POWER_TITLE[action] ?? 'Power action').replace('this machine', `this ${machine}`),
      description: `Run a ${action} on the local machine.`,
      command,
      impact: destructive
        ? 'All open apps will close. Unsaved work may be lost.'
        : 'Reversible — the machine can be woken/unlocked normally.',
      risk: destructive ? 'high' : 'low'
    }
  }
  if (toolName === 'app_quit' && args?.force === true) {
    const name = typeof args?.name === 'string' ? args.name : 'the app'
    return {
      title: `Force-quit ${name}`,
      description: `Immediately kill ${name} without letting it save.`,
      impact: 'Unsaved work in that app may be lost.',
      risk: 'medium'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function errText(err) {
  if (!err) return 'unknown error'
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : ''
  if (stderr) return stderr.split(/\r?\n/)[0]
  return err.message ? String(err.message).split(/\r?\n/)[0] : String(err)
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'system',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'app_open':
        return appOpen(args ?? {})
      case 'app_quit':
        return appQuit(args ?? {})
      case 'app_list':
        return appList()
      case 'open_path':
        return openPath(args ?? {})
      case 'system_power':
        return systemPower(args ?? {})
      default:
        return { success: false, error: `system: unknown tool ${toolName}` }
    }
  }
}

export default plugin
