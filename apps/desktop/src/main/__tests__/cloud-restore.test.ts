/**
 * Tests for the pure half of cloud restore (src/main/cloud/restore.ts):
 * the org's record pages → one conversation file.
 *
 *  - the version of a message the org received LAST wins, even when an
 *    earlier version carries the higher seq (a re-stamped prompt)
 *  - messages sort by seq, insert order breaking ties (prompt above reply)
 *  - the last snapshot is the envelope
 *  - a record shaped by another writer is coerced onto the desktop contract
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/cloud-restore.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rebuildConversation, type WireRecord } from '../cloud/restore'

const meta = {
  id: 'c',
  title: 'from meta',
  created_at: '2026-09-02T01:29:25.000Z',
  updated_at: '2026-09-02T01:30:15.000Z'
}

const rec = (
  base: string,
  seq: number,
  content: Record<string, unknown>,
  suffix = 'aaaaaaaa'
): WireRecord => ({
  id: `${base}.${suffix}`,
  seq,
  kind: 'message',
  content,
  created_at: new Date(seq).toISOString()
})

const snapshot = (seq: number, content: Record<string, unknown>): WireRecord => ({
  id: 'snap.c',
  seq,
  kind: 'snapshot',
  content,
  created_at: new Date(seq).toISOString()
})

test('a stale copy with the younger seq loses to the corrected one; the prompt stays above its reply', () => {
  // Seen live: the desktop pushed a prompt stamped 1.5 s after its own
  // reply, then the corrected copy sharing the reply's millisecond.
  const file = rebuildConversation(meta, [
    snapshot(5, { id: 'c', title: 'first envelope', updatedAt: 1 }),
    rec(
      'u',
      1_500,
      { id: 'u', role: 'user', content: 'prompt (stale)', timestamp: 1_500 },
      '0000000a'
    ),
    rec('u', 100, { id: 'u', role: 'user', content: 'prompt', timestamp: 100 }, '0000000b'),
    rec('a', 100, { id: 'a', role: 'assistant', content: 'reply', timestamp: 100 }),
    snapshot(6, { id: 'c', title: 'last envelope', updatedAt: 2 })
  ])
  assert.deepEqual(
    file.messages.map((m) => [m.id, m.role, m.content, m.timestamp]),
    [
      ['u', 'user', 'prompt', 100],
      ['a', 'assistant', 'reply', 100]
    ]
  )
  assert.equal(file.title, 'last envelope')
})

test('an edit pushed later replaces the original and keeps seq order across messages', () => {
  const file = rebuildConversation(meta, [
    rec('m2', 20, { id: 'm2', role: 'assistant', content: 'second', timestamp: 20 }),
    rec('m1', 10, { id: 'm1', role: 'user', content: 'first (old)', timestamp: 10 }, 'bbbbbbbb'),
    rec('m1', 11, { id: 'm1', role: 'user', content: 'first', timestamp: 11 }, 'cccccccc')
  ])
  assert.deepEqual(
    file.messages.map((m) => [m.id, m.content]),
    [
      ['m1', 'first'],
      ['m2', 'second']
    ]
  )
})

test('a record shaped by another writer is coerced onto the contract', () => {
  const file = rebuildConversation(meta, [
    rec('x', 1_788_312_565_276, { text: 'legacy text', role: 'assistant' }),
    rec('y', 7, { role: 'user', content: 42 })
  ])
  assert.deepEqual(
    file.messages.map((m) => [m.id, m.role, m.content, m.timestamp]),
    [
      ['y', 'user', '', 7], // seq too small to be a clock: created_at stands in
      ['x', 'assistant', 'legacy text', 1_788_312_565_276]
    ]
  )
  assert.equal(file.title, 'from meta')
  assert.equal(file.createdAt, Date.parse(meta.created_at))
  assert.equal(file.updatedAt, Date.parse(meta.updated_at))
})
