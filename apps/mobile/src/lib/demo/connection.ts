import type { BridgeState } from '@/lib/cloud/bridge'
import { KEEPALIVE_MS } from '@/lib/bridge/protocol'
import { useEffect, useState } from 'react'

/**
 * The demo's org link — the connection the tour's Connection screen
 * describes.
 *
 * Demo mode has no session and no bridge, but a settings list with no
 * Connection row made the tour a different shape from the paired app it is
 * standing in for. So the demo carries a link of its own: made up, and
 * internally consistent — up since before you looked, a desktop that is
 * always there, counters that tick at the real keepalive cadence, a catch-up
 * clock stamped by the same snapshot read a demo entry runs. The values are
 * fiction; the shape is the real `BridgeState`, so the screen renders both
 * without knowing which it holds.
 *
 * In-memory only, like the chat runtime: `resetDemoConnection` drops it with
 * the dataset it described (purgeDemoState), and the next demo entry starts
 * a fresh link.
 */

/** How long the made-up link has already been up when first looked at —
 *  a lived-in "Connected for 3h", never a suspicious "just now". */
const BASE_UPTIME_MS = 13_680_000

const BASE_FRAMES_SENT = 1_369
const BASE_FRAMES_RECEIVED = 2_642
const BASE_BYTES_SENT = 1_204_566
const BASE_BYTES_RECEIVED = 58_720_412

export const DEMO_API_BASE = 'https://api.wolffi.sh'
export const DEMO_DESKTOP_NAME = 'Sara’s MacBook Pro'

type DemoLink = {
  startedAt: number
  connectedAt: number
  lastSyncAt: number | null
  reconnects: number
  catchUps: number
}

let link: DemoLink | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function ensureLink(): DemoLink {
  if (!link) {
    const now = Date.now()
    link = {
      startedAt: now,
      connectedAt: now - BASE_UPTIME_MS,
      lastSyncAt: null,
      reconnects: 0,
      catchUps: 0
    }
  }
  return link
}

/** The link right now — computed on every read, so each read is a link
 *  whose traffic has moved. */
export function demoConnectionSnapshot(): BridgeState {
  const current = ensureLink()
  const heartbeats = Math.floor((Date.now() - current.startedAt) / KEEPALIVE_MS)
  return {
    status: 'connected',
    online: true,
    desktop: {
      deviceId: 'dev_demo_desktop',
      name: DEMO_DESKTOP_NAME,
      platform: 'darwin',
      appVersion: '0.1.0',
      connectedAt: current.connectedAt
    },
    apiBase: DEMO_API_BASE,
    connectedAt: current.connectedAt,
    lastError: null,
    reconnects: current.reconnects,
    framesSent: BASE_FRAMES_SENT + heartbeats + current.catchUps * 3,
    framesReceived: BASE_FRAMES_RECEIVED + heartbeats + current.catchUps * 5,
    bytesSent: BASE_BYTES_SENT + heartbeats * 44,
    bytesReceived: BASE_BYTES_RECEIVED + heartbeats * 44
  }
}

export function subscribeDemoConnection(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A catch-up ran — applyConfigSnapshot stamps this on every demo entry and
 *  every Sync press. */
export function markDemoConnectionSync(): void {
  const current = ensureLink()
  current.lastSyncAt = Date.now()
  current.catchUps += 1
  emit()
}

export function getDemoLastSyncAt(): number | null {
  return link?.lastSyncAt ?? null
}

/** The screen's Reconnect, in fiction: the link drops and rebuilds instantly. */
export function reconnectDemoConnection(): void {
  const current = ensureLink()
  current.connectedAt = Date.now()
  current.reconnects += 1
  emit()
}

/** Forget the fiction — purgeDemoState's in-memory step, and the tests'. */
export function resetDemoConnection(): void {
  link = null
  emit()
}

const DEMO_POLL_MS = 5_000

/**
 * The made-up link for a screen: re-read on every mutation above and on a
 * 5s clock for the keepalive share of the counters. Kept in STATE on
 * purpose — under React Compiler a Date.now() inside a module call is
 * invisible to memoization, and the counters would freeze.
 */
export function useDemoConnectionState(): BridgeState {
  const [state, setState] = useState(demoConnectionSnapshot)
  useEffect(() => {
    const refresh = (): void => setState(demoConnectionSnapshot())
    const unsubscribe = subscribeDemoConnection(refresh)
    const timer = setInterval(refresh, DEMO_POLL_MS)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [])
  return state
}
