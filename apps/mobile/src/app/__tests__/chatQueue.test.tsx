/**
 * The chat screen's message queue — what happens to a prompt written while a
 * turn is still running.
 *
 * The rule is the desktop's: it is not refused, it does not enter the feed, and
 * it is sent by the ordinary send path when the running turn ends — one per
 * turn, in the order it was written. Everything here is about WHEN sendPrompt
 * is called, because that is the whole contract: a queued message that goes out
 * early lands in the middle of someone else's turn, and one that never goes out
 * is a message the user believes they sent.
 */

import { cleanup, act, fireEvent, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  // The focus-scoped badge clearing belongs to react-navigation; a no-op
  // keeps this suite free of notification side effects.
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => ({})
}))
jest.mock('expo-image', () => {
  const { View } = require('react-native')
  return { Image: View }
})
jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual('react-native')
  return { WebView: (props: object) => <View {...props} /> }
})
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), remove: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
  setAudioModeAsync: jest.fn()
}))
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({ loop: false, status: 'readyToPlay' }),
  VideoView: () => null
}))
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const fade = { duration: () => fade }
  return { __esModule: true, default: { View }, FadeOut: fade }
})

/**
 * The composer stands in for the whole input: three ways to hand a submit over
 * (so the order the queue keeps is observable), the queue it was given back,
 * and a cancel for the head of it.
 */
jest.mock('@/components/chat/Composer', () => {
  const { Text, View } = require('react-native')
  return {
    Composer: ({
      onSubmit,
      onCancelQueued,
      queued,
      streaming
    }: {
      onSubmit: (p: { kind: 'text'; text: string; files: [] }) => void
      onCancelQueued: (id: string) => void
      queued: { id: string }[]
      streaming: boolean
    }) => (
      <View>
        {['first', 'second', 'third'].map((text) => (
          <Text
            key={text}
            testID={`send-${text}`}
            onPress={() => onSubmit({ kind: 'text', text, files: [] })}
          >
            {streaming ? 'queue' : 'send'}
          </Text>
        ))}
        <Text testID="cancel-head" onPress={() => onCancelQueued(queued[0]?.id ?? '')}>
          cancel
        </Text>
        <Text testID="queued">{String(queued.length)}</Text>
      </View>
    )
  }
})

jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  return {
    FEED_FADE_MS: 0,
    ChatFeed: ({ children }: { children: React.ReactNode }) => <View>{children}</View>
  }
})

const mockConversation: { data: unknown; isFetching: boolean } = {
  data: undefined,
  isFetching: true
}
jest.mock('@/lib/conversations/hooks', () => ({
  useConversation: () => mockConversation
}))

/** Every send is left pending until the test resolves it, exactly as a real
 *  round trip to the desktop would be. */
let mockResolveSend: (value: { conversationId: string }) => void = () => undefined
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: jest.fn(
    () => new Promise<{ conversationId: string }>((resolve) => (mockResolveSend = resolve))
  ),
  abortTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { sendPrompt } from '@/lib/sync/prompt'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'
const send = sendPrompt as jest.MockedFunction<typeof sendPrompt>

let view: Awaited<ReturnType<typeof render>>

async function mount(): Promise<void> {
  view = await render(
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 }
        }}
      >
        <ThemeContext.Provider
          value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
        >
          <ToastProvider>
            <ChatScreen />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

/** The turn the desktop is running right now. */
async function turnRunning(): Promise<void> {
  await act(async () => {
    useChatRuntime.getState().putStream(CONVERSATION, {
      message: { role: 'assistant', content: '', timestamp: 2 },
      status: 'streaming'
    })
    mockResolveSend({ conversationId: CONVERSATION })
  })
}

/** That turn, over — every ending arrives here, this one included. */
async function turnEnded(): Promise<void> {
  await act(async () => {
    useChatRuntime.getState().endStream(CONVERSATION)
  })
}

/** How many rows are waiting above the composer. */
const queuedCount = (): string => view.getByTestId('queued').props.children as string

/**
 * A press WITHOUT act() around it, so several can be put inside one act and
 * land in a single frame — which is the whole subject of the two same-frame
 * tests below. `fireEvent` acts on each press, and a frame it flushes is not
 * the frame being tested.
 */
const press = (testID: string): void => (view.getByTestId(testID).props.onPress as () => void)()

/** The text of the nth prompt handed to the desktop. */
const sentText = (nth: number): unknown => send.mock.calls[nth]?.[0]?.text

afterEach(() => {
  // Two open handles, or the jest worker never exits after the last assertion:
  // the mounted tree (any interval it holds is cleared on unmount) and the query
  // cache (a query that loses its last observer arms a 7-day gc timer).
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {} })
  mockConversation.data = undefined
  mockConversation.isFetching = false
  send.mockClear()
})

describe('queueing messages mid-turn', () => {
  it('holds them in order and sends one per turn, never into a running one', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    expect(send).toHaveBeenCalledTimes(1)
    await turnRunning()

    // Two more, written while the agent is working. Neither is sent, and
    // neither is refused — they wait, in the order they were written.
    await fireEvent.press(view.getByTestId('send-second'))
    await fireEvent.press(view.getByTestId('send-third'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(queuedCount()).toBe('2')

    // The turn ends. The head of the queue goes out by itself — and only the
    // head: the one behind it now waits for THIS turn.
    await turnEnded()
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentText(1)).toBe('second')
    expect(queuedCount()).toBe('1')

    await turnRunning()
    expect(send).toHaveBeenCalledTimes(2)

    await turnEnded()
    expect(send).toHaveBeenCalledTimes(3)
    expect(sentText(2)).toBe('third')
    expect(queuedCount()).toBe('0')
  })

  it('never sends a message taken back out of the queue', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    await fireEvent.press(view.getByTestId('send-second'))
    expect(queuedCount()).toBe('1')
    await fireEvent.press(view.getByTestId('cancel-head'))
    expect(queuedCount()).toBe('0')

    await turnEnded()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentText(0)).toBe('first')
  })

  it('sends a message written while its own send is still in flight, once that send lands', async () => {
    await mount()
    // No turn on screen yet — just this screen's own round trip, which is the
    // race a second tap used to win. It queues on that alone.
    await fireEvent.press(view.getByTestId('send-first'))
    await fireEvent.press(view.getByTestId('send-second'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(queuedCount()).toBe('1')

    // The first send comes back and the desktop never started a turn (an
    // offline reply, or a turn that ended before its status arrived): the
    // screen is idle, so the queue drains on its own.
    await act(async () => mockResolveSend({ conversationId: CONVERSATION }))
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentText(1)).toBe('second')
    expect(queuedCount()).toBe('0')
  })

  /**
   * Two submits inside ONE frame — a double tap on send, or a tap landing in
   * the same commit as the flush. `sending` is state and does not exist yet
   * for the second one, so without the synchronous guard both take the send
   * path: two sendMessage RPCs for one conversation, which the desktop runs in
   * sequence, so the second answer reads as a hang.
   */
  it('queues a second submit handed over before the first send has committed', async () => {
    await mount()
    await act(async () => {
      press('send-first')
      press('send-second')
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentText(0)).toBe('first')
    expect(queuedCount()).toBe('1')

    // And it goes out by itself when the send it was waiting on lands.
    await act(async () => mockResolveSend({ conversationId: CONVERSATION }))
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentText(1)).toBe('second')
    expect(queuedCount()).toBe('0')
  })

  /**
   * The same frame, on the queue side. Both rows are real and both belong in
   * the queue — what must not happen is the two of them sharing an identity,
   * which is what an id read inside the setState updater produces (React runs
   * updaters after both increments). Cancel is the observable: one row taken
   * out must take exactly one row with it.
   */
  it('gives each row its own identity when two are queued in one frame', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    await act(async () => {
      press('send-second')
      press('send-third')
    })
    expect(queuedCount()).toBe('2')

    await fireEvent.press(view.getByTestId('cancel-head'))
    expect(queuedCount()).toBe('1')

    // The survivor is the one behind it, and it is still sendable.
    await turnEnded()
    expect(sentText(1)).toBe('third')
  })

  it('drops the queue when the user walks away to a new chat', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()
    await fireEvent.press(view.getByTestId('send-second'))
    expect(queuedCount()).toBe('1')

    // The + in the header. The turn keeps running in the conversation being
    // left; the reply written to it does not follow the user out.
    await fireEvent.press(view.getByLabelText('New chat'))
    expect(queuedCount()).toBe('0')
    await turnEnded()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
