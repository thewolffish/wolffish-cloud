import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { router, type Href } from 'expo-router'
import { AppState, Platform } from 'react-native'
import {
  ANDROID_CHANNEL_ID,
  PUSH_WIRE_VERSION,
  parseDeeplink,
  parseNotification,
  type DeeplinkTarget,
  type RegisterPushFrame,
  type SetBadgeFrame,
  type UnregisterPushFrame
} from '@/lib/tunnel/protocol'
import { toHex } from '@/lib/tunnel/pairing'
import type { Tunnel } from '@/lib/tunnel/tunnel'
import { invalidateConversation } from '@/lib/conversations/cache'
import { markConversationDirty } from '@/lib/sync/dirty'
import { badgeTotal, useBadges, whenBadgesHydrated } from '@/state/badges'

/**
 * Model-initiated notifications, phone side.
 *
 * Two delivery paths land here and the user must never see the same
 * notification twice:
 *
 * - IN-BAND: the relay sends a `notification` control frame over the live
 *   tunnel; we render it locally and answer `notification_ack`. If our ack
 *   is not back at the relay within ~2 s it ALSO sends the Expo push, so…
 * - PUSH: …a remote push can arrive for a notification already rendered.
 *   The persisted `seen` LRU below is what folds the two into one: in-band
 *   renders mark the id seen, and the foreground handler refuses to show a
 *   remote push whose id it already knows. (A push arriving while the app
 *   is closed is displayed by the OS before we run — unavoidable, and only
 *   reachable when the tunnel died mid-ack, since a *live* tunnel is what
 *   makes the relay try in-band first.)
 *
 * Nothing here sends notifications. The phone registers where it can be
 * reached and renders what arrives; whether anything is sent at all is the
 * desktop model's deliberate tool call, rate-limited over there.
 *
 * WHERE A TAP GOES is the third thing this file owns, and it has two arrivals
 * that look alike and are not: a tap on a running app (the response listener,
 * which navigates on the spot) and the tap that STARTED the app, which has to
 * be read before the entry screen redirects or it ends up racing it. See
 * launchDeeplink.
 */

/** Stable device id — THE phoneId push registrations are keyed by. Minted
 *  once, kept in the OS keystore, deliberately random: it must not be
 *  derivable from (or leak) the tunnel identity key the relay never sees. */
const KEY_DEVICE_ID = 'wolffish.tunnel.deviceId'

/** Persisted ids of notifications this device already rendered. */
const KEY_SEEN = 'wolffish.notifications.seen.v1'
const SEEN_LIMIT = 200

let cachedPhoneId: string | null = null

export async function getPhoneId(): Promise<string> {
  if (cachedPhoneId) return cachedPhoneId
  try {
    const stored = await SecureStore.getItemAsync(KEY_DEVICE_ID)
    if (stored && /^[a-f0-9]{32}$/.test(stored)) {
      cachedPhoneId = stored
      return stored
    }
  } catch {
    // fall through to minting — worst case we mint again next launch
  }
  const minted = toHex(crypto.getRandomValues(new Uint8Array(16)))
  cachedPhoneId = minted
  try {
    await SecureStore.setItemAsync(KEY_DEVICE_ID, minted, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    })
  } catch {
    // keystore refused — the in-memory id still keys this session consistently
  }
  return minted
}

// ------------------------------------------------------------------ dedupe

/** In-memory mirror of the persisted LRU; loaded once per launch. */
let seenOrder: string[] = []
let seenSet = new Set<string>()
let seenLoaded: Promise<void> | null = null

function loadSeen(): Promise<void> {
  if (seenLoaded) return seenLoaded
  seenLoaded = AsyncStorage.getItem(KEY_SEEN)
    .then((raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) {
        seenOrder = parsed.filter((id): id is string => typeof id === 'string').slice(-SEEN_LIMIT)
        seenSet = new Set(seenOrder)
      }
    })
    .catch(() => undefined)
  return seenLoaded
}

async function hasSeen(notificationId: string): Promise<boolean> {
  await loadSeen()
  return seenSet.has(notificationId)
}

async function markSeen(notificationId: string): Promise<void> {
  await loadSeen()
  if (seenSet.has(notificationId)) return
  seenSet.add(notificationId)
  seenOrder.push(notificationId)
  while (seenOrder.length > SEEN_LIMIT) {
    const evicted = seenOrder.shift()
    if (evicted) seenSet.delete(evicted)
  }
  AsyncStorage.setItem(KEY_SEEN, JSON.stringify(seenOrder)).catch(() => undefined)
}

// ----------------------------------------------------------- unread badges

/**
 * The conversation the chat screen is showing while the app is frontmost —
 * reported by the screen itself (focus effect), null whenever it is not
 * focused. A notification for the conversation the user is LOOKING AT never
 * becomes a badge; everything else does, per conversation, in the badges
 * store. General notifications (settings pages, plain opens) are handled
 * without counting — see the store's own doc for why that is the whole
 * "cleared when the app opens" rule.
 */
let activeConversationId: string | null = null

export function setActiveConversation(conversationId: string | null): void {
  activeConversationId = conversationId
}

/** The conversation on screen right now, or null. Read by the sync layer to
 *  keep background body refreshes from prefetching files nobody is looking
 *  at — bandwidth the visible conversation's own cards are waiting on. */
export function getActiveConversation(): string | null {
  return activeConversationId
}

/** The conversation a notification's deeplink names, if any. `current` is the
 *  desktop-side placeholder and must never key a bucket here. */
function conversationTarget(url: unknown): string | null {
  const target = parseDeeplink(url)
  if (!target || target.route !== 'chat') return null
  if (!target.conversationId || target.conversationId === 'current') return null
  return target.conversationId
}

/**
 * Count one notification into the badges store — every arrival path funnels
 * here (in-band frame, foreground push, tray reconciliation) and the store's
 * counted-LRU is what makes the paths safe to overlap: an id counts once no
 * matter how many of them see it.
 */
function recordNotification(notificationId: string, url: unknown): void {
  const conversationId = conversationTarget(url)
  const store = useBadges.getState()
  if (!conversationId) {
    store.markHandled(notificationId)
    return
  }
  const viewing = conversationId === activeConversationId && AppState.currentState === 'active'
  if (viewing) store.markHandled(notificationId)
  else store.count(notificationId, conversationId)
}

/**
 * Fold the notification center into the badge counts. This is how pushes that
 * arrived while the app was DEAD are counted: nothing of ours ran when the OS
 * displayed them, but they are still sitting in the tray with their payloads.
 * Runs at launch (after the store rehydrates) and on every foreground; ends by
 * pushing the resulting absolute count to the OS icon and the relay, which is
 * also what wipes general notifications off the icon the moment the app opens.
 */
export async function reconcilePresentedNotifications(): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    const ids: string[] = []
    for (const notification of presented) {
      const data = notification.request.content.data as Record<string, unknown> | undefined
      const id = typeof data?.notificationId === 'string' ? data.notificationId : null
      if (id) ids.push(id)
    }
    // Ids still in the tray must stay in the dedupe: refreshed first, so a
    // notification that lingers there for weeks cannot age out of the LRU and
    // be counted a second time by the very loop below.
    useBadges.getState().refresh(ids)
    for (const notification of presented) {
      const data = notification.request.content.data as Record<string, unknown> | undefined
      const id = typeof data?.notificationId === 'string' ? data.notificationId : null
      if (id) recordNotification(id, data?.url)
    }
  } catch {
    // Unsupported runtime (web, an old dev client) — the counts still sync.
  }
  await syncBadge()
}

/**
 * The user opened a conversation: its badge is done. Clears the bucket (the
 * store change propagates to the icon and the relay via the subscription in
 * initNotifications) and dismisses the conversation's own notifications from
 * the tray, so what the badge said is gone stops being said anywhere.
 */
export function clearConversationBadges(conversationId: string): void {
  useBadges.getState().clearConversation(conversationId)
  void dismissConversationNotifications(conversationId)
}

/**
 * Unpairing: every badge goes at once — the buckets, the tray, the icon, and
 * the relay's per-device count. Must run BEFORE the tunnel drops and before
 * the wipe: the relay's counter is reachable only over the live socket, and
 * once it closes a stale count would ride every push until the next pairing.
 * The tray is emptied wholesale — general notifications included — because
 * everything in it deep-links into the pairing being severed. Awaited so the
 * caller holds the socket open until the zero has been sent.
 */
export async function clearAllBadges(): Promise<void> {
  useBadges.getState().clearAll()
  try {
    await Notifications.dismissAllNotificationsAsync()
  } catch {
    // Nothing to dismiss on this runtime.
  }
  await syncBadge(true)
}

/**
 * Unpairing: tell the relay to forget this device — token, platform, badge.
 * A registration left behind keeps routing pushes (badge counts stamped on)
 * at a phone that no longer holds the conversations they describe; deleted,
 * every later notify answers `dropped` — the honest result — and re-pairing
 * registers afresh. Must run while the socket is still up: once it drops,
 * this pairing's relay state is unreachable forever (re-pairing derives a
 * new rendezvous). Never throws — an offline unpair cannot reach the relay
 * and must still complete locally.
 */
export async function unregisterPush(): Promise<void> {
  const tunnel = activeTunnel
  if (!tunnel) return
  try {
    const frame: UnregisterPushFrame = {
      v: PUSH_WIRE_VERSION,
      type: 'unregister_push',
      phoneId: await getPhoneId()
    }
    ;(activeTunnel ?? tunnel).sendControl(frame)
  } catch {
    // Socket already dead — the registration outlives the pairing until the
    // token itself dies; nothing more can be done from this side.
  }
}

async function dismissConversationNotifications(conversationId: string): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    for (const notification of presented) {
      const data = notification.request.content.data as Record<string, unknown> | undefined
      if (conversationTarget(data?.url) !== conversationId) continue
      await Notifications.dismissNotificationAsync(notification.request.identifier).catch(
        () => undefined
      )
    }
  } catch {
    // Nothing to dismiss on this runtime.
  }
}

// ------------------------------------------------------- foreground display

let handlerInstalled = false

/**
 * Without a handler, notifications arriving while the app is OPEN are
 * silently swallowed. With it, they banner like they would from the lock
 * screen — except a remote push whose id we already rendered in-band, which
 * is suppressed (our own local renders carry `inband: true` and were deduped
 * before scheduling).
 */
function installForegroundHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data as Record<string, unknown> | undefined
      const id = typeof data?.notificationId === 'string' ? data.notificationId : null
      const duplicate = data?.inband !== true && id !== null && (await hasSeen(id))
      if (id && !duplicate) void markSeen(id)
      // Count it — this is where a remote push landing on a FOREGROUND app
      // enters the badge store (a rare path: it means the tunnel was down
      // while the app was up). In-band renders pass through here too and the
      // store's id dedupe folds them into their earlier count.
      if (id) recordNotification(id, data?.url)
      // The arrival is evidence: something changed in the conversation it
      // names, whatever this phone's sync bookkeeping believes — a remote
      // push reaching a foreground app usually MEANS the tunnel missed the
      // events that would have said so. Marked dirty, the next body fetch is
      // unconditional; invalidated, a mounted copy of that conversation
      // re-reads now rather than at its next mount.
      const changed = conversationTarget(data?.url)
      if (changed) {
        markConversationDirty(changed)
        invalidateConversation(changed)
      }
      return {
        shouldShowBanner: !duplicate,
        shouldShowList: !duplicate,
        shouldPlaySound: !duplicate,
        // False, deliberately: the badges store is the single writer of the
        // icon count (via syncBadge), so a push's own badge number — computed
        // by the relay for the app-is-dead case — never fights it while the
        // app is up.
        shouldSetBadge: false
      }
    }
  })
}

// ------------------------------------------------------------ tap handling

/** Responses already dealt with, by notification request identifier — the
 *  launch tap is seen twice (the entry screen reads it, the listener replays
 *  it) and must move the app exactly once. */
const routedResponses = new Set<string>()

/** The launch tap's destination: undefined until read, null once read and
 *  found absent or unusable. */
let launchHref: Href | null | undefined

/** The in-app route a target names. `wolffish://chat?id=X` is `/chat?id=X`,
 *  `wolffish://settings/model` is `/settings/model` — the deeplink table and
 *  this app's own routes are the same list, by construction. */
function hrefFor(target: DeeplinkTarget): Href {
  if (target.route === 'chat' && target.conversationId) {
    return { pathname: '/chat', params: { id: target.conversationId } } as Href
  }
  return `/${target.route}` as Href
}

/**
 * Resolve a tap to a screen, once.
 *
 * Null for a response already handled, and null for a link this build cannot
 * resolve — a deeplink naming a screen that does not exist here (an older app,
 * a newer desktop) must leave the user exactly where they are. It used to fall
 * through to the not-found route, which redirects home, which on a paired
 * phone redirects into whatever chat was last open: a tap that appeared to do
 * something arbitrary rather than nothing.
 *
 * The route table is also the whole security story: notification payloads are
 * data, and only a link naming one of this app's own screens may steer it.
 */
function takeResponseHref(response: Notifications.NotificationResponse | null): Href | null {
  if (!response) return null
  const requestId = response.notification.request.identifier
  if (routedResponses.has(requestId)) return null
  routedResponses.add(requestId)
  const data = response.notification.request.content.data as Record<string, unknown> | undefined
  // A tapped notification never becomes a badge: the tap IS the answer to it.
  // If it was already counted, the screen the tap lands on clears its bucket.
  const id = data?.notificationId
  if (typeof id === 'string') useBadges.getState().markHandled(id)
  const target = parseDeeplink(data?.url)
  // The tap is the strongest freshness signal there is: the user is about to
  // look at this conversation BECAUSE the desktop said it changed — often
  // from a cold start, where the phone's own metadata still predates the
  // change and a timestamp comparison would happily serve the stale copy.
  // Marked dirty, the open that follows fetches the body regardless.
  if (target?.route === 'chat' && target.conversationId && target.conversationId !== 'current') {
    markConversationDirty(target.conversationId)
    invalidateConversation(target.conversationId)
  }
  return target ? hrefFor(target) : null
}

/** A tap that arrived while the app was already running. Pushed, so the screen
 *  the user was on stays underneath and back returns to it — the same thing
 *  opening a conversation from History does. */
function routeResponse(response: Notifications.NotificationResponse | null): void {
  const href = takeResponseHref(response)
  if (href) router.push(href)
}

/**
 * Where the notification that LAUNCHED the app points, or null.
 *
 * Read synchronously: expo-notifications keeps the launch tap on the native
 * side, so this answers on the entry screen's FIRST render, before anything
 * has navigated. That timing is the whole point. A paired phone's entry screen
 * redirects into the app the moment it mounts, and a destination resolved even
 * one tick later (an async probe, the response listener) arrives as a SECOND
 * navigation racing that redirect — sometimes landing under it, sometimes
 * replaced by it, which is what made tapping a notification open the app but
 * not the conversation. Read here, the tap's destination simply IS the boot
 * destination: one navigation, nothing to race.
 *
 * Idempotent — the answer is latched, so a re-render cannot change it — and
 * marked routed, so the listener replaying the same tap does not move the app
 * a second time.
 */
export function launchDeeplink(): Href | null {
  if (launchHref !== undefined) return launchHref
  launchHref = takeResponseHref(lastNotificationResponse())
  return launchHref
}

/**
 * Forget the launch tap, once the entry screen has had it. Both halves matter:
 * the latch, so a later mount of that screen cannot navigate on a tap from
 * minutes ago, and the native copy, which `getLastNotificationResponse` would
 * otherwise keep answering with for the life of the process.
 */
export function forgetLaunchDeeplink(): void {
  launchHref = null
  try {
    Notifications.clearLastNotificationResponse()
  } catch {
    // Not available on this runtime — the latch above is what matters.
  }
}

function lastNotificationResponse(): Notifications.NotificationResponse | null {
  try {
    return Notifications.getLastNotificationResponse()
  } catch {
    return null // unsupported runtime (web, an old dev client)
  }
}

// ----------------------------------------------------------- registration

/** The tunnel push frames ride on — whichever connection is current. */
let activeTunnel: Tunnel | null = null

let listenersInstalled = false

/**
 * One-time app-level setup: foreground display, tap routing (warm and cold
 * start), and re-registration when the platform rotates the push token.
 * Call once from the root layout; safe to call again.
 */
export function initNotifications(): void {
  installForegroundHandler()
  if (listenersInstalled) return
  listenersInstalled = true
  Notifications.addNotificationResponseReceivedListener((response) => routeResponse(response))
  // Cold start: the tap that launched the app fired before any listener
  // existed, and the native module does not replay it to one. Normally the
  // entry screen has already taken it (launchDeeplink, read on its first
  // render — which happens before this effect) and this is a no-op; it stays
  // as the path for a launch that never went through that screen.
  routeResponse(lastNotificationResponse())
  // Token rotation — rare, silent, and fatal to push delivery if missed.
  Notifications.addPushTokenListener(() => {
    void refreshPushRegistration()
  })
  // Every badge change reaches the OS icon and the relay from ONE place —
  // whoever moved the store (a count, a clear, a prune) never syncs it too.
  useBadges.subscribe((state, previous) => {
    if (state.counts !== previous.counts) void syncBadge()
  })
  // Launch-time catch-up: count what the OS displayed while the app was dead.
  // After rehydration, or the persisted counts would overwrite these.
  void whenBadgesHydrated().then(() => reconcilePresentedNotifications())
}

/**
 * Wire one tunnel's control frames: render in-band notifications locally and
 * ack them. Called for every tunnel the client builds (handlers are per
 * tunnel instance); also remembers the tunnel for later registrations.
 */
export function attachNotificationHandlers(tunnel: Tunnel): void {
  activeTunnel = tunnel
  tunnel.onControl('notification', (raw) => {
    void (async () => {
      const frame = parseNotification(raw)
      if (!frame) return // malformed or from-the-future — ignored, not acked
      const duplicate = await hasSeen(frame.notificationId)
      if (!duplicate) {
        await markSeen(frame.notificationId)
        await Notifications.scheduleNotificationAsync({
          content: {
            title: frame.title,
            body: frame.body,
            sound: 'default',
            data: {
              notificationId: frame.notificationId,
              runId: frame.runId,
              phase: frame.phase,
              url: frame.deeplink,
              // Marks our own local render so the foreground handler shows it
              // instead of treating it as a duplicate of itself.
              inband: true
            }
          },
          trigger: null
        }).catch(() => undefined)
      }
      // Ack even a duplicate: the relay is holding a fallback timer for this
      // id, and the ack is what tells it the phone has the notification.
      try {
        tunnel.sendControl({
          v: PUSH_WIRE_VERSION,
          type: 'notification_ack',
          notificationId: frame.notificationId
        })
      } catch {
        // Socket died between delivery and ack — the relay's fallback push
        // fires and the seen-set above is what keeps it invisible.
      }
      // Count it — the main badge path while the app is alive. After the ack
      // on purpose: the relay's fallback clock must not wait on store writes.
      recordNotification(frame.notificationId, frame.deeplink)
    })()
  })
}

/**
 * How long the platform gets to hand over a push token before this device
 * registers WITHOUT one.
 *
 * Two links in the token chain can hang forever, and both are iOS's:
 *
 * - `requestPermissionsAsync` resolves when the user answers the system
 *   dialog. A user who swipes it away, or never looks at the phone, never
 *   answers it.
 * - `getExpoPushTokenAsync` first calls the native `getDevicePushTokenAsync`,
 *   which stores the promise, calls `registerForRemoteNotifications()`, and
 *   resolves only from the APNs delegate callback. When neither the success
 *   nor the failure callback fires — no APNs entitlement in the running
 *   build, a device that cannot reach Apple's push gateway at that moment —
 *   nothing settles it. There is no timeout inside expo-notifications.
 *
 * Android has no equivalent: its FCM token comes back from Play Services or
 * throws, promptly, which is exactly why push worked there and not here.
 */
const TOKEN_TIMEOUT_MS = 10_000

/** Bound a promise that may never settle. The loser is abandoned, not
 *  cancelled — harmless here, and a token that lands late still reaches the
 *  relay through the push-token listener's re-registration. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

/**
 * Acquire the Expo push token (null when permission is denied, when this is
 * a simulator, or when anything in the chain fails — a phone that cannot be
 * pushed still registers, and delivery degrades to in-band only).
 */
async function acquireExpoPushToken(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null
    // The channel must exist BEFORE any token work on Android; HIGH matches
    // the urgency the relay sends and must keep the exact id it names.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: 'Agent runs',
        importance: Notifications.AndroidImportance.HIGH
      })
    }
    let settings = await Notifications.getPermissionsAsync()
    if (!settings.granted && settings.canAskAgain) {
      settings = await Notifications.requestPermissionsAsync()
    }
    if (!settings.granted) return null
    const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId
    if (typeof projectId !== 'string' || !projectId) return null
    // The projectId argument is mandatory in EAS builds.
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
    return typeof data === 'string' && data ? data : null
  } catch {
    return null
  }
}

/** Serialize registrations — foreground + connect can race each other. */
let registering: Promise<void> | null = null

/**
 * Send `register_push` for this device over the current tunnel: on pairing,
 * on every foreground, and on token rotation. Always upserts the same
 * phoneId; a null token is a valid registration (permission denied). Never
 * throws — a failed registration must not disturb pairing or startup.
 *
 * REGISTRATION MUST HAPPEN, TOKEN OR NOT. The relay's routing table is keyed
 * by phoneId, and a notify for a phoneId it has never seen is dropped before
 * it considers any delivery path — including the live socket. So a phone that
 * fails to register gets nothing at all, not even in-band notifications it is
 * connected for. That is why the token is acquired under a timeout rather
 * than awaited: a phone with no usable push token still registers, still
 * receives everything in-band, and upgrades to real push the moment a token
 * arrives (the push-token listener re-registers).
 */
export function refreshPushRegistration(): Promise<void> {
  if (registering) return registering
  const run = (async () => {
    try {
      const tunnel = activeTunnel
      if (!tunnel) return
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') return
      const frame: RegisterPushFrame = {
        v: PUSH_WIRE_VERSION,
        type: 'register_push',
        phoneId: await getPhoneId(),
        expoPushToken: await withTimeout(acquireExpoPushToken(), TOKEN_TIMEOUT_MS, null),
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version ?? null
      }
      // Re-read: the tunnel may have been replaced while we awaited the
      // token; register on whichever connection is current now.
      ;(activeTunnel ?? tunnel).sendControl(frame)
      // A fresh registration is also the moment to re-assert the badge
      // count: this relay (or a redeployed one) may hold a stale number.
      await syncBadge(true)
    } catch {
      // No socket right now — the next foreground/connect registers again.
    }
  })()
  // Released here and NOT in a `finally` inside the body above. A body that
  // returns before its first await — no tunnel yet, an unsupported platform —
  // runs to completion synchronously, so that `finally` fired BEFORE this
  // assignment and left the guard holding an already-settled promise for the
  // life of the process: every later call returned it and registered nothing.
  // A foregrounded app that had not connected yet was enough to lose push
  // until the next cold start.
  registering = run
  void run.finally(() => {
    if (registering === run) registering = null
  })
  return run
}

// ------------------------------------------------------------- badge sync

/** The last count the relay was told, to keep quiet syncs from re-sending
 *  the same number on every foreground. Reset by force (re-registration). */
let lastSentBadge: number | null = null

/**
 * Push the store's absolute total to both counters the app cannot render:
 * the OS icon and the relay's per-device integer (which stamps `badge` onto
 * Expo pushes while the app is dead). Store subscriptions call it on every
 * badge change; reconciliation and registration call it directly — with
 * force after (re)registration, because that relay may hold a stale count.
 */
async function syncBadge(force = false): Promise<void> {
  const total = badgeTotal(useBadges.getState())
  try {
    await Notifications.setBadgeCountAsync(total)
  } catch {
    // No icon badge on this runtime — the relay count still matters.
  }
  const tunnel = activeTunnel
  if (!tunnel) return
  if (!force && lastSentBadge === total) return
  try {
    const frame: SetBadgeFrame = {
      v: PUSH_WIRE_VERSION,
      type: 'set_badge',
      phoneId: await getPhoneId(),
      count: total
    }
    ;(activeTunnel ?? tunnel).sendControl(frame)
    lastSentBadge = total
  } catch {
    // Socket died — the next connect's registration re-asserts the count.
  }
}
