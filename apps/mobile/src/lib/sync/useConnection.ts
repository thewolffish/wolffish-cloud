import { reconcilePresentedNotifications, refreshPushRegistration } from '@/lib/notifications/push'
import { clearOverlays, seedOverlays } from '@/lib/sync/overlays'
import { clearDesktopUpdater, seedDesktopUpdater } from '@/lib/sync/updater'
import { attachLiveUpdates, reconcile } from '@/lib/sync/sync'
import { attachTurnStream, seedActiveRuns } from '@/lib/sync/prompt'
import { bridgeClient } from '@/lib/cloud/bridge'
import { cloudSession } from '@/lib/cloud/session'
import { loadApiBase } from '@/lib/cloud/api'
import { useAppStore } from '@/state/appStore'
// Type-only, and it has to stay that way — see watchNetwork for why a value
// import of this module is a launch crash rather than a caught failure.
import type { NetworkStateType } from 'expo-network'
import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

/**
 * Keeps the org link alive across the app's lifecycle.
 *
 * iOS suspends a backgrounded app within seconds, so the socket dies whenever
 * the user leaves and must be rebuilt when they return. That is the normal
 * cycle, not an error: reconnecting is one authenticated upgrade in well
 * under a second, and the org keeps the desktop's end parked.
 *
 * Three separate jobs, deliberately not fused:
 *
 * Getting connected is the bridge client's own affair. It retries with
 * backoff, times out a dial that hangs, and tears down a socket that has
 * gone quiet — so it keeps working the whole time the app is open, not only
 * at launch. All this hook adds is a nudge when the user comes back, because
 * returning to the app is evidence the network probably returned too — and,
 * more to the point, the moment when what the socket believes about itself
 * is least likely to be true.
 *
 * Noticing the network moved is the third, and it exists because the other
 * two only fire when the USER does something. A phone that walks out of wifi
 * range onto cellular never backgrounds and never taps anything: the socket
 * dies bound to an interface that no longer exists, and nothing announces it.
 *
 * Catching up hangs off the ORG being reachable, not off the desktop being
 * there and not off the app opening. The phone's mirror is the org's record:
 * every time the socket forms, the index, the settings and usage are brought
 * level — with or without a desktop — and only the desktop-dependent seeds
 * (active runs, the overlay stack, the updater) wait for the desktop to
 * appear on the bridge.
 */

/**
 * Start connecting NOW — before React renders, before the persisted store has
 * rehydrated, before anything on screen exists to care. Everything the dial
 * needs is in the keystore, which is why it can run this early. Idempotent
 * and self-cancelling: no stored session does nothing at all, and the hook's
 * own resume() joins this attempt instead of starting a second.
 */
export function dialStoredSession(): void {
  void loadApiBase()
    .then(() => cloudSession.load())
    .then(() => bridgeClient.resume())
    .catch(() => undefined)
}

export function useConnection(): void {
  const paired = useAppStore((state) => state.paired)
  const setPaired = useAppStore((state) => state.setPaired)

  // The org revoked this phone (unpaired from the desktop, an admin, a
  // sign-out elsewhere): the session is gone, and so is "paired". The door
  // is next; demo mode is one tap away there.
  useEffect(
    () =>
      cloudSession.subscribe((session, reason) => {
        if (!session && reason && reason !== 'signed_out') setPaired(false)
      }),
    [setPaired]
  )

  useEffect(() => {
    if (!paired) return

    const kick = (patient = false): void => {
      void bridgeClient.resume(patient).catch(() => undefined)
    }

    kick()

    let lastState: AppStateStatus = AppState.currentState
    const onChange = (next: AppStateStatus): void => {
      const was = lastState
      lastState = next
      if (next !== 'active') return
      // Only a return from a REAL background gets the probe-and-catch-up
      // treatment: 'inactive' is the control centre or a permission sheet,
      // JS keeps running and the socket keeps its keepalive cadence. A
      // socket that is NOT up is still kicked from any return.
      if (was === 'background' || !bridgeClient.online) {
        kick()
        // A brief background can leave the socket intact — iOS suspends JS
        // before the OS gets around to killing the connection — and anything
        // pushed meanwhile is simply gone. The edge-triggered catch-up below
        // only fires when a connection re-FORMS, so a still-open return
        // needs its own reconcile.
        if (bridgeClient.online) void reconcile().catch(() => undefined)
      }
      // Every foreground re-upserts the push registration — the contract
      // that keeps the bridge's token fresh.
      void refreshPushRegistration()
      // Count what the OS displayed while the app was away, then push the
      // absolute total to the icon and the bridge.
      void reconcilePresentedNotifications()
    }
    const subscription = AppState.addEventListener('change', onChange)
    // Patient: a type flap fires mid-use with the user none the wiser, and a
    // spurious one must cost a probe, never the healthy socket it probed.
    const network = watchNetwork(() => kick(true))

    // Two edges, deliberately separate. The socket forming brings the mirror
    // level with the org and re-attaches the push handlers; the desktop
    // appearing on the bridge seeds the state only it can answer for.
    let wasOnline = false
    let wasConnected = false
    const off = bridgeClient.subscribe((state) => {
      const isOnline = state.online
      const isConnected = state.online && state.desktop !== null
      if (isOnline && !wasOnline) {
        // Handlers are stored per topic, so re-attaching replaces rather than
        // stacking — safe on a reconnect that reuses the same client.
        attachLiveUpdates()
        attachTurnStream()
        void reconcile().catch(() => undefined)
      }
      if (isConnected && !wasConnected) {
        // After attachTurnStream, never before: that call force-settles the
        // turns this phone may have missed the end of while it was away, and
        // this one re-opens the ones the desktop says are still going.
        void seedActiveRuns()
        // What the desktop is busy with only ever arrives as a push, so a
        // desktop that appears mid-run has already missed it. Seeded on
        // every appearance, because the clear below empties it on every
        // departure.
        void seedOverlays()
        void seedDesktopUpdater()
      }
      // Overlay cards claim something is running on a machine this one can
      // no longer see. Losing the desktop does not end those runs, but it
      // does end this phone's evidence for them.
      if (!isConnected && wasConnected) {
        clearOverlays()
        clearDesktopUpdater()
      }
      wasOnline = isOnline
      wasConnected = isConnected
    })

    return () => {
      subscription.remove()
      network()
      off()
    }
  }, [paired])
}

/**
 * Call `onUsable` whenever this device's network becomes something worth
 * re-checking the socket against. Returns the unsubscribe.
 *
 * Two edges, and the second is the one that matters: the network came back
 * (the backoff would have got there on its own; this makes it immediate),
 * and the INTERFACE changed while still connected — walking out of wifi
 * range onto cellular. Nothing else in the app can see the second one: the
 * socket was bound to an interface that no longer exists, the OS reports it
 * open until a TCP timeout a minute away, and the phone never backgrounds.
 */
function watchNetwork(onUsable: () => void): () => void {
  let previous: { type?: NetworkStateType; usable: boolean } | null = null
  try {
    // Required here, not imported at the top, and the distinction is the whole
    // guard: a native module resolves the moment its module body EVALUATES,
    // and a binary without it would die at launch with no screen at all.
    const Network = require('expo-network') as typeof import('expo-network')
    const subscription = Network.addNetworkStateListener((state) => {
      const usable = state.isConnected !== false && state.isInternetReachable !== false
      const last = previous
      previous = { type: state.type, usable }
      if (!usable || last === null) return
      if (!last.usable || last.type !== state.type) {
        if (AppState.currentState === 'background') return
        onUsable()
      }
    })
    return () => subscription.remove()
  } catch {
    return () => undefined
  }
}
