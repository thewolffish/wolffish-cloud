import type { BridgeState } from '@/lib/cloud/bridge'
import { useEffect, useState } from 'react'

/**
 * The demo's connection state — which is: not connected to anything.
 *
 * Demo mode has no session and no bridge, and the Connection screen now says
 * exactly that. It used to invent a link: a desktop that was always there,
 * an uptime that predated your arrival, counters ticking at the keepalive
 * cadence. It read well and it was a lie — a phone that appears paired to a
 * machine that does not exist teaches the wrong thing about the product, and
 * the one thing a person might want to do from that screen (pair a real
 * desktop) looked already done.
 *
 * So the screen keeps its shape — the same real `BridgeState`, the same rows
 * — with the honest values: no desktop, no traffic, nothing since. Pairing
 * for real is one row below, where it always was.
 *
 * What stays is the catch-up clock: the demo dataset really is applied to
 * this phone, and `markDemoConnectionSync` stamps when. That is a local
 * event, not a claim about a link.
 *
 * In-memory only, like the chat runtime: `resetDemoConnection` drops it with
 * the dataset it described (purgeDemoState).
 */

/** The org the demo's content belongs to — an address, not a connection. */
export const DEMO_API_BASE = 'https://api.wolffi.sh'

type DemoLink = {
  lastSyncAt: number | null
}

let link: DemoLink | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function ensureLink(): DemoLink {
  if (!link) link = { lastSyncAt: null }
  return link
}

/** Demo mode's connection, stated plainly: there isn't one. */
export function demoConnectionSnapshot(): BridgeState {
  return {
    status: 'idle',
    online: false,
    desktop: null,
    apiBase: DEMO_API_BASE,
    connectedAt: null,
    lastError: null,
    reconnects: 0,
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0
  }
}

export function subscribeDemoConnection(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A catch-up ran — applyConfigSnapshot stamps this on every demo entry and
 *  every Sync press. The one real event this module records. */
export function markDemoConnectionSync(): void {
  ensureLink().lastSyncAt = Date.now()
  emit()
}

export function getDemoLastSyncAt(): number | null {
  return link?.lastSyncAt ?? null
}

/** Forget it — purgeDemoState's in-memory step, and the tests'. */
export function resetDemoConnection(): void {
  link = null
  emit()
}

const DEMO_POLL_MS = 5_000

/**
 * The demo's connection state for a screen. Subscribed and polled like the
 * live one so the rows below it (the catch-up clock in particular) refresh
 * on the same cadence in both modes.
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
