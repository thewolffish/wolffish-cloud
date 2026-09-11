/**
 * A voice take, from the composer's tick to the wire.
 *
 * The recorder hands the screen `{kind:'voice'}` and nothing else: no text, no
 * picked file, just a URI and a length. What has to happen after that is the
 * whole point of this test — the take becomes an ordinary audio attachment and
 * rides the SAME staging → upload → send pipeline every file takes, with one
 * extra bit set. Two things would break silently without it:
 *
 *  - the flag. Without `voicePrompt: true` the desktop treats the audio as an
 *    attachment to transcribe-on-demand rather than the prompt itself, and the
 *    turn runs with an empty message.
 *  - the attachment. A voice send with no file reaches the desktop as an empty
 *    prompt, which it refuses — the take would vanish with no error to show.
 */

import { cleanup, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
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

/** The composer's only role here: hand the screen one finished take. */
jest.mock('@/components/chat/Composer', () => {
  const { Text } = require('react-native')
  return {
    Composer: ({
      onSubmit
    }: {
      onSubmit: (p: { kind: 'voice'; uri: string; durationSeconds: number }) => void
    }) => (
      <Text
        testID="send-voice"
        onPress={() =>
          onSubmit({ kind: 'voice', uri: 'file:///cache/take.m4a', durationSeconds: 12 })
        }
      >
        send
      </Text>
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
jest.mock('@/lib/conversations/hooks', () => ({
  useConversation: () => ({ data: undefined, isFetching: false })
}))
jest.mock('@/lib/cloud/bridge', () => ({
  // `subscribe` is what `useDesktopReachable` reaches for; with no listener
  // ever called, `connected` stays at the `true` this mock opens with.
  bridgeClient: { connected: true, active: {}, subscribe: () => () => {} }
}))

/** The staging pipeline, stubbed at its seams — the test is about what the
 *  screen asks of it, not about moving bytes. */
type Picked = {
  id: string
  uri: string
  name: string
  mimeType: string
  sizeBytes: number
  durationSeconds?: number
}
const mockUploadForSend = jest.fn(
  async (entries: { picked: Picked }[], conversationId: string | null) => ({
    attachments: entries.map((e) => ({
      type: 'audio' as const,
      filePath: `uploads/conv-x/${e.picked.name}`,
      originalName: e.picked.name,
      mimeType: e.picked.mimeType,
      sizeBytes: 4096,
      sha256: 'deadbeef'
    })),
    failed: [] as string[],
    conversationId: conversationId ?? 'conv-voice'
  })
)
jest.mock('@/lib/sync/attachments', () => ({
  stageForSend: jest.fn(async (files: Picked[]) =>
    files.map((picked) => ({
      picked,
      staged: { uri: 'file:///staged/take.m4a', relPath: 'staged/take.m4a', sizeBytes: 4096 }
    }))
  ),
  stagedAttachment: (entry: { picked: Picked; staged: { relPath: string } }) => ({
    type: 'audio' as const,
    filePath: entry.staged.relPath,
    originalName: entry.picked.name,
    mimeType: entry.picked.mimeType,
    sizeBytes: entry.picked.sizeBytes
  }),
  uploadForSend: (...args: Parameters<typeof mockUploadForSend>) => mockUploadForSend(...args),
  fileLocally: jest.fn(async () => []),
  discardStaged: jest.fn()
}))

type SentPrompt = {
  conversationId: string | null
  text: string
  voicePrompt?: boolean
  attachments?: { type: string }[]
}
const mockSendPrompt = jest.fn(async (_input: SentPrompt) => ({ conversationId: 'conv-voice' }))
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: (input: SentPrompt) => mockSendPrompt(input),
  abortTurn: jest.fn(),
  beginTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'
import { act, fireEvent, screen } from '@testing-library/react-native'

async function mount(): Promise<void> {
  await render(
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

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {} })
  mockSendPrompt.mockClear()
  mockUploadForSend.mockClear()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('sending a voice take', () => {
  it('uploads the audio and sends it as the prompt itself', async () => {
    await mount()
    await act(async () => {
      fireEvent.press(screen.getByTestId('send-voice'))
    })

    // Staged and uploaded like any other attachment — one audio file, named
    // the way the desktop names a recording.
    expect(mockUploadForSend).toHaveBeenCalledTimes(1)
    const [entries] = mockUploadForSend.mock.calls[0]
    expect(entries).toHaveLength(1)
    expect(entries[0].picked.name).toMatch(/^voice-\d+\.m4a$/)
    expect(entries[0].picked.mimeType).toBe('audio/mp4')
    expect(entries[0].picked.durationSeconds).toBe(12)

    // …and sent as the prompt: no text, the flag on, the attachment attached.
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const sent = mockSendPrompt.mock.calls[0][0]
    expect(sent.text).toBe('')
    expect(sent.voicePrompt).toBe(true)
    expect(sent.attachments?.[0]?.type).toBe('audio')
  })
})
