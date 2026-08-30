// Publishes an over-the-air hotfix to the production channel — the release
// path for JS-only changes (components, screens, locales, API code, assets)
// that shouldn't wait for App Store review. Native changes (new modules,
// config plugins, SDK bumps) cannot ship this way; the runtime guard below
// refuses them and routes you to a store build instead.
//
// One step mirroring provision.js + release.js combined (an OTA has no
// review wait, so bump and tag happen together): gate format/types/tests,
// verify the source is runtime-compatible with the latest shipped store
// build, bump APP_VERSION (patch) + UPDATE_DATE, commit, publish with
// `eas update`, tag, push. CODE_VERSION (the store build counter) is
// untouched — the tag is a real production release of what users run, even
// though it will never appear in the store; OTA decouples JS releases from
// native builds, and the commit records which build line the update rides.
//   npm run ota          -> 1.0.3 -> 1.0.4, publish, tag v1.0.4
//   npm run ota 1.1.0    -> APP_VERSION = 1.1.0, publish, tag v1.1.0
// Roll a bad update back with `npm run rollback` (scripts/rollback.js);
// the fix then ships as the next normal ota release.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const configPath = path.join(root, 'app.config.ts')
const pkgPath = path.join(root, 'package.json')
const readmePath = path.join(root, 'README.md')

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()

// The README's shields.io version badge — the last place the version was
// written by hand, and the first thing anyone sees on the repo's front page.
// Left to a human it silently advertises the previous release, so it rides the
// bump commit like package.json does. Mirrored verbatim in provision.js; these
// scripts share no module by design.
const BADGE = /(badge\/version-)(\d+\.\d+\.\d+)(-)/

// Returns the paths to stage — empty when there is nothing to say. A missing
// README, or one without a badge, is not an error: the version lives in
// app.config.ts and this is only a display of it. Returning the list rather
// than a fixed 'README.md' keeps `git add` from failing on the same absence
// this function tolerates.
function bumpReadmeBadge(version) {
  if (!fs.existsSync(readmePath)) return []
  const readme = fs.readFileSync(readmePath, 'utf8')
  if (!BADGE.test(readme)) {
    console.warn('No version badge in README.md — nothing to bump.')
    return []
  }
  fs.writeFileSync(readmePath, readme.replace(BADGE, `$1${version}$3`))
  return ['README.md']
}

const requestedVersion = process.argv[2]
if (requestedVersion && !/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  console.error(`Invalid version "${requestedVersion}" — expected e.g. 1.1.0`)
  process.exit(1)
}

// The bump commit must contain nothing but the bump.
if (out('git', ['status', '--porcelain'])) {
  console.error('Working tree is not clean — commit or stash first.')
  process.exit(1)
}

let config = fs.readFileSync(configPath, 'utf8')
const codeMatch = config.match(/export const CODE_VERSION = (\d+)/)
const versionMatch = config.match(/export const APP_VERSION = '([^']+)'/)
if (!codeMatch || !versionMatch) {
  console.error('CODE_VERSION or APP_VERSION not found in app.config.ts')
  process.exit(1)
}

const code = codeMatch[1]
const [major, minor, patch] = versionMatch[1].split('.').map(Number)
const nextVersion = requestedVersion || `${major}.${minor}.${patch + 1}`
const tag = `v${nextVersion}`

if (out('git', ['tag', '--list', tag])) {
  console.error(`${tag} already exists — pass an explicit version: npm run ota <x.y.z>`)
  process.exit(1)
}

// Gate: the exact source being published must be healthy.
run('npx', [
  'prettier',
  '--check',
  '**/*.{js,jsx,ts,tsx}',
  '--ignore-path',
  '.gitignore',
  '--ignore-path',
  '.prettierignore'
])
run('npx', ['tsc', '--noEmit'])
run('npx', ['jest', '--silent'])

// A local Android build strips an attribute from masked-view's manifest inside
// node_modules, forking the fingerprint on both platforms (see the script).
// Repair it before anything reads the hash — the guard below, and `eas update`
// itself, which stamps the published update with the runtime version it
// computes here. Runs even when the guard is skipped: an update published under
// a drifted runtime version reaches no installed binary at all.
run('node', ['scripts/fix-fingerprint-drift.js'])

// Runtime guard: an update only reaches binaries whose build-time fingerprint
// equals the publish-time fingerprint. Comparing against the latest shipped
// store build catches the silent failure mode — publishing an update that no
// installed binary can receive — before anything is bumped or tagged.
if (process.env.OTA_SKIP_RUNTIME_CHECK === '1') {
  console.warn('OTA_SKIP_RUNTIME_CHECK=1 — skipping the runtime compatibility check.')
} else {
  const compatible = []
  const incompatible = []
  for (const platform of ['ios', 'android']) {
    const builds = JSON.parse(
      out('eas', [
        'build:list',
        '--json',
        '--non-interactive',
        '--platform',
        platform,
        '--limit',
        '10'
      ])
    )
    const shipped = builds.find(
      (b) =>
        b.status === 'FINISHED' &&
        b.buildProfile === 'production' &&
        b.distribution === 'STORE' &&
        b.fingerprint?.hash
    )
    if (!shipped) {
      console.log(`No shipped ${platform} store build — skipping ${platform}.`)
      continue
    }
    const local = JSON.parse(
      out('npx', ['expo-updates', 'fingerprint:generate', '--platform', platform])
    ).hash
    if (local === shipped.fingerprint.hash) {
      compatible.push(`${platform} (build ${shipped.appBuildVersion})`)
    } else {
      incompatible.push(
        `${platform}: local ${local} != build ${shipped.appBuildVersion} (${shipped.fingerprint.hash})`
      )
    }
  }
  if (incompatible.length) {
    console.error(
      `Runtime mismatch — this source can't reach the shipped build(s):\n  ${incompatible.join('\n  ')}\n` +
        'Something changed the native surface (dependency, config, plugin) since that build.\n' +
        'Ship it as a store release instead: npm run provision -> build -> submit -> npm run release.'
    )
    process.exit(1)
  }
  if (!compatible.length) {
    console.error(
      'No shipped store build can receive updates yet — OTA starts after the next ' +
        'store release: npm run provision -> build -> submit -> npm run release.'
    )
    process.exit(1)
  }
  console.log(`Runtime compatible with: ${compatible.join(', ')}`)
}

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const updateDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00:00.000Z`

config = config.replace(
  /export const APP_VERSION = '[^']*'/,
  `export const APP_VERSION = '${nextVersion}'`
)
config = config.replace(
  /export const UPDATE_DATE = '[^']*'/,
  `export const UPDATE_DATE = '${updateDate}'`
)
fs.writeFileSync(configPath, config)

// Keep the npm version in lockstep with the app version (release.js asserts it).
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = nextVersion
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
run('npm', ['install', '--package-lock-only', '--ignore-scripts'])

const readmePaths = bumpReadmeBadge(nextVersion)

run('git', ['add', 'app.config.ts', 'package.json', 'package-lock.json', ...readmePaths])
run('git', ['commit', '-m', `ota: ${tag} (over build ${code})`])

// Publish exactly the committed tree. Nothing is pushed yet, so a failed
// publish leaves only a local commit.
try {
  run('eas', [
    'update',
    '--channel',
    'production',
    // Which server-side EAS env-var set to resolve at bundle time — required
    // in non-interactive mode on SDK 55+ (eas-cli 21).
    '--environment',
    'production',
    '--message',
    `${tag} (over build ${code})`,
    '--non-interactive'
  ])
} catch {
  console.error(
    'Publish failed — the bump commit is local-only; undo with: git reset --hard HEAD~1\n' +
      '(First publish ever? Create the channel once: eas channel:create production)'
  )
  process.exit(1)
}

run('git', ['tag', '-a', tag, '-m', `ota: ${tag} (over build ${code})`])

const hasOrigin = out('git', ['remote']).split('\n').includes('origin')
if (hasOrigin) {
  run('git', ['push', 'origin', 'HEAD', '--tags'])
} else {
  console.log('No "origin" remote — pushed nothing. Push manually when one exists.')
}

console.log(`OTA ${tag} published to production (over build ${code})`)
