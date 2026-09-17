/**
 * UserBridge — one Durable Object per user: the live link between that
 * user's desktop and their phone(s).
 *
 * Everything DURABLE about a user (config, conversations, files, usage)
 * lives in D1/R2 and both devices read it through the ordinary REST routes.
 * What cannot be durable is what happens RIGHT NOW on the desktop — a turn
 * streaming, a question the agent is parked on, a settings write the phone
 * wants applied through the desktop's own code paths — and that is all this
 * object carries: the desktop holds one WebSocket here, each phone holds one
 * while it is on screen, and the object forwards frames between them.
 *
 *   phone  ──ws──▶  UserBridge  ◀──ws──  desktop
 *          rpc ─────────────────────────▶  (answers with res)
 *          ◀────────────────────────────  ev (pushes to every phone)
 *
 * It also holds the two things the old relay used to: PRESENCE — whether
 * the desktop is connected right now, which is the phone's fast "is my
 * desktop up" check — and the PUSH register (Expo tokens per phone), so a
 * notification the desktop's agent sends reaches a phone that is not on
 * screen. Frames are plain JSON: the org's API is the trusted party on both
 * ends (it already holds the user's data), so there is nothing for an
 * end-to-end cipher to protect against here.
 *
 * Hibernation: sockets survive the object being evicted between frames, so
 * an idle desktop costs nothing; the auto-response answers keepalive pings
 * without waking it.
 */
import {
  errorCodeOf,
  getExpoReceipts,
  sendExpoPush,
  tokenPrefix,
  type ExpoErrorCode,
  type ExpoPushMessage
} from '@/lib/expo-push'
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '@/index'

/** Application close codes (4000–4999 is the app range). */
export const BridgeClose = {
  /** A newer socket for the same device took over. */
  Replaced: 4000,
  /** The device's sessions were revoked (unpaired, signed out, admin). */
  Revoked: 4001,
  ProtocolViolation: 4400,
  MessageTooLarge: 4413
} as const

/** One frame may not exceed this — the runtime's own WebSocket ceiling. */
const MAX_FRAME_BYTES = 1024 * 1024
/** Conversation ids ARE filenames on the desktop, so this is that same safe
 *  set — the shape both clients validate a deeplink id against. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** How long an in-band notification may wait for the phone's ack before the
 *  push fallback fires. The phone acks the moment it renders. */
const INBAND_ACK_MS = 2_000
/** Where both platforms stop counting: iOS shows 999+, Android's launchers
 *  give up well before that. A number past this is noise on a lock screen. */
const BADGE_COUNT_MAX = 999
/** Expo's own recommendation: give a ticket this long before asking what
 *  became of it. Sooner and the receipt simply is not made yet. */
const RECEIPT_SWEEP_DELAY_MS = 15 * 60_000
/** How long a notificationId is remembered, so a resend replays its original
 *  outcome instead of buzzing the same pocket again. */
const NOTIFY_DEDUP_RETENTION_MS = 24 * 3_600_000
/** Expo forgets receipts after about a day; a ticket we never got one for is
 *  abandoned at the same horizon rather than swept forever. */
const TICKET_RETENTION_MS = NOTIFY_DEDUP_RETENTION_MS
/** Floor between alarm firings, so a failing receipt fetch can never turn the
 *  sweep into a tight loop. */
const MIN_ALARM_GAP_MS = 60_000
/** The Android channel the phone creates at launch. The id must match what
 *  the handset registered or Android silently drops the notification. */
const ANDROID_CHANNEL_ID = 'agent-runs'

/** Durable Object storage prefixes, all three push-owned. */
const PUSH_PREFIX = 'push:'
const TICKET_PREFIX = 'ticket:'
const RESULT_PREFIX = 'notif:'

/**
 * Transport priority for one push, per platform.
 *
 * Expo's two priorities do not mean the same thing on the two platforms. APNs
 * 5 is a power hint — the notification still arrives. FCM `normal` is a
 * QUEUE: a phone in Doze holds the message until its next maintenance window,
 * minutes at best and hours overnight, which is precisely the asleep-and-
 * closed case push exists for. So Android is always sent high, whatever the
 * model chose: every push here is a user-visible notification the model
 * deliberately sent, which is what FCM reserves high priority for, and the
 * phone cannot show the difference anyway — one channel, at HIGH importance.
 */
function expoPriority(platform: 'ios' | 'android', urgency: unknown): 'default' | 'high' {
  if (platform === 'android') return 'high'
  return urgency === 'high' ? 'high' : 'default'
}

export type BridgeRole = 'desktop' | 'phone'

type Attachment = {
  role: BridgeRole
  /** Random per-socket tag: how a phone's RPC answers find their way back. */
  tag: string
  deviceId: string
  sessionId: string
  name: string
  platform: string
  appVersion: string
  /** What the device is, as it describes itself on the way in. */
  model: string
  os: string
  osVersion: string
  connectedAt: number
}

type PushRegistration = {
  token: string | null
  platform: 'ios' | 'android'
  appVersion: string | null
  badge: number
  updatedAt: number
}

/** An Expo ticket awaiting its receipt. Key: `ticket:<ticketId>`. */
type TicketRecord = {
  ticketId: string
  deviceId: string
  notificationId: string
  sentAt: number
}

/** The routing decision the desktop is answered with, and the model reads. */
type NotifyResult = {
  v: 1
  type: 'notify_result'
  notificationId: string | null
  route: 'inband' | 'push' | 'dropped'
  reason?: string
}

/** Idempotency memory for a processed notify. Key: `notif:<notificationId>`. */
type ResultRecord = { result: NotifyResult; at: number }

export type PresenceDevice = {
  deviceId: string
  name: string
  platform: string
  appVersion: string
  connectedAt: number
}

export type PresenceFrame = {
  t: 'presence'
  /** The desktop RPCs route to — the most recently connected one. */
  desktop: PresenceDevice | null
  desktops: PresenceDevice[]
  phones: PresenceDevice[]
}

const randomTag = (): string => {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export class UserBridge extends DurableObject<Env> {
  /** notificationId → resolver of the in-band ack wait. In memory only: the
   *  wait is two seconds, far shorter than any eviction. */
  private readonly ackWaiters = new Map<string, () => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalives never wake the object: the runtime answers them itself.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/ws':
        return this.openSocket(request)
      case '/status':
        return Response.json(this.presence())
      case '/close': {
        const device = url.searchParams.get('device') ?? ''
        const closed = this.closeDevice(device, BridgeClose.Revoked, 'revoked')
        // A revoked device stops being pushable the moment it leaves, rather
        // than lingering until its token dies of old age: the handset that
        // holds it has just been told to wipe everything the notifications
        // would be about.
        if (device) {
          await this.ctx.storage.delete(`${PUSH_PREFIX}${device}`)
          await this.markPush(device, { state: 'unknown', registeredAt: null, error: '' })
        }
        return Response.json({ ok: true, closed })
      }
      case '/event': {
        const body = (await request.json().catch(() => null)) as {
          to?: BridgeRole
          topic?: string
          payload?: unknown
        } | null
        if (!body?.topic) return Response.json({ error: 'invalid_request' }, { status: 400 })
        const frame = JSON.stringify({ t: 'ev', topic: body.topic, payload: body.payload ?? null })
        let sent = 0
        for (const ws of this.ctx.getWebSockets(body.to ?? 'phone')) sent += this.raw(ws, frame)
        return Response.json({ ok: true, sent })
      }
      default:
        return Response.json({ error: 'not_found' }, { status: 404 })
    }
  }

  // ── Connections ─────────────────────────────────────────────────────────

  private openSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'expected_websocket' }, { status: 426 })
    }
    const role = request.headers.get('x-wfc-role') === 'desktop' ? 'desktop' : 'phone'
    const attachment: Attachment = {
      role,
      tag: randomTag(),
      deviceId: request.headers.get('x-wfc-device') ?? '',
      sessionId: request.headers.get('x-wfc-session') ?? '',
      name: (request.headers.get('x-wfc-name') ?? '').slice(0, 120),
      platform: (request.headers.get('x-wfc-platform') ?? '').slice(0, 32),
      appVersion: (request.headers.get('x-wfc-version') ?? '').slice(0, 64),
      model: (request.headers.get('x-wfc-model') ?? '').slice(0, 120),
      os: (request.headers.get('x-wfc-os') ?? '').slice(0, 32),
      osVersion: (request.headers.get('x-wfc-os-version') ?? '').slice(0, 60),
      connectedAt: Date.now()
    }
    // One socket per device: a reconnect replaces the socket it superseded,
    // so a phone that came back from the background never has two.
    if (attachment.deviceId) this.closeDevice(attachment.deviceId, BridgeClose.Replaced, 'replaced')

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.serializeAttachment(attachment)
    this.ctx.acceptWebSocket(server, [role, `dev:${attachment.deviceId}`, `tag:${attachment.tag}`])
    // The newcomer learns who is here; everyone else learns the newcomer.
    this.broadcastPresence()
    if (attachment.deviceId && role === 'phone') this.ctx.waitUntil(this.touchDevice(attachment))
    return new Response(null, { status: 101, webSocket: client })
  }

  private closeDevice(deviceId: string, code: number, reason: string): number {
    if (!deviceId) return 0
    let closed = 0
    for (const ws of this.ctx.getWebSockets(`dev:${deviceId}`)) {
      try {
        ws.close(code, reason)
        closed++
      } catch {
        // already gone
      }
    }
    return closed
  }

  /** The phone showed up: its device row's last_seen_at is the org's record
   *  of that, read by the desktop's paired-phones list. The rest of what the
   *  phone says about itself is written back here too — an upgraded OS or a
   *  renamed handset corrects itself on the next connect, and the panel can
   *  describe a phone that is asleep right now. Best-effort. */
  private async touchDevice(attachment: Attachment): Promise<void> {
    // The socket carries the device's PLATFORM (ios/android); the row's own
    // platform column stays the device KIND ('mobile'), so the phone's OS
    // lands in `os` — from the explicit param, or from that platform.
    const os =
      attachment.os ||
      (attachment.platform === 'ios' || attachment.platform === 'android' ? attachment.platform : '')
    try {
      await this.env.DB.prepare(
        `UPDATE devices SET last_seen_at = ?1,
           app_version = CASE WHEN ?2 = '' THEN app_version ELSE ?2 END,
           name = CASE WHEN ?3 = '' THEN name ELSE ?3 END,
           model = CASE WHEN ?4 = '' THEN model ELSE ?4 END,
           os = CASE WHEN ?5 = '' THEN os ELSE ?5 END,
           os_version = CASE WHEN ?6 = '' THEN os_version ELSE ?6 END
         WHERE id = ?7`
      )
        .bind(
          new Date(attachment.connectedAt).toISOString(),
          attachment.appVersion,
          attachment.name,
          attachment.model,
          os,
          attachment.osVersion,
          attachment.deviceId
        )
        .run()
    } catch {
      // presence is served live either way
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.forget(ws)
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.forget(ws)
  }

  private forget(ws: WebSocket): void {
    try {
      ws.close(1000, 'bye')
    } catch {
      // closing an already-closed socket is fine
    }
    // The socket is still listed until this handler returns; announce the
    // presence WITHOUT it, so the remaining side sees the drop now.
    this.broadcastPresence(ws)
  }

  // ── Frames ──────────────────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(BridgeClose.ProtocolViolation, 'text frames only')
      return
    }
    if (message.length > MAX_FRAME_BYTES) {
      ws.close(BridgeClose.MessageTooLarge, 'frame too large')
      return
    }
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(message) as Record<string, unknown>
    } catch {
      ws.close(BridgeClose.ProtocolViolation, 'not json')
      return
    }
    const me = ws.deserializeAttachment() as Attachment | null
    if (!me || typeof frame?.t !== 'string') return

    if (me.role === 'phone') {
      switch (frame.t) {
        case 'rpc':
          this.forwardRpc(me, frame)
          return
        case 'push':
          await this.handlePush(me, frame.frame as Record<string, unknown> | undefined)
          return
        case 'presence':
          this.send(ws, this.presence())
          return
        default:
          return
      }
    }
    // Desktop.
    switch (frame.t) {
      case 'res':
        this.routeResponse(frame)
        return
      case 'ev':
        this.broadcastPhones(frame)
        return
      case 'notify':
        await this.deliverNotify(ws, frame.frame as Record<string, unknown> | undefined)
        return
      case 'presence':
        this.send(ws, this.presence())
        return
      default:
        return
    }
  }

  /**
   * A phone's request for the desktop. The id is prefixed with the phone's
   * socket tag on the way out and stripped on the way back, which is the
   * whole routing table — nothing is stored, so a phone that vanishes
   * mid-call simply has nowhere for the answer to land.
   */
  private forwardRpc(from: Attachment, frame: Record<string, unknown>): void {
    const desktop = this.primaryDesktop()
    const id = frame.id
    if (typeof id !== 'number' && typeof id !== 'string') return
    if (!desktop) {
      const back = this.ctx.getWebSockets(`tag:${from.tag}`)[0]
      if (back) {
        this.send(back, {
          t: 'res',
          id,
          error: { code: 'desktop_offline', message: 'the desktop is not connected' }
        })
      }
      return
    }
    this.send(desktop, {
      t: 'rpc',
      id: `${from.tag}:${String(id)}`,
      method: frame.method,
      params: frame.params ?? {},
      phone: { deviceId: from.deviceId, name: from.name }
    })
  }

  private routeResponse(frame: Record<string, unknown>): void {
    const wireId = typeof frame.id === 'string' ? frame.id : ''
    const colon = wireId.indexOf(':')
    if (colon <= 0) return
    const tag = wireId.slice(0, colon)
    const rawId = wireId.slice(colon + 1)
    const phone = this.ctx.getWebSockets(`tag:${tag}`)[0]
    if (!phone) return
    // Numeric ids round-trip as numbers — the phone matches strictly.
    const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId
    const { id: _drop, ...rest } = frame
    this.send(phone, { ...rest, id })
  }

  private broadcastPhones(frame: Record<string, unknown>): void {
    const encoded = JSON.stringify(frame)
    for (const ws of this.ctx.getWebSockets('phone')) this.raw(ws, encoded)
  }

  // ── Presence ────────────────────────────────────────────────────────────

  private describe(ws: WebSocket): PresenceDevice | null {
    const a = ws.deserializeAttachment() as Attachment | null
    if (!a) return null
    return {
      deviceId: a.deviceId,
      name: a.name,
      platform: a.platform,
      appVersion: a.appVersion,
      connectedAt: a.connectedAt
    }
  }

  private primaryDesktop(exclude?: WebSocket): WebSocket | null {
    let best: { ws: WebSocket; at: number } | null = null
    for (const ws of this.ctx.getWebSockets('desktop')) {
      if (ws === exclude) continue
      const a = ws.deserializeAttachment() as Attachment | null
      if (!a) continue
      if (!best || a.connectedAt > best.at) best = { ws, at: a.connectedAt }
    }
    return best?.ws ?? null
  }

  presence(exclude?: WebSocket): PresenceFrame {
    const desktops: PresenceDevice[] = []
    const phones: PresenceDevice[] = []
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue
      const d = this.describe(ws)
      if (!d) continue
      const a = ws.deserializeAttachment() as Attachment
      if (a.role === 'desktop') desktops.push(d)
      else phones.push(d)
    }
    desktops.sort((x, y) => y.connectedAt - x.connectedAt)
    phones.sort((x, y) => y.connectedAt - x.connectedAt)
    return { t: 'presence', desktop: desktops[0] ?? null, desktops, phones }
  }

  private broadcastPresence(exclude?: WebSocket): void {
    const encoded = JSON.stringify(this.presence(exclude))
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue
      this.raw(ws, encoded)
    }
  }

  // ── Push notifications ──────────────────────────────────────────────────

  /**
   * Phone-side push control frames. Registrations are keyed by the ORG's
   * device id, never by anything the handset makes up: the socket already
   * proved which device it is when it authenticated, so a phone cannot
   * register a token against a device that is not itself.
   */
  private async handlePush(from: Attachment, frame: Record<string, unknown> | undefined): Promise<void> {
    if (!frame || typeof frame.type !== 'string' || !from.deviceId) return
    const key = `${PUSH_PREFIX}${from.deviceId}`
    switch (frame.type) {
      case 'register_push': {
        const current = (await this.ctx.storage.get<PushRegistration>(key)) ?? null
        const token = typeof frame.expoPushToken === 'string' ? frame.expoPushToken : null
        const next: PushRegistration = {
          token,
          platform: frame.platform === 'android' ? 'android' : 'ios',
          appVersion: typeof frame.appVersion === 'string' ? frame.appVersion : null,
          badge: current?.badge ?? 0,
          updatedAt: Date.now()
        }
        await this.ctx.storage.put(key, next)
        // A REGISTRATION WITHOUT A TOKEN IS NOT A FAILURE and must not read
        // like one: permission refused and "this is a simulator" both land
        // here, and both mean in-band delivery only, honestly. What it does
        // mean is that a phone previously marked `dead` is alive again as
        // soon as it comes back with a token.
        await this.markPush(from.deviceId, {
          state: token ? 'live' : 'none',
          registeredAt: Date.now(),
          ...(token ? { error: '' } : {})
        })
        console.log(
          `[push] device registered: ${from.deviceId} (${next.platform}, app ` +
            `${next.appVersion ?? 'unknown'}, token ${tokenPrefix(token)})`
        )
        return
      }
      case 'unregister_push':
        await this.ctx.storage.delete(key)
        await this.markPush(from.deviceId, { state: 'unknown', registeredAt: null })
        console.log(`[push] device unregistered: ${from.deviceId}`)
        return
      case 'set_badge': {
        const current = await this.ctx.storage.get<PushRegistration>(key)
        if (!current) return
        const raw = typeof frame.count === 'number' && Number.isFinite(frame.count) ? frame.count : 0
        const count = Math.min(BADGE_COUNT_MAX, Math.max(0, Math.round(raw)))
        if (current.badge === count) return
        await this.ctx.storage.put(key, { ...current, badge: count })
        return
      }
      case 'notification_ack': {
        const id = typeof frame.notificationId === 'string' ? frame.notificationId : ''
        this.ackWaiters.get(id)?.()
        return
      }
      default:
        return
    }
  }

  /**
   * The desktop's agent asked for a notification. Routing decision tree, in
   * order:
   *
   *   1. already processed?      -> replay the stored result, send nothing
   *   2. a phone socket is live  -> deliver in-band, answer `inband`, then
   *      wait ~2 s for the ack and fall back to Expo push if it never comes
   *      (the phone dedupes by notificationId, so an overlap is invisible)
   *   3. no live phone, a token  -> answer `push`, then send via Expo
   *   4. nothing to deliver on   -> dropped, with the reason that names the
   *      seam rather than the symptom
   *
   * THE DESKTOP IS ANSWERED BEFORE THE SLOW PART, AND THE SLOW PART IS
   * AWAITED HERE. Those are two separate rules and both were learned the hard
   * way.
   *
   * Answering first is what keeps the model's turn from hanging on exp.host's
   * round trip — and the answer would not improve by waiting, because a
   * ticket means Expo accepted the message, not that a handset got it. What
   * establishes delivery is the receipt sweep in `alarm()`, minutes later; a
   * dead token found there prunes the registration, so the NEXT notify tells
   * the truth instead of this one guessing at it.
   *
   * Awaiting rather than `ctx.waitUntil` is not a preference. In a Durable
   * Object, waitUntil does not extend the lifetime of anything: work handed
   * to it from a WebSocket message handler is abandoned the moment that
   * handler returns, which here meant `pushViaExpo` never reached its first
   * fetch — every off-screen notification answered `push` and sent nothing at
   * all. Awaiting costs this one user's object a few hundred milliseconds
   * with the answer already on the wire, and other frames still interleave at
   * the await points (the phone's own ack arrives during exactly this wait).
   */
  private async deliverNotify(desktop: WebSocket, frame: Record<string, unknown> | undefined): Promise<void> {
    const notificationId = typeof frame?.notificationId === 'string' ? frame.notificationId : ''
    const answer = (result: NotifyResult): void => {
      this.send(desktop, { t: 'notify_result', frame: result })
    }
    if (!frame || !notificationId) {
      answer({
        v: 1,
        type: 'notify_result',
        notificationId: null,
        route: 'dropped',
        reason: 'malformed notify frame'
      })
      return
    }

    // Idempotency: a re-sent notificationId gets its original outcome and
    // triggers nothing. The desktop mints these ids, so this is trustworthy —
    // and it is what keeps a resend (a reconnect mid-flight, a retry the
    // harness did not suppress) from buzzing the same pocket twice.
    const resultKey = `${RESULT_PREFIX}${notificationId}`
    const prior = await this.ctx.storage.get<ResultRecord>(resultKey)
    if (prior) {
      answer(prior.result)
      return
    }

    /**
     * The conversation this notification came OUT of, shape-checked HERE
     * because this is the only place both delivery paths pass through.
     *
     * Conversation ids are filenames on the desktop, so this is that same safe
     * set. It matters because the phone keys a badge by it: the in-band frame
     * is re-validated on arrival (parseNotification), but the Expo payload is
     * read straight out of `data`, so anything not caught here would key a
     * badge bucket no screen can show and no read can clear.
     */
    const conversationId =
      typeof frame.conversationId === 'string' && CONVERSATION_ID_RE.test(frame.conversationId)
        ? frame.conversationId
        : null

    const phones = this.ctx.getWebSockets('phone')
    const registrations = [
      ...(await this.ctx.storage.list<PushRegistration>({ prefix: PUSH_PREFIX }))
    ]
    const pushable = registrations.filter(([, reg]) => Boolean(reg.token))

    let result: NotifyResult
    /** What still has to happen once the desktop has its answer. */
    let deliver: (() => Promise<void>) | null = null
    if (phones.length === 0 && pushable.length === 0) {
      result = {
        v: 1,
        type: 'notify_result',
        notificationId,
        route: 'dropped',
        reason: registrations.length
          ? 'the phone is not connected and has no push token registered — notification permission ' +
            'is off on the handset, or it is a simulator, which cannot receive push'
          : 'no phone has registered for notifications on this account'
      }
    } else {
      // Count the notification the moment a delivery path exists — once per
      // notificationId (replays returned above), never per send attempt, so
      // the in-band try and its push fallback cannot double-count.
      await this.bumpBadges(registrations)
      if (phones.length > 0) {
        // Spread, then override: the frame travels whole so a field this build
        // does not know still reaches the phone, but `conversationId` is the
        // sanitized one rather than whatever arrived.
        const encoded = JSON.stringify({
          t: 'notification',
          frame: { ...frame, type: 'notification', conversationId }
        })
        for (const ws of phones) this.raw(ws, encoded)
        result = { v: 1, type: 'notify_result', notificationId, route: 'inband' }
        deliver = () => this.fallBackUnlessAcked(notificationId, frame, conversationId)
      } else {
        result = { v: 1, type: 'notify_result', notificationId, route: 'push' }
        deliver = () => this.pushViaExpo(notificationId, frame, conversationId)
      }
    }

    await this.ctx.storage.put(resultKey, { result, at: Date.now() } satisfies ResultRecord)
    // Make sure SOMETHING will prune this idempotency record eventually.
    await this.armAlarm(Date.now() + NOTIFY_DEDUP_RETENTION_MS)
    answer(result)
    if (deliver) {
      // Never throws outward: a notification is the last thing that should be
      // able to close a user's bridge socket.
      await deliver().catch((error) => {
        console.error(`[push] ${notificationId}: delivery failed: ${String(error)}`)
      })
    }
  }

  /** One unread more on every registered phone, clamped where the platforms
   *  stop counting. The phone overwrites this with its own absolute
   *  `set_badge` as soon as it is on screen — this is only the number the OS
   *  paints while the app is dead. */
  private async bumpBadges(entries: [string, PushRegistration][]): Promise<void> {
    await Promise.all(
      entries.map(([key, reg]) =>
        this.ctx.storage.put(key, {
          ...reg,
          badge: Math.min(BADGE_COUNT_MAX, (reg.badge ?? 0) + 1)
        })
      )
    )
  }

  /** The in-band ack window: give the phone a moment, then push anyway. The
   *  phone's own seen-set is what keeps the pair from rendering twice. */
  private async fallBackUnlessAcked(
    notificationId: string,
    frame: Record<string, unknown>,
    conversationId: string | null
  ): Promise<void> {
    const acked = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(notificationId)
        resolve(false)
      }, INBAND_ACK_MS)
      this.ackWaiters.set(notificationId, () => {
        clearTimeout(timer)
        this.ackWaiters.delete(notificationId)
        resolve(true)
      })
    })
    if (acked) return
    console.warn(`[push] ${notificationId}: no ack within ${INBAND_ACK_MS}ms — pushing`)
    await this.pushViaExpo(notificationId, frame, conversationId)
  }

  /**
   * Send one notification to every registered token and deal with the tickets.
   *
   * A TICKET IS NOT A DELIVERY. `push/send` answers 200 with per-message
   * tickets, and an error ticket — a dead token, a broken FCM key — arrives
   * under that same 200. Treating the HTTP status as the outcome is how a
   * phone that could not be pushed for weeks kept being reported as pushed.
   */
  private async pushViaExpo(
    notificationId: string,
    frame: Record<string, unknown>,
    conversationId: string | null
  ): Promise<void> {
    const registrations = await this.ctx.storage.list<PushRegistration>({ prefix: PUSH_PREFIX })
    const targets: { key: string; deviceId: string; reg: PushRegistration; token: string }[] = []
    for (const [key, reg] of registrations) {
      if (reg.token) {
        targets.push({ key, deviceId: key.slice(PUSH_PREFIX.length), reg, token: reg.token })
      }
    }
    if (targets.length === 0) return

    const ttl = typeof frame.ttl === 'number' ? frame.ttl : 900
    const messages: ExpoPushMessage[] = targets.map(({ reg, token }) => ({
      to: token,
      title: String(frame.title ?? ''),
      body: String(frame.body ?? ''),
      sound: 'default',
      badge: reg.badge ?? 0,
      ttl,
      priority: expoPriority(reg.platform, frame.urgency),
      channelId: ANDROID_CHANNEL_ID,
      data: {
        notificationId,
        runId: frame.runId ?? '',
        phase: frame.phase ?? 'info',
        url: frame.deeplink ?? null,
        // Which conversation RAISED it — what the phone badges. Separate from
        // `url`, which is where a tap goes and which notify_phone lets the
        // model omit entirely; a notification with no destination still came
        // from somewhere, and the phone has no other way to learn where.
        conversationId,
        // When the DESKTOP sent it. Without this the phone's notification log
        // can only date a pushed one by when the handset received it: minutes
        // late out of a tray, hours late for a phone that was off.
        ts: typeof frame.ts === 'number' ? frame.ts : Date.now()
      }
    }))

    const tickets = await sendExpoPush(this.env, messages)
    let stored = 0
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!
      const ticket = tickets[i]
      if (!ticket) {
        // Transport or HTTP failure — expo-push.ts has already logged what.
        await this.markPush(target.deviceId, {
          error: 'push service unreachable',
          errorAt: Date.now()
        })
        continue
      }
      if (ticket.status === 'error') {
        await this.onPushError(
          notificationId,
          target.key,
          target.deviceId,
          target.token,
          errorCodeOf(ticket),
          ticket.message
        )
        continue
      }
      await this.ctx.storage.put(`${TICKET_PREFIX}${ticket.id}`, {
        ticketId: ticket.id,
        deviceId: target.deviceId,
        notificationId,
        sentAt: Date.now()
      } satisfies TicketRecord)
      await this.markPush(target.deviceId, { sentAt: Date.now() })
      stored += 1
    }
    // Receipts are what actually prove delivery — sweep them after Expo's
    // recommended 15 minutes.
    if (stored > 0) await this.armAlarm(Date.now() + this.sweepDelayMs())
  }

  /**
   * One failed ticket or receipt, in the only two flavours that differ: the
   * ones that condemn THIS handset, and the ones that condemn the org's whole
   * Expo project. Both end up on the device row, because the row is what an
   * admin, the desktop panel and the model can all actually read.
   */
  private async onPushError(
    notificationId: string,
    key: string | null,
    deviceId: string,
    token: string | null,
    code: ExpoErrorCode,
    message?: string
  ): Promise<void> {
    if (code === 'DeviceNotRegistered') {
      // The token is dead (app uninstalled, token rotated away). Drop the
      // registration so later notifies degrade honestly instead of pretending
      // to push, and leave the state on the row saying why.
      if (key) await this.ctx.storage.delete(key)
      await this.markPush(deviceId, { state: 'dead', error: code, errorAt: Date.now() })
      console.warn(
        `[push] ${notificationId}: DeviceNotRegistered — registration for ${deviceId} removed ` +
          `(token ${tokenPrefix(token)})`
      )
      return
    }
    await this.markPush(deviceId, { error: code, errorAt: Date.now() })
    if (code === 'InvalidCredentials') {
      console.error(
        `[push] ${notificationId}: InvalidCredentials — the FCM/APNs credentials on the org's ` +
          'Expo project are broken; NO push will deliver for anyone until they are fixed'
      )
    } else if (code === 'MessageTooBig') {
      console.error(`[push] ${notificationId}: MessageTooBig — payload over 4 KiB`)
    } else if (code === 'MessageRateExceeded') {
      console.error(`[push] ${notificationId}: MessageRateExceeded for ${deviceId}`)
    } else {
      console.error(`[push] ${notificationId}: error ${code}: ${message ?? ''}`)
    }
  }

  /**
   * What the org believes about one phone's pushability, on the device row
   * where every other reader already looks. Best-effort by design: a failed
   * write must never cost the notification it was describing.
   */
  private async markPush(
    deviceId: string,
    patch: {
      state?: 'unknown' | 'none' | 'live' | 'dead'
      registeredAt?: number | null
      sentAt?: number
      deliveredAt?: number
      error?: string
      errorAt?: number
    }
  ): Promise<void> {
    if (!deviceId) return
    const sets: string[] = []
    const values: unknown[] = []
    const push = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = ?${values.length}`)
    }
    const iso = (at: number | null | undefined): string | null =>
      typeof at === 'number' ? new Date(at).toISOString() : null
    if (patch.state !== undefined) push('push_state', patch.state)
    if (patch.registeredAt !== undefined) push('push_registered_at', iso(patch.registeredAt))
    if (patch.sentAt !== undefined) push('push_sent_at', iso(patch.sentAt))
    if (patch.deliveredAt !== undefined) push('push_delivered_at', iso(patch.deliveredAt))
    if (patch.error !== undefined) push('push_error', patch.error)
    if (patch.errorAt !== undefined) push('push_error_at', iso(patch.errorAt))
    if (sets.length === 0) return
    values.push(deviceId)
    try {
      await this.env.DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?${values.length}`)
        .bind(...values)
        .run()
    } catch {
      // The notification matters more than the bookkeeping about it.
    }
  }

  /**
   * Receipt sweep and storage hygiene — the DO's single alarm, shared by both
   * jobs that need one.
   *
   * RECEIPTS ARE THE ONLY PROOF. Tickets always look successful once Expo has
   * taken the message; whether APNs or FCM ever accepted it is answered here,
   * fifteen minutes later. A DeviceNotRegistered receipt is the reliable
   * signal that a token died, and an InvalidCredentials receipt is the ONLY
   * place broken FCM/APNs credentials on the Expo project ever surface —
   * without this sweep an org can push into a void indefinitely while every
   * surface reports success.
   */
  async alarm(): Promise<void> {
    const now = Date.now()

    const tickets = await this.ctx.storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
    const due: [string, TicketRecord][] = []
    for (const [key, ticket] of tickets) {
      if (ticket.sentAt + this.sweepDelayMs() <= now) due.push([key, ticket])
    }

    if (due.length > 0) {
      const receipts = await getExpoReceipts(
        this.env,
        due.map(([, t]) => t.ticketId)
      )
      if (receipts) {
        for (const [key, ticket] of due) {
          const receipt = receipts[ticket.ticketId]
          if (!receipt) {
            // Expo has not made one yet, or never will. Either way this
            // ticket has had its window; holding it changes nothing.
            console.warn(`[push] no receipt for ticket ${ticket.ticketId} — dropped from sweep`)
          } else if (receipt.status === 'error') {
            await this.onPushError(
              ticket.notificationId,
              `${PUSH_PREFIX}${ticket.deviceId}`,
              ticket.deviceId,
              null,
              errorCodeOf(receipt),
              receipt.message
            )
          } else {
            await this.markPush(ticket.deviceId, { deliveredAt: now, error: '' })
          }
          await this.ctx.storage.delete(key)
        }
      } else {
        // Receipt endpoint unreachable: keep the due tickets for the next
        // sweep, but never forever — Expo forgets receipts after about a day.
        for (const [key, ticket] of due) {
          if (ticket.sentAt + TICKET_RETENTION_MS <= now) {
            console.warn(`[push] ticket ${ticket.ticketId} abandoned — receipts unreachable for 24h`)
            await this.ctx.storage.delete(key)
          }
        }
      }
    }

    // Prune idempotency records past their retention.
    const results = await this.ctx.storage.list<ResultRecord>({ prefix: RESULT_PREFIX })
    for (const [key, record] of results) {
      if (record.at + NOTIFY_DEDUP_RETENTION_MS <= now) await this.ctx.storage.delete(key)
    }

    // Re-arm for whatever remains, with a floor so a failing sweep can never
    // turn into a tight loop of alarms.
    let next: number | null = null
    const remainingTickets = await this.ctx.storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
    for (const [, ticket] of remainingTickets) {
      const at = ticket.sentAt + this.sweepDelayMs()
      next = next === null ? at : Math.min(next, at)
    }
    const remainingResults = await this.ctx.storage.list<ResultRecord>({ prefix: RESULT_PREFIX })
    for (const [, record] of remainingResults) {
      const at = record.at + NOTIFY_DEDUP_RETENTION_MS
      next = next === null ? at : Math.min(next, at)
    }
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + this.alarmGapMs()))
  }

  /**
   * The receipt window, and the floor between alarms. Both are overridable by
   * env vars no deployment sets — the local push smoke turns fifteen minutes
   * into two seconds, because a sweep that only runs a quarter of an hour
   * after a send is otherwise proved by nothing at all, and it is the half of
   * delivery that knows whether the org's Expo credentials work.
   */
  private sweepDelayMs(): number {
    const override = Number(this.env.PUSH_SWEEP_DELAY_MS ?? '')
    return Number.isFinite(override) && override > 0 ? override : RECEIPT_SWEEP_DELAY_MS
  }

  private alarmGapMs(): number {
    const override = Number(this.env.PUSH_SWEEP_DELAY_MS ?? '')
    return Number.isFinite(override) && override > 0 ? override : MIN_ALARM_GAP_MS
  }

  /** Move the single DO alarm earlier if needed; never postpone one. */
  private async armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }
  // ── Wire helpers ────────────────────────────────────────────────────────

  private send(ws: WebSocket, frame: unknown): void {
    this.raw(ws, JSON.stringify(frame))
  }

  private raw(ws: WebSocket, encoded: string): number {
    try {
      ws.send(encoded)
      return 1
    } catch {
      return 0
    }
  }
}
