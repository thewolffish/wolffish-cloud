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
/** How long an in-band notification may wait for the phone's ack before the
 *  push fallback fires. The phone acks the moment it renders. */
const INBAND_ACK_MS = 2_000
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

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
  connectedAt: number
}

type PushRegistration = {
  token: string | null
  platform: 'ios' | 'android'
  appVersion: string | null
  badge: number
  updatedAt: number
}

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
        if (device) await this.ctx.storage.delete(`push:${device}`)
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
   *  of that, read by the desktop's paired-phones list. Best-effort. */
  private async touchDevice(attachment: Attachment): Promise<void> {
    try {
      await this.env.DB.prepare(
        'UPDATE devices SET last_seen_at = ?1, app_version = CASE WHEN ?2 = \'\' THEN app_version ELSE ?2 END WHERE id = ?3'
      )
        .bind(new Date(attachment.connectedAt).toISOString(), attachment.appVersion, attachment.deviceId)
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

  private async handlePush(from: Attachment, frame: Record<string, unknown> | undefined): Promise<void> {
    if (!frame || typeof frame.type !== 'string' || !from.deviceId) return
    const key = `push:${from.deviceId}`
    switch (frame.type) {
      case 'register_push': {
        const current = (await this.ctx.storage.get<PushRegistration>(key)) ?? null
        const next: PushRegistration = {
          token: typeof frame.expoPushToken === 'string' ? frame.expoPushToken : null,
          platform: frame.platform === 'android' ? 'android' : 'ios',
          appVersion: typeof frame.appVersion === 'string' ? frame.appVersion : null,
          badge: current?.badge ?? 0,
          updatedAt: Date.now()
        }
        await this.ctx.storage.put(key, next)
        return
      }
      case 'unregister_push':
        await this.ctx.storage.delete(key)
        return
      case 'set_badge': {
        const current = await this.ctx.storage.get<PushRegistration>(key)
        if (!current) return
        const count = typeof frame.count === 'number' && Number.isFinite(frame.count) ? frame.count : 0
        await this.ctx.storage.put(key, { ...current, badge: Math.max(0, Math.round(count)) })
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
   * The desktop's agent asked for a notification. In-band first: every
   * connected phone gets the frame and the first ack settles it. Otherwise
   * — or when nobody acks in time — every registered push token gets an
   * Expo push. The desktop learns which route it took.
   */
  private async deliverNotify(desktop: WebSocket, frame: Record<string, unknown> | undefined): Promise<void> {
    const notificationId = typeof frame?.notificationId === 'string' ? frame.notificationId : ''
    const result = (route: 'inband' | 'push' | 'dropped', reason?: string): void => {
      this.send(desktop, {
        t: 'notify_result',
        frame: {
          v: 1,
          type: 'notify_result',
          notificationId: notificationId || null,
          route,
          ...(reason ? { reason } : {})
        }
      })
    }
    if (!frame || !notificationId) {
      result('dropped', 'malformed notify frame')
      return
    }
    const phones = this.ctx.getWebSockets('phone')
    if (phones.length > 0) {
      const encoded = JSON.stringify({ t: 'notification', frame: { ...frame, type: 'notification' } })
      for (const ws of phones) this.raw(ws, encoded)
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
      if (acked) {
        result('inband')
        return
      }
    }
    const registrations = await this.ctx.storage.list<PushRegistration>({ prefix: 'push:' })
    const targets: Array<{ key: string; reg: PushRegistration }> = []
    for (const [key, reg] of registrations) if (reg.token) targets.push({ key, reg })
    if (targets.length === 0) {
      result('dropped', phones.length ? 'phone did not acknowledge and has no push token' : 'no phone registered for push')
      return
    }
    const messages = targets.map(({ reg }) => ({
      to: reg.token,
      title: String(frame.title ?? ''),
      body: String(frame.body ?? ''),
      sound: 'default',
      badge: reg.badge + 1,
      ttl: typeof frame.ttl === 'number' ? frame.ttl : 900,
      priority: frame.urgency === 'high' ? 'high' : 'normal',
      ...(reg.platform === 'android' ? { channelId: 'agent-runs' } : {}),
      data: {
        notificationId,
        runId: frame.runId ?? '',
        phase: frame.phase ?? 'info',
        url: frame.deeplink ?? null
      }
    }))
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${this.env.EXPO_ACCESS_TOKEN}` } : {})
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) {
        result('dropped', `push service answered ${res.status}`)
        return
      }
      // The badge the OS shows while the app is dead counts up per push;
      // the phone resets it (set_badge) whenever its own state changes.
      await Promise.all(
        targets.map(({ key, reg }) => this.ctx.storage.put(key, { ...reg, badge: reg.badge + 1 }))
      )
      result('push')
    } catch (err) {
      result('dropped', `push service unreachable: ${(err as Error).message}`)
    }
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
