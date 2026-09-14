/**
 * Cloud message-converter tests — the one rule `toOpenAIMessages` enforces
 * beyond a 1:1 mapping: two user messages in a row are coalesced into one
 * user turn.
 *
 * This is what lets the turn-end guards inject a bare `role: 'user'` aside
 * after an empty end_turn instead of interposing a fake assistant message
 * (see agent/empty-turn-guard.ts — that fake message, a literal
 * `(continuing)`, is the shape the model kept copying back out to users as
 * `(no output)` / `(no content)`). The OpenAI wire format permits
 * non-alternating roles, but the chat template on the far side of the router
 * belongs to the upstream, and some templates raise on them — so the shape
 * never leaves here.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/cloud-messages.test.ts
 */

import assert from 'node:assert/strict'
import { toOpenAIMessages } from '../providers/cloud'
import { emptyTurnNudge } from '../agent/empty-turn-guard'
import type { ChatMessage } from '../thalamus'

let checks = 0
function check(label: string, fn: () => void): void {
  fn()
  checks++
  console.log(`✅ ${label}`)
}

const NUDGE = emptyTurnNudge({ stopReason: 'end_turn', text: '', toolCalls: [], thinking: '' }, 0)
assert.ok(
  NUDGE && NUDGE.length === 1 && NUDGE[0].role === 'user',
  'the guard injects one user aside'
)

const roles = (msgs: ChatMessage[]): string[] => toOpenAIMessages('SYSTEM', msgs).map((m) => m.role)

check('an empty end_turn after a tool batch lands as an ordinary user turn', () => {
  assert.deepEqual(
    roles([
      { role: 'user', content: 'build the report' },
      {
        role: 'assistant',
        content: 'On it.',
        toolUses: [{ id: 't1', name: 'file_read', args: {} }]
      },
      { role: 'tool', toolUseId: 't1', toolName: 'file_read', content: 'contents' },
      ...NUDGE
    ]),
    ['system', 'user', 'assistant', 'tool', 'user']
  )
})

check('an empty end_turn on the FIRST call merges into the opening user turn', () => {
  const out = toOpenAIMessages('SYSTEM', [{ role: 'user', content: 'hi' }, ...NUDGE])
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user']
  )
  const content = out[1].content
  assert.equal(typeof content, 'string')
  assert.ok(String(content).startsWith('hi\n\n'), 'the original text leads, the aside follows')
  assert.ok(String(content).includes('empty response'), 'the aside survives the merge')
})

check('a merge into a block-content user turn appends a text block', () => {
  const out = toOpenAIMessages('SYSTEM', [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mediaType: 'image/png', data: 'AAA' }
      ]
    },
    ...NUDGE
  ])
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user']
  )
  const parts = out[1].content as Array<Record<string, unknown>>
  assert.equal(parts.length, 3, 'text + image + the aside')
  assert.equal(parts[1].type, 'image_url', 'the image is untouched')
  assert.equal(parts[2].type, 'text')
})

check('no consecutive user turns ever leave the converter', () => {
  const out = toOpenAIMessages('SYSTEM', [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'user', content: 'three' }
  ])
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user']
  )
  assert.equal(out[1].content, 'one\n\ntwo\n\nthree')
})

check('an ordinary alternating transcript is unchanged', () => {
  assert.deepEqual(
    roles([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ]),
    ['system', 'user', 'assistant', 'user']
  )
})

console.log(`\n${checks} checks`)
