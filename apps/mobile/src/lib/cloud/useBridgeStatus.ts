import { bridgeClient, type BridgeState, type BridgeStatus } from '@/lib/cloud/bridge'
import { useAppStore } from '@/state/appStore'
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** The four colours a link can be — the tones `StatusDot` renders. */
export type BridgeTone = 'ok' | 'busy' | 'error' | 'idle'

/**
 * The whole bridge state, for a screen that renders its details.
 *
 * Republished on every frame the socket sends or receives, so anything that
 * only needs the phase should take `useBridgeStatus` instead rather than
 * re-render itself against a byte counter.
 */
export function useBridgeState(): BridgeState {
  const [state, setState] = useState<BridgeState>(bridgeClient.current)
  useEffect(() => bridgeClient.subscribe(setState), [])
  return state
}

/**
 * One status → word + colour mapping, shared by the hook below and the demo's
 * made-up link (lib/demo/connection renders 'connected' through it) — one
 * table, so the settings row, the Connection screen and the fiction cannot
 * disagree.
 *
 * Anything mid-flight is amber, not grey: a dial in progress is the link
 * working, and grey would read as dead. The org reachable with the desktop
 * away is amber too — the phone is fine; the machine it runs turns on is
 * not there.
 */
export function describeBridgeStatus(
  status: BridgeStatus,
  t: TFunction
): { status: BridgeStatus; label: string; tone: BridgeTone } {
  switch (status) {
    case 'connected':
      return { status, label: t('connection.status.connected'), tone: 'ok' }
    case 'connecting':
      return { status, label: t('connection.status.connecting'), tone: 'busy' }
    case 'waiting-for-desktop':
      return { status, label: t('connection.status.waitingDesktop'), tone: 'busy' }
    case 'reconnecting':
      return { status, label: t('connection.status.reconnecting'), tone: 'busy' }
    case 'error':
      return { status, label: t('connection.status.error'), tone: 'error' }
    default:
      return { status, label: t('connection.status.idle'), tone: 'idle' }
  }
}

/**
 * The link as a word and a colour — what a status chip needs and nothing more.
 *
 * Keeps the phase rather than the state object, so the traffic counters that
 * tick constantly on a busy link do not re-render whoever is showing it.
 */
export function useBridgeStatus(): { status: BridgeStatus; label: string; tone: BridgeTone } {
  const { t } = useTranslation()
  const [status, setStatus] = useState<BridgeStatus>(bridgeClient.current.status)
  useEffect(() => bridgeClient.subscribe((state) => setStatus(state.status)), [])
  return describeBridgeStatus(status, t)
}

/**
 * Is there a desktop on the other end RIGHT NOW — paired, and on the bridge.
 *
 * The predicate behind every control that cannot work without one: the
 * workspace stores the phone edits through the desktop, turns run there,
 * and the diagnostic bundle is collected there. Demo mode is false by
 * construction, and so is a paired phone whose desktop is asleep — that
 * phone still reads everything from the org, it just cannot ask the
 * desktop to do anything.
 */
export function useDesktopReachable(): boolean {
  const paired = useAppStore((state) => state.paired)
  const [connected, setConnected] = useState(bridgeClient.connected)
  useEffect(
    () => bridgeClient.subscribe((state) => setConnected(state.online && state.desktop !== null)),
    []
  )
  return paired && connected
}
