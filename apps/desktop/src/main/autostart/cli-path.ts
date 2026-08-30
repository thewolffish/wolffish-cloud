/**
 * Making `wolffish` a command the shell can find, on all three platforms.
 *
 * This is the single most consequential piece of the CLI: everything else is
 * unreachable if the shell can't resolve the name, and the failure looks like
 * "wolffish: command not found" rather than anything that points at a fix. So
 * the app reports the state honestly (installed / missing / shadowed by
 * something else) and offers to install it, instead of assuming the packaging
 * did it.
 *
 * The entry point is a SHIM, never the app binary itself, for two reasons:
 *
 *  - On Windows the packaged executable is GUI-subsystem, so a console that
 *    starts it hands it no usable stdout and everything it prints is lost. A
 *    `.cmd` does NOT fix that — cmd.exe being console-subsystem says nothing
 *    about the child it launches, and believing otherwise is what shipped a
 *    `wolffish` that answered every command with a blank line. The shim
 *    delegates to `wolffish-cli.exe`, which is console-subsystem and passes its
 *    own handles down explicitly. See build/win-cli-launcher/wolffish-cli.cs.
 *  - Booting ~150 MB of Electron to run `wolffish ls` is absurd. The shim
 *    execs the client under `ELECTRON_RUN_AS_NODE=1`, which turns the same
 *    binary you already ship into a plain node — no second runtime to install,
 *    and no window machinery on a list command.
 *
 * On Linux the `.deb`/`.rpm` postinst runs `update-alternatives --install` for
 * the app binary — but under electron-builder that is named after
 * package.json#name, so what appears is `/usr/bin/wolffish-app`, NOT
 * `/usr/bin/wolffish`. The name this shim wants is free on a freshly installed
 * machine, and until the app has booted once there is no `wolffish` at all:
 * the installer has to name `wolffish-app` for the first launch, because it is
 * the only command that exists yet.
 */
import { appImageLaunchEnv, stableCliEntry, stableExecPath } from '@main/autostart/appimage'
import { wlog } from '@main/workspace/logger'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TAG = '[cli-path]'

export type CliPathStatus = {
  /** `wolffish` resolves on PATH and points at our shim. */
  installed: boolean
  /**
   * Our shim FILE exists, whether or not the shell can find it.
   *
   * Not the same question as `installed`, and the difference is what a Remove
   * control has to gate on: a shim written into a directory that is not on
   * PATH, or one shadowed by another binary, reports `installed: false` while
   * very much still being a file this app put there. Gating removal on
   * `installed` hid the button in exactly the cases someone wants it.
   */
  present: boolean
  /** Where the shim is (or would be) written. */
  target: string
  /** What `which wolffish` actually answers, when anything does. */
  resolved: string | null
  /**
   * The shim's directory is not on PATH, so writing it changed nothing the
   * shell can see. Carries the line to add to the profile.
   */
  needsPathEntry: boolean
  /** Shell snippet that fixes `needsPathEntry`, or null. */
  profileHint: string | null
  /** Something else already owns the name — usually a stale symlink. */
  shadowedBy: string | null
  /** Populated when install failed; surfaced verbatim as an alert. */
  error: string | null
}

/**
 * Where the shim goes: `~/.wolffish/bin`, the app's own managed bin directory
 * — the same one that already holds `gog`, `ffmpeg` and the voice engines.
 *
 * It used to be `~/.local/bin` on POSIX, chosen because that is the XDG
 * convention and is usually already on PATH. Two things were wrong with that.
 * It broke the project's own hard rule — *uninstall must be `rm -rf
 * ~/.wolffish/`* — by leaving an executable behind that pointed at a deleted
 * app. And the convenience it bought was not real: `~/.local/bin` is NOT in
 * macOS's default PATH (`/etc/paths` lists only /usr/local/bin and the system
 * dirs), so two of three platforms needed a profile line anyway. Windows was
 * already writing here, so the old split was also internally inconsistent.
 *
 * Needs no privilege on any platform, and it is one directory to add to PATH
 * for every wolffish-managed binary rather than one per tool.
 */
export function shimDir(): string {
  return path.join(os.homedir(), '.wolffish', 'bin')
}

export function shimPath(): string {
  return path.join(shimDir(), process.platform === 'win32' ? 'wolffish.cmd' : 'wolffish')
}

/**
 * The pre-`~/.wolffish/bin` location. Swept on install so an upgraded machine
 * does not keep a stale shim that is EARLIER on PATH than the new one — it
 * would keep winning `command -v` and silently run the old target forever.
 * Only removed when it is recognisably ours.
 */
function legacyShimPath(): string | null {
  if (process.platform === 'win32') return null
  return path.join(os.homedir(), '.local', 'bin', 'wolffish')
}

async function removeLegacyShim(): Promise<void> {
  const legacy = legacyShimPath()
  if (!legacy || !existsSync(legacy)) return
  try {
    const body = await fs.readFile(legacy, 'utf8')
    // Never delete a file we did not write. The generated banner is the
    // signature; anything else at that path belongs to the user.
    if (!body.includes('Wolffish CLI launcher')) return
    await fs.rm(legacy, { force: true })
    wlog.info(TAG, `removed legacy shim ${legacy}`)
  } catch {
    // unreadable or already gone — nothing to clean
  }
}

/**
 * The client entry the shim runs. Packaged, it rides `extraResources`; in dev
 * it is read straight out of the source tree so `npm run dev` has a working
 * `wolffish` too.
 */
export function cliEntryPath(isDev: boolean, appPath: string, resourcesPath: string): string {
  return isDev
    ? path.join(appPath, 'src', 'cli', 'wolffish.mjs')
    : path.join(resourcesPath, 'cli', 'wolffish.mjs')
}

/** A NAME=VALUE as a shell command prefix, or nothing at all. */
function prefixed(env: string | null): string {
  return env ? `${env} ` : ''
}

function posixShim(execPath: string, entry: string): string {
  return `#!/bin/sh
# Wolffish CLI launcher — generated by the app, safe to regenerate.
# ELECTRON_RUN_AS_NODE turns the shipped Electron binary into a plain node,
# so the CLI needs no separate runtime and no window ever opens.
${prefixed(appImageLaunchEnv())}ELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${entry}" "$@"
`
}

/** The console-subsystem launcher, shipped beside the app binary. */
function launcherPath(execPath: string): string {
  return path.join(path.dirname(execPath), 'wolffish-cli.exe')
}

/**
 * The SECOND Windows shim, for Git Bash.
 *
 * A lot of Windows developers live in Git Bash, and it does not resolve
 * commands the way cmd does: PATHEXT is a cmd.exe convention, so bash looking
 * for `wolffish` never considers `wolffish.cmd` and reports "command not
 * found" with the directory sitting right there on PATH. MSYS does append
 * `.exe` on its own — but not `.cmd`, and not `.bat`.
 *
 * So Windows gets both files in the same directory. cmd and PowerShell resolve
 * `wolffish.cmd` through PATHEXT and never see this one (an extensionless file
 * is not executable to them); bash finds this one and never sees the `.cmd`.
 * Neither shell is aware of the other's shim.
 */
function bashShimPath(): string | null {
  if (process.platform !== 'win32') return null
  return path.join(shimDir(), 'wolffish')
}

/** Windows path as MSYS wants it — backslashes are escapes in a shell string. */
function toPosixPath(target: string): string {
  return target.replace(/\\/g, '/')
}

function gitBashShim(execPath: string, entry: string): string {
  const head = `#!/bin/sh
# Wolffish CLI launcher — generated by the app, safe to regenerate.
# This is the Git Bash half of the Windows CLI; cmd.exe uses wolffish.cmd
# beside it. See src/main/autostart/cli-path.ts.
`
  const launcher = launcherPath(execPath)
  if (!existsSync(launcher)) {
    // Dev tree, or a build from before the launcher existed. Best effort: this
    // prints nothing when stdout is a live console, but redirects and pipes
    // still work, which is what a dev loop uses.
    return `${head}${prefixed(appImageLaunchEnv())}ELECTRON_RUN_AS_NODE=1 exec "${toPosixPath(execPath)}" "${toPosixPath(entry)}" "$@"
`
  }

  // winpty, but only for an interactive run.
  //
  // Git Bash's default terminal is mintty, which is NOT a Windows console — it
  // is a pty proxied over pipes. The launcher needs a real console to hand the
  // GUI-subsystem child, and with mintty there is none: it would fall back to
  // pipe passthrough, which costs colour, width, and the session prompt. winpty
  // ships with Git for Windows precisely to bridge this, and allocates the
  // hidden console the launcher then works with.
  //
  // Gated on stdin AND stdout both being terminals so it never touches a
  // redirect or a pipe — `wolffish -p ... | grep` and `cat log | wolffish` must
  // keep their real handles, and winpty in that path would corrupt them.
  return `${head}WOLFFISH_LAUNCHER='${toPosixPath(launcher)}'
if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1; then
  exec winpty "$WOLFFISH_LAUNCHER" "$@"
fi
exec "$WOLFFISH_LAUNCHER" "$@"
`
}

function windowsShim(execPath: string, entry: string): string {
  // Plain ASCII on purpose: a .cmd is read by cmd.exe under whatever codepage
  // the console happens to be on, and a stray em dash would render as mojibake.
  const head =
    '@echo off\r\nrem Wolffish CLI launcher - generated by the app, safe to regenerate.\r\n'

  // Hand off to the console-subsystem launcher when it is there. Running the
  // app binary from a .cmd directly is what made `wolffish` print NOTHING: it
  // is GUI-subsystem, so an unredirected cmd.exe gives it no usable stdout and
  // the output goes nowhere. See build/win-cli-launcher/wolffish-cli.cs.
  const launcher = launcherPath(execPath)
  if (existsSync(launcher)) {
    return `${head}"${launcher}" %*\r\nexit /b %ERRORLEVEL%\r\n`
  }

  // No launcher: a dev tree (`npm run dev` runs electron out of node_modules,
  // where nothing was ever built) or a packaged build from before it existed.
  // Redirected and piped invocations still work in this form, which is what
  // the dev loop actually uses — better than refusing to write a shim at all.
  return `${head}setlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`
}

/** cmd.exe's executable extensions, in the order it tries them. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Windows' answer to `command -v`, walked by hand rather than shelled out to
 * `where`.
 *
 * `where.exe` searches the CURRENT DIRECTORY before it searches PATH. The app's
 * shortcut sets its working directory to the install root, and the packaged
 * binary living there is called `wolffish.exe` — so `where wolffish` answered
 * with the 200 MB GUI app, `isWolffishCli` refused to read something that size,
 * and every Windows machine was told a stranger had taken the name. The shim
 * was on PATH and working the entire time. POSIX never saw it because
 * `command -v` does not consult the cwd and the packaged binary there is named
 * `wolffish-app`.
 *
 * Walking PATH ourselves also lets the CALLER's PATH decide, which is the same
 * correction `onPath` makes and for the same reason: a terminal that launched
 * after the installer's PATH broadcast knows something this long-running
 * process's frozen environment block does not.
 */
function whichOnWindows(callerPath?: string | null): string | null {
  const dirs = (callerPath ?? process.env.PATH ?? '').split(';').filter(Boolean)
  const exts = (process.env.PATHEXT || DEFAULT_PATHEXT).split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      // PATHEXT is conventionally uppercase and the filesystem does not care,
      // so the name that MATCHED is not necessarily the name on disk. This path
      // gets printed at the user, so hand back the real one.
      const candidate = path.join(dir, `wolffish${ext}`)
      if (existsSync(candidate)) return onDiskName(dir, `wolffish${ext}`)
    }
  }
  return null
}

/** `dir/name` with the casing the directory actually uses. */
function onDiskName(dir: string, name: string): string {
  try {
    const actual = readdirSync(dir).find((entry) => entry.toLowerCase() === name.toLowerCase())
    return path.join(dir, actual ?? name)
  } catch {
    return path.join(dir, name)
  }
}

/** What `wolffish` resolves to right now, if anything. */
async function whichWolffish(callerPath?: string | null): Promise<string | null> {
  try {
    if (process.platform === 'win32') return whichOnWindows(callerPath)
    const { stdout } = await run('sh', ['-lc', 'command -v wolffish'])
    const line = stdout.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/**
 * Compare two paths the way the HOST does. Windows filesystems are
 * case-insensitive and its PATH separator is `;`; Linux is case-SENSITIVE, so
 * folding case there would call `/home/Ann/bin` a match for `/home/ann/bin`
 * and report a command as findable when the shell cannot find it. macOS is
 * usually case-insensitive but can be formatted either way — comparing
 * exactly is the safe direction, since a false "not installed" only offers a
 * reinstall that is already idempotent.
 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * True when `dir` is on a PATH — the CALLER's when it sends one, this
 * process's otherwise.
 *
 * The distinction is the whole point. This runs in the daemon, and a daemon
 * started by systemd or launchd inherits a minimal PATH that has nothing to do
 * with the user's shell. Reading its own environment therefore reported "on
 * PATH: no" on every service-managed install — a confident wrong answer that
 * sent people to reinstall a shim that was already working — and reported
 * "yes" for a desktop launch that happened to inherit a login shell. The
 * terminal knows the answer for certain, because it IS the shell; it just had
 * no way to say so.
 */
function onPath(dir: string, callerPath?: string | null): boolean {
  const sep = process.platform === 'win32' ? ';' : ':'
  const entries = (callerPath ?? process.env.PATH ?? '').split(sep).filter(Boolean)
  return entries.some((entry) => samePath(entry, dir))
}

/**
 * The one line that fixes a missing PATH entry, for the shell the user is
 * actually in. `$HOME`-relative rather than expanded: this gets pasted into a
 * profile that may be synced between machines with different usernames.
 *
 * The same directory carries `gog`, `ffmpeg` and the voice engines, so adding
 * it once covers every wolffish-managed binary — and google.ts already writes
 * this exact export when it installs gogcli, which is why the hint matches its
 * wording instead of inventing a second convention.
 */
function profileHintFor(dir: string): string {
  const home = os.homedir()
  const portable = dir.startsWith(home) ? dir.replace(home, '$HOME') : dir
  if (process.platform === 'win32') {
    return `setx PATH "%PATH%;%USERPROFILE%\\.wolffish\\bin"`
  }
  const shell = path.basename(process.env.SHELL ?? 'bash')
  if (shell === 'fish') return `fish_add_path ${dir}`
  const rc = shell === 'zsh' ? '~/.zshrc' : '~/.bashrc'
  return `echo 'export PATH="${portable}:$PATH"' >> ${rc}`
}

/**
 * Is the file `wolffish` resolves to one of ours?
 *
 * Both launchers carry the same banner — the shim this module writes, and the
 * `/usr/bin/wolffish` the .deb and .rpm ship — so one read answers it. The size
 * guard is not a micro-optimization: `resolved` is whatever happens to own that
 * name on this machine, and reading an arbitrary binary in as a UTF-8 string
 * would mean a several-hundred-megabyte allocation on every status check.
 */
async function isWolffishCli(file: string): Promise<boolean> {
  try {
    const { size } = await fs.stat(file)
    if (size > 8192) return false
    return (await fs.readFile(file, 'utf8')).includes('Wolffish CLI launcher')
  } catch {
    return false
  }
}

export async function cliPathStatus(callerPath?: string | null): Promise<CliPathStatus> {
  const target = shimPath()
  const dir = shimDir()
  const present = existsSync(target)
  const resolved = await whichWolffish(callerPath)
  const dirOnPath = onPath(dir, callerPath)

  // Resolving to something that is NOT our shim is the confusing case: the
  // command "works" and does the wrong thing. On Linux that is usually the
  // package's own /usr/bin/wolffish-app symlink to the GUI binary, which will
  // open a window instead of a prompt.
  //
  // The exception is the package's `/usr/bin/wolffish`, which IS this client —
  // installed system-wide so the command works before the app has ever run.
  // Reporting that as a conflict, and telling the user to fix a PATH that needs
  // no fixing, is crying wolf about the thing working exactly as designed.
  const elsewhere = resolved !== null && !samePath(resolved, target)
  const packaged = elsewhere && (await isWolffishCli(resolved as string))
  const resolvedElsewhere = elsewhere && !packaged

  return {
    installed: packaged || (present && dirOnPath && !resolvedElsewhere),
    present,
    target,
    resolved,
    needsPathEntry: !packaged && present && !dirOnPath,
    profileHint: packaged || dirOnPath ? null : profileHintFor(dir),
    shadowedBy: resolvedElsewhere ? resolved : null,
    error: null
  }
}

/**
 * Write (or rewrite) the shim. Idempotent — running it after an app update is
 * the intended way to re-point it at the new binary.
 */
export async function installCliPath(execPath: string, entry: string): Promise<CliPathStatus> {
  const target = shimPath()
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Both paths, not just the binary: under an AppImage the caller's execPath
    // and entry are inside a mount that dies with this process, and a shim is
    // read long after. No-ops for every other kind of install.
    const [exec, cli] = [stableExecPath(execPath), await stableCliEntry(entry)]
    const body = process.platform === 'win32' ? windowsShim(exec, cli) : posixShim(exec, cli)
    await fs.writeFile(target, body, 'utf8')
    if (process.platform !== 'win32') await fs.chmod(target, 0o755)

    // Windows gets a second, extensionless shim so Git Bash can find the
    // command at all. Written with LF and a `#!` line: MSYS decides a file is
    // executable by that magic, not by a mode bit NTFS does not really have.
    const bashShim = bashShimPath()
    if (bashShim) await fs.writeFile(bashShim, gitBashShim(exec, cli), 'utf8')

    await removeLegacyShim()
    wlog.info(TAG, `installed ${target}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `install failed: ${detail}`)
    return { ...(await cliPathStatus()), error: detail }
  }
  return cliPathStatus()
}

export async function uninstallCliPath(): Promise<CliPathStatus> {
  await fs.rm(shimPath(), { force: true }).catch(() => undefined)
  // Both, or Remove leaves the command still working in Git Bash and only
  // appears to have done nothing.
  const bashShim = bashShimPath()
  if (bashShim) await fs.rm(bashShim, { force: true }).catch(() => undefined)
  return cliPathStatus()
}
