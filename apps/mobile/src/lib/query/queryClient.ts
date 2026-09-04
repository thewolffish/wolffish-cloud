import AsyncStorage from '@react-native-async-storage/async-storage'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { defaultShouldDehydrateQuery, QueryClient, type Query } from '@tanstack/react-query'

/**
 * Server-state layer. The query cache is persisted to the device so remote
 * content survives restarts and refreshes slowly in the background instead of
 * refetching everything up front:
 *
 * - gcTime keeps data eligible for persistence for 7 days.
 * - staleTime means cached data renders instantly and refetches in the
 *   background only after a minute of staleness.
 * - maxAge on the persister drops anything older than 7 days at restore.
 *
 * Conversation queries are backed by SQLite (lib/conversations) and are
 * excluded from AsyncStorage persistence — SQLite is already durable, and
 * mirroring hundreds of conversations into AsyncStorage would defeat the
 * point of the database.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 7 * 24 * 60 * 60 * 1000,
      staleTime: 60 * 1000,
      retry: 2
    }
  }
})

/** Query families whose source of truth is on-device SQLite. */
const LOCAL_QUERY_KEYS = new Set(['conversations', 'conversation', 'data-usage'])

/**
 * The admin screens read OTHER PEOPLE's spend, devices and conversations.
 * Every other query here is the signed-in person's own work, and persisting
 * it is a convenience; persisting this would put the company's transcripts
 * into AsyncStorage — unencrypted, surviving sign-out, and still there long
 * after someone stopped being an admin. So the admin families live in memory
 * for as long as the screen is open and are never dehydrated.
 *
 * The prefix, not the exact key: `['admin', 'roster']`, `['admin', 'user',
 * id]` and everything else the screens add are all covered by the one rule,
 * which is what keeps a later screen from quietly opting itself back in.
 */
const ADMIN_QUERY_PREFIX = 'admin'

export function shouldPersistQuery(query: Query): boolean {
  const family = query.queryKey[0]
  if (typeof family === 'string') {
    if (family === ADMIN_QUERY_PREFIX) return false
    if (LOCAL_QUERY_KEYS.has(family)) return false
  }
  return defaultShouldDehydrateQuery(query)
}

/**
 * AsyncStorage key the dehydrated cache is written under. Exported because a
 * demo refresh deletes it outright (lib/demo/reset) — clearing the in-memory
 * cache alone leaves the last dehydrated copy on disk to be restored at the
 * next launch.
 */
export const QUERY_CACHE_KEY = 'wolffish.query-cache'

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: 3_000
})

export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
