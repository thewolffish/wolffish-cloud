/**
 * The folder chips over the transcript: which folders a conversation changed
 * files in, derived from the persisted segments alone. Pins the rules the
 * strip relies on — only successful file-changing calls count, the diff's
 * absolute path wins over the call's argument, a relative argument resolves
 * against the first working folder, and labels read relative to the working
 * folder that contains them.
 */
import type { Segment } from '@preload/index'
import {
  collectChangedFiles,
  collectTouchedFolders
} from '../../../renderer/src/lib/touched-folders/touchedFolders'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.error(`FAIL ${label}${detail !== undefined ? `\n     ${JSON.stringify(detail)}` : ''}`)
  }
}

function call(id: string, name: string, args: Record<string, unknown>): Segment {
  return { kind: 'tool_call', turnId: 't1', segmentId: `c-${id}`, toolCallId: id, name, args }
}
function result(id: string, status: 'success' | 'failed' | 'denied', diffFile?: string): Segment {
  return {
    kind: 'tool_result',
    turnId: 't1',
    segmentId: `r-${id}`,
    toolCallId: id,
    status,
    output: '',
    ...(diffFile
      ? { meta: { diff: { file: diffFile, patch: '', additions: 1, deletions: 0, kind: 'edit' } } }
      : {})
  } as Segment
}
const msg = (segments: Segment[]): { role: string; segments: Segment[] } => ({
  role: 'assistant',
  segments
})
const W = '/repo/app'

function main(): void {
  const messages = [
    { role: 'user', segments: undefined },
    msg([
      call('1', 'file_read', { path: 'src/a.ts' }),
      result('1', 'success'),
      call('2', 'file_edit', { path: 'src/a.ts' }),
      result('2', 'success', `${W}/src/a.ts`),
      call('3', 'file_write', { path: `${W}/src/lib/b.ts` }),
      result('3', 'success', `${W}/src/lib/b.ts`),
      call('4', 'file_edit', { path: 'src/a.ts' }),
      result('4', 'success', `${W}/src/a.ts`),
      call('5', 'file_patch', { path: 'test/x.test.ts' }),
      result('5', 'success'),
      call('6', 'file_edit', { path: 'src/never.ts' }),
      result('6', 'failed'),
      call('7', 'file_write', { path: 'src/denied.ts' }),
      result('7', 'denied'),
      call('8', 'file_write', { path: 'README.md' }),
      result('8', 'success', `${W}/README.md`),
      call('9', 'file_edit', { path: '/tmp/scratch/notes.md' }),
      result('9', 'success'),
      call('10', 'file_edit', { path: 'pending.ts' })
    ])
  ]
  const files = collectChangedFiles(messages, [W])
  ok(
    'only successful file-changing calls count, in stream order',
    JSON.stringify(files) ===
      JSON.stringify([
        `${W}/src/a.ts`,
        `${W}/src/lib/b.ts`,
        `${W}/src/a.ts`,
        `${W}/test/x.test.ts`,
        `${W}/README.md`,
        '/tmp/scratch/notes.md'
      ]),
    files
  )
  const folders = collectTouchedFolders(messages, [W])
  ok(
    'one chip per folder, labeled relative to the working folder, files deduplicated',
    JSON.stringify(folders) ===
      JSON.stringify([
        { path: `${W}/src`, label: 'src', files: 1 },
        { path: `${W}/src/lib`, label: 'src/lib', files: 1 },
        { path: `${W}/test`, label: 'test', files: 1 },
        { path: W, label: 'app', files: 1 },
        { path: '/tmp/scratch', label: 'scratch', files: 1 }
      ]),
    folders
  )
  ok(
    'no working folder: a relative path cannot resolve and is skipped',
    collectTouchedFolders(messages, []).every((f) => f.path.startsWith('/'))
  )
  ok(
    'the longest containing working folder labels a nested folder',
    collectTouchedFolders(messages, ['/repo', W])[0]?.label === 'src'
  )
  ok(
    'a message without segments contributes nothing',
    collectTouchedFolders([{ role: 'assistant' }], [W]).length === 0
  )
  ok(
    'windows separators are normalized',
    collectTouchedFolders(
      [msg([call('w', 'file_edit', { path: 'src\\win.ts' }), result('w', 'success')])],
      ['C:\\proj']
    )[0]?.path === 'C:/proj/src'
  )
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
main()
