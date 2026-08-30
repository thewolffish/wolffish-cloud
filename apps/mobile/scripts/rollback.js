// Emergency lever for a bad OTA: rolls production back one step, touching
// no versions and no source. `eas update:rollback` republishes the update
// group published before the latest one (same branch and runtime); if none
// exists it publishes a roll-back-to-embedded, reverting devices to the
// bundle baked into their store build. Devices converge like any update —
// next cold start or foreground check. The bad release's tag stays (it
// really shipped); an empty marker commit records the rollback in git. The
// actual fix ships later as a normal `npm run ota`, which bumps a fresh
// version and supersedes the rollback.
//   npm run rollback
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()

// The marker commit must record the rollback and nothing else.
if (out('git', ['status', '--porcelain'])) {
  console.error('Working tree is not clean — commit or stash first.')
  process.exit(1)
}

let latest
try {
  const page = JSON.parse(
    out('eas', [
      'update:list',
      '--branch',
      'production',
      '--json',
      '--non-interactive',
      '--limit',
      '1'
    ])
  ).currentPage
  latest = page && page[0]
} catch (error) {
  console.error(
    'Could not list production updates — nothing published yet, or EAS is unreachable.\n' +
      (error.stderr || error.message || '')
  )
  process.exit(1)
}
if (!latest) {
  console.error('No updates on the production channel — nothing to roll back.')
  process.exit(1)
}

const groupId = latest.group ?? latest.id
const label = latest.message || String(groupId).slice(0, 8)
console.log(
  `Rolling back "${label}" (runtime ${latest.runtimeVersion ?? '?'}, created ${latest.createdAt ?? '?'}).\n` +
    'EAS republishes the update before it — or the embedded bundle if it was the first.'
)

try {
  run('eas', ['update:rollback', String(groupId), '-m', `rollback: ${label}`, '--non-interactive'])
} catch {
  console.error(
    'Rollback failed — nothing was recorded; production is unchanged. Rerun when fixed.'
  )
  process.exit(1)
}

run('git', ['commit', '--allow-empty', '-m', `rollback: ${label}`])

const hasOrigin = out('git', ['remote']).split('\n').includes('origin')
if (hasOrigin) {
  run('git', ['push', 'origin', 'HEAD'])
} else {
  console.log('No "origin" remote — pushed nothing. Push manually when one exists.')
}

console.log(`Rolled back "${label}" — ship the fix with: npm run ota`)
