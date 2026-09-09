jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * Spilled messages, on the way back into the phone.
 *
 * A message too big for one record is synced by the desktop as a 4,000-char
 * preview plus a `syncOverflow` pointer to a blob holding the whole message
 * (apps/desktop/src/main/cloud/sync.ts wireMessage). Two things must hold
 * for the phone's catch-up, and both failed silently before this suite:
 *
 *   1. The body comes back. The catch-up fetched the record pages and
 *      stored them as-is, so a long reply restored from the cloud read as
 *      its preview — a truncated message that looks like a finished one.
 *   2. What cannot be hydrated still renders as prose. Rows written before
 *      2026-09-08 carry the placeholder as `{kind:'text', text}` with no
 *      `delta`, and the feed concatenates `delta` — so the bubble showed the
 *      literal word "undefined". The admin transcript reads the same
 *      records through the same rebuild, so it showed the same word.
 *
 * The rules mirror apps/desktop/src/main/cloud/restore.ts and its
 * restore-overflow test; a change to one side belongs on both.
 *
 * No fake timers here. (Were one added, it goes LAST: `jest.useFakeTimers()`
 * poisons every test declared after it — see src/app/__tests__/
 * leaderboardScreen.test.tsx.)
 */

import { hydrateOverflow, rebuildConversation, rebuiltToMessages } from '@/lib/sync/rebuild'
import { buildRenderBlocks } from '@/lib/conversations/segments'
import type { WireRecord } from '@/lib/cloud/api'

// ---------------------------------------------------------------- fixtures

const SHA_OK = 'a'.repeat(64)
const SHA_GONE = 'b'.repeat(64)
const SHA_SUPERSEDED = 'c'.repeat(64)

const fullBody = {
  id: 'm2',
  role: 'assistant',
  content: 'the whole reply',
  timestamp: 1_700_000_000_002,
  segments: [
    { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'the whole reply' },
    { kind: 'tool_call', turnId: 't1', segmentId: 's2', toolCallId: 'c1', name: 'bash', args: {} }
  ]
}

/** A message record as the org stores it (base id + content-hash suffix). */
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

const PREVIEW =
  'the whole re\n\n[… 300,000 characters; the full message is synced alongside this record]'

/** The spilled record exactly as rows written before 2026-09-08 carry it. */
const legacyStub = (id: string, sha: string): Record<string, unknown> => ({
  id,
  role: 'assistant',
  content: PREVIEW,
  timestamp: 1_700_000_000_002,
  segments: [{ kind: 'text', text: '[full segment detail in the message body blob]' }],
  syncOverflow: { sha256: sha, bytes: 300_000, name: `.records/conv-c/${id}.json` }
})

const fetchBody =
  (fetched: string[]) =>
  async (sha: string): Promise<string> => {
    fetched.push(sha)
    if (sha === SHA_OK) return JSON.stringify(fullBody)
    throw new Error('http_404 (HTTP 404)')
  }

// ------------------------------------------------------ the pure transform

describe('hydrateOverflow', () => {
  it('fetches only the surviving version of each spilled message', async () => {
    const fetched: string[] = []
    const records = [
      rec('m1', 1, { id: 'm1', role: 'user', content: 'hi', timestamp: 1 }),
      // An earlier version of m2 shares the survivor's blob NAME, so its sha
      // is gone from the store — a fetch would be a guaranteed 404.
      rec('m2', 2, legacyStub('m2', SHA_SUPERSEDED), '00000000'),
      rec('m2', 2, legacyStub('m2', SHA_OK), '22222222'),
      rec('m3', 3, legacyStub('m3', SHA_GONE), '33333333')
    ]
    await hydrateOverflow(records, fetchBody(fetched))
    expect([...fetched].sort()).toEqual([SHA_OK, SHA_GONE].sort())
  })

  it('a fetched body replaces the preview and drops the pointer', async () => {
    const records = [rec('m2', 2, legacyStub('m2', SHA_OK))]
    await hydrateOverflow(records, fetchBody([]))
    const content = records[0]!.content as Record<string, unknown>
    expect(content.content).toBe('the whole reply')
    expect(content.syncOverflow).toBeUndefined()
    expect(content.segments).toHaveLength(2)
  })

  it('a body that will not come keeps the preview and reports the miss', async () => {
    const records = [rec('m3', 3, legacyStub('m3', SHA_GONE))]
    const misses: string[] = []
    await hydrateOverflow(records, fetchBody([]), { onMiss: (sha) => misses.push(sha) })
    const content = records[0]!.content as Record<string, unknown>
    expect(content.content).toBe(PREVIEW)
    expect(content.syncOverflow).toEqual(expect.objectContaining({ sha256: SHA_GONE }))
    expect(misses).toEqual([SHA_GONE])
  })

  it('a body that is not a message object is treated as a miss', async () => {
    const records = [rec('m2', 2, legacyStub('m2', SHA_OK))]
    const misses: string[] = []
    await hydrateOverflow(records, async () => '"just a string"', {
      onMiss: (sha) => misses.push(sha)
    })
    expect((records[0]!.content as Record<string, unknown>).content).toBe(PREVIEW)
    // Not an error, not a miss: the record simply keeps what it had.
    expect(misses).toEqual([])
    await hydrateOverflow(records, async () => 'not json', { onMiss: (sha) => misses.push(sha) })
    expect(misses).toEqual([SHA_OK])
  })

  it('does not fetch at all when nothing spilled', async () => {
    let called = false
    const records = [rec('m1', 1, { id: 'm1', role: 'user', content: 'plain', timestamp: 1 })]
    const out = await hydrateOverflow(records, async () => {
      called = true
      return '{}'
    })
    expect(called).toBe(false)
    expect(out).toBe(records)
  })
})

// ------------------------------------------------- the placeholder renders

describe('rebuildConversation — legacy placeholder segments', () => {
  it('gives a text segment without a delta one, so the feed never prints "undefined"', () => {
    const messages = rebuiltToMessages(
      rebuildConversation([rec('m3', 3, legacyStub('m3', SHA_GONE))])
    )
    const segments = messages[0]!.segments!
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual(
      expect.objectContaining({
        kind: 'text',
        delta: '[full segment detail in the message body blob]',
        turnId: expect.any(String),
        segmentId: expect.any(String)
      })
    )
    const blocks = buildRenderBlocks(messages[0]!)
    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'text',
        markdown: '[full segment detail in the message body blob]'
      })
    ])
    expect(JSON.stringify(blocks)).not.toContain('undefined')
  })

  it('coerces a reasoning segment the same way, and leaves every other kind alone', () => {
    const messages = rebuiltToMessages(
      rebuildConversation([
        rec('m1', 1, {
          id: 'm1',
          role: 'assistant',
          content: 'done',
          segments: [
            { kind: 'reasoning', content: 'thinking…' },
            { kind: 'tool_call', segmentId: 's2', toolCallId: 'c1', name: 'bash', args: {} },
            { kind: 'separator' }
          ]
        })
      ])
    )
    const segments = messages[0]!.segments as Array<Record<string, unknown>>
    expect(segments[0]).toEqual(expect.objectContaining({ kind: 'reasoning', delta: 'thinking…' }))
    expect(segments[1]).toEqual({
      kind: 'tool_call',
      segmentId: 's2',
      toolCallId: 'c1',
      name: 'bash',
      args: {}
    })
    expect(segments[2]).toEqual({ kind: 'separator' })
  })

  it('leaves a segment that already carries a delta exactly as written', () => {
    const messages = rebuiltToMessages(
      rebuildConversation([rec('m2', 2, { ...fullBody, syncOverflow: undefined })])
    )
    expect(messages[0]!.segments).toEqual(fullBody.segments)
  })

  it('a message without segments stays without them', () => {
    const rebuilt = rebuildConversation([
      rec('m1', 1, { id: 'm1', role: 'user', content: 'plain', timestamp: 1 })
    ])
    expect(rebuilt.messages[0]!.payload).toBeUndefined()
  })
})

// ---------------------------------------- through the catch-up, end to end

const mockRunCalls: Array<{ sql: string; args: unknown[] }> = []
const mockRunAsync = jest.fn(async (sql: string, args: unknown[] = []) => {
  mockRunCalls.push({ sql, args })
  return { changes: 1 }
})
const mockDb = {
  runAsync: mockRunAsync,
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async (sql: string) => {
    if (sql.includes('updated_at FROM conversations')) return { updated_at: 1_000 }
    if (sql.includes('COUNT(*) AS count FROM messages')) return { count: 0 }
    return null
  }),
  getAllAsync: jest.fn(async () => []),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({ runAsync: mockRunAsync, execAsync: mockDb.execAsync })
  })
}
jest.mock('@/lib/db/database', () => ({
  getDb: () => Promise.resolve(mockDb),
  withExclusiveTransaction: (db: typeof mockDb, task: (tx: unknown) => Promise<void>) =>
    db.withExclusiveTransactionAsync(task)
}))

const mockRecords = jest.fn()
const mockFileText = jest.fn()
jest.mock('@/lib/cloud/api', () => ({
  conversationsSince: jest.fn(),
  conversationRecords: (...args: unknown[]) => mockRecords(...args),
  fileTextBySha: (...args: unknown[]) => mockFileText(...args),
  usageDays: jest.fn(async () => ({ days: [] }))
}))
jest.mock('@/lib/cloud/session', () => ({
  cloudSession: {
    isSignedIn: true,
    withAccessToken: async (fn: (token: string) => Promise<unknown>) => fn('phone-token')
  }
}))
jest.mock('@/lib/sync/snapshot', () => ({ fetchConfigSnapshot: jest.fn(async () => ({})) }))
jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
    get active() {
      return null
    },
    connected: false,
    online: true
  }
}))
jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn()
}))
jest.mock('@/state/demoConfig', () => ({
  useDemoConfig: { getState: () => ({ applySnapshot: jest.fn(), setUsageDays: jest.fn() }) },
  applyPushedSnapshot: jest.fn(),
  applyVariablesPush: jest.fn(),
  refreshConfigSnapshot: jest.fn(async () => undefined)
}))

import { fetchConversationBody } from '@/lib/sync/sync'

describe('fetchConversationBody — spilled messages', () => {
  beforeEach(() => {
    mockRunCalls.length = 0
    mockRecords.mockReset()
    mockFileText.mockReset()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  const inserted = (): Array<{ id: string; content: string; payload: Record<string, unknown> }> =>
    mockRunCalls
      .filter(({ sql }) => sql.startsWith('INSERT INTO messages'))
      .map(({ args }) => ({
        id: args[2] as string,
        content: args[4] as string,
        payload: JSON.parse(String(args[6])) as Record<string, unknown>
      }))

  it('stores the whole message, read through the blob route with the phone’s own token', async () => {
    mockRecords.mockResolvedValue({
      records: [
        rec('m1', 1, { id: 'm1', role: 'user', content: 'hi', timestamp: 1 }),
        rec('m2', 2, legacyStub('m2', SHA_SUPERSEDED), '00000000'),
        rec('m2', 2, legacyStub('m2', SHA_OK), '22222222')
      ],
      next_after: null
    })
    mockFileText.mockImplementation((_token: string, sha: string) => fetchBody([])(sha))

    expect(await fetchConversationBody('c')).toBe(true)

    expect(mockFileText).toHaveBeenCalledTimes(1)
    expect(mockFileText).toHaveBeenCalledWith('phone-token', SHA_OK)
    const rows = inserted()
    expect(rows.map((r) => r.content)).toEqual(['hi', 'the whole reply'])
    expect(rows[1]!.payload.segments).toHaveLength(2)
    expect(rows[1]!.payload.syncOverflow).toBeUndefined()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('keeps the preview — as renderable prose — when the blob is gone', async () => {
    mockRecords.mockResolvedValue({
      records: [rec('m3', 3, legacyStub('m3', SHA_GONE))],
      next_after: null
    })
    mockFileText.mockImplementation((_token: string, sha: string) => fetchBody([])(sha))

    expect(await fetchConversationBody('c')).toBe(true)

    const rows = inserted()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(PREVIEW)
    const segments = rows[0]!.payload.segments as Array<Record<string, unknown>>
    expect(segments[0]!.delta).toBe('[full segment detail in the message body blob]')
    // The pointer stays, so the next pull tries the blob again.
    expect(rows[0]!.payload.syncOverflow).toEqual(expect.objectContaining({ sha256: SHA_GONE }))
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
