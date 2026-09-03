import i18n from '@/lib/i18n'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { getApiBase } from '@/lib/cloud/api'
import { cloudSession } from '@/lib/cloud/session'
import {
  CloseCode,
  KEEPALIVE_MS,
  KEEPALIVE_REQUEST,
  KEEPALIVE_RESPONSE,
  Rpc,
  type BridgeFrame,
  type EventTopic,
  type PresenceDevice,
  type RpcMethod
} from '@/lib/bridge/protocol'

/**
 * The phone's socket to the org bridge — the live link to the desktop.
 *
 * One instance for the app's lifetime. It dials while the app is in the
 * foreground and vanishes when iOS suspends it; every return re-dials in
 * well under a second (a token from the keystore, one TLS handshake, one
 * upgrade — no key exchange, nothing to pin). That is normal, not an error,
 * and the reconnect loop treats it that way.
 *
 * Two facts are kept apart on purpose: whether THIS socket is up (the org is
 * reachable) and whether the DESKTOP is on the bridge (the presence frame
 * the bridge sends on every change). `connected` means both — that is the
 * answer every screen asking "can I reach my desktop" needs — while
 * `online` is the socket alone. A phone whose desktop is asleep is online
 * and not connected: it reads everything from the org and simply cannot run
 * a turn, which the UI says plainly instead of spinning.
 *
 * Nothing here touches conversations or config: this module owns the
 * connection, `lib/sync` owns what travels over it.
 */

export type BridgeStatus =
  'idle' | 'connecting' | 'waiting-for-desktop' | 'connected' | 'reconnecting' | 'error'

/** What the Connection screen renders. */
export type BridgeState = {
  status: BridgeStatus
  /** The socket to the org is open. */
  online: boolean
  /** The desktop on the other end, when one is on the bridge. */
  desktop: PresenceDevice | null
  apiBase: string
  connectedAt: number | null
  lastError: string | null
  reconnects: number
  framesSent: number
  framesReceived: number
  bytesSent: number
  bytesReceived: number
}

export type ConnectionListener = (state: BridgeState) => void
export type EventHandler = (payload: unknown) => void
export type FrameHandler = (frame: Record<string, unknown>) => void

/** Ceiling on the reconnect backoff. The phone only runs while it is on
 *  screen, and every second of backoff is a second someone spends looking at
 *  a card that says "reconnecting" — one phone retrying cannot stampede. */
const MAX_BACKOFF_MS = 8_000
const CONNECT_TIMEOUT_MS = 15_000
/** Silence that means the socket is dead regardless of what the OS reports. */
const LIVENESS_TIMEOUT_MS = KEEPALIVE_MS * 2.5
/** How long the wake probe waits for its pong before redialing. */
const WAKE_ANSWER_MS = 2_500
const PATIENT_ANSWER_MS = 10_000
const RPC_TIMEOUT_MS = 30_000
const COUNTER_NOTIFY_MS = 300

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** RN's WebSocket takes a third `options` argument (headers) the DOM type
 *  does not declare. */
type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> }
) => WebSocket

class BridgeClient {
  private ws: WebSocket | null = null
  private state: BridgeState = {
    status: 'idle',
    online: false,
    desktop: null,
    apiBase: getApiBase(),
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
  private generation = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  private counterTimer: ReturnType<typeof setTimeout> | null = null
  private lastInbound = 0
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers = new Map<string, EventHandler>()
  private readonly frameHandlers = new Map<string, FrameHandler>()
  private readonly listeners = new Set<ConnectionListener>()
  /** The dial in flight, so two callers cannot each build a socket. */
  private dialing: Promise<void> | null = null

  get state_(): BridgeState {
    return this.state
  }

  /** The current state — what `subscribe` replays to a new listener. */
  get current(): BridgeState {
    return this.state
  }

  /** The desktop is reachable right now: socket up AND desktop present. */
  get connected(): boolean {
    return this.state.online && this.state.desktop !== null
  }

  /** The org is reachable (socket open), desktop or no desktop. */
  get online(): boolean {
    return this.state.online
  }

  /** The live link, for `lib/sync` to issue RPCs and subscribe to events. */
  get active(): BridgeClient | null {
    return this.state.online ? this : null
  }

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private patch(next: Partial<BridgeState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener(this.state)
  }

  private notifyCounters(): void {
    if (this.counterTimer) return
    this.counterTimer = setTimeout(() => {
      this.counterTimer = null
      this.patch({})
    }, COUNTER_NOTIFY_MS)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Make sure the stored session is on the bridge, or on its way. Returns
   * false only when nothing is paired. Safe to call as often as anything
   * likes — launch, every foreground, after a failed RPC; a dial already
   * under way is joined rather than raced.
   *
   * `patient` shapes the wake probe on a socket that claims to be open:
   * false for the foreground return, where the user is looking and the
   * socket is the one iOS habitually kills; true for a network-type flap
   * mid-use, where a false kill costs a visible reconnect for nothing.
   */
  async resume(patient = false): Promise<boolean> {
    await cloudSession.load()
    if (!cloudSession.isSignedIn) return false
    this.running = true
    if (this.dialing) {
      await this.dialing.catch(() => undefined)
      return true
    }
    if (this.ws && this.state.online) {
      this.probe(patient ? PATIENT_ANSWER_MS : WAKE_ANSWER_MS)
      return true
    }
    if (this.ws) return true // mid-dial: the open handler takes it from here
    this.clearReconnect()
    this.attempt = 0
    await this.dial()
    return true
  }

  /** Drop the connection but keep the session — used when backgrounding. */
  suspend(): void {
    this.running = false
    this.clearReconnect()
    this.teardownSocket('suspended')
    this.patch({ status: 'idle', online: false, desktop: null, connectedAt: null })
  }

  /** Drop the socket and dial again — the Connection screen's Reconnect. */
  refresh(): void {
    if (!cloudSession.isSignedIn) return
    this.running = true
    this.clearReconnect()
    this.attempt = 0
    this.teardownSocket('refresh')
    void this.dial()
  }

  /**
   * Sign this phone out: the org session goes (revoked at the org when it
   * can be reached), the socket with it. The door is next.
   */
  async disconnect(): Promise<void> {
    this.running = false
    this.clearReconnect()
    this.teardownSocket('signed out')
    this.patch({ status: 'idle', online: false, desktop: null, connectedAt: null })
    await cloudSession.signOut()
  }

  /**
   * An RPC failed in a way that means the link is gone, not that the
   * desktop said no. Kick the socket rather than leaving the user to press a
   * button that will fail the same way.
   */
  reportRpcFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (!/not connected|timed out|socket closed|desktop_offline|desktop is not/i.test(message)) {
      return
    }
    if (this.state.online) {
      this.probe(PATIENT_ANSWER_MS)
      return
    }
    void this.resume(true)
  }

  private dial(): Promise<void> {
    const run = this.connect().finally(() => {
      if (this.dialing === run) this.dialing = null
    })
    this.dialing = run
    return run
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.patch({
      status: this.state.reconnects > 0 ? 'reconnecting' : 'connecting',
      apiBase: getApiBase()
    })
    let token: string
    try {
      token = await cloudSession.getAccessToken()
    } catch (err) {
      if (generation !== this.generation) return
      if (!cloudSession.isSignedIn) {
        this.running = false
        this.patch({ status: 'idle', online: false, desktop: null, lastError: null })
        return
      }
      this.fail(`no session: ${(err as Error).message}`)
      return
    }
    if (generation !== this.generation || !this.running) return
    const base = getApiBase().replace(/^http/, 'ws')
    const name = encodeURIComponent(Device.deviceName ?? Device.modelName ?? 'Phone')
    const version = encodeURIComponent(Constants.expoConfig?.version ?? '')
    const url = `${base}/v1/bridge/ws?role=phone&name=${name}&platform=${Platform.OS}&version=${version}`
    let socket: WebSocket
    try {
      socket = new (WebSocket as unknown as RNWebSocketCtor)(url, null, {
        headers: { authorization: `Bearer ${token}` }
      })
    } catch (err) {
      this.fail(`dial failed: ${(err as Error).message}`)
      return
    }
    this.ws = socket
    const connectTimer = setTimeout(() => {
      if (generation !== this.generation) return
      this.teardownSocket('connect timeout')
      this.fail('connect timed out')
    }, CONNECT_TIMEOUT_MS)
    socket.onopen = () => {
      if (generation !== this.generation) return
      clearTimeout(connectTimer)
      this.attempt = 0
      this.lastInbound = Date.now()
      this.patch({
        status: 'waiting-for-desktop',
        online: true,
        connectedAt: Date.now(),
        lastError: null
      })
      this.startKeepalive()
      // Announce this device so the desktop's Mobile panel can label it.
      void this.rpc(Rpc.hello, {
        deviceName: Device.deviceName ?? Device.modelName ?? 'Phone',
        platform: Platform.OS,
        model: Device.modelName ?? null,
        osVersion: Device.osVersion ?? null,
        appVersion: Constants.expoConfig?.version ?? null
      }).catch(() => undefined)
    }
    socket.onmessage = (event) => {
      if (generation !== this.generation) return
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data))
    }
    socket.onerror = (event) => {
      if (generation !== this.generation) return
      const message = (event as { message?: string }).message ?? 'socket error'
      this.state = { ...this.state, lastError: message }
    }
    socket.onclose = (event) => {
      if (generation !== this.generation) return
      clearTimeout(connectTimer)
      this.ws = null
      this.stopKeepalive()
      this.abortInFlight(`socket closed (${event.code})`)
      const revoked = event.code === CloseCode.Revoked
      this.patch({
        status: revoked ? 'idle' : this.running ? 'reconnecting' : 'idle',
        online: false,
        desktop: null,
        connectedAt: null,
        lastError: revoked ? i18n.t('connection.revoked') : this.state.lastError
      })
      if (revoked) {
        // The org cut this device off (unpaired from the desktop, an admin
        // revoke). The session's next refresh confirms it; the door follows.
        this.running = false
        void cloudSession.withAccessToken(async () => undefined).catch(() => undefined)
        return
      }
      if (this.running) this.scheduleReconnect()
    }
  }

  private fail(message: string): void {
    this.ws = null
    this.patch({
      status: 'error',
      online: false,
      desktop: null,
      connectedAt: null,
      lastError: message
    })
    if (this.running) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return
    const delay =
      Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempt, 4)) + Math.random() * 300
    this.attempt++
    this.state = { ...this.state, reconnects: this.state.reconnects + 1 }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.dial()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private teardownSocket(reason: string): void {
    this.generation++
    this.stopKeepalive()
    this.abortInFlight(reason)
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
      if (Date.now() - this.lastInbound > LIVENESS_TIMEOUT_MS) {
        this.teardownSocket('liveness')
        this.fail('the link went quiet')
        return
      }
      this.sendRaw(KEEPALIVE_REQUEST)
    }, KEEPALIVE_MS)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.keepaliveTimer = null
    this.answerTimer = null
  }

  /**
   * Ask the bridge a question and give it a deadline. A socket that reads
   * fine and answers nothing is the worst state available — the one iOS
   * leaves behind after a background — and this is how it is caught fast.
   */
  private probe(answerMs: number): void {
    if (!this.ws || this.answerTimer) return
    const seen = this.lastInbound
    this.sendRaw(KEEPALIVE_REQUEST)
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null
      if (this.lastInbound !== seen) return
      this.teardownSocket('probe unanswered')
      this.fail('the link did not answer')
    }, answerMs)
  }

  // ── Frames ──────────────────────────────────────────────────────────────

  private onMessage(text: string): void {
    this.lastInbound = Date.now()
    this.state = {
      ...this.state,
      framesReceived: this.state.framesReceived + 1,
      bytesReceived: this.state.bytesReceived + text.length
    }
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
        const desktop = frame.desktop ?? null
        const was = this.state.desktop !== null
        this.patch({ desktop, status: desktop ? 'connected' : 'waiting-for-desktop' })
        // Every RPC parked on a desktop that just left would time out on its
        // own; failing them now is what lets the composer say so at once.
        if (was && !desktop) this.abortInFlight('desktop_offline')
        return
      }
      case 'res': {
        const id = typeof frame.id === 'number' ? frame.id : Number(frame.id)
        const waiter = this.pending.get(id)
        if (!waiter) return
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        if (frame.error) {
          waiter.reject(new Error(frame.error.message || frame.error.code || 'rpc failed'))
        } else {
          waiter.resolve(frame.result)
        }
        return
      }
      case 'ev':
        this.eventHandlers.get(frame.topic)?.(frame.payload)
        this.eventHandlers.get('*')?.({ topic: frame.topic, payload: frame.payload })
        return
      case 'notification':
        this.frameHandlers.get('notification')?.(frame.frame)
        return
      default:
        return
    }
  }

  private abortInFlight(reason: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  /**
   * Call the desktop. Rejects at once when no desktop is on the bridge —
   * the bridge answers `desktop_offline` and so does this, before the wire
   * is even touched — and after `timeoutMs` of silence otherwise.
   */
  rpc<T = unknown>(
    method: RpcMethod | string,
    params: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS
  ): Promise<T> {
    if (!this.ws || !this.state.online) return Promise.reject(new Error('not connected'))
    if (!this.state.desktop) return Promise.reject(new Error('desktop_offline'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      if (!this.send({ t: 'rpc', id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('not connected'))
      }
    })
  }

  /** Handlers are stored per topic: re-registering REPLACES, never stacks,
   *  so a reconnect that re-attaches cannot double every event. */
  onEvent(topic: EventTopic | '*', handler: EventHandler): void {
    this.eventHandlers.set(topic, handler)
  }

  /** In-band notifications from the bridge. Same replace-not-stack rule. */
  onFrame(type: 'notification', handler: FrameHandler): void {
    this.frameHandlers.set(type, handler)
  }

  /** Push control to the bridge: register a token, ack, set the badge. */
  sendPush(frame: Record<string, unknown>): boolean {
    return this.send({ t: 'push', frame })
  }

  private send(frame: BridgeFrame): boolean {
    return this.sendRaw(JSON.stringify(frame))
  }

  private sendRaw(text: string): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== 1) return false
    try {
      socket.send(text)
      this.state = {
        ...this.state,
        framesSent: this.state.framesSent + 1,
        bytesSent: this.state.bytesSent + text.length
      }
      this.notifyCounters()
      return true
    } catch {
      return false
    }
  }
}

export const bridgeClient = new BridgeClient()

export type { BridgeClient }
