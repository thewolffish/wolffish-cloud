/**
 * The desktop's end of the bridge — one WebSocket to the org's UserBridge,
 * held for as long as the session is signed in.
 *
 * The desktop is the party that PARKS: it must be on the bridge whenever a
 * phone decides to open, which is most often when nobody is watching this
 * machine. So the socket reconnects with backoff forever, pings the bridge
 * (which answers without waking) and tears down a socket that has gone
 * quiet even when the OS still reports it open.
 *
 * Responsibilities end at carrying frames: RPC handlers (what the phone may
 * ask), event emission (what the desktop announces) and presence. The mobile
 * channel decides what any of it means.
 */
import { API_BASE } from '@main/cloud/api'
import { cloudSession } from '@main/cloud/session'
import {
  KEEPALIVE_MS,
  KEEPALIVE_REQUEST,
  KEEPALIVE_RESPONSE,
  type BridgeFrame,
  type EventTopic,
  type NotifyFrame,
  type NotifyResultFrame,
  type PresenceDevice,
  type RpcMethod
} from '@main/cloud/bridge-protocol'
import { WebSocket as NodeWebSocket } from 'ws'

/** Silence that means the socket is dead regardless of what the OS reports —
 *  two and a half keepalive intervals, one answer allowed to go missing. */
const LIVENESS_TIMEOUT_MS = KEEPALIVE_MS * 2.5
const CONNECT_TIMEOUT_MS = 15_000
const MAX_BACKOFF_MS = 30_000
/** How often listeners hear about counter-only movement. */
const COUNTER_NOTIFY_MS = 300

export type BridgeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** What the Mobile panel and the CLI render. */
export type BridgeState = {
  status: BridgeStatus
  /** Phones on the bridge right now. */
  phones: PresenceDevice[]
  connectedAt: number | null
  lastError: string | null
  reconnects: number
  framesSent: number
  framesReceived: number
  bytesSent: number
  bytesReceived: number
}

export type RpcHandler = (
  params: Record<string, unknown>,
  from: PresenceDevice | null
) => Promise<unknown> | unknown

export type BridgeOptions = {
  /** How this desktop introduces itself to the phone's presence card. */
  identity: { name: string; platform: string; appVersion: string }
  log?: (line: string) => void
  debug?: (line: string) => void
}

export class BridgeClient {
  private ws: NodeWebSocket | null = null
  private state: BridgeState = {
    status: 'idle',
    phones: [],
    connectedAt: null,
    lastError: null,
    reconnects: 0,
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0
  }
  private running = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private keepaliveTimer: NodeJS.Timeout | null = null
  private livenessTimer: NodeJS.Timeout | null = null
  private lastInbound = 0
  private counterTimer: NodeJS.Timeout | null = null
  private readonly rpcHandlers = new Map<string, RpcHandler>()
  private readonly frameHandlers = new Map<string, (frame: Record<string, unknown>) => void>()
  private readonly stateListeners = new Set<(state: BridgeState) => void>()
  /** Bumped per socket so a stale socket's late events are ignored. */
  private generation = 0

  constructor(private readonly options: BridgeOptions) {}

  getState(): BridgeState {
    return { ...this.state, phones: [...this.state.phones] }
  }

  onState(listener: (state: BridgeState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  get connected(): boolean {
    return this.state.status === 'connected'
  }

  /** A phone is on the other end right now. */
  get phonePresent(): boolean {
    return this.connected && this.state.phones.length > 0
  }

  get outboundBufferedBytes(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Connect and keep connecting. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.attempt = 0
    void this.dial()
  }

  stop(): void {
    this.running = false
    this.clearReconnect()
    this.teardownSocket()
    this.patch({ status: 'idle', phones: [], connectedAt: null })
  }

  /** Drop and redial now — after a sign-in, or when the caller has reason to
   *  doubt the socket. */
  refresh(): void {
    if (!this.running) return
    this.attempt = 0
    this.clearReconnect()
    this.teardownSocket()
    void this.dial()
  }

  private async dial(): Promise<void> {
    if (!this.running || this.ws) return
    const generation = ++this.generation
    this.patch({
      status: this.state.reconnects > 0 || this.attempt > 0 ? 'reconnecting' : 'connecting'
    })
    let token: string
    try {
      token = await cloudSession.getAccessToken()
    } catch (err) {
      if (generation !== this.generation) return
      this.fail(`no session: ${(err as Error).message}`)
      return
    }
    if (generation !== this.generation || !this.running) return
    const url = new URL('/v1/bridge/ws', API_BASE.replace(/^http/, 'ws'))
    url.searchParams.set('role', 'desktop')
    url.searchParams.set('name', this.options.identity.name)
    url.searchParams.set('platform', this.options.identity.platform)
    url.searchParams.set('version', this.options.identity.appVersion)
    let socket: NodeWebSocket
    try {
      socket = new NodeWebSocket(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: CONNECT_TIMEOUT_MS
      })
    } catch (err) {
      this.fail(`dial failed: ${(err as Error).message}`)
      return
    }
    this.ws = socket
    socket.on('open', () => {
      if (generation !== this.generation) return
      this.attempt = 0
      this.lastInbound = Date.now()
      this.patch({ status: 'connected', connectedAt: Date.now(), lastError: null })
      this.startKeepalive()
      this.options.debug?.('bridge socket open')
    })
    socket.on('message', (data) => {
      if (generation !== this.generation) return
      this.onMessage(typeof data === 'string' ? data : data.toString())
    })
    socket.on('close', (code, reasonBuf) => {
      if (generation !== this.generation) return
      const reason = reasonBuf?.toString() ?? ''
      this.options.log?.(`bridge closed (${code}${reason ? ` ${reason}` : ''})`)
      this.ws = null
      this.stopKeepalive()
      // 4001 = revoked: the session is gone; the cloud session's own refresh
      // will notice and sign out. Keep trying regardless — a sign-in on
      // this machine starts a new session and the socket comes right back.
      this.patch({ status: this.running ? 'reconnecting' : 'idle', phones: [], connectedAt: null })
      if (this.running) this.scheduleReconnect()
    })
    socket.on('error', (err) => {
      if (generation !== this.generation) return
      this.options.debug?.(`bridge socket error: ${err.message}`)
      this.state.lastError = err.message
    })
  }

  private fail(message: string): void {
    this.options.log?.(`bridge: ${message}`)
    this.ws = null
    this.patch({ status: 'error', lastError: message, phones: [], connectedAt: null })
    if (this.running) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return
    const delay =
      Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 500
    this.attempt++
    this.state.reconnects++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.dial()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private teardownSocket(): void {
    this.generation++
    this.stopKeepalive()
    const socket = this.ws
    this.ws = null
    if (socket) {
      try {
        socket.close(1000, 'bye')
      } catch {
        // already closed
      }
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState !== NodeWebSocket.OPEN) return
      try {
        this.ws.send(KEEPALIVE_REQUEST)
      } catch {
        // the close handler takes it from here
      }
    }, KEEPALIVE_MS)
    this.keepaliveTimer.unref?.()
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastInbound > LIVENESS_TIMEOUT_MS) {
        this.options.log?.('bridge silent past the liveness window — redialing')
        this.refresh()
      }
    }, KEEPALIVE_MS)
    this.livenessTimer.unref?.()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.keepaliveTimer = null
    this.livenessTimer = null
  }

  // ── Frames ──────────────────────────────────────────────────────────────

  private onMessage(text: string): void {
    this.lastInbound = Date.now()
    this.state.framesReceived++
    this.state.bytesReceived += text.length
    this.notifyCounters()
    if (text === KEEPALIVE_RESPONSE) return
    let frame: BridgeFrame
    try {
      frame = JSON.parse(text) as BridgeFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'presence': {
        const had = this.state.phones.length
        this.patch({ phones: Array.isArray(frame.phones) ? frame.phones : [] })
        if (had === 0 && this.state.phones.length > 0) this.options.log?.('phone connected')
        if (had > 0 && this.state.phones.length === 0) this.options.log?.('phone disconnected')
        return
      }
      case 'rpc':
        void this.serve(frame)
        return
      case 'ev':
        // Server-originated events (a pairing claimed) share the topic space.
        this.frameHandlers.get(`ev:${frame.topic}`)?.(frame as unknown as Record<string, unknown>)
        return
      case 'notify_result':
        this.frameHandlers.get('notify_result')?.(frame.frame as unknown as Record<string, unknown>)
        return
      default:
        return
    }
  }

  private async serve(frame: Extract<BridgeFrame, { t: 'rpc' }>): Promise<void> {
    const handler = this.rpcHandlers.get(frame.method)
    if (!handler) {
      this.send({
        t: 'res',
        id: frame.id,
        error: { code: 'unknown_method', message: `unknown method ${frame.method}` }
      })
      return
    }
    try {
      const result = await handler(frame.params ?? {}, frame.phone ?? null)
      this.send({ t: 'res', id: frame.id, result: result ?? null })
    } catch (err) {
      this.send({
        t: 'res',
        id: frame.id,
        error: { message: err instanceof Error ? err.message : String(err) }
      })
    }
  }

  onRpc(method: RpcMethod | string, handler: RpcHandler): void {
    this.rpcHandlers.set(method, handler)
  }

  /** A server-originated event on the desktop's side (`pair.claimed`). */
  onServerEvent(topic: string, handler: (payload: unknown) => void): void {
    this.frameHandlers.set(`ev:${topic}`, (frame) =>
      handler((frame as { payload?: unknown }).payload)
    )
  }

  onNotifyResult(handler: (frame: NotifyResultFrame) => void): void {
    this.frameHandlers.set('notify_result', (frame) =>
      handler(frame as unknown as NotifyResultFrame)
    )
  }

  /** Push one event to every phone on the bridge. Silently dropped when the
   *  socket is down — pushes are best-effort by contract; the phone
   *  reconciles on its next connection. */
  emit(topic: EventTopic | string, payload: unknown): void {
    this.send({ t: 'ev', topic, payload })
  }

  /** Ask the bridge to notify the user's phones. Throws when not connected. */
  notify(frame: NotifyFrame): void {
    if (!this.connected) throw new Error('bridge not connected')
    this.send({ t: 'notify', frame })
  }

  private send(frame: BridgeFrame): void {
    const socket = this.ws
    if (!socket || socket.readyState !== NodeWebSocket.OPEN) return
    const encoded = JSON.stringify(frame)
    try {
      socket.send(encoded)
      this.state.framesSent++
      this.state.bytesSent += encoded.length
      this.notifyCounters()
    } catch (err) {
      this.options.debug?.(`bridge send failed: ${(err as Error).message}`)
    }
  }

  // ── State plumbing ──────────────────────────────────────────────────────

  private patch(next: Partial<BridgeState>): void {
    Object.assign(this.state, next)
    const snapshot = this.getState()
    for (const listener of this.stateListeners) listener(snapshot)
  }

  private notifyCounters(): void {
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      const snapshot = this.getState()
      for (const listener of this.stateListeners) listener(snapshot)
    }, COUNTER_NOTIFY_MS)
    this.counterTimer.unref?.()
  }
}
