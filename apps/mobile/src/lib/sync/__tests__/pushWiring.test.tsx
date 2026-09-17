/**
 * The phone must tell the bridge it can be pushed — from production code.
 *
 * `attachNotificationHandlers` does two jobs behind one call: it subscribes
 * to the tunnel's `notification` topic AND records that tunnel as the socket
 * the push module sends on. Everything push-side is gated on that record —
 * `register_push`, `unregister_push`, `set_badge` all return early without
 * it — so a build that never calls it registers no token, and the bridge
 * answers every notify `dropped (no phone registered for push)` while in-band
 * frames land on a socket with no handler and go unacked.
 *
 * That is exactly what shipped: the call lived in the pre-cloud tunnel client
 * and was not carried across when the phone moved onto the org bridge. The
 * function kept its own unit tests — which call it directly — so nothing went
 * red. This test asserts the WIRING instead: mount the hook, bring the socket
 * up, and require the connect edge to attach and register.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockAttachNotifications = jest.fn()
const mockRefreshPush = jest.fn()
jest.mock('@/lib/notifications/push', () => ({
  attachNotificationHandlers: (tunnel: unknown) => mockAttachNotifications(tunnel),
  refreshPushRegistration: () => mockRefreshPush(),
  reconcilePresentedNotifications: jest.fn()
}))
jest.mock('@/lib/sync/overlays', () => ({ seedOverlays: jest.fn(), clearOverlays: jest.fn() }))
jest.mock('@/lib/sync/updater', () => ({
  seedDesktopUpdater: jest.fn(),
  clearDesktopUpdater: jest.fn()
}))
jest.mock('@/lib/sync/sync', () => ({
  attachLiveUpdates: jest.fn(),
  reconcile: jest.fn(async () => undefined),
  refreshConfig: jest.fn(async () => undefined)
}))
jest.mock('@/lib/sync/prompt', () => ({
  attachTurnStream: jest.fn(),
  seedActiveRuns: jest.fn(async () => undefined)
}))

// `mock`-prefixed: jest hoists these factories above the file, and only names
// it can prove are mocks may cross that boundary.
type BridgeState = { online: boolean; desktop: string | null }
let mockEmitState: ((state: BridgeState) => void) | null = null
jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
    resume: jest.fn(async () => true),
    subscribe: (listener: (state: BridgeState) => void) => {
      mockEmitState = listener
      return () => undefined
    },
    get connected() {
      return false
    },
    get online() {
      return false
    }
  }
}))

jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: jest.fn() })
}))

import { useConnection } from '@/lib/sync/useConnection'
import { bridgeClient } from '@/lib/cloud/bridge'
import { useAppStore } from '@/state/appStore'
import { cleanup, render } from '@testing-library/react-native'

function Host(): null {
  useConnection()
  return null
}

afterEach(() => {
  cleanup()
  mockAttachNotifications.mockClear()
  mockRefreshPush.mockClear()
  mockEmitState = null
})

describe('push wiring', () => {
  it('attaches the notification handlers to the live tunnel when the socket forms', async () => {
    useAppStore.setState({ paired: true })
    await render(<Host />)
    expect(mockEmitState).not.toBeNull()

    mockEmitState?.({ online: true, desktop: null })

    // The tunnel it attaches to must be the one the app actually talks on —
    // handlers on any other object leave `activeTunnel` pointing nowhere.
    expect(mockAttachNotifications).toHaveBeenCalledWith(bridgeClient)
    // A cold start connects without any AppState change, so this edge is the
    // only thing that registers the token on a freshly launched app.
    expect(mockRefreshPush).toHaveBeenCalled()
  })

  it('re-attaches after the socket drops and comes back', async () => {
    useAppStore.setState({ paired: true })
    await render(<Host />)

    mockEmitState?.({ online: true, desktop: null })
    mockEmitState?.({ online: false, desktop: null })
    mockEmitState?.({ online: true, desktop: null })

    // Per topic, so re-attaching replaces rather than stacks — and the new
    // socket is a new registration, not an inherited one.
    expect(mockAttachNotifications).toHaveBeenCalledTimes(2)
    expect(mockRefreshPush).toHaveBeenCalledTimes(2)
  })
})
