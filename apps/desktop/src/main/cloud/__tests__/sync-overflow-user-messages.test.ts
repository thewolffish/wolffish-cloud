/**
 * A spilled record still carries the user's own mid-turn messages.
 *
 * The cloud fork does not serve transcripts from the desktop the way the relay
 * build does — the phone rebuilds them from records pulled out of the org API
 * (apps/mobile/src/lib/sync/sync.ts). A message past MAX_RECORD_BYTES does not
 * fit in one record, so `wireMessage` SPILLS: the full body goes to a blob and
 * the record keeps a readable prefix plus a placeholder segment.
 *
 * That placeholder used to replace EVERY segment, which quietly took the user's
 * own words with it. A `user_message` segment is a message the user typed into
 * the phone mid-run (runtime/agent/interjection.ts) — and unlike everything else
 * in a spilled record it has no second copy on that device: the pending bubble
 * came down the moment the agent read it, and the phone's transcript IS these
 * records. So it went missing whenever the blob was not (or not yet) hydrated,
 * and permanently down the truncated path, which has no blob at all.
 *
 * The messages that matter here are a sentence long, on a record already past
 * the ceiling — which is why keeping them costs nothing worth counting.
 *
 * `spilledSegments` lives in restore.ts — the pure half of the engine, kept
 * apart from sync.ts precisely so the record SHAPES can be exercised without
 * Electron, next to hydrateOverflow which reads what it writes.
 *
 * No server, no Electron. Run from apps/desktop:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/sync-overflow-user-messages.test.ts
 */

import assert from 'node:assert/strict'
import { spilledSegments } from '@main/cloud/restore'
import type { ConversationMessage } from '@main/conversations'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks++
  console.log(`✅ ${name}`)
}

const userMessage = (id: string, text: string): unknown => ({
  kind: 'user_message',
  turnId: 't1',
  segmentId: `s_${id}`,
  messageId: id,
  text,
  timestamp: 1
})

const huge: ConversationMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'x'.repeat(10),
  timestamp: 1,
  segments: [
    { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'working' },
    userMessage('m_1_aaaaaa', 'actually, use the other file'),
    {
      kind: 'tool_call',
      turnId: 't1',
      segmentId: 's3',
      toolCallId: 'c1',
      name: 'shell',
      args: { command: 'x'.repeat(400_000) }
    },
    userMessage('m_2_bbbbbb', 'and skip the tests folder')
  ] as ConversationMessage['segments']
}

function main(): void {
  const spilled = spilledSegments(huge, '[full segment detail in the message body blob]')

  check('the placeholder still leads the record', () => {
    const first = spilled[0] as { kind: string; delta: string; segmentId: string }
    assert.equal(first.kind, 'text')
    assert.equal(first.segmentId, 'sync-overflow')
    assert.ok(first.delta.length > 0)
  })

  check('every mid-turn user message survives the spill, in order', () => {
    const kept = spilled.filter((s) => (s as { kind?: string }).kind === 'user_message')
    assert.equal(kept.length, 2)
    assert.deepEqual(
      kept.map((s) => (s as { messageId: string }).messageId),
      ['m_1_aaaaaa', 'm_2_bbbbbb']
    )
    assert.equal((kept[0] as { text: string }).text, 'actually, use the other file')
    assert.equal((kept[1] as { text: string }).text, 'and skip the tests folder')
  })

  check('the agent’s own bulk does NOT ride along — that is what the blob is for', () => {
    const kinds = spilled.map((s) => (s as { kind: string }).kind)
    assert.equal(kinds.includes('tool_call'), false)
    // The only text segment is the placeholder itself.
    assert.equal(kinds.filter((k) => k === 'text').length, 1)
  })

  check('what survives is small enough to be free', () => {
    assert.ok(
      Buffer.byteLength(JSON.stringify(spilled)) < 2_048,
      `${Buffer.byteLength(JSON.stringify(spilled))} bytes`
    )
  })

  check('a message with no user messages keeps the old one-placeholder shape', () => {
    const plain: ConversationMessage = {
      ...huge,
      segments: [
        { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'working' }
      ] as ConversationMessage['segments']
    }
    assert.equal(spilledSegments(plain, 'note').length, 1)
  })

  check('a message with no segments at all is still just the placeholder', () => {
    const bare = { id: 'a2', role: 'assistant', content: 'hi', timestamp: 1 } as ConversationMessage
    assert.equal(spilledSegments(bare, 'note').length, 1)
  })

  console.log(`\n${checks} checks passed`)
}

main()
