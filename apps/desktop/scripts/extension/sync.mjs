#!/usr/bin/env node
// Refreshes the browser extension bundled with the desktop app from a build
// of packages/extension.
//
// The desktop ships the extension at src/defaults/workspace/extension and
// copies it to ~/.wfc/workspace/extension on every launch (workspace.ts
// ensureBundledExtension), so that folder IS what users load into Chrome.
// This replaces it atomically — the build is staged beside the target, then
// swapped in with two renames — and only after the staged copy has passed the
// identity check below, so a stale or personal-edition build can never
// half-replace the bundle or replace it at all.
//
// Usage (from apps/desktop; Node only, no dependencies):
//   node scripts/extension/sync.mjs                # from packages/extension/dist
//   node scripts/extension/sync.mjs <built-dir>    # from any built extension dir
//   node scripts/extension/sync.mjs --check        # verify the bundle in place, copy nothing
//
// Build first: `cd packages/extension && pnpm install --frozen-lockfile && pnpm build`
// (vite writes to packages/extension/dist). Sourcemaps and the dev-only
// refresh.js are left out, as the extension's own release script leaves them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')
const TARGET = path.join(desktopRoot, 'src', 'defaults', 'workspace', 'extension')
const DEFAULT_SOURCE = path.join(repoRoot, 'packages', 'extension', 'dist')

// The identity a cloud-edition build carries. The manifest's name is a
// `__MSG_…__` reference resolved through the default locale's messages —
// the same way Chrome resolves it — and the port is not in the manifest at
// all: it is compiled into the scripts (DEFAULT_PORT and the storage default),
// so every 2315x-shaped number in the bundle's JS must be the cloud port.
const EXPECTED = {
  name: 'Wolffish Cloud',
  geckoId: 'wolffish-cloud@wolffi.sh',
  port: 23152,
  logPrefix: '[Wolffish Cloud]'
}
const STALE_LOG_PREFIX = '[Wolffish]'

const excluded = (rel) =>
  rel.endsWith('.map') || path.basename(rel) === 'refresh.js' || path.basename(rel) === '.DS_Store'

/** Every file under `dir`, as relative POSIX-ish paths, excluding dev artifacts. */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...listFiles(dir, rel))
    else if (!excluded(rel)) out.push(rel)
  }
  return out.sort()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * The identity check. Returns the list of problems (empty means the bundle
 * passes) plus the facts the summary line prints.
 */
function verify(dir) {
  const problems = []
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return { problems: ['manifest.json is missing'], facts: null }
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (error) {
    return { problems: [`manifest.json is not valid JSON: ${error.message}`], facts: null }
  }

  if (manifest.manifest_version !== 3) problems.push(`manifest_version is ${manifest.manifest_version}, expected 3`)
  if (typeof manifest.version !== 'string' || !manifest.version) problems.push('manifest has no version')

  // Name — literal, or resolved through _locales/<default_locale>/messages.json.
  let name = manifest.name
  const msgRef = typeof name === 'string' ? name.match(/^__MSG_(\w+)__$/) : null
  if (msgRef) {
    const locale = manifest.default_locale
    const messagesPath = path.join(dir, '_locales', String(locale), 'messages.json')
    if (!locale || !fs.existsSync(messagesPath)) {
      problems.push(`name is ${name} but _locales/${locale}/messages.json is missing`)
      name = null
    } else {
      name = readJson(messagesPath)[msgRef[1]]?.message ?? null
    }
  }
  if (name !== EXPECTED.name) problems.push(`name is ${JSON.stringify(name)}, expected ${JSON.stringify(EXPECTED.name)}`)

  const geckoId = manifest.browser_specific_settings?.gecko?.id
  if (geckoId !== EXPECTED.geckoId) problems.push(`gecko id is ${JSON.stringify(geckoId)}, expected ${JSON.stringify(EXPECTED.geckoId)}`)

  // Every file the manifest points at must be in the bundle.
  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {})
  ].filter((file) => typeof file === 'string')
  for (const file of new Set(referenced)) {
    if (!fs.existsSync(path.join(dir, file))) problems.push(`manifest references ${file}, which is missing`)
  }

  // Port and log prefix: compiled into the scripts, so scan every JS file.
  let portSeen = false
  let cloudPrefixSeen = false
  for (const rel of listFiles(dir)) {
    if (!rel.endsWith('.js')) continue
    const text = fs.readFileSync(path.join(dir, rel), 'utf8')
    for (const match of text.matchAll(/\b2315\d\b/g)) {
      if (Number(match[0]) === EXPECTED.port) portSeen = true
      else problems.push(`${rel} carries port ${match[0]}, expected ${EXPECTED.port}`)
    }
    if (text.includes(EXPECTED.logPrefix)) cloudPrefixSeen = true
    if (text.includes(STALE_LOG_PREFIX)) problems.push(`${rel} still logs as ${STALE_LOG_PREFIX}, expected ${EXPECTED.logPrefix}`)
  }
  if (!portSeen) problems.push(`no script carries the default port ${EXPECTED.port}`)
  if (!cloudPrefixSeen) problems.push(`no script logs as ${EXPECTED.logPrefix}`)

  return { problems, facts: { version: manifest.version, name, geckoId } }
}

/** How the staged bundle differs from the one in place, for the summary. */
function diffSummary(oldDir, newDir) {
  if (!fs.existsSync(oldDir)) return 'no previous bundle'
  const oldFiles = new Set(listFiles(oldDir))
  const newFiles = listFiles(newDir)
  let added = 0
  let changed = 0
  for (const rel of newFiles) {
    if (!oldFiles.has(rel)) added += 1
    else if (!fs.readFileSync(path.join(oldDir, rel)).equals(fs.readFileSync(path.join(newDir, rel)))) changed += 1
  }
  const removed = [...oldFiles].filter((rel) => !newFiles.includes(rel)).length
  return `${changed} changed, ${added} added, ${removed} removed`
}

function copyTree(source, dest, files) {
  for (const rel of files) {
    const to = path.join(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(source, rel), to)
  }
}

function fail(message) {
  console.error(`extension sync: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const positional = args.filter((arg) => !arg.startsWith('--'))
const relTarget = path.relative(desktopRoot, TARGET)

if (checkOnly) {
  if (!fs.existsSync(TARGET)) fail(`${relTarget} does not exist`)
  const { problems, facts } = verify(TARGET)
  if (problems.length) fail(`${relTarget} fails the identity check:\n  - ${problems.join('\n  - ')}`)
  console.log(
    `extension: ${relTarget} ok — v${facts.version}, ${listFiles(TARGET).length} files, ${facts.name} · ${facts.geckoId} · port ${EXPECTED.port} · logs ${EXPECTED.logPrefix}`
  )
  process.exit(0)
}

const source = path.resolve(positional[0] ?? DEFAULT_SOURCE)
if (!fs.existsSync(path.join(source, 'manifest.json'))) {
  fail(`${source} has no manifest.json — build the extension first (cd packages/extension && pnpm build)`)
}
if (source === TARGET) fail('the source is the bundle itself; pass the build directory')

const files = listFiles(source)
const staging = `${TARGET}.staging-${process.pid}`
const previous = `${TARGET}.previous-${process.pid}`
fs.rmSync(staging, { recursive: true, force: true })
try {
  copyTree(source, staging, files)
  const { problems, facts } = verify(staging)
  if (problems.length) fail(`the build fails the identity check, bundle left untouched:\n  - ${problems.join('\n  - ')}`)
  const delta = diffSummary(TARGET, staging)

  // The swap: two renames on the same filesystem. If the second one fails the
  // old bundle is put back, so the target is never left missing.
  const hadPrevious = fs.existsSync(TARGET)
  if (hadPrevious) fs.renameSync(TARGET, previous)
  try {
    fs.renameSync(staging, TARGET)
  } catch (error) {
    if (hadPrevious) fs.renameSync(previous, TARGET)
    throw error
  }
  if (hadPrevious) fs.rmSync(previous, { recursive: true, force: true })

  console.log(
    `extension: synced ${files.length} files (v${facts.version}) from ${path.relative(repoRoot, source)} → ${relTarget} (${delta}) — ${facts.name} · ${facts.geckoId} · port ${EXPECTED.port} · logs ${EXPECTED.logPrefix}`
  )
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
