jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The mid-turn send at the wire — sync/prompt.ts interject and the
 * `interjection.status` pushes that follow it.
 *
 * A message sent while a turn runs is handed to the desktop's turn runner and
 * drawn as a pending row until the desktop says what became of it. Every
 * outcome here is a push, and each has one correct reaction:
 *
 *   pending     the desktop's copy replaces the optimistic row (same id)
 *   delivered   the agent read it — the row comes down, the segment draws it
 *   withdrawn   user / canceled → the words go back to the composer;
 *               turn_ended / error → nothing here; the desktop re-sends it
 *                                    as the next turn under the same id
 *
 * …and only for a message THIS phone sent. Another surface's message merely
 * adds and removes a row. Plus the two ways the hand-over is not one after
 * all: `no_live_turn`, and a desktop too old to know the method.
 */

jest.mock('@/lib/sync/sync', () => ({
  fetchConversationBody: jest.fn(async () => true),
  setConversationSettleHook: jest.fn()
}))

jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn(),
  refetchConversation: jest.fn(async () => undefined),
  conversationHasMessage: () => false
}))

jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))

const mockDb = {
  runAsync: jest.fn(async () => undefined),
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async () => ({ next: 0 })),
  getAllAsync: jest.fn(async () => []),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn(mockDb)
  })
}
jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve(mockDb) }))

type EventHandler = (payload: unknown) => void
const mockHandlers = new Map<string, EventHandler>()
const mockRpc = jest.fn()

jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
    get active() {
      return {
        rpc: mockRpc,
        onEvent: (topic: string, handler: EventHandler) => mockHandlers.set(topic, handler)
      }
    },
    connected: true
  }
}))

import { Event, Rpc } from '@/lib/bridge/protocol'
import { attachTurnStream, interject, isOwnInterjection } from '@/lib/sync/prompt'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'
const ID = 'm_1700000000000_abc123'

function emit(topic: string, payload: unknown): void {
  mockHandlers.get(topic)?.(payload)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const pendingIds = (): string[] =>
  (useChatRuntime.getState().pending[CONVERSATION] ?? []).map((m) => m.id ?? '')

/** The calls made to one RPC method, params only. */
const callsTo = (method: string): Record<string, unknown>[] =>
  mockRpc.mock.calls
    .filter((call) => call[0] === method)
    .map((call) => call[1] as Record<string, unknown>)

/** A desktop that accepts every interjection and every send. */
function desktopAccepts(): void {
  mockRpc.mockImplementation(async (method: string) => {
    if (method === Rpc.interject) return { status: 'pending' }
    if (method === Rpc.sendMessage) return { conversationId: CONVERSATION }
    return {}
  })
}

const withdrawnEvent = (reason: string, messageId = ID, text = 'skip the tests') => ({
  conversationId: CONVERSATION,
  messageId,
  channel: 'mobile',
  text,
  attachments: [],
  state: 'withdrawn',
  reason
})

beforeEach(() => {
  mockRpc.mockReset()
  mockHandlers.clear()
  useChatRuntime.setState({ streams: {}, cards: {}, pending: {}, draftRestores: {} })
  attachTurnStream()
})

describe('handing a message to the running turn', () => {
  it('puts the row up under the caller id and keeps it once the desktop accepts', async () => {
    desktopAccepts()
    const result = await interject({ conversationId: CONVERSATION, messageId: ID, text: 'skip' })
    expect(result).toEqual({ status: 'pending' })
    expect(pendingIds()).toEqual([ID])
    expect(isOwnInterjection(ID)).toBe(true)
    const [params] = callsTo(Rpc.interject)
    expect(params.conversationId).toBe(CONVERSATION)
    expect(params.messageId).toBe(ID)
    expect(params.text).toBe('skip')
    // Nothing about the turn was touched: no overlay opened, none closed.
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('takes the row down and says so when nothing is running', async () => {
    mockRpc.mockImplementation(async () => ({ status: 'no_live_turn' }))
    const result = await interject({ conversationId: CONVERSATION, messageId: ID, text: 'skip' })
    expect(result).toEqual({ status: 'no_live_turn' })
    expect(pendingIds()).toEqual([])
    expect(isOwnInterjection(ID)).toBe(false)
  })

  it('treats a desktop that predates the method the same way', async () => {
    mockRpc.mockImplementation(async () => {
      throw new Error('no handler for desktop.chat.interject')
    })
    const result = await interject({ conversationId: CONVERSATION, messageId: ID, text: 'skip' })
    expect(result).toEqual({ status: 'no_live_turn' })
    expect(pendingIds()).toEqual([])
  })

  it('lets any other failure through, with the row already down', async () => {
    mockRpc.mockImplementation(async () => {
      throw new Error('empty prompt')
    })
    await expect(
      interject({ conversationId: CONVERSATION, messageId: ID, text: 'skip' })
    ).rejects.toThrow('empty prompt')
    expect(pendingIds()).toEqual([])
  })
})

describe('what the desktop says became of it', () => {
  beforeEach(async () => {
    desktopAccepts()
    await interject({ conversationId: CONVERSATION, messageId: ID, text: 'skip the tests' })
  })

  it('replaces the optimistic row with the desktop copy on pending', () => {
    emit(Event.interjection, {
      conversationId: CONVERSATION,
      messageId: ID,
      channel: 'mobile',
      text: 'the transcript of what was said',
      attachments: [],
      voicePrompt: true,
      state: 'pending'
    })
    const rows = useChatRuntime.getState().pending[CONVERSATION] ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('the transcript of what was said')
    expect(rows[0].voicePrompt).toBe(true)
  })

  it('takes the row down when the agent reads it', () => {
    emit(Event.interjection, {
      conversationId: CONVERSATION,
      messageId: ID,
      channel: 'mobile',
      text: 'skip the tests',
      attachments: [],
      state: 'delivered'
    })
    expect(pendingIds()).toEqual([])
    expect(isOwnInterjection(ID)).toBe(false)
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBeUndefined()
  })

  it('hands the words back to the composer when the turn was stopped first', async () => {
    emit(Event.interjection, withdrawnEvent('canceled'))
    await flush()
    expect(pendingIds()).toEqual([])
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBe('skip the tests')
    expect(callsTo(Rpc.sendMessage)).toHaveLength(0)
  })

  it('hands them back when the user withdrew it', async () => {
    emit(Event.interjection, withdrawnEvent('user'))
    await flush()
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBe('skip the tests')
    expect(callsTo(Rpc.sendMessage)).toHaveLength(0)
  })

  /**
   * The turn ended before the agent read it, so the message becomes the next
   * turn — sent by the DESKTOP, not by this phone.
   *
   * It used to be sent here, and that was the hole: this handler only runs if
   * the push arrives, and a phone that is backgrounded, relaunching or off the
   * tunnel at that moment never sees it. The desktop cannot miss an event it
   * emits itself, it holds the transcript, and it keeps the message parked on
   * disk until one exists — so the re-send moved there, and the words survive
   * a phone that is not listening. All this side does now is let the row go;
   * the fresh turn arrives as a normal `message.appended` under the same id.
   */
  it('leaves the re-send to the desktop when the turn ended before reading it', async () => {
    emit(Event.interjection, withdrawnEvent('turn_ended'))
    await flush()
    expect(pendingIds()).toEqual([])
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBeUndefined()
    // Never from here — a second sender under the same id is a duplicate turn.
    expect(callsTo(Rpc.sendMessage)).toHaveLength(0)
  })

  it('does the same when the turn died', async () => {
    emit(Event.interjection, withdrawnEvent('error'))
    await flush()
    expect(pendingIds()).toEqual([])
    expect(callsTo(Rpc.sendMessage)).toHaveLength(0)
  })

  it('only adds and removes rows for a message another surface sent', async () => {
    const theirs = 'm_1700000000001_def456'
    emit(Event.interjection, {
      conversationId: CONVERSATION,
      messageId: theirs,
      channel: 'electron',
      text: 'from the desktop composer',
      attachments: [],
      state: 'pending'
    })
    expect(pendingIds()).toEqual([ID, theirs])
    emit(Event.interjection, withdrawnEvent('turn_ended', theirs, 'from the desktop composer'))
    await flush()
    expect(pendingIds()).toEqual([ID])
    // Not ours to re-send, and not ours to put in the composer.
    expect(callsTo(Rpc.sendMessage)).toHaveLength(0)
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBeUndefined()
  })
})
