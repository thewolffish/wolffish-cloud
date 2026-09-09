/**
 * Spilled messages, on the way back in — the pure half.
 *
 * A message too big for one record is synced as a preview plus a pointer
 * (sync.ts wireMessage). Two things must hold for every reader of the
 * record, the owner's restore and the admin transcript alike:
 *
 *   1. hydrateOverflow swaps the full body back in through whatever fetch
 *      the reader has, drops the pointer with it, and a body that will not
 *      come leaves the preview standing.
 *   2. The preview's placeholder segment renders as PROSE. Rows written
 *      before 2026-09-08 carry it as `{kind:'text', text}` — no `delta` —
 *      and every renderer concatenates `delta`, so a reader that never
 *      fetched the body (an admin, until today) showed the literal word
 *      "undefined" in place of the message. rebuildConversation coerces it.
 *
 * No server, no Electron. Run from apps/desktop:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/restore-overflow.test.ts
 */

import assert from 'node:assert/strict'
import { hydrateOverflow, rebuildConversation, type WireRecord } from '@main/cloud/restore'

const META = {
  id: 'conv_1',
  title: 'Spilled',
  created_at: '2026-09-08T00:00:00.000Z',
  updated_at: '2026-09-08T00:00:00.000Z'
}
const SHA_OK = 'a'.repeat(64)
const SHA_GONE = 'b'.repeat(64)
const SHA_SUPERSEDED = 'c'.repeat(64)

const fullBody = {
  id: 'm_2',
  role: 'assistant',
  content: 'the whole reply',
  timestamp: 1_700_000_000_002,
  segments: [
    { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'the whole reply' },
    { kind: 'tool_call', turnId: 't1', segmentId: 's2', toolCallId: 'c1', name: 'bash', args: {} }
  ]
}

const record = (id: string, seq: number, content: unknown): WireRecord => ({
  id,
  seq,
  kind: 'message',
  content,
  created_at: '2026-09-08T00:00:00.000Z',
  base_id: id.replace(/\.[0-9a-f]{8}$/, ''),
  version_hash: null
})

// The old placeholder shape, exactly as rows on the server carry it.
const legacyStub = (sha: string): Record<string, unknown> => ({
  id: 'm_2',
  role: 'assistant',
  content:
    'the whole reply\n\n[… 300,000 characters; the full message is synced alongside this record]',
  timestamp: 1_700_000_000_002,
  segments: [{ kind: 'text', text: '[full segment detail in the message body blob]' }],
  syncOverflow: { sha256: sha, bytes: 300_000, name: '.records/conv-conv_1/m_2.json' }
})

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks++
  console.log(`✅ ${name}`)
}

async function main(): Promise<void> {
  // ── 1. hydration swaps the body in, and only where the blob exists ───────
  {
    const fetched: string[] = []
    const records = [
      record('m_1.11111111', 1_700_000_000_001, {
        id: 'm_1',
        role: 'user',
        content: 'hi',
        timestamp: 1
      }),
      // An earlier version of m_2: same blob NAME as the survivor below, so
      // its sha no longer resolves — and it is not asked for.
      record('m_2.00000000', 1_700_000_000_002, legacyStub(SHA_SUPERSEDED)),
      record('m_2.22222222', 1_700_000_000_002, legacyStub(SHA_OK)),
      record('m_3.33333333', 1_700_000_000_003, legacyStub(SHA_GONE))
    ]
    const misses: string[] = []
    await hydrateOverflow(
      records,
      async (sha) => {
        fetched.push(sha)
        if (sha === SHA_OK) return JSON.stringify(fullBody)
        throw new Error('HTTP 404')
      },
      { onMiss: (sha) => misses.push(sha) }
    )
    check('only the surviving version of each spilled message is fetched', () =>
      assert.deepEqual([...fetched].sort(), [SHA_OK, SHA_GONE].sort())
    )
    check('a fetched body replaces the preview and drops the pointer', () => {
      const c = records[2]!.content as Record<string, unknown>
      assert.equal(c.content, 'the whole reply')
      assert.equal(c.syncOverflow, undefined)
      assert.equal((c.segments as unknown[]).length, 2)
    })
    check('a missing body keeps the preview and reports the miss', () => {
      const c = records[3]!.content as Record<string, unknown>
      assert.ok(String(c.content).includes('the full message is synced alongside'))
      assert.deepEqual(misses, [SHA_GONE])
    })

    // ── 2. the surviving preview rebuilds into segments a renderer can draw ─
    const file = rebuildConversation(META, records)
    check('rebuild keeps every message', () => assert.equal(file.messages.length, 3))
    check('a legacy placeholder segment gets a string delta', () => {
      const segs = (file.messages[2] as { segments?: Array<Record<string, unknown>> }).segments
      assert.ok(segs && segs.length === 1)
      assert.equal(segs[0]!.kind, 'text')
      assert.equal(segs[0]!.delta, '[full segment detail in the message body blob]')
      assert.equal(typeof segs[0]!.turnId, 'string')
      assert.equal(typeof segs[0]!.segmentId, 'string')
    })
    check('a hydrated message is rebuilt untouched', () => {
      const segs = (file.messages[1] as { segments?: Array<Record<string, unknown>> }).segments
      assert.deepEqual(segs, fullBody.segments)
    })
  }

  // ── 3. nothing to hydrate is a no-op, and segment-less messages ride along ─
  {
    const records = [
      record('m_1.11111111', 1, { id: 'm_1', role: 'user', content: 'plain', timestamp: 1 })
    ]
    let called = false
    await hydrateOverflow(records, async () => {
      called = true
      return '{}'
    })
    check('no spilled record, no fetch', () => assert.equal(called, false))
    const file = rebuildConversation(META, records)
    check('a message without segments stays without them', () =>
      assert.equal('segments' in file.messages[0]!, false)
    )
  }

  console.log(`\n${checks} checks passed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
