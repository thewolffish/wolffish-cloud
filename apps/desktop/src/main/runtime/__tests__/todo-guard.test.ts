/**
 * The task-list contract: a list the model writes during a turn is never
 * left stale on the user's card. Notice every iteration while open, one
 * close-out nudge at turn end, doctrine in the always-on prompt.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/todo-guard.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_TODO_NUDGES,
  openTaskListNotice,
  openTodoItems,
  todoCloseoutNudge
} from '../agent/todo-guard'
import { formatRuntimeStatus } from '../outbound'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// apps/desktop/src/main/runtime/__tests__ -> repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

let n = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    n++
    console.log(`✅ ${name}`)
  } catch (err) {
    n++
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

type Ended = { stopReason: 'end_turn'; text: string; toolCalls: never[]; thinking: undefined }
const ended = (text: string, toolCalls: unknown[] = []): Ended => ({
  stopReason: 'end_turn' as const,
  text,
  toolCalls: toolCalls as never[],
  thinking: undefined
})

const open = [
  { content: 'Write the page', status: 'completed' as const },
  { content: 'Wire the sound', status: 'in_progress' as const },
  { content: 'Test in the browser', status: 'pending' as const }
]
const closed = open.map((i) => ({ ...i, status: 'completed' as const }))

check('open items are pending and in_progress, nothing else', () => {
  assert.deepEqual(
    openTodoItems(open).map((i) => i.status),
    ['in_progress', 'pending']
  )
  assert.equal(openTodoItems(closed).length, 0)
})

check('the notice names what the card shows and the close-out rule', () => {
  const notice = openTaskListNotice(open)
  assert.ok(notice, 'an open list must produce a notice')
  assert.ok(notice.includes('2 of 3 items unfinished'), notice)
  assert.ok(notice.includes('"Wire the sound" (in_progress)'), notice)
  assert.ok(notice.includes('todo_write'), 'must name the tool that fixes it')
  assert.ok(
    notice.includes('before starting the next'),
    'must say completions are written as they land'
  )
})

check('a closed list produces no notice', () => {
  assert.equal(openTaskListNotice(closed), undefined)
})

check('ending a turn with open items is sent back once', () => {
  const nudge = todoCloseoutNudge(open, ended('All done — the game is on your desktop.'), 0)
  assert.ok(nudge, 'must nudge')
  assert.equal(nudge.length, 2)
  assert.equal(nudge[0].role, 'assistant')
  assert.equal(nudge[0].content, 'All done — the game is on your desktop.')
  assert.equal(nudge[1].role, 'user')
  const aside = String(nudge[1].content)
  assert.ok(aside.includes('todo_write'), 'must name the tool')
  assert.ok(aside.includes('2 of 3 items unfinished'), 'must say what is open')
  assert.ok(aside.includes('zero characters'), 'must permit the silent close')
  assert.equal(
    todoCloseoutNudge(open, ended('done'), MAX_TODO_NUDGES),
    null,
    'budget spent → let it end'
  )
})

check('an empty final reply still gets a non-empty assistant placeholder', () => {
  const nudge = todoCloseoutNudge(open, ended(''), 0)
  assert.ok(nudge && String(nudge[0].content).length > 0, 'Anthropic rejects empty text blocks')
})

check('no nudge without a list, with a closed list, or while tools are still being called', () => {
  assert.equal(todoCloseoutNudge(null, ended('done'), 0), null)
  assert.equal(todoCloseoutNudge(closed, ended('done'), 0), null)
  assert.equal(
    todoCloseoutNudge(open, ended('', [{ id: 'x', name: 'todo_write', args: {} }]), 0),
    null
  )
  assert.equal(
    todoCloseoutNudge(
      open,
      { stopReason: 'max_tokens', text: '', toolCalls: [] as never[], thinking: undefined },
      0
    ),
    null
  )
})

check('the runtime tail carries the task-list notice', () => {
  const rendered = formatRuntimeStatus({
    iteration: 3,
    toolsCalled: 4,
    renderCounters: true,
    deliveredFiles: [],
    online: true,
    taskList: openTaskListNotice(open)
  })
  assert.ok(rendered.includes('TASK LIST: OPEN'), rendered)
})

check('the agent loop wires the notice and the nudge', () => {
  const src = read('apps/desktop/src/main/runtime/agent/Agent.ts')
  assert.ok(
    src.includes('taskList: todoItemsThisTurn ? openTaskListNotice(todoItemsThisTurn) : undefined')
  )
  assert.ok(src.includes('todoCloseoutNudge(todoItemsThisTurn, parsed, todoNudges)'))
  assert.ok(src.includes('todoItemsThisTurn = items'), 'every write must refresh the tracked list')
})

check('the always-on prompt, the coding overlay and the tool description carry the rule', () => {
  const core = read('apps/desktop/src/defaults/workspace/brain/prefrontal/agents.core.md')
  assert.ok(core.includes('never left stale'), 'agents.core.md must carry the task-list rule')
  assert.ok(core.includes('BEFORE you start the next step'), core.slice(0, 0))
  const coding = read('apps/desktop/src/defaults/workspace/brain/prefrontal/coding.md')
  assert.ok(coding.includes('closed out'), 'coding.md must say the list closes before the wrap-up')
  const cerebellum = read('apps/desktop/src/main/runtime/cerebellum.ts')
  assert.ok(cerebellum.includes('never left stale'), 'the tool description must carry the rule')
})

console.log(`\n${n} checks`)
