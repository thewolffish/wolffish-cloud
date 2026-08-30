/**
 * Compile the Windows CLI launcher.
 *
 * `wolffish-cli.exe` has to be console-subsystem to hand real console handles
 * to the GUI-subsystem app binary — see build/win-cli-launcher/wolffish-cli.cs
 * for why that is the only thing that makes `wolffish --help` print anything.
 *
 * Compiled with csc.exe out of the in-box .NET Framework rather than MSVC or
 * Rust. That is the whole reason the launcher is C#: csc has shipped inside
 * Windows itself since 8, so `electron-builder --win` keeps working on any
 * Windows machine and on the CI runner without a toolchain step, and the
 * runtime it needs is already there for the same reason.
 *
 * A no-op on macOS and Linux, which have no subsystem concept and never had
 * the bug.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(root, 'build', 'win-cli-launcher', 'wolffish-cli.cs')
const OUT = path.join(root, 'build', 'win-cli-launcher', 'wolffish-cli.exe')

/**
 * The newest in-box C# compiler.
 *
 * v4.0.30319 is the one that has been present since Windows 8; the v2/v3.5
 * directories beside it are older and are not a fallback worth taking, since
 * the source uses nothing they lack but they do lack the newer defaults.
 */
function findCsc() {
  const roots = [
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64'),
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework')
  ]
  for (const base of roots) {
    const csc = path.join(base, 'v4.0.30319', 'csc.exe')
    if (existsSync(csc)) return csc
  }
  return null
}

export function buildWindowsCliLauncher() {
  if (process.platform !== 'win32') return null

  // Rebuilding an unchanged launcher on every pack is pure latency, and the
  // output is a build artifact that may already be current from a prior run.
  if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs) return OUT

  const csc = findCsc()
  if (!csc) {
    throw new Error(
      'wolffish-cli.exe cannot be built: no in-box csc.exe found under %WINDIR%\\Microsoft.NET.\n' +
        'Without it the `wolffish` command installs but prints nothing, so this is fatal rather than skipped.'
    )
  }

  mkdirSync(path.dirname(OUT), { recursive: true })
  execFileSync(
    csc,
    ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${OUT}`, SRC],
    { stdio: 'inherit' }
  )
  return OUT
}

// Runnable on its own for a quick local rebuild.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildWindowsCliLauncher()
  console.log(out ? `built ${out}` : 'not windows — nothing to build')
}
