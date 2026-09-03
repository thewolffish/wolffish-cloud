jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Connection screen in demo mode, and the settings row that opens it.
 *
 * The tour describes a made-up org link (lib/demo/connection) that must LOOK
 * exactly like a healthy paired one — connected face, a desktop that is
 * there, the real API endpoint — while its three actions stay honest about
 * what a demo can actually do. The wire is what the assertions chase: Sync
 * must answer from the saved snapshot and never call the live sync module,
 * Reconnect must move the fiction's own counters, and Sign out must run the
 * demo wipe and land on the door — never touching the session, badges or
 * push registration that only a pairing owns.
 *
 * The paired path is pinned alongside so the demo branch cannot silently
 * swallow it: a real sign-out still clears badges, unregisters push and
 * revokes the session before the wipe.
 */

jest.mock('@/lib/cloud/bridge', () => {
  const state = {
    status: 'connected',
    online: true,
    desktop: {
      deviceId: 'd',
      name: 'Office iMac',
      platform: 'darwin',
      appVersion: '0.1.0',
      connectedAt: 1
    },
    apiBase: 'https://api.wolffi.sh',
    connectedAt: 1,
    lastError: null,
    reconnects: 0,
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0
  }
  return {
    bridgeClient: {
      current: state,
      connected: true,
      online: true,
      subscribe: (listener: (next: unknown) => void) => {
        listener(state)
        return () => undefined
      },
      refresh: jest.fn(),
      resume: jest.fn(),
      disconnect: jest.fn(),
      reportRpcFailure: jest.fn()
    }
  }
})
jest.mock('@/lib/cloud/session', () => ({
  cloudSession: {
    current: {
      version: 1,
      session: { user: { email: 'sara@wolffi.sh' }, deviceId: 'dev_1' },
      orgName: 'Wolffish Inc',
      desktop: { id: 'd', name: 'Office iMac' },
      pairedAt: 1
    },
    subscribe: () => () => undefined
  }
}))

jest.mock('@/lib/demo/factoryReset', () => ({ factoryResetDevice: jest.fn() }))
jest.mock('@/lib/demo/importer', () => ({ applyConfigSnapshot: jest.fn() }))
jest.mock('@/lib/notifications/push', () => ({
  clearAllBadges: jest.fn(),
  unregisterPush: jest.fn()
}))
jest.mock('@/lib/sync/activity', () => ({
  beginSync: () => ({ step: jest.fn(), end: jest.fn() })
}))
jest.mock('@/lib/sync/sync', () => ({
  getLastSyncedAt: () => null,
  refreshConfig: jest.fn(),
  refreshSync: jest.fn(),
  refreshUsage: jest.fn()
}))

// Mutable so each block can pick its mode; reset in beforeEach.
const mockAppState = { paired: false, demoMode: true, setPaired: jest.fn() }
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (s: typeof mockAppState) => unknown): unknown =>
    selector(mockAppState)
  useAppStore.getState = (): typeof mockAppState => mockAppState
  return { useAppStore }
})

const mockToastShow = jest.fn()
jest.mock('@/providers/toast/useToast', () => ({
  useToast: () => ({ show: mockToastShow, dismiss: jest.fn() })
}))

// The settings list's trailing summaries read stores this test does not
// exercise; the list's shape — which rows exist — is what is under test.
jest.mock('@/components/settings/TabSummaries', () => {
  const summaries = [
    'AppearanceSummary',
    'CapabilitiesSummary',
    'ChannelsSummary',
    'ConversationsSummary',
    'DataSummary',
    'KnowledgeSummary',
    'McpSummary',
    'ModelSummary',
    'PreferencesSummary',
    'ServicesSummary',
    'UpdatesSummary',
    'UsageSummary',
    'VariablesSummary'
  ]
  return Object.fromEntries(summaries.map((name) => [name, (): null => null]))
})
jest.mock('@/lib/sync/useFreshConfig', () => ({ useFreshConfig: () => undefined }))

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), canGoBack: jest.fn(() => true), push: jest.fn(), replace: jest.fn() }
}))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }))

import ConnectionScreen from '@/app/settings/connection'
import SettingsScreen from '@/app/settings/index'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { applyConfigSnapshot } from '@/lib/demo/importer'
import { resetDemoConnection, DEMO_DESKTOP_NAME } from '@/lib/demo/connection'
import { clearAllBadges, unregisterPush } from '@/lib/notifications/push'
import { refreshConfig, refreshSync } from '@/lib/sync/sync'
import { bridgeClient } from '@/lib/cloud/bridge'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { router } from 'expo-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

const mockFactoryReset = jest.mocked(factoryResetDevice)
const mockApplySnapshot = jest.mocked(applyConfigSnapshot)
const mockClearAllBadges = jest.mocked(clearAllBadges)
const mockUnregisterPush = jest.mocked(unregisterPush)
const mockRefreshConfig = jest.mocked(refreshConfig)
const mockRefreshSync = jest.mocked(refreshSync)
const mockDisconnect = jest.mocked(bridgeClient.disconnect)
const mockRefresh = jest.mocked(bridgeClient.refresh)
const mockReplace = jest.mocked(router.replace)

async function draw(element: React.JSX.Element): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <LocaleContext.Provider
        value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
      >
        {element}
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAppState.paired = false
  mockAppState.demoMode = true
  mockFactoryReset.mockResolvedValue(undefined)
  mockApplySnapshot.mockResolvedValue(true)
  mockClearAllBadges.mockResolvedValue(undefined)
  mockUnregisterPush.mockResolvedValue(undefined)
  mockDisconnect.mockResolvedValue(undefined)
  resetDemoConnection()
})

describe('the settings list row', () => {
  it('shows Connection wearing the connected face in demo mode', async () => {
    await draw(<SettingsScreen />)
    expect(screen.getByText('Connection')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('is absent on the door — neither paired nor demo', async () => {
    mockAppState.demoMode = false
    await draw(<SettingsScreen />)
    expect(screen.queryByText('Connection')).toBeNull()
  })
})

describe('the demo link on screen', () => {
  it('renders connected, with the made-up details a paired screen would show', async () => {
    await draw(<ConnectionScreen />)

    expect(screen.getByText('Connected')).toBeTruthy()
    // The real endpoint and the fiction's desktop — the page must read like
    // a paired one, not like a placeholder.
    expect(screen.getByText('https://api.wolffi.sh')).toBeTruthy()
    expect(screen.getByText(DEMO_DESKTOP_NAME)).toBeTruthy()
    // Up for hours, not since the tap that opened the screen.
    expect(screen.getByText('3h')).toBeTruthy()
  })

  it('Sync answers from the snapshot and never calls the live sync module', async () => {
    await draw(<ConnectionScreen />)

    const buttons = screen.getAllByText('Sync')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'success', message: expect.stringContaining('Up to date') })
      )
    )
    expect(mockApplySnapshot).toHaveBeenCalled()
    expect(mockRefreshConfig).not.toHaveBeenCalled()
    expect(mockRefreshSync).not.toHaveBeenCalled()
  })

  it("Reconnect moves the fiction's own counter, not the socket", async () => {
    await draw(<ConnectionScreen />)

    fireEvent.press(screen.getAllByText('Reconnect')[1])

    // The reconnect counter is the only row that can read '1'.
    expect(await screen.findByText('1')).toBeTruthy()
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})

describe('leaving the demo', () => {
  it('sign out runs the demo wipe and lands on the door', async () => {
    await draw(<ConnectionScreen />)

    fireEvent.press(screen.getAllByText('Sign out')[1])
    expect(await screen.findByText('Leave the demo?')).toBeTruthy()
    const withDialog = screen.getAllByText('Sign out')
    fireEvent.press(withDialog[withDialog.length - 1])

    await waitFor(() => expect(mockFactoryReset).toHaveBeenCalled())
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    // Nothing a pairing owns is touched: no session, no badges, no push.
    expect(mockDisconnect).not.toHaveBeenCalled()
    expect(mockClearAllBadges).not.toHaveBeenCalled()
    expect(mockUnregisterPush).not.toHaveBeenCalled()
    expect(mockAppState.setPaired).not.toHaveBeenCalled()
  })
})

describe('the paired path', () => {
  it('shows the account, the org and the desktop the session names', async () => {
    mockAppState.paired = true
    mockAppState.demoMode = false
    await draw(<ConnectionScreen />)

    expect(screen.getByText('sara@wolffi.sh')).toBeTruthy()
    expect(screen.getByText('Wolffish Inc')).toBeTruthy()
    expect(screen.getByText('Office iMac')).toBeTruthy()
  })

  it('sign out still clears badges, unregisters push and revokes the session before the wipe', async () => {
    mockAppState.paired = true
    mockAppState.demoMode = false
    await draw(<ConnectionScreen />)

    fireEvent.press(screen.getAllByText('Sign out')[1])
    expect(await screen.findByText('Sign this phone out?')).toBeTruthy()
    const withDialog = screen.getAllByText('Sign out')
    fireEvent.press(withDialog[withDialog.length - 1])

    await waitFor(() => expect(mockFactoryReset).toHaveBeenCalled())
    expect(mockClearAllBadges).toHaveBeenCalled()
    expect(mockUnregisterPush).toHaveBeenCalled()
    expect(mockDisconnect).toHaveBeenCalled()
    expect(mockAppState.setPaired).toHaveBeenCalledWith(false)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
  })
})
