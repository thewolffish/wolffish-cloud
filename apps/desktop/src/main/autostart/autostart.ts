/**
 * Cross-platform "start Wolffish when the machine comes up".
 *
 * Electron's own `app.setLoginItemSettings` is `@platform darwin,win32` — it
 * has never been implemented on Linux (electron/electron#15198), so the app
 * shipped a toggle that silently did nothing there and a status reader that
 * could only ever answer "inactive". This module owns the whole question
 * instead, and reports what is ACTUALLY registered rather than what was asked
 * for, so the UI can show the difference.
 *
 * One axis decides the mechanism now — the platform:
 *
 *   macOS    login item (Electron's own call, made at the call site)
 *   Windows  login item (Electron's own call, made at the call site)
 *   Linux    XDG autostart .desktop — what every other Electron app
 *            hand-rolls, because Electron won't
 *
 * There used to be a second axis: a `headless` service mode (launchd agent,
 * Task Scheduler job, systemd user unit + lingering) for a VPS install with no
 * window, driven by the terminal CLI. Both the CLI and headless boot are gone,
 * so the only thing left to register is a desktop session's autostart. What
 * survives of that mode here is `sweepServiceRegistrations`, which REMOVES the
 * old ones: a launchd agent with `KeepAlive` still relaunches an app whose
 * `--headless` flag no longer means anything.
 */
import { appImageLaunchEnv, stableExecPath } from '@main/autostart/appimage'
import { wlog } from '@main/workspace/logger'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TAG = '[autostart]'

/**
 * Write the entry but never talk to a live service manager.
 *
 * This exists because a test that fakes `os.homedir()` does NOT fake
 * `launchctl`, `systemctl` or `schtasks` — those address the real user domain
 * whatever path you hand them. A platform test wrote a plist into a temp HOME
 * and then bootstrapped it for real, leaving a `KeepAlive: true` agent that
 * relaunched the installed app every time it was quit, and outlived the temp
 * file so nothing on disk explained it. Faking the filesystem is not enough;
 * the shell-outs need their own gate.
 */
const DRY_RUN = process.env.WOLFFISH_AUTOSTART_DRY_RUN === '1'

/** Run a service-manager command, unless this process is in dry-run. */
async function serviceCall(bin: string, args: string[]): Promise<void> {
  if (DRY_RUN) return
  await run(bin, args)
}

export type AutostartMechanism = 'loginItem' | 'xdg' | 'unsupported'

export type AutostartStatus = {
  /** Registered and expected to actually fire. */
  active: boolean
  mechanism: AutostartMechanism
  /** Where the registration lives, for the Preferences row. */
  location: string | null
  /** Registered but NOT going to behave as promised. */
  warning: string | null
}

const IDENTIFIER = 'cloud.wolffi.sh'

/**
 * Artifacts this app registered under FORMER names — the `.dev` launchd
 * label and the pre-rename `wolffish.*` unit/desktop files. Swept on every
 * install so an upgraded machine never keeps two registrations racing to
 * start the app. The personal Wolffish app uses its own identifiers and is
 * never matched by any of these.
 */
const OLD_IDENTIFIERS = ['cloud.wolffish.dev']
const OLD_UNIT_NAMES = ['wolffish.service']
const OLD_DESKTOP_FILES = ['wolffish.desktop']

const UNIT_NAME = 'wfc.service'
const TASK_NAME = 'Wolffish Cloud'
const DESKTOP_FILE = 'wfc.desktop'

async function removeOldRegistrations(): Promise<void> {
  if (process.platform === 'linux') {
    for (const desk of OLD_DESKTOP_FILES) {
      const file = path.join(os.homedir(), '.config', 'autostart', desk)
      if (existsSync(file)) {
        await fs.rm(file, { force: true }).catch(() => undefined)
        wlog.info(TAG, `removed old autostart entry ${desk}`)
      }
    }
  }
}

/**
 * Tear down every SERVICE registration this app ever wrote — the launchd
 * agent, the systemd user unit, the Task Scheduler job — under both the
 * current and the former identifiers.
 *
 * None of these are installed any more: headless mode and the terminal CLI
 * that drove it are gone. But a machine that ran an older build still has
 * them, and they are not inert. The launchd plist carries `KeepAlive`, so it
 * relaunches the app after every quit; the systemd unit passes `--headless`,
 * a flag nothing reads now, so the unit boots a windowed app on a server. Both
 * outlive any uninstall the UI can still offer, which is what makes sweeping
 * them the right thing to do rather than merely tidy.
 *
 * Best-effort throughout: a missing launchctl/systemctl/schtasks is the normal
 * case on most of these platforms, and a failure here must never fail the
 * autostart write it runs beside.
 */
async function sweepServiceRegistrations(): Promise<void> {
  if (process.platform === 'darwin') {
    const uid = String(process.getuid?.() ?? 501)
    for (const id of [IDENTIFIER, ...OLD_IDENTIFIERS]) {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${id}.plist`)
      const loaded = await run('launchctl', ['print', `gui/${uid}/${id}`]).then(
        () => true,
        () => false
      )
      if (!existsSync(plist) && !loaded) continue
      await serviceCall('launchctl', ['bootout', `gui/${uid}/${id}`]).catch(() =>
        serviceCall('launchctl', ['unload', '-w', plist]).catch(() => undefined)
      )
      await fs.rm(plist, { force: true }).catch(() => undefined)
      wlog.info(TAG, `removed launch agent ${id}`)
    }
  } else if (process.platform === 'linux') {
    for (const unit of [UNIT_NAME, ...OLD_UNIT_NAMES]) {
      const file = path.join(os.homedir(), '.config', 'systemd', 'user', unit)
      if (!existsSync(file)) continue
      await serviceCall('systemctl', ['--user', 'disable', '--now', unit]).catch(() => undefined)
      await fs.rm(file, { force: true }).catch(() => undefined)
      await serviceCall('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
      wlog.info(TAG, `removed systemd unit ${unit}`)
    }
  } else if (process.platform === 'win32') {
    if (DRY_RUN) return
    const exists = await run('schtasks', ['/query', '/tn', TASK_NAME]).then(
      () => true,
      () => false
    )
    if (!exists) return
    await serviceCall('schtasks', ['/delete', '/f', '/tn', TASK_NAME]).catch(() => undefined)
    wlog.info(TAG, `removed scheduled task ${TASK_NAME}`)
  }
}

/**
 * `--no-sandbox` on the COMMAND LINE, not just the `app.commandLine` switch
 * main already appends.
 *
 * Chromium refuses to start as root with the sandbox enabled — it aborts with
 * `FATAL: Running as root without --no-sandbox is not supported` from
 * PreSandboxStartup, which runs long before a line of the app's JavaScript is
 * evaluated. So appending the switch from main is too late to be seen by the
 * one check that most needs it. It changes nothing else — this app already
 * runs fully unsandboxed on purpose (see the `no-sandbox` block in main), so
 * putting the same decision in argv only moves it early enough to count.
 */
const NO_SANDBOX = '--no-sandbox'

// ─── Linux: XDG autostart .desktop ──────────────────────────────────────────

function xdgPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'autostart', DESKTOP_FILE)
}

async function installXdg(execPath: string): Promise<AutostartStatus> {
  const file = xdgPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // `Exec=` is a command line, not a shell line, so a NAME=VALUE prefix would be
  // read as the program to run. `env` is the portable way to say the same thing
  // to a session manager. Absent unless this app is itself running unpacked.
  const launchEnv = appImageLaunchEnv()
  const prefix = launchEnv ? `env ${launchEnv} ` : ''
  const body = `[Desktop Entry]
Type=Application
Version=1.0
Name=Wolffish
Comment=Personal AI agent that runs locally with full system access
Exec=${prefix}"${execPath}" ${NO_SANDBOX}
Icon=wfc
Terminal=false
X-GNOME-Autostart-enabled=true
`
  await fs.writeFile(file, body, 'utf8')
  // Some session managers skip entries without the exec bit; the spec doesn't
  // require it but honoring it costs nothing and fixes those.
  await fs.chmod(file, 0o755).catch(() => undefined)
  return xdgStatus()
}

async function uninstallXdg(): Promise<AutostartStatus> {
  await fs.rm(xdgPath(), { force: true })
  return xdgStatus()
}

async function xdgStatus(): Promise<AutostartStatus> {
  const file = xdgPath()
  return {
    active: existsSync(file),
    mechanism: 'xdg',
    location: file,
    warning: null
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/** Which mechanism THIS machine uses. */
export function autostartMechanism(): AutostartMechanism {
  if (process.platform === 'linux') return 'xdg'
  if (process.platform === 'darwin' || process.platform === 'win32') return 'loginItem'
  return 'unsupported'
}

/**
 * Register autostart. `execPath` is the binary a session manager should run —
 * `app.getPath('exe')` from the caller, so this module stays Electron-free and
 * testable under plain node.
 *
 * The loginItem mechanism is NOT handled here: it is Electron's own call and
 * stays at the call site, which keeps this module's shell-out surface honest.
 */
export async function installAutostart(execPath: string): Promise<AutostartStatus> {
  const mechanism = autostartMechanism()
  // The .desktop file below records execPath for a session manager to run at
  // NEXT boot. Under an AppImage the caller's path is a /tmp mount that will
  // not exist by then, so the registration would succeed, report itself
  // healthy, and quietly never start the app again.
  const exec = stableExecPath(execPath)
  await removeOldRegistrations().catch(() => undefined)
  await sweepServiceRegistrations().catch(() => undefined)
  try {
    if (mechanism === 'xdg') return await installXdg(exec)
    return { active: false, mechanism, location: null, warning: null }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `install (${mechanism}) failed: ${detail}`)
    return { active: false, mechanism, location: null, warning: detail }
  }
}

export async function uninstallAutostart(): Promise<AutostartStatus> {
  const mechanism = autostartMechanism()
  await sweepServiceRegistrations().catch(() => undefined)
  try {
    if (mechanism === 'xdg') return await uninstallXdg()
    return { active: false, mechanism, location: null, warning: null }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `uninstall (${mechanism}) failed: ${detail}`)
    return { active: false, mechanism, location: null, warning: detail }
  }
}

/** What is registered right now — never what was asked for. */
export async function autostartStatus(): Promise<AutostartStatus> {
  const mechanism = autostartMechanism()
  try {
    if (mechanism === 'xdg') return await xdgStatus()
    return { active: false, mechanism, location: null, warning: null }
  } catch {
    return { active: false, mechanism, location: null, warning: null }
  }
}
