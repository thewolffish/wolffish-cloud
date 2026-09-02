jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The chat controls' permission switch: the Ask/Bypass pair that used to be a
 * Preferences toggle, now riding with the model selection in the ModelSwitch's
 * own track. Two things are load-bearing:
 *
 * - Bypass is the default. The store ships `bypassPermissions: true`, and the
 *   switch must light that segment without anyone touching anything.
 * - A tap writes through `setConfigValue` — the same desktop-editable path the
 *   old toggle used — so the store flips and the description under the track
 *   restates the active stance.
 *
 * No hand-rolled `act`: store writes are settled by waitFor.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { PermissionsSwitch } from '@/components/chat/ChatControls'
import { useDemoConfig } from '@/state/demoConfig'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

/** Awaited: render resolves asynchronously, and `screen` is empty until it does. */
async function draw(): Promise<void> {
  await render(<PermissionsSwitch />)
}

/** The segment's own selected mark — the track renders its pair as tabs. */
const selectedOf = (name: string): boolean | undefined =>
  screen.getByRole('tab', { name }).props.accessibilityState?.selected

afterEach(cleanup)

describe('Permissions switch', () => {
  it('defaults to Bypass — the shipped store value, nobody has to pick it', async () => {
    useDemoConfig.setState({ bypassPermissions: true })
    await draw()
    expect(selectedOf('Bypass')).toBe(true)
    expect(selectedOf('Ask')).toBe(false)
    expect(
      screen.getByText('Skip permission prompts — the agent acts without asking.')
    ).toBeTruthy()
  })

  it('tapping Ask flips the store and the description restates the stance', async () => {
    useDemoConfig.setState({ bypassPermissions: true })
    await draw()
    fireEvent.press(screen.getByText('Ask'))
    await waitFor(() => expect(useDemoConfig.getState().bypassPermissions).toBe(false))
    expect(selectedOf('Ask')).toBe(true)
    expect(
      screen.getByText('Ask before sensitive actions — approvals appear in chat.')
    ).toBeTruthy()
  })

  it('tapping Bypass from Ask goes back — the pair is a two-way switch', async () => {
    useDemoConfig.setState({ bypassPermissions: false })
    await draw()
    expect(selectedOf('Ask')).toBe(true)
    fireEvent.press(screen.getByText('Bypass'))
    await waitFor(() => expect(useDemoConfig.getState().bypassPermissions).toBe(true))
    expect(selectedOf('Bypass')).toBe(true)
  })

  it('follows the store, so a desktop change moves the switch without a remount', async () => {
    useDemoConfig.setState({ bypassPermissions: true })
    await draw()
    // What a snapshot carrying the desktop's own config amounts to.
    useDemoConfig.setState({ bypassPermissions: false })
    await waitFor(() => expect(selectedOf('Ask')).toBe(true))
    expect(selectedOf('Bypass')).toBe(false)
  })
})
