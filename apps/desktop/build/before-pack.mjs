/**
 * electron-builder beforePack hook.
 *
 * Hooked here rather than onto `npm run build:win` because CI calls
 * `npx electron-builder --win` directly (see .github/workflows/release.yml) —
 * anything hung off the npm script would simply not run on a release build,
 * and that failure is invisible: the installer packs fine and `wolffish` prints
 * nothing on the user's machine.
 */
import { buildWindowsCliLauncher } from '../scripts/win-cli-launcher/build.mjs'

export default async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return
  const out = buildWindowsCliLauncher()
  if (out) console.log(`  • built windows cli launcher  file=${out}`)
}
