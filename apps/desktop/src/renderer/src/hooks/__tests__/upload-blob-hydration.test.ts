/**
 * The feed's blob loader must survive a file that is still downloading.
 *
 *   npx tsx --tsconfig tsconfig.node.json \
 *     src/renderer/src/hooks/__tests__/upload-blob-hydration.test.ts
 *
 * The bug this guards: a conversation's media downloads when the conversation
 * is OPENED (nothing is predownloaded at restore), so the first read of a
 * delivered screenshot loses a seconds-long race with its own download.
 * useUploadBlob answered that miss with a permanent `error`, and since nothing
 * ever re-ran the hook, the feed said "Image file was deleted or unavailable"
 * for the life of the mount — about a file that landed on disk moments later
 * and rendered perfectly in the files sheet (AttachmentList re-checks on the
 * hydration signal) and after any reload. The admin transcript, which draws
 * the same AssistantBubble, said the same thing.
 *
 * These are SOURCE assertions, not behavioral ones: the hook needs a DOM and
 * a live `window.api` to run, which this suite has neither of. They cannot
 * prove the loader works — the app is where that was checked — but they do
 * fail loudly if the three pieces that make it work are removed, which is the
 * regression that would otherwise ship silently.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(
  join(import.meta.dirname, '..', 'use-upload-blob', 'useUploadBlob.ts'),
  'utf8'
)

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

check('the loader subscribes to the hydration signal', () => {
  assert.match(SRC, /from '@lib\/hydration\/hydrationStore'/)
  assert.match(SRC, /const hydrationFileVersion = useHydrationFileVersion\(\)/)
})

check('a hydration bump re-runs the read', () => {
  // The dep is the whole fix: without it the hook never looks again.
  assert.match(SRC, /\}, \[filePath, mimeType, hydrationFileVersion\]\)/)
})

check('a file still queued or mid-download is not reported as deleted', () => {
  assert.match(SRC, /setError\(!isPathHydrating\(filePath\)\)/)
  assert.ok(!/setError\(true\)/.test(SRC), 'error must never be latched unconditionally')
})

check('bytes already in hand are not re-read on a bump', () => {
  assert.match(SRC, /if \(urlRef\.current\) return/)
})

check('the object URL is revoked outside the retrying effect', () => {
  // Revoking in the loading effect's cleanup would tear down an image already
  // on screen every time another file in the same flight lands.
  const revoke = SRC.indexOf('URL.revokeObjectURL')
  const load = SRC.indexOf('window.api.upload.readFile')
  assert.ok(revoke !== -1 && load !== -1, 'both the revoke and the read must exist')
  assert.ok(revoke < load, 'the revoke belongs to the earlier, path-scoped effect')
  assert.match(SRC, /\}, \[filePath, mimeType\]\)/)
})

console.log(`${n} checks, exit ${process.exitCode ?? 0}`)
