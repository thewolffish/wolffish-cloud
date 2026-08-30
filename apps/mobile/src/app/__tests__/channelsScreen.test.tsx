jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Channels screen's writing rows and the glyphs the settings list shows
 * for them.
 *
 * The store contract is pinned in state/__tests__/demoConfigSettingsPush.test.ts;
 * this is the half that only exists on screen, and it is the half that breaks
 * silently. Since the any-setting pass every row on this screen writes except
 * the two power switches and the CLI card's status rows — a mistyped field
 * name here would render exactly like its neighbours while going nowhere, and
 * a status row that quietly became a switch would look identical while lying.
 * The assertions are therefore about the wire: tapping a segment has to leave
 * as a configSet naming the key the desktop accepts, and the allow-list
 * fields have to leave ONCE, on end-editing — a Telegram allow-list write
 * restarts the desktop's bridge, so nine keystrokes must not be nine
 * restarts.
 *
 * The summary is the other half: each icon is bound to whether the agent can
 * actually be reached that way, so it must follow the store rather than a
 * mounted value — the desktop can flip any of these while the list is open.
 *
 * No hand-rolled `act`: every tap is a fireEvent settled by waitFor.
 */

const mockRpc = jest.fn()

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return { rpc: mockRpc, connected: true }
    },
    get connected() {
      return true
    },
    subscribe: () => () => undefined,
    reportRpcFailure: jest.fn()
  }
}))

jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (state: { paired: boolean }) => unknown): unknown =>
    selector({ paired: true })
  useAppStore.getState = (): { paired: boolean } => ({ paired: true })
  return { useAppStore }
})

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }))
// The screen's focus refresh belongs to the sync layer, which has its own
// tests; here it would only add an unawaited RPC to every render.
jest.mock('@/lib/sync/useFreshConfig', () => ({ useFreshConfig: () => undefined }))

import ChannelsScreen from '@/app/settings/channels'
import { ChannelsSummary } from '@/components/settings/TabSummaries'
import { ThemeContext } from '@/providers/theme/useTheme'
import { Rpc } from '@/lib/tunnel/protocol'
import { resetOutboxForTests } from '@/lib/sync/outbox'
import { useDemoConfig } from '@/state/demoConfig'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import '@/lib/i18n'

const configSetCalls = (): unknown[][] =>
  mockRpc.mock.calls.filter(([method]) => method === Rpc.configSet)

/** Themed, because the rows reach for it through Input/Select. Awaited:
 *  render resolves asynchronously here, and `screen` is empty until it does. */
async function draw(node: React.ReactElement): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      {node}
    </ThemeContext.Provider>
  )
}

/**
 * Press one segment of the Off | On pair belonging to a named row.
 *
 * `nth` disambiguates the rows that deliberately share a label: "Verbose task
 * results" is the wording every non-phone channel uses, so the screen carries
 * four of them (in-app, Telegram, WhatsApp, CLI) and they are told apart by the
 * card they sit in — which is exactly the desktop's own rule for these labels.
 */
function pressSegment(row: string, segment: 'Off' | 'On', nth = 0): void {
  fireEvent.press(within(screen.getAllByLabelText(row)[nth]).getByText(segment))
}

describe('Channels — this phone', () => {
  beforeEach(() => {
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    useDemoConfig.setState({ mobileNotifications: true, mobileVerbose: false })
  })

  it('renders both settings with the desktop panel’s own words', async () => {
    await draw(<ChannelsScreen />)
    expect(screen.getByText('This phone')).toBeTruthy()
    expect(screen.getByText('Phone notifications')).toBeTruthy()
    expect(screen.getByText(/notify_phone tool/)).toBeTruthy()
    expect(screen.getByText('Task results')).toBeTruthy()
    expect(screen.getByText(/Connection logging is always on/)).toBeTruthy()
  })

  it('switching the feed on writes mobileVerbose to the desktop', async () => {
    await draw(<ChannelsScreen />)
    pressSegment('Task results', 'On')
    await waitFor(() => {
      expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { mobileVerbose: true } }]])
    })
    expect(useDemoConfig.getState().mobileVerbose).toBe(true)
  })

  it('switching notifications off writes mobileNotifications to the desktop', async () => {
    await draw(<ChannelsScreen />)
    pressSegment('Phone notifications', 'Off')
    await waitFor(() => {
      expect(configSetCalls()).toEqual([
        [Rpc.configSet, { settings: { mobileNotifications: false } }]
      ])
    })
    expect(useDemoConfig.getState().mobileNotifications).toBe(false)
  })

  it('a change made on the desktop moves the row without a remount', async () => {
    await draw(<ChannelsScreen />)
    expect(screen.getByLabelText('Task results').props.accessibilityState.checked).toBe(false)
    // What a config.changed push amounts to once its snapshot has applied.
    useDemoConfig.setState({ mobileVerbose: true })
    await waitFor(() => {
      expect(screen.getByLabelText('Task results').props.accessibilityState.checked).toBe(true)
    })
    // Rendering is not writing: nothing left the phone.
    expect(configSetCalls()).toEqual([])
  })
})

/**
 * The desktop-owned channel cards — in-app, Telegram, WhatsApp. Editable
 * since the any-setting pass, except the power switches: starting a bridge
 * is the desktop's own act, so those stay status rows, and that split is
 * exactly what these tests hold in place.
 */
describe('Channels — the desktop-owned rows', () => {
  beforeEach(() => {
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    useDemoConfig.setState({
      inappVerbose: false,
      telegramEnabled: true,
      telegramAllowedUserIds: '429753549',
      telegramAutoRefresh: true,
      whatsappEnabled: true,
      whatsappAutoRefresh: true
    })
  })

  it('the in-app feed switch writes inappVerbose to the desktop', async () => {
    await draw(<ChannelsScreen />)
    // The first "Verbose task results" on the screen is the in-app card's.
    pressSegment('Verbose task results', 'On', 0)
    await waitFor(() => {
      expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { inappVerbose: true } }]])
    })
    expect(useDemoConfig.getState().inappVerbose).toBe(true)
  })

  it('a Telegram preference writes through like any other setting', async () => {
    await draw(<ChannelsScreen />)
    // Telegram's card renders the screen's first "Auto refresh" row.
    pressSegment('Auto refresh', 'Off', 0)
    await waitFor(() => {
      expect(configSetCalls()).toEqual([
        [Rpc.configSet, { settings: { telegramAutoRefresh: false } }]
      ])
    })
    expect(useDemoConfig.getState().telegramAutoRefresh).toBe(false)
  })

  it('the allow-list commits once, when editing ends', async () => {
    await draw(<ChannelsScreen />)
    const input = screen.getByDisplayValue('429753549')
    // Typing alone must put NOTHING on the wire — an allow-list write
    // restarts the desktop's bridge, so the write is one act, on blur.
    fireEvent.changeText(input, '429753549, 1001')
    expect(configSetCalls()).toEqual([])
    fireEvent(input, 'endEditing', { nativeEvent: { text: '429753549, 1001' } })
    await waitFor(() => {
      expect(configSetCalls()).toEqual([
        [Rpc.configSet, { settings: { telegramAllowedUserIds: '429753549, 1001' } }]
      ])
    })
    expect(useDemoConfig.getState().telegramAllowedUserIds).toBe('429753549, 1001')
  })

  it('the power switches stay status rows and never write', async () => {
    await draw(<ChannelsScreen />)
    // Two "Enabled" rows (Telegram, WhatsApp), neither of them a switch: a
    // status row exposes no accessible switch control to press.
    expect(screen.getAllByText('Enabled')).toHaveLength(2)
    expect(screen.queryByLabelText('Enabled')).toBeNull()
  })
})

/**
 * The terminal card. One row writes and four report, and the split is the
 * whole point: `cliVerbose` is an ordinary config key the desktop accepts,
 * while the command's health and the autostart registration are facts about a
 * machine this device only mirrors (see CliStatus). A status row that quietly
 * became a switch would look identical and write nothing.
 */
describe('Channels — the terminal', () => {
  beforeEach(() => {
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    useDemoConfig.setState({
      cliVerbose: false,
      cli: { pathInstalled: true, serviceActive: false, runMode: 'headless', mechanism: 'systemd' }
    })
  })

  it('reports the desktop machine rather than offering to change it', async () => {
    await draw(<ChannelsScreen />)
    expect(screen.getByText('The wolffish command')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('Not registered')).toBeTruthy()
    expect(screen.getByText('Background service')).toBeTruthy()
    expect(screen.getByText('systemd')).toBeTruthy()
    // Reporting, not driving: nothing on this card is a switch except verbose.
    expect(screen.queryByLabelText('Autostart')).toBeNull()
  })

  it('says so when the desktop could not answer, instead of guessing', async () => {
    useDemoConfig.setState({
      cli: { pathInstalled: null, serviceActive: null, runMode: 'gui', mechanism: null }
    })
    await draw(<ChannelsScreen />)
    // Two unknowns and an em dash — never "Not on PATH" for a command nobody
    // probed, which is the one wrong answer this card could give.
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
    expect(screen.queryByText('Not on PATH')).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('switching the terminal feed on writes cliVerbose to the desktop', async () => {
    await draw(<ChannelsScreen />)
    // The fourth "Verbose task results" on the screen: in-app, Telegram,
    // WhatsApp, then the terminal's, in the order the cards render.
    pressSegment('Verbose task results', 'On', 3)
    await waitFor(() => {
      expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { cliVerbose: true } }]])
    })
    expect(useDemoConfig.getState().cliVerbose).toBe(true)
  })

  it('a change made on the desktop moves the row without a remount', async () => {
    await draw(<ChannelsScreen />)
    const row = (): unknown => screen.getAllByLabelText('Verbose task results')[3]
    expect(
      (row() as { props: { accessibilityState: { checked: boolean } } }).props.accessibilityState
        .checked
    ).toBe(false)
    // What a cli:configChange → config.changed → snapshot round trip amounts to.
    useDemoConfig.setState({ cliVerbose: true })
    await waitFor(() => {
      expect(
        (row() as { props: { accessibilityState: { checked: boolean } } }).props.accessibilityState
          .checked
      ).toBe(true)
    })
    expect(configSetCalls()).toEqual([])
  })
})

describe('Channels summary', () => {
  it('reads each channel from its own state, not from being paired', async () => {
    useDemoConfig.setState({
      mobileNotifications: true,
      telegramEnabled: false,
      whatsappEnabled: true,
      cli: { pathInstalled: true, serviceActive: true, runMode: 'gui', mechanism: 'launchd' }
    })
    await draw(<ChannelsSummary />)
    expect(
      screen.getByLabelText('Phone notifications On, CLI On, Telegram Off, WhatsApp On')
    ).toBeTruthy()

    useDemoConfig.setState({ mobileNotifications: false })
    await waitFor(() => {
      expect(
        screen.getByLabelText('Phone notifications Off, CLI On, Telegram Off, WhatsApp On')
      ).toBeTruthy()
    })

    // A command the shell cannot find is a channel you cannot reach — and an
    // unprobed one reads the same way here, because the row is a glance.
    useDemoConfig.setState({
      cli: { pathInstalled: null, serviceActive: true, runMode: 'gui', mechanism: 'launchd' }
    })
    await waitFor(() => {
      expect(
        screen.getByLabelText('Phone notifications Off, CLI Off, Telegram Off, WhatsApp On')
      ).toBeTruthy()
    })
  })
})
