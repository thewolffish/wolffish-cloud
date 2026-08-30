import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Unread notification badges, the phone's authoritative copy.
 *
 * One bucket per conversation: how many model-initiated notifications have
 * arrived for it that the user has not yet answered by OPENING it. General
 * notifications — ones that deep-link to a settings page or nowhere — are
 * deliberately never counted here: opening the app is what clears those, and
 * an open app is the only place this store is ever rendered. They still reach
 * the OS icon while the app is away, because the relay counts every delivered
 * notification into the push `badge`; the moment the app opens, the sync in
 * lib/notifications/push.ts overwrites icon and relay with this store's
 * conversation-only total, which is exactly the "cleared on open" the general
 * ones want.
 *
 * The store never decides what counts — push.ts does (it knows the deeplink,
 * the active conversation, the app state). The store owns the two invariants
 * that make badges trustworthy: every notification id counts AT MOST ONCE
 * (`counted`, an LRU shared by both delivery paths, so an in-band render and
 * its Expo fallback can never double-count), and a bucket cannot outlive its
 * conversation (`clearConversation` on open/delete, `prune` after a full
 * index sync for conversations deleted while the phone was away).
 */

/** One conversation's uncleared notifications. `at` is when the bucket last
 *  grew — what lets prune() spare buckets younger than the index it checks. */
export type BadgeBucket = { n: number; at: number }

/** Ids remembered for dedupe; matches the seen-LRU in push.ts. */
const COUNTED_LIMIT = 200

/** A bucket can never grow past this; the relay clamps to the same ceiling. */
const BUCKET_MAX = 999

export type BadgeState = {
  counts: Record<string, BadgeBucket>
  /** Notification ids already counted or handled, oldest first. */
  counted: string[]
  /** Count one notification against one conversation. No-op on a known id. */
  count: (notificationId: string, conversationId: string) => void
  /** Remember an id WITHOUT counting it — a tap being acted on, a general
   *  notification, one that arrived for the conversation on screen. */
  markHandled: (notificationId: string) => void
  /**
   * Move known ids to the LRU's fresh end. Reconciliation calls this with
   * every notification still in the tray, so an id cannot age out of the
   * dedupe while the notification it deduplicates is still presented — the
   * one way a slow-burning tray entry could ever count twice.
   */
  refresh: (notificationIds: readonly string[]) => void
  /** The user opened (or deleted) the conversation — its badge is done. */
  clearConversation: (conversationId: string) => void
  /**
   * Unpairing: every bucket at once. `counted` deliberately survives — it is
   * what stops a straggler push arriving after the wipe from re-minting a
   * bucket for a conversation that no longer exists.
   */
  clearAll: () => void
  /**
   * Drop buckets for conversations the desktop no longer has. `liveIds` is
   * the full id list from a completed index sync and `before` is when that
   * sync STARTED — a bucket that grew after the list was taken is spared,
   * because its conversation may simply be newer than the list.
   */
  prune: (liveIds: readonly string[], before: number) => void
}

function remember(counted: string[], notificationId: string): string[] {
  const next = [...counted, notificationId]
  return next.length > COUNTED_LIMIT ? next.slice(next.length - COUNTED_LIMIT) : next
}

export const useBadges = create<BadgeState>()(
  persist(
    (set, get) => ({
      counts: {},
      counted: [],
      count: (notificationId, conversationId) => {
        const { counts, counted } = get()
        if (counted.includes(notificationId)) return
        const bucket = counts[conversationId]
        set({
          counts: {
            ...counts,
            [conversationId]: {
              n: Math.min(BUCKET_MAX, (bucket?.n ?? 0) + 1),
              at: Date.now()
            }
          },
          counted: remember(counted, notificationId)
        })
      },
      markHandled: (notificationId) => {
        const { counted } = get()
        if (counted.includes(notificationId)) return
        set({ counted: remember(counted, notificationId) })
      },
      refresh: (notificationIds) => {
        const { counted } = get()
        const alive = new Set(notificationIds.filter((id) => counted.includes(id)))
        if (alive.size === 0) return
        const rest = counted.filter((id) => !alive.has(id))
        set({ counted: [...rest, ...counted.filter((id) => alive.has(id))] })
      },
      clearConversation: (conversationId) => {
        const { counts } = get()
        if (!(conversationId in counts)) return
        const { [conversationId]: _cleared, ...rest } = counts
        set({ counts: rest })
      },
      clearAll: () => {
        if (Object.keys(get().counts).length === 0) return
        set({ counts: {} })
      },
      prune: (liveIds, before) => {
        const { counts } = get()
        const live = new Set(liveIds)
        const kept = Object.entries(counts).filter(
          ([id, bucket]) => live.has(id) || bucket.at >= before
        )
        if (kept.length === Object.keys(counts).length) return
        set({ counts: Object.fromEntries(kept) })
      }
    }),
    {
      name: 'wolffish.badges',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: (state) => ({ counts: state.counts, counted: state.counted })
    }
  )
)

/** The number the app icon and the relay carry — conversation buckets only. */
export function badgeTotal(state: Pick<BadgeState, 'counts'>): number {
  let total = 0
  for (const bucket of Object.values(state.counts)) total += bucket.n
  return Math.min(BUCKET_MAX, total)
}

/** Resolves once the persisted badges are restored — counting before that
 *  would be overwritten by the rehydrate. */
export function whenBadgesHydrated(): Promise<void> {
  if (useBadges.persist.hasHydrated()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useBadges.persist.onFinishHydration(() => {
      unsub()
      resolve()
    })
  })
}
