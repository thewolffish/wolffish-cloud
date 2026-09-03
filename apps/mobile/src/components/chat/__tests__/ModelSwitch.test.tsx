jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The model row in the cloud edition: one lane through the organization's
 * API, so the Local/Cloud switch is gone and what stands in its place shows
 * the desktop's current model and never offers a choice. Pinned here:
 *
 * - the row names the model the store holds, and "No model" when it holds
 *   none — the same fallback the composer's chip uses;
 * - the cloud desktop stamps `brainProvider: 'cloud'` (or nothing at all),
 *   and both render — no "?" box, no crash on an id the vendor map lacks;
 * - nothing on it is a tab: there is no local side to flip to any more.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { ModelSwitch } from '@/components/chat/ModelSwitch'
import { useDemoConfig } from '@/state/demoConfig'
import { cleanup, render, screen } from '@testing-library/react-native'
import '@/lib/i18n'

afterEach(cleanup)

describe('ModelSwitch (org lane)', () => {
  it('shows the desktop’s current model', async () => {
    useDemoConfig.setState({ brainProvider: 'cloud', brainModel: 'qwen3-235b' })
    await render(<ModelSwitch />)
    expect(screen.getByText('qwen3-235b')).toBeTruthy()
    expect(screen.getByLabelText('qwen3-235b')).toBeTruthy()
  })

  it('says "No model" when the store holds none', async () => {
    useDemoConfig.setState({ brainProvider: '', brainModel: '' })
    await render(<ModelSwitch />)
    expect(screen.getByText('No model')).toBeTruthy()
  })

  it('offers nothing to switch — no tabs, no local side', async () => {
    useDemoConfig.setState({ brainProvider: 'cloud', brainModel: 'qwen3-235b' })
    await render(<ModelSwitch />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})
