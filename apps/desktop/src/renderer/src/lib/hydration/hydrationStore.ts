/**
 * Renderer-side store of conversation media hydration — the on-open
 * download of files a fresh install has not pulled yet (nothing is
 * predownloaded at restore; media arrives when its conversation is opened,
 * like the phone).
 *
 * One IPC subscription feeds every consumer: the chat's progress banner
 * (byte-level ticks) and the attachment cards (pending-path membership, so
 * a not-yet-downloaded file renders "downloading" instead of "deleted").
 * Two versions deliberately tick at different rates:
 *   - tickVersion: every throttled progress event (~100ms while bytes
 *     move) — only the banner subscribes to this;
 *   - fileVersion: only when a flight starts, a file completes, or a
 *     flight ends — membership changes. Attachment lists subscribe to
 *     this one so cards never re-render on byte ticks, and existence
 *     checks re-run exactly when a file may have just landed.
 */
import type { ConversationHydrationProgress } from '@preload/index'
import { useSyncExternalStore } from 'react'

const flights = new Map<string, ConversationHydrationProgress>()
const pendingPaths = new Set<string>()
let tickVersion = 0
let fileVersion = 0
let wired = false
const listeners = new Set<() => void>()

function rebuildPending(): void {
  pendingPaths.clear()
  for (const flight of flights.values()) {
    for (const rel of flight.pending) pendingPaths.add(rel)
  }
}

function ensureWired(): void {
  if (wired) return
  wired = true
  window.api.conversation.onHydrationProgress((progress) => {
    const previous = flights.get(progress.conversationId)
    const membershipChanged =
      progress.done ||
      previous === undefined ||
      previous.filesDone !== progress.filesDone ||
      previous.pending.length !== progress.pending.length
    if (progress.done) flights.delete(progress.conversationId)
    else flights.set(progress.conversationId, progress)
    tickVersion++
    if (membershipChanged) {
      rebuildPending()
      fileVersion++
    }
    for (const listener of listeners) listener()
  })
}

function subscribe(listener: () => void): () => void {
  ensureWired()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Live progress of the given conversation's hydration, null when idle.
 *  Re-renders on every throttled byte tick — banner use only. */
export function useHydration(conversationId: string | null): ConversationHydrationProgress | null {
  useSyncExternalStore(subscribe, () => tickVersion)
  return conversationId ? (flights.get(conversationId) ?? null) : null
}

/** Bumps when any hydration starts, finishes a file, or completes — the
 *  signal that a missing file may have just landed on disk. */
export function useHydrationFileVersion(): number {
  return useSyncExternalStore(subscribe, () => fileVersion)
}

/** True while this workspace-relative path is queued or mid-download. */
export function isPathHydrating(filePath: string): boolean {
  return pendingPaths.has(filePath)
}
