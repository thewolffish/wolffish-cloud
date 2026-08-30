/**
 * The rows a queued message shows while it waits.
 *
 * They are all a user has to go on: the message is not in the feed, so the row
 * IS the record that something was written and will be sent. Each kind has to
 * describe itself — a prompt by its text, an attachment-only prompt by its file
 * names, a take by its length — and each has to be removable.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 })
}))

import { QueuedPromptTray, type QueuedPrompt } from '@/components/chat/QueuedPrompts'
// Nothing under test reaches i18n's init on its own, and untranslated rows
// would pass every assertion that isn't about their words.
import '@/lib/i18n'
import type { PickedFile } from '@/lib/files/pickAttachments'

const file = (name: string): PickedFile => ({
  id: name,
  uri: `file:///cache/${name}`,
  name,
  mimeType: 'image/jpeg',
  sizeBytes: 1024
})

// RTL 14 renders through act() and publishes the result asynchronously.
async function draw(prompts: QueuedPrompt[], onCancel = jest.fn()): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <QueuedPromptTray prompts={prompts} onCancel={onCancel} />
    </ThemeContext.Provider>
  )
}

describe('the queued-prompt tray', () => {
  it('shows nothing at all when the queue is empty', async () => {
    await draw([])
    expect(screen.toJSON()).toBeNull()
  })

  it('describes each waiting message by whatever it has to describe it', async () => {
    await draw([
      { id: 'q_1', kind: 'text', text: 'and then deploy it', files: [] },
      { id: 'q_2', kind: 'text', text: '', files: [file('receipt.jpg'), file('invoice.pdf')] },
      { id: 'q_3', kind: 'voice', uri: 'file:///cache/take.m4a', durationSeconds: 75 }
    ])

    expect(screen.getByText('and then deploy it')).toBeTruthy()
    // No caption: the files are the message, so they are the label.
    expect(screen.getByText('receipt.jpg, invoice.pdf')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    // The count glyph says nothing on its own — the row carries the words.
    expect(screen.getByLabelText('2 attachments')).toBeTruthy()
    // Nothing to preview — the desktop transcribes a take when it is sent, not
    // when it is queued — so the row offers its length and playback instead.
    expect(screen.getByText('Voice message')).toBeTruthy()
    expect(screen.getByText('1:15')).toBeTruthy()
    expect(screen.getByLabelText('Play')).toBeTruthy()
  })

  it('takes back the row that was tapped, and only that one', async () => {
    const onCancel = jest.fn()
    await draw(
      [
        { id: 'q_1', kind: 'text', text: 'first', files: [] },
        { id: 'q_2', kind: 'text', text: 'second', files: [] }
      ],
      onCancel
    )
    fireEvent.press(screen.getAllByLabelText('Remove from queue')[1])
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith('q_2')
  })
})
