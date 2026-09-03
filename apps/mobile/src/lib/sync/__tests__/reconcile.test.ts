jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * Reconciliation is the half of sync nobody sees working.
 *
 * Pushes cover the phone while it is awake; this covers everything it slept
 * through, and every miss here is silent by nature — a conversation deleted
 * on the desktop that lingers on the phone looks exactly like a real one,
 * and a body that stopped growing looks exactly like a finished answer. The
 * source is the org now (the index with its tombstones, the record pages a
 * body is rebuilt from), so the cases pinned here are the ones with no
 * visible symptom: deletions the cursor carries, staleness that emptiness
 * cannot detect, and the stamp a rebuilt body is filed under.
 */

type Row = {
  id: string
  updated_at: number
  body_synced_at: number | null
  message_count?: number
}

const mockState: { rows: Row[]; messages: Record<string, number> } = { rows: [], messages: {} }
const mockRunCalls: Array<{ sql: string; args: unknown[] }> = []

const mockRunAsync = jest.fn(async (sql: string, args: unknown[] = []) => {
  mockRunCalls.push({ sql, args })
  if (sql.startsWith('DELETE FROM conversations')) {
    const before = mockState.rows.length
    mockState.rows = mockState.rows.filter((r) => r.id !== args[0])
    return { changes: before - mockState.rows.length }
  }
  if (sql.startsWith('DELETE FROM messages')) delete mockState.messages[args[0] as string]
  if (sql.startsWith('UPDATE conversations SET updated_at = MAX')) {
    const row = mockState.rows.find((r) => r.id === args[1])
    if (row) row.updated_at = Math.max(row.updated_at, args[0] as number)
  }
  if (sql.startsWith('UPDATE conversations SET body_synced_at')) {
    const row = mockState.rows.find((r) => r.id === args[2])
    if (row) {
      row.body_synced_at = args[0] as number
      row.message_count = args[1] as number
    }
  }
  if (sql.startsWith('INSERT INTO conversations')) {
    const id = args[0] as string
    const updated = args[8] as number
    const row = mockState.rows.find((r) => r.id === id)
    if (!row) mockState.rows.push({ id, updated_at: updated, body_synced_at: null })
    else if (updated >= row.updated_at) row.updated_at = updated
  }
  return { changes: 1 }
})

const mockDb = {
  runAsync: mockRunAsync,
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM sync_meta')) return { value: mockCursor }
    if (sql.includes('COUNT(*) AS count FROM messages')) {
      return { count: mockState.messages[args[0] as string] ?? 0 }
    }
    if (sql.includes('body_synced_at FROM conversations')) {
      return mockState.rows.find((r) => r.id === args[0]) ?? null
    }
    if (sql.includes('updated_at FROM conversations')) {
      return mockState.rows.find((r) => r.id === args[0]) ?? null
    }
    return null
  }),
  getAllAsync: jest.fn(async () => mockState.rows.map((r) => ({ id: r.id }))),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({ runAsync: mockRunAsync, execAsync: mockDb.execAsync })
  })
}
let mockCursor = ''

jest.mock('@/lib/db/database', () => ({
  getDb: () => Promise.resolve(mockDb),
  // The real helper only adds a busy-timeout PRAGMA before the task.
  withExclusiveTransaction: (db: typeof mockDb, task: (tx: unknown) => Promise<void>) =>
    db.withExclusiveTransactionAsync(task)
}))

// The org, mocked at the client: an index the test scripts page by page,
// and record pages per conversation.
const mockSince = jest.fn()
const mockRecords = jest.fn()
const mockUsage = jest.fn(async (..._args: unknown[]) => ({ days: [] as unknown[] }))
jest.mock('@/lib/cloud/api', () => ({
  conversationsSince: (...args: unknown[]) => mockSince(...args),
  conversationRecords: (...args: unknown[]) => mockRecords(...args),
  usageDays: (...args: unknown[]) => mockUsage(...args)
}))
jest.mock('@/lib/cloud/session', () => ({
  cloudSession: {
    isSignedIn: true,
    withAccessToken: async (fn: (token: string) => Promise<unknown>) => fn('token')
  }
}))
const mockSnapshot = jest.fn(async () => ({}))
jest.mock('@/lib/sync/snapshot', () => ({
  fetchConfigSnapshot: () => mockSnapshot()
}))

const mockHandlers = new Map<string, (payload: unknown) => void>()
jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
    get active() {
      return {
        rpc: jest.fn(),
        onEvent: (topic: string, handler: (payload: unknown) => void) => {
          mockHandlers.set(topic, handler)
        }
      }
    },
    connected: true,
    online: true
  }
}))

jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn()
}))
const cacheMock = jest.requireMock('@/lib/conversations/cache') as {
  invalidateConversation: jest.Mock
  invalidateConversationList: jest.Mock
}

jest.mock('@/state/demoConfig', () => ({
  useDemoConfig: { getState: () => ({ applySnapshot: jest.fn(), setUsageDays: jest.fn() }) },
  applyPushedSnapshot: jest.fn(),
  applyVariablesPush: jest.fn(),
  // The config half of reconcile delegates here (outbox-aware wrapper); the
  // mock keeps the observable behavior — one snapshot fetch that can fail
  // independently — so the assertions below stay about reconcile's contract.
  refreshConfigSnapshot: async () => {
    await mockSnapshot()
  }
}))

import {
  attachLiveUpdates,
  fetchConversationBody,
  isBodyStale,
  refreshSync,
  reconcile,
  setConversationSettleHook
} from '@/lib/sync/sync'
import { setActiveConversation } from '@/lib/notifications/push'
import { Event } from '@/lib/bridge/protocol'
import { useChatRuntime } from '@/state/chatRuntime'
import type { ConversationMessage } from '@/lib/conversations/types'

/** One org index row, in the shape `GET /v1/conversations?since` answers. */
const wireRow = (id: string, updatedAtMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  device_id: null,
  created_at: new Date(updatedAtMs).toISOString(),
  updated_at: new Date(updatedAtMs).toISOString(),
  deleted_at: null,
  ...extra
})

/** A message record as the org stores it (base id + content-hash suffix). */
const rec = (base: string, seq: number, content: Record<string, unknown>, suffix = 'aaaaaaaa') => ({
  id: `${base}.${suffix}`,
  seq,
  kind: 'message',
  content,
  created_at: new Date(seq).toISOString()
})

const envelope = (seq: number, updatedAt: number) => ({
  id: `snap.c`,
  seq,
  kind: 'snapshot',
  content: { id: 'c', title: 'c', updatedAt },
  created_at: new Date(seq).toISOString()
})

/** Serve one page of records, then the terminator. */
const serveRecords = (records: unknown[]): void => {
  mockRecords.mockResolvedValue({ records, next_after: null })
}

beforeEach(() => {
  mockState.rows = []
  mockState.messages = {}
  mockRunCalls.length = 0
  mockCursor = ''
  mockSince.mockReset().mockResolvedValue({ conversations: [], next: null, cursor: null })
  mockRecords.mockReset()
  mockSnapshot.mockReset().mockResolvedValue({})
  mockHandlers.clear()
  cacheMock.invalidateConversation.mockClear()
  cacheMock.invalidateConversationList.mockClear()
  useChatRuntime.getState().reset()
  setConversationSettleHook(() => undefined)
  setActiveConversation(null)
})

/** Let the fire-and-forget handler chains drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Conversation ids the org was asked record pages for, in call order. */
const bodyCalls = (): string[] => mockRecords.mock.calls.map(([, id]) => id as string)

const liveMessage = (id: string): ConversationMessage => ({
  id,
  role: 'assistant',
  content: 'streaming',
  timestamp: 1
})

const putStream = (conversationId: string, status: 'streaming' | 'complete'): void => {
  useChatRuntime.getState().putStream(conversationId, {
    base: liveMessage('m-live'),
    tail: '',
    status,
    channel: null,
    message: liveMessage('m-live'),
    ...(status === 'complete' ? { ended: 'desktop' as const } : {})
  })
}

describe('refreshSync deletion reconciliation', () => {
  it('drops local conversations the org tombstoned while the phone slept', async () => {
    mockState.rows = [
      { id: 'kept', updated_at: 1, body_synced_at: 1 },
      { id: 'deleted-while-asleep', updated_at: 1, body_synced_at: 1 }
    ]
    mockState.messages['deleted-while-asleep'] = 3
    mockSince.mockResolvedValue({
      conversations: [
        wireRow('deleted-while-asleep', 1, { deleted_at: new Date(200).toISOString() })
      ],
      next: null,
      cursor: '2026-01-01T00:00:00.200Z~~9'
    })

    const result = await refreshSync(true)

    expect(result.removed).toBe(1)
    expect(mockState.rows.map((r) => r.id)).toEqual(['kept'])
    // Its messages go too — a body with no conversation is unreachable bytes.
    expect(mockState.messages['deleted-while-asleep']).toBeUndefined()
  })

  it('asks from the stored cursor and stores the one the org answers', async () => {
    mockCursor = '2026-01-01T00:00:00.000Z~~4'
    mockSince.mockResolvedValue({
      conversations: [],
      next: null,
      cursor: '2026-01-02T00:00:00.000Z~~7'
    })

    await refreshSync()

    expect(mockSince.mock.calls[0][1]).toBe('2026-01-01T00:00:00.000Z~~4')
    const stored = mockRunCalls.find(({ sql }) => sql.startsWith('INSERT INTO sync_meta'))
    expect(stored?.args).toEqual(['cursor', '2026-01-02T00:00:00.000Z~~7'])
  })

  it('walks every page before it is done', async () => {
    mockSince
      .mockResolvedValueOnce({
        conversations: [wireRow('a', 100)],
        next: 'p2',
        cursor: '2026-01-01T00:00:00.100Z~~1'
      })
      .mockResolvedValueOnce({
        conversations: [wireRow('b', 200)],
        next: null,
        cursor: '2026-01-01T00:00:00.200Z~~2'
      })

    const result = await refreshSync()

    expect(result.changed).toBe(2)
    expect(mockSince.mock.calls[1][1]).toBe('2026-01-01T00:00:00.100Z~~1')
    expect(mockState.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('never prunes the conversation on screen — it goes on the first sweep after they leave', async () => {
    mockState.rows = [{ id: 'on-screen', updated_at: 1, body_synced_at: 1 }]
    mockState.messages['on-screen'] = 4
    setActiveConversation('on-screen')
    mockSince.mockResolvedValue({
      conversations: [wireRow('on-screen', 1, { deleted_at: new Date(200).toISOString() })],
      next: null,
      cursor: 'x~~1'
    })

    expect((await refreshSync(true)).removed).toBe(0)
    expect(mockState.rows.map((r) => r.id)).toEqual(['on-screen'])
    expect(mockState.messages['on-screen']).toBe(4)

    setActiveConversation(null)
    expect((await refreshSync(true)).removed).toBe(1)
    expect(mockState.rows).toEqual([])
  })
})

describe('body staleness', () => {
  it('is stale when the org changed it after the last body pull', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 400 }]
    expect(await isBodyStale('c')).toBe(true)
  })

  it('is stale when the body was never pulled', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: null }]
    expect(await isBodyStale('c')).toBe(true)
  })

  it('is current when the body pull is at least as new as the change', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: 400 }]
    expect(await isBodyStale('c')).toBe(false)
  })

  it('stamps body_synced_at so the next open trusts the cache', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    serveRecords([rec('m1', 1, { id: 'm1', role: 'user', content: 'hi', timestamp: 1 })])

    await fetchConversationBody('c')

    expect(await isBodyStale('c')).toBe(false)
  })

  it('leaves the stamp unset when the write fails, so the copy is retried', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    serveRecords([envelope(5, 400)])
    mockDb.withExclusiveTransactionAsync.mockRejectedValueOnce(new Error('disk full'))

    await expect(fetchConversationBody('c')).rejects.toThrow()
    expect(await isBodyStale('c')).toBe(true)
  })
})

describe('reconcile', () => {
  it('brings config, conversations and usage level in one pass', async () => {
    await reconcile()

    expect(mockSnapshot).toHaveBeenCalled()
    expect(mockSince).toHaveBeenCalled()
    expect(mockUsage).toHaveBeenCalled()
  })

  // Half a reconcile is better than none: an org that cannot answer for
  // settings must still be able to correct the conversation list.
  it('still syncs conversations when the config pull fails', async () => {
    mockState.rows = [{ id: 'gone', updated_at: 1, body_synced_at: null }]
    mockSnapshot.mockRejectedValue(new Error('no config'))
    mockSince.mockResolvedValue({
      conversations: [wireRow('gone', 1, { deleted_at: new Date(9).toISOString() })],
      next: null,
      cursor: 'x~~1'
    })

    await expect(reconcile()).resolves.toBeUndefined()
    expect(mockState.rows).toEqual([])
  })
})

describe('fetchConversationBody', () => {
  it('rebuilds the transcript from the record pages: last-received version per message, seq order', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    serveRecords([
      rec('m2', 20, { id: 'm2', role: 'assistant', content: 'second', timestamp: 20 }),
      // Two versions of m1 (an edit): the one the org received last wins.
      rec('m1', 10, { id: 'm1', role: 'user', content: 'first (old)', timestamp: 10 }, 'bbbbbbbb'),
      rec('m1', 11, { id: 'm1', role: 'user', content: 'first', timestamp: 11 }, 'cccccccc'),
      envelope(30, 1_000)
    ])

    expect(await fetchConversationBody('c')).toBe(true)

    const inserts = mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO messages'))
    expect(inserts.map(({ args }) => args[4])).toEqual(['first', 'second'])
    expect(inserts.map(({ args }) => args[2])).toEqual(['m1', 'm2'])
  })

  it('a stale copy with the younger seq loses to the corrected one, and the prompt stays above its reply', async () => {
    // Seen live: the desktop pushed a prompt stamped 1.5 s after its own
    // reply, then the corrected copy sharing the reply's millisecond. By
    // seq the stale copy is "newest" and sorts under the reply; by receipt
    // it is simply superseded.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    serveRecords([
      envelope(5, 1_000),
      rec('u', 1_500, { id: 'u', role: 'user', content: 'prompt', timestamp: 1_500 }, '0000000a'),
      rec('u', 100, { id: 'u', role: 'user', content: 'prompt', timestamp: 100 }, '0000000b'),
      rec('a', 100, { id: 'a', role: 'assistant', content: 'reply', timestamp: 100 }),
      // A later envelope replaces the earlier one the same way.
      envelope(6, 2_000)
    ])

    expect(await fetchConversationBody('c')).toBe(true)

    const inserts = mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO messages'))
    expect(inserts.map(({ args }) => args[2])).toEqual(['u', 'a'])
    expect(inserts.map(({ args }) => args[5])).toEqual([100, 100])
    const stamp = mockRunCalls.find(({ sql }) => sql.includes('body_synced_at'))
    expect(stamp?.args).toContain(2_000)
  })

  it('stamps the envelope clock, not this phone clock', async () => {
    // The silent bug: body_synced_at taken from Date.now() is compared
    // against a timestamp the *desktop* wrote. A phone running ahead makes
    // every conversation look current and it never refreshes again.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    serveRecords([
      envelope(5, 1_000),
      rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })
    ])

    await fetchConversationBody('c')

    expect(mockState.rows[0].body_synced_at).toBe(1_000)
    expect(await isBodyStale('c')).toBe(false)
  })

  it('stamps the version the org served, not the one this phone knew about', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: 1_000 }]
    serveRecords([
      envelope(5, 2_000),
      rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })
    ])

    await fetchConversationBody('c')
    expect(mockState.rows[0].body_synced_at).toBe(2_000)

    mockState.rows[0].updated_at = 2_000
    expect(await isBodyStale('c')).toBe(false)
  })

  it('falls back to what it knew when asked if the org serves no envelope', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    serveRecords([rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })])

    await fetchConversationBody('c')

    expect(mockState.rows[0].body_synced_at).toBe(1_000)
  })

  it('records the version it actually fetched, so a mid-fetch change refetches', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRecords.mockImplementation(async () => {
      // The desktop pushes while the body is in flight; the index moves
      // before the write completes.
      mockState.rows[0].updated_at = 2_000
      return {
        records: [rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })],
        next_after: null
      }
    })

    await fetchConversationBody('c')

    expect(mockState.rows[0].body_synced_at).toBe(1_000)
    expect(await isBodyStale('c')).toBe(true)
  })

  it('never wipes a good transcript when the answer is malformed', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: 1_000 }]
    mockState.messages['c'] = 12
    for (const bad of [{}, { records: null }, { records: 'nope' }, undefined]) {
      mockRecords.mockResolvedValue(bad)
      expect(await fetchConversationBody('c')).toBe(false)
      expect(mockState.messages['c']).toBe(12)
    }
  })

  it('refuses an empty answer over a transcript this phone holds', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockState.messages['c'] = 3
    serveRecords([envelope(5, 1_000)])

    expect(await fetchConversationBody('c')).toBe(false)
    expect(mockState.messages['c']).toBe(3)
  })

  it('still syncs a conversation that is genuinely empty on both sides', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    serveRecords([envelope(5, 1_000)])

    expect(await fetchConversationBody('c')).toBe(true)
    expect(await isBodyStale('c')).toBe(false)
  })

  it('refuses an empty answer while a live turn overlays the conversation', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    putStream('c', 'streaming')
    serveRecords([envelope(5, 1_000)])

    expect(await fetchConversationBody('c')).toBe(false)
    expect(await isBodyStale('c')).toBe(true)
  })

  it('pages every record page before rebuilding', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRecords
      .mockResolvedValueOnce({
        records: [rec('m1', 1, { id: 'm1', role: 'user', content: 'a', timestamp: 1 })],
        next_after: 1
      })
      .mockResolvedValueOnce({
        records: [rec('m2', 2, { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 })],
        next_after: null
      })

    expect(await fetchConversationBody('c')).toBe(true)

    expect(mockRecords.mock.calls.map(([, , after]) => after)).toEqual([0, 1])
    const inserts = mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO messages'))
    expect(inserts).toHaveLength(2)
  })
})

/**
 * The aggressive half of catch-up: metadata alone cannot un-stale a
 * transcript, and the pushes that normally would were exactly what the phone
 * slept through. These pin the three rules — changed conversations re-read,
 * cached-and-stale bodies refetch under a cap, and live-turn conversations
 * are left to the turn machinery.
 */
describe('aggressive catch-up', () => {
  it('refreshSync invalidates every changed conversation, not just the list', async () => {
    mockSince.mockResolvedValue({
      conversations: [wireRow('a', 300), wireRow('b', 200)],
      next: null,
      cursor: 'x~~2'
    })

    await refreshSync(false)

    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('a')
    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('b')
  })

  it('a row without an id never reaches the store', async () => {
    mockSince.mockResolvedValue({
      conversations: [{ title: 'ghost', updated_at: 'x' }, null, { id: '', updated_at: 'x' }],
      next: null,
      cursor: 'x~~2'
    })

    await refreshSync(false)

    expect(mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO conversations'))).toEqual(
      []
    )
    expect(cacheMock.invalidateConversation).not.toHaveBeenCalled()
  })

  it('reconcile refetches the newest stale cached bodies, capped', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
    mockState.rows = ids.map((id, i) => ({ id, updated_at: (i + 1) * 100, body_synced_at: 1 }))
    for (const id of ids) mockState.messages[id] = 2
    mockSince.mockResolvedValue({
      conversations: ids.map((id, i) => wireRow(id, (i + 1) * 100)),
      next: null,
      cursor: 'x~~6'
    })
    mockRecords.mockResolvedValue({
      records: [
        envelope(999, 999),
        rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })
      ],
      next_after: null
    })

    await reconcile()

    expect(bodyCalls()).toEqual(['c6', 'c5', 'c4', 'c3'])
  })

  it('reconcile leaves a conversation with a running turn to the turn machinery', async () => {
    mockState.rows = [
      { id: 'busy', updated_at: 500, body_synced_at: 1 },
      { id: 'idle', updated_at: 400, body_synced_at: 1 }
    ]
    mockState.messages['busy'] = 2
    mockState.messages['idle'] = 2
    putStream('busy', 'streaming')
    mockSince.mockResolvedValue({
      conversations: [wireRow('busy', 500), wireRow('idle', 400)],
      next: null,
      cursor: 'x~~2'
    })
    mockRecords.mockResolvedValue({
      records: [
        envelope(999, 999),
        rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })
      ],
      next_after: null
    })

    await reconcile()

    expect(bodyCalls()).toEqual(['idle'])
  })
})

/**
 * The pushes, as the bridge delivers them: `conversation.upserted` is the
 * desktop's own view and only ever invalidates; `conversation.synced` is the
 * org confirming the records landed — the one signal a body may be fetched
 * on and expected to carry the turn just watched.
 */
describe('pushes', () => {
  const emit = async (topic: string, payload: Record<string, unknown>): Promise<void> => {
    attachLiveUpdates()
    mockHandlers.get(topic)?.(payload)
    await flush()
  }

  it('upserted always invalidates the conversation, and fetches nothing itself', async () => {
    mockState.rows = [{ id: 'c', updated_at: 100, body_synced_at: 1 }]
    mockState.messages['c'] = 3

    await emit(Event.conversationUpserted, { id: 'c', updatedAt: 500, title: 'c' })

    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('c')
    expect(bodyCalls()).toEqual([])
  })

  it('synced refetches a cached body the org just moved past', async () => {
    mockState.rows = [{ id: 'c', updated_at: 100, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    mockRecords.mockResolvedValue({
      records: [
        envelope(500, 500),
        rec('m', 1, { id: 'm', role: 'user', content: 'x', timestamp: 1 })
      ],
      next_after: null
    })

    await emit(Event.conversationSynced, { id: 'c', updatedAt: 500 })
    await flush()

    expect(bodyCalls()).toEqual(['c'])
  })

  it('synced fetches nothing mid-turn — the body in the org predates the turn', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    putStream('c', 'streaming')

    await emit(Event.conversationSynced, { id: 'c', updatedAt: 500 })
    await flush()

    expect(bodyCalls()).toEqual([])
  })

  it('synced hands a just-ended turn to the settle path instead of racing it', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    putStream('c', 'complete')
    const settle = jest.fn()
    setConversationSettleHook(settle)

    await emit(Event.conversationSynced, { id: 'c', updatedAt: 500 })
    await flush()

    expect(settle).toHaveBeenCalledWith('c')
    expect(bodyCalls()).toEqual([])
  })

  it('a config push carrying its snapshot applies it without a fetch', async () => {
    const { applyPushedSnapshot } = jest.requireMock('@/state/demoConfig') as {
      applyPushedSnapshot: jest.Mock
    }
    await emit(Event.configChanged, { section: 'x', at: 1, snapshot: { capabilities: [] } })
    expect(applyPushedSnapshot).toHaveBeenCalled()
    expect(mockSnapshot).not.toHaveBeenCalled()
  })
})
