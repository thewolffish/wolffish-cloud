/**
 * Expo push API client — plain fetch, no SDK.
 *
 * Two endpoints, both batched at Expo's documented ceiling of 100 items per
 * request: `push/send` turns messages into tickets, `push/getReceipts` turns
 * ticket ids into delivery receipts. This file only talks HTTP; what to do
 * about each ticket or receipt (prune a dead registration, re-arm an alarm,
 * write the device's push health) is the UserBridge's business.
 *
 * TICKETS ARE NOT DELIVERY. `push/send` answering 200 means Expo ACCEPTED the
 * message, and a body full of error tickets comes back under that same 200 —
 * which is why nothing here treats `res.ok` as success. A receipt, fetched
 * minutes later, is the only thing that says a push actually reached APNs or
 * FCM, and an `InvalidCredentials` receipt is the ONLY place broken FCM/APNs
 * credentials on the Expo project ever surface.
 *
 * AUTH IS LOAD-BEARING. The Expo account this org's app belongs to has
 * Enhanced Security for Push Notifications switched on, so an unauthenticated
 * send fails outright: a missing or stale EXPO_ACCESS_TOKEN is a total push
 * outage, not a degraded mode. It is logged as its own distinct error rather
 * than folded into generic transport noise, because the fix is one command
 * and nothing else in the system can tell you to run it.
 */
import type { Env } from '@/index'

/** Expo's own host. Overridable ONLY by an env var a deployment never sets:
 *  the local smoke lane points it at scripts/mock-expo.mjs, exactly as the
 *  model and search lanes point at their own mocks, because ticket and
 *  receipt handling is the part of this file that cannot be proved against
 *  the real service without pushing to someone's phone. */
const EXPO_BASE_DEFAULT = 'https://exp.host'
const base = (env: Env): string => (env.EXPO_PUSH_BASE || EXPO_BASE_DEFAULT).replace(/\/+$/, '')
export const pushUrl = (env: Env): string => `${base(env)}/--/api/v2/push/send`
export const receiptsUrl = (env: Env): string => `${base(env)}/--/api/v2/push/getReceipts`
/** Expo's documented per-request ceiling for both endpoints. */
export const EXPO_BATCH_LIMIT = 100
/** Neither call may hold the calling Durable Object's alarm open forever. */
const EXPO_TIMEOUT_MS = 10_000

/** One message in the shape POST push/send expects. */
export type ExpoPushMessage = {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound: 'default'
  priority: 'default' | 'high'
  /** Seconds. */
  ttl: number
  channelId: string
  /** App-icon unread count. Applied by iOS at delivery; Android launchers
   *  that support numeric badges pick it up from the notification instead. */
  badge?: number
}

export type ExpoTicket =
  { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } }

export type ExpoReceipt =
  { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } }

/** Every error code Expo documents, plus the catch-all this code uses when a
 *  ticket or receipt names something newer than this build knows. */
export type ExpoErrorCode =
  | 'DeviceNotRegistered'
  | 'InvalidCredentials'
  | 'MessageTooBig'
  | 'MessageRateExceeded'
  | 'ExpoError'
  | 'ProviderError'
  | 'unknown'

export function errorCodeOf(outcome: ExpoTicket | ExpoReceipt): ExpoErrorCode {
  if (outcome.status !== 'error') return 'unknown'
  return (outcome.details?.error as ExpoErrorCode | undefined) ?? 'unknown'
}

function headers(env: Env): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {})
  }
}

/**
 * A 401/403 from exp.host means the access token is missing, revoked or
 * wrong. With Enhanced Security on that is every push for every user of this
 * org, not one unlucky handset, so it gets its own line with the fix in it.
 */
function logIfAuthFailure(status: number, what: string): boolean {
  if (status !== 401 && status !== 403) return false
  console.error(
    `[push] EXPO AUTH ERROR (${status}) on ${what} — EXPO_ACCESS_TOKEN is missing or invalid; ` +
      'Enhanced Security rejects every unauthenticated call, so NO push will deliver for ANY ' +
      'user until the secret is fixed (npx wrangler secret put EXPO_ACCESS_TOKEN)'
  )
  return true
}

/**
 * Send push messages, batched. Returns one ticket per message, in order, or
 * null for a message whose batch failed at the transport/HTTP layer (those
 * produced no ticket at all, and the caller must not record one).
 */
export async function sendExpoPush(
  env: Env,
  messages: ExpoPushMessage[]
): Promise<(ExpoTicket | null)[]> {
  const tickets: (ExpoTicket | null)[] = []
  for (let i = 0; i < messages.length; i += EXPO_BATCH_LIMIT) {
    const batch = messages.slice(i, i + EXPO_BATCH_LIMIT)
    try {
      const response = await fetch(pushUrl(env), {
        method: 'POST',
        headers: headers(env),
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS)
      })
      if (!response.ok) {
        if (!logIfAuthFailure(response.status, 'push/send')) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          console.error(`[push] push/send failed with HTTP ${response.status}: ${detail}`)
        }
        tickets.push(...batch.map(() => null))
        continue
      }
      const payload = (await response.json()) as { data?: ExpoTicket[] }
      const data = Array.isArray(payload.data) ? payload.data : []
      // Positional, exactly as Expo documents: ticket j answers message j of
      // this batch. A short answer leaves the rest null rather than shifting
      // every later ticket onto the wrong device.
      for (let j = 0; j < batch.length; j += 1) tickets.push(data[j] ?? null)
    } catch (error) {
      console.error(`[push] push/send network failure: ${String(error)}`)
      tickets.push(...batch.map(() => null))
    }
  }
  return tickets
}

/**
 * Fetch receipts for ticket ids, batched and merged. Returns null when EVERY
 * batch failed — the caller keeps its tickets and retries on the next sweep;
 * a partial map when at least one batch answered, and an id missing from it
 * simply has no receipt yet.
 */
export async function getExpoReceipts(
  env: Env,
  ticketIds: string[]
): Promise<Record<string, ExpoReceipt> | null> {
  const receipts: Record<string, ExpoReceipt> = {}
  let anySuccess = false
  for (let i = 0; i < ticketIds.length; i += EXPO_BATCH_LIMIT) {
    const batch = ticketIds.slice(i, i + EXPO_BATCH_LIMIT)
    try {
      const response = await fetch(receiptsUrl(env), {
        method: 'POST',
        headers: headers(env),
        body: JSON.stringify({ ids: batch }),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS)
      })
      if (!response.ok) {
        if (!logIfAuthFailure(response.status, 'push/getReceipts')) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          console.error(`[push] push/getReceipts failed with HTTP ${response.status}: ${detail}`)
        }
        continue
      }
      const payload = (await response.json()) as {
        data?: Record<string, ExpoReceipt>
      }
      Object.assign(receipts, payload.data ?? {})
      anySuccess = true
    } catch (error) {
      console.error(`[push] push/getReceipts network failure: ${String(error)}`)
    }
  }
  return anySuccess ? receipts : null
}

/** First 12 characters of a push token — enough to tell two registrations
 *  apart in a log line, never enough to send anything to a user's phone. */
export function tokenPrefix(token: string | null): string {
  if (!token) return 'none'
  return `${token.slice(0, 12)}…`
}
