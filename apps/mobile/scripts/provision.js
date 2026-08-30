// Provisions the next store build: gates on format/types/tests, bumps
// APP_VERSION (patch) and CODE_VERSION (+1), refreshes UPDATE_DATE, and
// commits the bump — so every store build maps to one clean provision
// commit. If the submitted build sails through review, `npm run release`
// then tags that same commit. Only the provisioned build that ships gets
// a tag; releases stay 1:N with provisions.
//   npm run provision          -> 1.0.0 -> 1.0.1, build +1
//   npm run provision 1.1.0    -> APP_VERSION = 1.1.0, build +1
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
// bump commit like package.json does. Mirrored verbatim in ota.js; these
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

// The provision commit must contain nothing but the bump.
if (out('git', ['status', '--porcelain'])) {
  console.error('Working tree is not clean — commit or stash first.')
  process.exit(1)
}

// Gate: the exact source being provisioned must be healthy.
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

let config = fs.readFileSync(configPath, 'utf8')
const codeMatch = config.match(/export const CODE_VERSION = (\d+)/)
const versionMatch = config.match(/export const APP_VERSION = '([^']+)'/)
if (!codeMatch || !versionMatch) {
  console.error('CODE_VERSION or APP_VERSION not found in app.config.ts')
  process.exit(1)
}

const [major, minor, patch] = versionMatch[1].split('.').map(Number)
const nextCode = Number(codeMatch[1]) + 1
const nextVersion = requestedVersion || `${major}.${minor}.${patch + 1}`

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const updateDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00:00.000Z`

config = config.replace(
  /export const CODE_VERSION = \d+/,
  `export const CODE_VERSION = ${nextCode}`
)
config = config.replace(
  /export const APP_VERSION = '[^']*'/,
  `export const APP_VERSION = '${nextVersion}'`
)
config = config.replace(
  /export const UPDATE_DATE = '[^']*'/,
  `export const UPDATE_DATE = '${updateDate}'`
)
fs.writeFileSync(configPath, config)

// Keep the npm version in lockstep with the store version.
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = nextVersion
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
run('npm', ['install', '--package-lock-only', '--ignore-scripts'])

const readmePaths = bumpReadmeBadge(nextVersion)

run('git', ['add', 'app.config.ts', 'package.json', 'package-lock.json', ...readmePaths])
run('git', ['commit', '-m', `provision: v${nextVersion} (build ${nextCode})`])

const hasOrigin = out('git', ['remote']).split('\n').includes('origin')
if (hasOrigin) {
  run('git', ['push', 'origin', 'HEAD'])
} else {
  console.log('No "origin" remote — pushed nothing. Push manually when one exists.')
}

console.log(`Provisioned v${nextVersion} (build ${nextCode}), updated ${updateDate.slice(0, 10)}`)
