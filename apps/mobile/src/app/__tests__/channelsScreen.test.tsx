jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Channels screen's writing rows and the glyphs the settings list shows
 * for them.
 *
 * The store contract is pinned in state/__tests__/demoConfigSettingsPush.test.ts;
 * this is the half that only exists on screen, and it is the half that breaks
 * silently. Since the any-setting pass every row on this screen writes, so a
 * mistyped field name here would render exactly like its neighbours while
 * going nowhere.
 * The assertions are therefore about the wire: tapping a segment has to leave
 * as a configSet naming the key the desktop accepts, and the allow-list
 * fields have to leave ONCE, on end-editing — a heavyweight desktop write
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

jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
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
import { Rpc } from '@/lib/bridge/protocol'
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
 * `nth` disambiguates rows that deliberately share a label: "Show all tool
 * activity" is the wording every non-phone channel uses, and rows sharing it
 * are told apart by the card they sit in — exactly the desktop's own rule.
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
 * The desktop-owned channel card — in-app. Editable since the any-setting
 * pass; every row is an ordinary config key the desktop accepts.
 */
describe('Channels — the desktop-owned rows', () => {
  beforeEach(() => {
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    useDemoConfig.setState({ inappVerbose: false })
  })

  it('the in-app feed switch writes inappVerbose to the desktop', async () => {
    await draw(<ChannelsScreen />)
    // The first "Show all tool activity" on the screen is the in-app card's.
    pressSegment('Show all tool activity', 'On', 0)
    await waitFor(() => {
      expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { inappVerbose: true } }]])
    })
    expect(useDemoConfig.getState().inappVerbose).toBe(true)
  })
})

describe('Channels summary', () => {
  it('reads the channel from its own state, not from being paired', async () => {
    useDemoConfig.setState({ mobileNotifications: true })
    await draw(<ChannelsSummary />)
    expect(screen.getByLabelText('Phone notifications On')).toBeTruthy()

    // Reachable, not paired: you are looking at the app, so pairing is not the
    // question — whether notify_phone may ring this device is.
    useDemoConfig.setState({ mobileNotifications: false })
    await waitFor(() => {
      expect(screen.getByLabelText('Phone notifications Off')).toBeTruthy()
    })
  })
})
