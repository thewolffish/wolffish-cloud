/**
 * The composer's hand-over: what leaves it, how many times, and what the field
 * looks like on either side of that.
 *
 * The subject is one press producing one message. The draft is React state, so
 * a second press landing before the first has committed still reads the text
 * that was already handed over — on a phone that is an ordinary double tap, and
 * it used to send (or queue) the same message twice.
 */

import { cleanup, act, fireEvent, render } from '@testing-library/react-native'
import { Keyboard } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
// The rainbow strip and the sheets' entrances; nothing here turns on either.
jest.mock('@/components/chat/RainbowBorder', () => ({ RainbowBorder: () => null }))
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const anim = { duration: () => anim, delay: () => anim, springify: () => anim }
  return { __esModule: true, default: { View }, FadeInDown: anim, FadeInUp: anim, FadeOut: anim }
})
jest.mock('expo-audio', () => ({
  useAudioRecorder: () => ({ prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn() }),
  useAudioRecorderState: () => ({ durationMillis: 0 }),
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
  setAudioModeAsync: jest.fn(),
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} }
}))

import { Composer, type ComposerSubmit } from '@/components/chat/Composer'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'

/** The expanded editor's placeholder — its handle here, and the assertion that
 *  the long copy is the one this surface carries. */
const EXPANDED = 'Message Wolffish — take all the room you need.'
const EXPANDED_QUEUE = 'Queue for Wolffish — this goes out when the current turn ends.'

const onSubmit = jest.fn<void, [ComposerSubmit]>()

let view: Awaited<ReturnType<typeof render>>

async function mount(streaming = false): Promise<void> {
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
            <Composer
              streaming={streaming}
              conversation={null}
              queued={[]}
              onSubmit={onSubmit}
              onCancelQueued={jest.fn()}
              onStop={jest.fn()}
              onNewConversation={jest.fn()}
            />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

/** Type into the field carrying `placeholder`. */
const type = async (placeholder: string, text: string): Promise<void> => {
  await fireEvent.changeText(view.getByPlaceholderText(placeholder), text)
}

/**
 * A press WITHOUT act() around it, so two can be put inside one act and land in
 * a single frame — which is the whole subject of the same-frame tests. Pressable
 * exposes its handler as `onClick` on the host view.
 */
const press = (label: string): void => (view.getByLabelText(label).props.onClick as () => void)()

/** What the one-row field currently holds. */
const fieldValue = (): string => view.getByLabelText('Message Wolffish').props.value as string

const dismissed = jest.spyOn(Keyboard, 'dismiss')

afterEach(() => {
  // Two open handles, or the jest worker never exits after the last assertion:
  // the mounted tree (any interval it holds is cleared on unmount) and the query
  // cache (a query that loses its last observer arms a 7-day gc timer).
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  onSubmit.mockClear()
  dismissed.mockClear()
})

describe('handing a message over', () => {
  it('sends once for two presses in the same frame, and empties the field', async () => {
    await mount()
    await type('Message Wolffish', 'hello')
    await act(async () => {
      press('Send')
      press('Send')
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'text', text: 'hello', files: [] })
    expect(fieldValue()).toBe('')
  })

  it('lets the next message go once the field has repainted', async () => {
    await mount()
    await type('Message Wolffish', 'first')
    await act(async () => press('Send'))
    await type('Message Wolffish', 'second')
    await act(async () => press('Send'))
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]?.[0]).toEqual({ kind: 'text', text: 'second', files: [] })
  })

  /**
   * The keyboard goes with the message. It was holding half the screen for a
   * field that is now empty, and what the user wants that half for is the
   * reply — so it comes down at the hand-over rather than waiting for a tap
   * somewhere neutral.
   */
  it('drops the keyboard when the message leaves', async () => {
    await mount()
    await type('Message Wolffish', 'hello')
    expect(dismissed).not.toHaveBeenCalled()
    await act(async () => press('Send'))
    expect(dismissed).toHaveBeenCalled()
  })

  it('drops it for a queued message too', async () => {
    await mount(true)
    await type('Queue for Wolffish', 'later')
    await act(async () => press('Queue message'))
    expect(dismissed).toHaveBeenCalled()
  })

  it('queues rather than sends mid-turn, and still only once per frame', async () => {
    await mount(true)
    await type('Queue for Wolffish', 'later')
    await act(async () => {
      press('Queue message')
      press('Queue message')
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('the keyboard dismiss bar', () => {
  /**
   * The iPhone keyboard has no dismiss control of its own, so the composer
   * docks one above it: the field names its own accessory by id, and the
   * chevron puts the keyboard away — without touching the draft, which is
   * the difference between hiding the keyboard and abandoning the message.
   */
  it('links the field to its accessory, and the chevron drops the keyboard only', async () => {
    await mount()
    const field = view.getByLabelText('Message Wolffish')
    expect(typeof field.props.inputAccessoryViewID).toBe('string')
    expect(field.props.inputAccessoryViewID.length).toBeGreaterThan(0)
    await type('Message Wolffish', 'still writing')
    await act(async () => press('Hide keyboard'))
    expect(dismissed).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(fieldValue()).toBe('still writing')
  })
})

describe('the expanded editor', () => {
  it('sends its own draft and comes down with it', async () => {
    await mount()
    await act(async () => press('Edit prompt'))
    await type(EXPANDED, 'a much longer prompt')
    await act(async () => press('Send'))

    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'text',
      text: 'a much longer prompt',
      files: []
    })
    // Collapsed with it, and the composer's own field is empty behind it.
    expect(view.queryAllByPlaceholderText(EXPANDED)).toHaveLength(0)
    expect(fieldValue()).toBe('')
  })

  it('names the queue when a turn is running', async () => {
    await mount(true)
    await act(async () => press('Edit prompt'))
    expect(view.getByPlaceholderText(EXPANDED_QUEUE)).toBeTruthy()
  })

  it('commits without sending when Done is used instead', async () => {
    await mount()
    await act(async () => press('Edit prompt'))
    await type(EXPANDED, 'still writing')
    await act(async () => press('Done'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(view.queryAllByPlaceholderText(EXPANDED)).toHaveLength(0)
    expect(fieldValue()).toBe('still writing')
  })
})
