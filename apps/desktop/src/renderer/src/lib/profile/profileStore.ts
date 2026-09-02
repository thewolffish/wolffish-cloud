/**
 * The signed-in user's profile, fetched ONCE up front (when the session
 * becomes ready) instead of when the profile sheet opens — the sheet and
 * the sidebar user card read it synchronously. Saves update it in place;
 * `prefetchProfile` re-runs on every sign-in, so a stale copy can't
 * outlive a session switch.
 */
import type { CloudProfile } from '@preload/index'
import { useSyncExternalStore } from 'react'

export type ProfileSnapshot = {
  profile: CloudProfile | null
  /** Data URL of the avatar image, or null when none is set. */
  avatar: string | null
}

let snapshot: ProfileSnapshot = { profile: null, avatar: null }
const listeners = new Set<() => void>()

function emit(next: Partial<ProfileSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}

export function prefetchProfile(): void {
  void window.api.auth.getProfile().then((profile) => {
    if (profile) emit({ profile })
  })
  void window.api.auth
    .getAvatar()
    .then((avatar) => emit({ avatar }))
    .catch(() => undefined)
}

export function clearProfile(): void {
  emit({ profile: null, avatar: null })
}

export function setProfileLocal(patch: Partial<CloudProfile>): void {
  if (snapshot.profile) emit({ profile: { ...snapshot.profile, ...patch } })
}

export function setAvatarLocal(avatar: string | null): void {
  emit({ avatar })
}

export function getProfileSnapshot(): ProfileSnapshot {
  return snapshot
}

export function useProfile(): ProfileSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot
  )
}
