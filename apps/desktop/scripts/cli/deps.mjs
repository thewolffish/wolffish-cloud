#!/usr/bin/env node
/**
 * postinstall: install the terminal client's own dependencies under src/cli
 * with Bun (a devDependency of the root), so `npm ci` alone leaves the CLI
 * buildable — on a laptop and on every CI runner.
 *
 * Best-effort: a machine that only wants to run the desktop app can live
 * without it, and a failure here must not fail `npm install`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The real binary, not npm's .bin shim (a .cmd on Windows that execFileSync
// cannot run without a shell). The bun package names it bun.exe everywhere.
const bun = path.join(repo, 'node_modules', 'bun', 'bin', 'bun.exe')
const cliDir = path.join(repo, 'src', 'cli')

if (!existsSync(bun)) {
  console.log('[cli] bun not installed yet — skipping CLI dependencies')
  process.exit(0)
}
try {
  execFileSync(bun, ['install', '--frozen-lockfile'], { cwd: cliDir, stdio: 'inherit' })
} catch (error) {
  console.log(`[cli] dependency install failed (${error?.message ?? error}); run it later with: node scripts/cli/deps.mjs`)
}
