// Run: npx tsx --tsconfig tsconfig.node.json src/main/__tests__/media-url.test.ts
import assert from 'node:assert/strict'
import { WORKSPACE_MEDIA_SCHEME, workspaceMediaPath } from '@main/media-url'

let n = 0
const check = (name: string, fn: () => void): void => {
  n++
  try {
    fn()
    console.log(`✅ ${name}`)
  } catch (err) {
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

check('the scheme the renderer emits is the one the handler parses', () => {
  assert.equal(WORKSPACE_MEDIA_SCHEME, 'wolffish-media')
  assert.equal(workspaceMediaPath('wolffish-media://files/chart.png'), 'files/chart.png')
})
check('screenshots under a conversation folder resolve', () => {
  assert.equal(
    workspaceMediaPath('wolffish-media://screenshots/conv-abc/shot-1.jpg'),
    'screenshots/conv-abc/shot-1.jpg'
  )
})
check('percent-encoded names decode', () => {
  assert.equal(workspaceMediaPath('wolffish-media://files/my%20chart.png'), 'files/my chart.png')
})
check('a leading slash is tolerated', () => {
  assert.equal(workspaceMediaPath('wolffish-media:///files/a.png'), 'files/a.png')
})
check('the retired wfc-media prefix is not ours', () => {
  assert.equal(workspaceMediaPath('wfc-media://files/a.png'), null)
})
check('other schemes are not ours', () => {
  assert.equal(workspaceMediaPath('file:///etc/passwd'), null)
  assert.equal(workspaceMediaPath('https://example.com/x.png'), null)
})
check('climbing out of the workspace is refused', () => {
  assert.equal(workspaceMediaPath('wolffish-media://../../etc/passwd'), null)
  assert.equal(workspaceMediaPath('wolffish-media://files/..%2F..%2Fsecret'), null)
})
check('an empty path is refused', () => {
  assert.equal(workspaceMediaPath('wolffish-media://'), null)
})
console.log(`${n} checks, exit ${process.exitCode ?? 0}`)
