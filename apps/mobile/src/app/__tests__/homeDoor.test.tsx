jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The door, for a phone a previous pairing left data on.
 *
 * A revoked phone — unpaired from the desktop's Mobile panel, signed out by
 * an admin, an expired session — lands back here on its next launch still
 * holding every conversation, file and setting it synced. The screen that
 * erases them lives in Settings, on the far side of this door, so without an
 * exit here the only way to clear that copy off the phone is to reinstall
 * the app. These pin the exit: offered when there IS something to erase,
 * absent on a fresh install, and it runs the real device wipe.
 */

jest.mock('@/lib/conversations/repo', () => ({ countConversations: jest.fn() }))
jest.mock('@/lib/demo/factoryReset', () => ({ factoryResetDevice: jest.fn() }))
jest.mock('@/lib/demo/reset', () => ({ purgeDemoState: jest.fn() }))
jest.mock('@/lib/demo/importer', () => ({
  applyConfigSnapshot: jest.fn(),
  fetchDemoManifest: jest.fn(),
  importDemoData: jest.fn()
}))
jest.mock('@/lib/sync/sync', () => ({ attachLiveUpdates: jest.fn(), initialSync: jest.fn() }))
jest.mock('@/lib/sync/prompt', () => ({ attachTurnStream: jest.fn() }))
jest.mock('@/lib/conversations/cache', () => ({ invalidateConversationList: jest.fn() }))
jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: { subscribe: () => () => undefined, resume: jest.fn(), current: { online: false } }
}))
jest.mock('@/lib/notifications/push', () => ({
  forgetLaunchDeeplink: () => undefined,
  launchDeeplink: null
}))
jest.mock('@/components/common/build-info/BuildInfo', () => ({ BuildInfo: (): null => null }))

const mockAppState = {
  paired: false,
  demoMode: false,
  demoVersion: null,
  setPaired: jest.fn(),
  setDemoMode: jest.fn(),
  setDemoVersion: jest.fn()
}
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

jest.mock('expo-image', () => ({ Image: (): null => null }))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }))
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({
  Redirect: (): null => null,
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({})
}))

import Home from '@/app/index'
import { countConversations } from '@/lib/conversations/repo'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

const mockCount = jest.mocked(countConversations)
const mockFactoryReset = jest.mocked(factoryResetDevice)

async function draw(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <LocaleContext.Provider
        value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
      >
        <Home />
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAppState.paired = false
  mockAppState.demoMode = false
  mockFactoryReset.mockResolvedValue(undefined)
  mockCount.mockResolvedValue(0)
})

describe('a phone a previous pairing left data on', () => {
  it('offers the erase, and erasing runs the device wipe', async () => {
    mockCount.mockResolvedValue(42)
    await draw()

    const erase = await screen.findByText('Erase this phone')
    fireEvent.press(erase)

    expect(await screen.findByText('Erase everything on this phone?')).toBeTruthy()
    const buttons = screen.getAllByText('Erase')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() => expect(mockFactoryReset).toHaveBeenCalled())
    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
    )
    // Nothing is left to erase, so the exit goes with it.
    await waitFor(() => expect(screen.queryByText('Erase this phone')).toBeNull())
  })

  it('is not offered on a fresh install — there is nothing to erase', async () => {
    await draw()
    await waitFor(() => expect(mockCount).toHaveBeenCalled())
    expect(screen.queryByText('Erase this phone')).toBeNull()
  })
})
