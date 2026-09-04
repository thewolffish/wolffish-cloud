/**
 * Autostart behaviour on all three platforms, from one machine.
 *
 * The interesting failures here are platform-shaped and none of them throw:
 * a mechanism chosen for the wrong OS, an entry a session manager will not
 * parse, a path that expires before the thing that reads it. So this exercises
 * the real module with `process.platform` and `os.homedir()` swapped, writes
 * into a temp HOME, and asserts on the ARTIFACTS — the exact bytes a session
 * manager will read.
 *
 * Runs with WOLFFISH_AUTOSTART_DRY_RUN=1, so it writes files and never invokes
 * a service manager. Faking os.homedir() is not enough on its own: launchctl,
 * systemctl and schtasks address the REAL user domain whatever path you hand
 * them, so without the flag this test registers things on the machine running
 * it. It did once — bootstrapping a KeepAlive LaunchAgent into the live user
 * domain from a temp HOME, which then relaunched the installed app on every
 * quit and outlived the temp plist, so nothing on disk explained the
 * behaviour. That leak is also why `sweepServiceRegistrations` exists, and why
 * it is asserted below.
 *
 * What it cannot cover, and what still needs a real box: whether a session
 * manager honours the .desktop entry, and whether launchctl/systemctl really
 * tear down a registration this only proves is deleted from disk.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/__tests__/autostart-platforms.test.ts
 */
// Set BEFORE the module loads: the flag is read at import time.
process.env.WOLFFISH_AUTOSTART_DRY_RUN = '1'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Swap process.platform + os.homedir for the duration of one case.
 *
 * AWAITS the callback. An earlier version restored the platform in a
 * synchronous `finally`, which returned the real platform the moment the
 * subject hit its first `await` — so any code that re-read `process.platform`
 * after an await saw darwin regardless of what the case asked for. A harness
 * that silently tests the wrong thing is worse than no harness.
 */
async function asPlatform<T>(
  platform: NodeJS.Platform,
  home: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalHome = os.homedir
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  ;(os as { homedir: () => string }).homedir = () => home
  try {
    return await fn()
  } finally {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    ;(os as { homedir: () => string }).homedir = originalHome
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-autostart-'))

async function main(): Promise<void> {
  const autostart = await import('@main/autostart/autostart')

  // ── mechanism dispatch ────────────────────────────────────────────────────
  // macOS/Windows stay on Electron's login item — the behaviour that already
  // ships and is known to work. Linux is the only platform this module writes
  // a file for, because setLoginItemSettings has never done anything there.
  const matrix: Array<[NodeJS.Platform, string]> = [
    ['darwin', 'loginItem'],
    ['win32', 'loginItem'],
    ['linux', 'xdg']
  ]
  for (const [platform, expected] of matrix) {
    const actual = await asPlatform(platform, TMP, () => autostart.autostartMechanism())
    check(`${platform} → ${expected}`, () => assert.equal(actual, expected))
  }

  // DISPLAY is a property of THIS PROCESS's environment, not of the machine: a
  // desktop app relaunched from a bare SSH shell or a cron job has none. The
  // mechanism must not depend on it, or such a relaunch would orphan the
  // registration it wrote last time and install a different one.
  const savedDisplay = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY }
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  const blind = await asPlatform('linux', TMP, () => autostart.autostartMechanism())
  if (savedDisplay.d !== undefined) process.env.DISPLAY = savedDisplay.d
  if (savedDisplay.w !== undefined) process.env.WAYLAND_DISPLAY = savedDisplay.w
  check('a missing DISPLAY does not change the linux mechanism', () => {
    assert.equal(blind, 'xdg')
  })

  // ── Linux: the XDG autostart entry ────────────────────────────────────────
  const linuxHome = path.join(TMP, 'linux')
  fs.mkdirSync(linuxHome, { recursive: true })
  // Faking os.homedir() is not enough here: xdgPath() reads XDG_CONFIG_HOME
  // first, so on a machine that sets one this case would assert against a file
  // that was never written — and would write a real autostart entry into the
  // developer's own session.
  const savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  await asPlatform('linux', linuxHome, () => autostart.installAutostart('/opt/Wolffish/wfc'))

  const desktopFile = path.join(linuxHome, '.config', 'autostart', 'wfc.desktop')
  check('linux: writes ~/.config/autostart/wfc.desktop', () => {
    assert.ok(fs.existsSync(desktopFile), `${desktopFile} missing`)
  })
  check('linux: entry is a valid Desktop Entry', () => {
    const body = fs.readFileSync(desktopFile, 'utf8')
    assert.ok(body.startsWith('[Desktop Entry]'), 'must start with the group header')
    for (const key of ['Type=Application', 'Exec=', 'Name=Wolffish', 'Terminal=false']) {
      assert.ok(body.includes(key), `missing ${key}`)
    }
    // GNOME skips entries without this; KDE ignores it. Harmless either way.
    assert.ok(body.includes('X-GNOME-Autostart-enabled=true'))
  })
  check('linux: the entry launches unsandboxed, so root can use it too', () => {
    const body = fs.readFileSync(desktopFile, 'utf8')
    const exec = body.split('\n').find((line) => line.startsWith('Exec='))
    assert.ok(exec?.includes('--no-sandbox'), `root would abort before startup: ${exec}`)
  })
  check('linux: entry is executable (some sessions require it)', () => {
    assert.ok((fs.statSync(desktopFile).mode & 0o111) !== 0, 'exec bit not set')
  })
  check('linux: autostart writes nothing outside ~/.config', () => {
    const stray = fs.readdirSync(linuxHome).filter((entry) => entry !== '.config')
    assert.deepEqual(stray, [], `wrote outside the footprint: ${stray.join(', ')}`)
  })

  const afterInstall = await asPlatform('linux', linuxHome, () => autostart.autostartStatus())
  check('linux: status reports the written entry as active', () => {
    assert.equal(afterInstall.active, true)
    assert.equal(afterInstall.mechanism, 'xdg')
    assert.equal(afterInstall.location, desktopFile)
  })

  await asPlatform('linux', linuxHome, () => autostart.uninstallAutostart())
  // Restored only now, after the UNINSTALL. Putting it back before that line
  // left the removal reading the real XDG_CONFIG_HOME on any machine that sets
  // one: the temp entry survived (so this case failed) and the delete landed on
  // the developer's own autostart entry instead.
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
  check('linux: uninstall removed the entry', () => {
    assert.ok(!fs.existsSync(desktopFile), 'entry survived uninstall')
  })

  // ── the service registrations are torn down, not left behind ──────────────
  // Headless mode and the terminal CLI that drove it are gone, so nothing
  // installs a launchd agent, a systemd unit or a scheduled task any more. A
  // machine that ran an older build still HAS them, and they are not inert: the
  // plist carries KeepAlive (it relaunches the app after every quit) and the
  // unit passes `--headless`, a flag nothing reads now. Leaving either in place
  // is the leaked-agent failure this whole file was written after.
  const macLeftover = path.join(TMP, 'sweep-mac')
  const macPlist = path.join(macLeftover, 'Library', 'LaunchAgents', 'cloud.wolffi.sh.plist')
  fs.mkdirSync(path.dirname(macPlist), { recursive: true })
  fs.writeFileSync(macPlist, '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n')
  await asPlatform('darwin', macLeftover, () => autostart.installAutostart('/Applications/W.app'))
  check('macos: a leftover LaunchAgent plist is swept on the next register', () => {
    assert.ok(!fs.existsSync(macPlist), 'KeepAlive agent survived — it relaunches the app on quit')
  })

  const linuxLeftover = path.join(TMP, 'sweep-linux')
  const leftoverUnit = path.join(linuxLeftover, '.config', 'systemd', 'user', 'wfc.service')
  fs.mkdirSync(path.dirname(leftoverUnit), { recursive: true })
  fs.writeFileSync(leftoverUnit, '[Service]\nExecStart=/opt/Wolffish/wfc --headless\n')
  const savedXdgSweep = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  await asPlatform('linux', linuxLeftover, () => autostart.uninstallAutostart())
  if (savedXdgSweep !== undefined) process.env.XDG_CONFIG_HOME = savedXdgSweep
  check('linux: a leftover systemd unit is swept on uninstall too', () => {
    assert.ok(!fs.existsSync(leftoverUnit), 'unit survived — it boots a windowed app on a server')
  })

  // ── AppImage: recording a path that outlives the process ──────────────────
  // An AppImage runs from /tmp/.mount_WolffiXXXXXX, deleted on exit and named
  // differently on every launch. The .desktop entry is READ LATER, by a session
  // manager at next boot, so naming the mount produces an entry that is broken
  // before it is first used while looking correct to the process that wrote it.
  // The .AppImage file is the stable name for the same app.
  const mount = path.join(TMP, '.mount_Wolffi123456')
  const appImageHome = path.join(TMP, 'appimage')
  fs.mkdirSync(mount, { recursive: true })
  fs.mkdirSync(appImageHome, { recursive: true })
  const savedAppImage = process.env.APPIMAGE
  process.env.APPIMAGE = path.join(appImageHome, '.wfc', 'Wolffish.AppImage')
  const savedXdgApp = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME

  await asPlatform('linux', appImageHome, () =>
    autostart.installAutostart(path.join(mount, 'wfc-app'))
  )
  const appImageEntry = path.join(appImageHome, '.config', 'autostart', 'wfc.desktop')
  check('appimage: the entry names the .AppImage, not the mount it runs from', () => {
    const body = fs.readFileSync(appImageEntry, 'utf8')
    assert.ok(body.includes('Wolffish.AppImage'), `named nothing stable:\n${body}`)
    assert.ok(!body.includes(mount), 'recorded a path that dies with this process')
  })
  check('appimage: a mounted launch does not make the entry self-extract', () => {
    const body = fs.readFileSync(appImageEntry, 'utf8')
    assert.ok(
      !body.includes('APPIMAGE_EXTRACT_AND_RUN'),
      'unpacks ~600 MB on every login for a machine that can mount fine'
    )
  })

  // A box with no /dev/fuse — a container started without the device — can only
  // run an AppImage by unpacking it, and the installer bakes that into the
  // launcher it writes. The entry has to reach the same conclusion or autostart
  // fails on exactly the machines the installer just got working. It does not
  // re-derive it: this process running at all is proof of a launch that worked.
  const extractHome = path.join(TMP, 'appimage-extract')
  fs.mkdirSync(extractHome, { recursive: true })
  process.env.APPIMAGE = path.join(extractHome, '.wfc', 'Wolffish.AppImage')
  process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
  await asPlatform('linux', extractHome, () =>
    autostart.installAutostart(path.join(mount, 'wfc-app'))
  )
  delete process.env.APPIMAGE_EXTRACT_AND_RUN
  if (savedXdgApp !== undefined) process.env.XDG_CONFIG_HOME = savedXdgApp
  if (savedAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = savedAppImage

  check('appimage: the entry carries it as env, not as a bare assignment', () => {
    const body = fs.readFileSync(
      path.join(extractHome, '.config', 'autostart', 'wfc.desktop'),
      'utf8'
    )
    const exec = body.split('\n').find((line) => line.startsWith('Exec='))
    assert.ok(
      exec?.startsWith('Exec=env APPIMAGE_EXTRACT_AND_RUN=1 '),
      `a NAME=VALUE prefix would be read as the program to run: ${exec}`
    )
  })

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
