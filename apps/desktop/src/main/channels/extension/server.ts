import {
  listConversations,
  logEvent,
  readEvents,
  type ConversationSummary,
  type ExtensionEvent
} from '@main/channels/extension/log'
import { diskWriter } from '@main/io/diskWriter'
import { wlog } from '@main/workspace/logger'
import { getBrowserExtensionConfig, getRuntimeExtensionVersion } from '@main/workspace/workspace'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

const TAG = 'extension'
/** A client whose last ping is older than this is a dead peer. */
const HEARTBEAT_CHECK_MS = 45_000
/** Sweep cadence — short so zombies linger ~1 sweep, not ~2 check windows. */
const HEARTBEAT_SWEEP_MS = 15_000
/**
 * Every real extension (old or new) sends extension_info immediately on
 * open. A connection that stays silent this long is not an extension —
 * typically the orphaned socket of a reloaded service worker.
 */
const IDENTITY_TIMEOUT_MS = 10_000

// ─── Debug Logger ───────────────────────────────────────────────────────────

const DEBUG_DIR = join(homedir(), '.wolffish', 'workspace', 'logs', 'extension', '.debug')
let debugReady: Promise<void> | null = null

function ensureDebugDir(): Promise<void> {
  if (!debugReady) debugReady = mkdir(DEBUG_DIR, { recursive: true }).then(() => {})
  return debugReady
}

function debugStamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function debugFile(): string {
  return join(DEBUG_DIR, `${new Date().toISOString().slice(0, 10)}.log`)
}

async function debug(level: string, msg: string): Promise<void> {
  const line = `${debugStamp()}  ${level.padEnd(5)}  ${msg}\n`
  try {
    await ensureDebugDir()
    await diskWriter.appendLine(debugFile(), line)
  } catch {
    // never let debug logging crash anything
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExtensionConnectionStatus = 'stopped' | 'listening' | 'connected' | 'error'

/** One connected browser, as shown in the panel and to the model. */
export interface ExtensionBrowserInfo {
  id: string
  /** Stable per-browser-profile id — survives reloads; lets the panel match a returning browser to its row. */
  instanceId: string | null
  /** Selection key: the browser slug, suffixed -1/-2 when the same browser is connected twice. */
  key: string
  browser: string
  name: string
  version: string | null
  browserVersion: string | null
  os: string | null
  /** Signed-in profile email — distinguishes profiles of the same browser. */
  profileEmail: string | null
  connectedAt: number
  lastPing: number
}

export interface ExtensionServerStatus {
  status: ExtensionConnectionStatus
  error: string | null
  extensionVersion: string | null
  port: number
  browsers: ExtensionBrowserInfo[]
}

interface ExtensionClient {
  id: string
  ws: WebSocket
  connectedAt: number
  lastPing: number
  /**
   * null until extension_info arrives. Unidentified clients are invisible —
   * not listed, not routable — and are terminated after IDENTITY_TIMEOUT_MS.
   */
  version: string | null
  /** Stable per-browser-profile id persisted by the extension; null for pre-identity extensions. */
  instanceId: string | null
  browser: string
  name: string
  browserVersion: string | null
  os: string | null
  profileEmail: string | null
  identityTimer: ReturnType<typeof setTimeout> | null
}

interface PendingCommand {
  resolve: (response: WolffishResponse) => void
  reject: (error: Error) => void
  clientId: string
}

interface WolffishCommand {
  id: string
  type: string
  params: Record<string, unknown>
}

interface WolffishResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

export interface SendCommandOptions {
  /** Browser selection query (key, slug, or name fragment). */
  target?: string | null
  /** Conversation whose sticky browser selection applies. */
  conversationId?: string | null
}

// ─── Server ─────────────────────────────────────────────────────────────────

export class ExtensionServer {
  private wss: WebSocketServer | null = null
  private clients = new Map<string, ExtensionClient>()
  private stickyByConversation = new Map<string, string>()
  /**
   * slug → (instanceId → slot number). Slots are assigned once per browser
   * instance and never renumbered or reused while the app runs, so a
   * reloading browser reclaims its own chrome-N key instead of swapping
   * keys with its sibling profile mid-conversation. Survives stop()/start()
   * (port changes) deliberately; resets only with the app.
   */
  private keySlots = new Map<string, Map<string, number>>()
  private status: ExtensionConnectionStatus = 'stopped'
  private statusError: string | null = null
  private pendingCommands = new Map<string, PendingCommand>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private currentConversationId: string | null = null
  /** clientId → conversation last events_sync'd to that client's panel. */
  private syncedByClient = new Map<string, string>()
  private currentTitle: string | null = null
  private currentPort = 23151
  private onStatusChange: ((status: ExtensionServerStatus) => void) | null = null

  setStatusChangeHandler(handler: (status: ExtensionServerStatus) => void): void {
    this.onStatusChange = handler
  }

  async start(config: { port: number }): Promise<ExtensionServerStatus> {
    void debug('INFO', `start() called: port=${config.port}`)

    if (this.wss) {
      void debug('INFO', 'start() stopping existing server first')
      await this.stop()
    }

    this.currentPort = config.port

    return new Promise((resolve) => {
      try {
        this.wss = new WebSocketServer({ port: config.port, host: '127.0.0.1' })
        void debug('INFO', `WebSocketServer created on 127.0.0.1:${config.port}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.status = 'error'
        this.statusError = message
        wlog.error(TAG, `Failed to create server: ${message}`)
        void debug('ERROR', `WebSocketServer constructor threw: ${message}`)
        resolve(this.getStatus())
        return
      }

      this.wss.on('listening', () => {
        this.status = 'listening'
        this.statusError = null
        wlog.info(TAG, `WebSocket server listening on port ${config.port}`)
        void debug('INFO', `listening on port ${config.port}`)
        this.broadcastStatus()
        resolve(this.getStatus())
      })

      this.wss.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : err.message
        this.status = 'error'
        this.statusError = message
        wlog.error(TAG, message)
        void debug('ERROR', `server error: code=${err.code} message=${message}`)
        this.broadcastStatus()
        resolve(this.getStatus())
      })

      this.wss.on('connection', (ws: WebSocket, req) => {
        const origin = req.headers.origin ?? 'none'
        const ua = req.headers['user-agent'] ?? 'none'
        void debug(
          'INFO',
          `new connection: origin=${origin} ua=${ua.slice(0, 80)} readyState=${ws.readyState}`
        )
        this.handleConnection(ws)
      })
    })
  }

  async stop(): Promise<void> {
    void debug('INFO', 'stop() called')
    this.stopHeartbeat()
    this.rejectAllPending('Server shutting down')

    for (const client of this.clients.values()) {
      client.ws.close()
    }
    this.clients.clear()
    this.stickyByConversation.clear()
    this.syncedByClient.clear()
    this.clearBridge()

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }

    this.status = 'stopped'
    this.statusError = null
    this.broadcastStatus()
    wlog.info(TAG, 'Server stopped')
    void debug('INFO', 'server stopped')
  }

  isConnected(): boolean {
    return this.identifiedClients().length > 0
  }

  getStatus(): ExtensionServerStatus {
    const keys = this.selectionKeys()
    const browsers = this.identifiedClients().map((c) => this.toBrowserInfo(c, keys))
    return {
      status: this.status,
      error: this.statusError,
      extensionVersion: browsers[0]?.version ?? null,
      port: this.currentPort,
      browsers
    }
  }

  setConversationId(id: string | null, title?: string | null): void {
    if (!id) return
    this.currentConversationId = id
    if (title && title !== 'Untitled') this.currentTitle = title
  }

  updateTitle(id: string, title: string): void {
    if (!title || title === 'Untitled') return
    if (id !== this.currentConversationId || !this.isConnected()) return
    if (title === this.currentTitle) return
    this.currentTitle = title
    if ([...this.syncedByClient.values()].includes(id)) {
      void this.pushEventsSync(id)
    }
  }

  /** Connected browsers as shown to the model (selection keys included). */
  listBrowsers(): ExtensionBrowserInfo[] {
    return this.getStatus().browsers
  }

  /**
   * Pin a conversation to one connected browser. Throws with a model-facing
   * message when the query matches zero or several browsers.
   */
  useBrowser(query: string, conversationId?: string | null): ExtensionBrowserInfo {
    const convId = conversationId ?? this.currentConversationId
    const client = this.resolveClient(query, convId)
    if (convId) this.stickyByConversation.set(convId, client.id)
    void debug('INFO', `useBrowser: conv=${convId} -> ${client.name} (${client.id})`)
    return this.toBrowserInfo(client, this.selectionKeys())
  }

  async sendCommand(
    type: string,
    params: Record<string, unknown>,
    opts?: SendCommandOptions
  ): Promise<WolffishResponse> {
    const client = this.resolveClient(
      opts?.target ?? null,
      opts?.conversationId ?? this.currentConversationId
    )
    return this.dispatchCommand(client, type, params)
  }

  private async dispatchCommand(
    client: ExtensionClient,
    type: string,
    params: Record<string, unknown>
  ): Promise<WolffishResponse> {
    const id = randomUUID()
    const command: WolffishCommand = { id, type, params }

    if (this.currentConversationId) {
      const event = await logEvent(this.currentConversationId, type, params, client.instanceId)

      // Sync state is per client: each browser's panel follows only the
      // conversations that browser executes, so a mid-conversation browser
      // switch re-syncs the new browser instead of leaking single events
      // into whatever its panel showed before.
      if (this.currentConversationId !== this.syncedByClient.get(client.id)) {
        this.syncedByClient.set(client.id, this.currentConversationId)
        void this.pushEventsSync(this.currentConversationId, client)
      } else {
        this.pushEventLogged(client, event)
      }
    }

    // No execution timeout: a command runs for as long as it legitimately
    // needs (e.g. humanized typing of a long body). Pending commands are not
    // orphaned — they are settled when their client's socket closes, the
    // server shuts down, or the same browser instance reconnects, which is
    // the only way a sent command can fail to come back.
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject, clientId: client.id })

      try {
        client.ws.send(JSON.stringify(command))
      } catch (err) {
        this.pendingCommands.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async runTestScenario(
    target?: string | null
  ): Promise<{ ok: boolean; steps: number; passed: number }> {
    const identified = this.identifiedClients()
    if (identified.length === 0) {
      return { ok: false, steps: 0, passed: 0 }
    }
    let client: ExtensionClient
    try {
      client = target ? this.resolveClient(target, null) : identified[0]
    } catch {
      return { ok: false, steps: 0, passed: 0 }
    }

    void debug('INFO', `running test scenario against ${client.name} (${client.id})`)
    const saved = this.currentConversationId
    const testId = `test-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`
    this.currentConversationId = testId

    // Push events_sync so the tested browser shows this conversation as active
    void this.pushEventsSync(testId, client)

    const steps: Array<{ type: string; params: Record<string, unknown> }> = [
      { type: 'browser_tab_open', params: { url: 'https://wolffi.sh/extension', active: true } },
      { type: 'browser_get_url', params: {} },
      { type: 'browser_tabs_list', params: {} },
      { type: 'browser_cookies_get', params: { domain: 'wolffi.sh' } },
      { type: 'browser_screenshot', params: {} },
      { type: 'browser_read_page', params: { format: 'markdown' } },
      { type: 'browser_query_selector', params: { selector: 'h1', limit: 1 } },
      { type: 'browser_get_page_info', params: {} },
      { type: 'browser_scroll', params: { direction: 'down', amount: 300 } },
      { type: 'browser_screenshot', params: { fullPage: true } }
    ]

    let passed = 0
    for (const step of steps) {
      try {
        const res = await this.dispatchCommand(client, step.type, step.params)
        if (res.success) passed++
        else void debug('WARN', `test ${step.type}: ${res.error}`)
      } catch (err) {
        void debug('WARN', `test ${step.type} threw: ${err instanceof Error ? err.message : err}`)
      }
    }

    this.currentConversationId = saved
    void debug('INFO', `test scenario complete: ${passed}/${steps.length}`)
    return { ok: passed === steps.length, steps: steps.length, passed }
  }

  sendPortUpdate(port: number): void {
    this.broadcastRaw({ type: 'event', event: 'port_update', data: { port } })
  }

  /** Reload the extension in one browser (by selection query) or all when no target. */
  async requestReload(target?: string | null): Promise<void> {
    try {
      if (target && target.trim()) {
        const client = this.resolveClient(target, null)
        this.sendRaw(client, { type: 'event', event: 'extension_reload', data: {} })
        return
      }
      this.broadcastRaw({ type: 'event', event: 'extension_reload', data: {} })
    } catch {
      // best-effort
    }
  }

  private async checkVersionAndReload(client: ExtensionClient): Promise<void> {
    if (!client.version) return
    try {
      const runtimeVersion = await getRuntimeExtensionVersion()
      void debug(
        'INFO',
        `version check: ${client.name}=${client.version} runtime=${runtimeVersion}`
      )
      if (!runtimeVersion) return
      if (client.version !== runtimeVersion) {
        wlog.info(
          TAG,
          `Extension version mismatch on ${client.name}: running=${client.version} runtime=${runtimeVersion} — sending reload`
        )
        void debug('INFO', `sending extension_reload to ${client.name} due to version mismatch`)
        this.sendRaw(client, { type: 'event', event: 'extension_reload', data: {} })
      } else {
        wlog.info(TAG, `Extension version ${client.version} is current on ${client.name}`)
      }
    } catch (err) {
      void debug('ERROR', `version check failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  async getConversations(): ReturnType<typeof listConversations> {
    return listConversations()
  }

  async getConversationEvents(conversationId: string): Promise<ExtensionEvent[]> {
    return readEvents(conversationId)
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private openClients(): ExtensionClient[] {
    return [...this.clients.values()].filter((c) => c.ws.readyState === 1 /* OPEN */)
  }

  /**
   * Clients that completed the extension_info handshake — the only ones
   * listed, routable, and counted as "connected". A freshly accepted socket
   * that hasn't identified yet (or never will — an orphaned pre-reload
   * socket) must not surface as a ghost "Browser" entry.
   */
  private identifiedClients(): ExtensionClient[] {
    return this.openClients().filter((c) => c.version !== null)
  }

  private toBrowserInfo(c: ExtensionClient, keys: Map<string, string>): ExtensionBrowserInfo {
    return {
      id: c.id,
      instanceId: c.instanceId,
      key: keys.get(c.id) ?? c.browser,
      browser: c.browser,
      name: c.name,
      version: c.version,
      browserVersion: c.browserVersion,
      os: c.os,
      profileEmail: c.profileEmail,
      connectedAt: c.connectedAt,
      lastPing: c.lastPing
    }
  }

  /** Stable per-instance slot for numbered keys; assigned on first sight. */
  private slotFor(client: ExtensionClient): number {
    const instanceKey = client.instanceId ?? `conn:${client.id}`
    let slots = this.keySlots.get(client.browser)
    if (!slots) {
      slots = new Map()
      this.keySlots.set(client.browser, slots)
    }
    const existing = slots.get(instanceKey)
    if (existing !== undefined) return existing
    const next = slots.size === 0 ? 1 : Math.max(...slots.values()) + 1
    slots.set(instanceKey, next)
    return next
  }

  /** clientId → selection key (slug, or slug-N by persistent slot when a slug repeats). */
  private selectionKeys(): Map<string, string> {
    const bySlug = new Map<string, ExtensionClient[]>()
    for (const c of this.identifiedClients()) {
      const group = bySlug.get(c.browser) ?? []
      group.push(c)
      bySlug.set(c.browser, group)
    }
    const keys = new Map<string, string>()
    for (const [slug, group] of bySlug) {
      if (group.length === 1) keys.set(group[0].id, slug)
      else for (const c of group) keys.set(c.id, `${slug}-${this.slotFor(c)}`)
    }
    return keys
  }

  private describeBrowsers(): string {
    const keys = this.selectionKeys()
    return this.identifiedClients()
      .map((c) => {
        const version = c.browserVersion ? ` ${c.browserVersion.split('.')[0]}` : ''
        const profile = c.profileEmail ? ` (${c.profileEmail})` : ''
        return `${c.name}${version}${profile} [${keys.get(c.id) ?? c.browser}]`
      })
      .join(', ')
  }

  /** connected ⇄ listening tracks identified clients; error/stopped are set elsewhere. */
  private refreshConnectionStatus(): void {
    if (!this.wss || this.status === 'error' || this.status === 'stopped') return
    this.status = this.identifiedClients().length > 0 ? 'connected' : 'listening'
  }

  /**
   * Pick the browser a command goes to. Model-facing errors: every throw
   * explains what is connected and how to choose.
   */
  private resolveClient(target: string | null, conversationId: string | null): ExtensionClient {
    const identified = this.identifiedClients()
    if (identified.length === 0) {
      throw new Error('Browser extension is not connected')
    }

    if (target && target.trim()) {
      const q = target.trim().toLowerCase()
      const keys = this.selectionKeys()
      let matches = identified.filter((c) => keys.get(c.id) === q || c.browser === q)
      if (matches.length === 0) {
        matches = identified.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.browser.startsWith(q) ||
            (c.profileEmail ?? '').toLowerCase().includes(q)
        )
      }
      if (matches.length === 1) {
        if (conversationId) this.stickyByConversation.set(conversationId, matches[0].id)
        return matches[0]
      }
      if (matches.length === 0) {
        throw new Error(
          `No connected browser matches "${target}". Connected browsers: ${this.describeBrowsers()}.`
        )
      }
      throw new Error(
        `"${target}" matches more than one connected browser: ${this.describeBrowsers()}. Use the exact key in brackets to disambiguate.`
      )
    }

    if (identified.length === 1) return identified[0]

    if (conversationId) {
      const stickyId = this.stickyByConversation.get(conversationId)
      const sticky = stickyId ? this.clients.get(stickyId) : undefined
      if (sticky && sticky.ws.readyState === 1 && sticky.version !== null) return sticky
    }

    throw new Error(
      `Multiple browsers are connected: ${this.describeBrowsers()}. No browser is selected for this conversation yet — call ext_use_browser with the key in brackets to pick one. If the user's request or the conversation makes the choice obvious, pick it yourself; otherwise ask the user which browser to use.`
    )
  }

  private handleConnection(ws: WebSocket): void {
    const client: ExtensionClient = {
      id: randomUUID(),
      ws,
      connectedAt: Date.now(),
      lastPing: Date.now(),
      version: null,
      instanceId: null,
      browser: 'browser',
      name: 'Browser',
      browserVersion: null,
      os: null,
      profileEmail: null,
      identityTimer: null
    }
    this.clients.set(client.id, client)
    this.startHeartbeat()
    // Not yet visible anywhere: status, panel, and routing only pick the
    // client up once extension_info arrives. A socket that never identifies
    // (orphan of a reloaded service worker) is culled here instead of
    // haunting the panel as a version-less "Browser" row.
    client.identityTimer = setTimeout(() => {
      client.identityTimer = null
      if (this.clients.has(client.id) && client.version === null) {
        void debug(
          'WARN',
          `no extension_info after ${IDENTITY_TIMEOUT_MS}ms — terminating ${client.id}`
        )
        wlog.info(TAG, 'Dropping connection that never identified itself')
        client.ws.terminate()
        this.removeClient(client, 'Never identified')
      }
    }, IDENTITY_TIMEOUT_MS)
    void debug('INFO', `handleConnection complete — id=${client.id} readyState=${ws.readyState}`)

    ws.on('message', (data: Buffer | string) => {
      const raw = String(data)
      void debug('RECV', `[${client.name}] ${raw.slice(0, 300)}`)
      this.handleMessage(client, raw)
    })

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString()
      void debug(
        'INFO',
        `ws close: id=${client.id} browser=${client.name} code=${code} reason="${reasonStr}"`
      )
      wlog.info(TAG, `WebSocket close: code=${code} reason="${reasonStr}" browser=${client.name}`)
      this.removeClient(client, 'Extension disconnected')
    })

    ws.on('error', (err) => {
      void debug('ERROR', `ws error (${client.name}): ${err.message}`)
      wlog.error(TAG, `WebSocket error: ${err.message}`)
    })

    ws.on('unexpected-response', (_req, res) => {
      void debug('ERROR', `unexpected-response: status=${res.statusCode}`)
      wlog.error(TAG, `Unexpected response: ${res.statusCode}`)
    })
  }

  private removeClient(client: ExtensionClient, reason: string): void {
    if (!this.clients.has(client.id)) return
    const wasIdentified = client.version !== null
    if (client.identityTimer) {
      clearTimeout(client.identityTimer)
      client.identityTimer = null
    }
    this.clients.delete(client.id)
    this.rejectPendingFor(client.id, reason)
    this.syncedByClient.delete(client.id)
    for (const [conv, cid] of this.stickyByConversation) {
      if (cid === client.id) this.stickyByConversation.delete(conv)
    }
    this.refreshConnectionStatus()
    if (this.clients.size === 0) {
      this.stopHeartbeat()
      this.clearBridge()
    }
    if (wasIdentified) {
      wlog.info(
        TAG,
        this.identifiedClients().length === 0
          ? 'Extension disconnected'
          : `${client.name} disconnected (${this.identifiedClients().length} remaining)`
      )
      this.broadcastStatus()
    }
    void debug('INFO', `cleanup complete after disconnect of ${client.id}`)
  }

  private handleMessage(client: ExtensionClient, raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      void debug('WARN', `invalid JSON: ${raw.slice(0, 100)}`)
      wlog.warn(TAG, 'Received invalid JSON')
      return
    }

    if (msg.type === 'ping') {
      client.lastPing = Date.now()
      this.sendRaw(client, { type: 'pong' })
      return
    }

    if (msg.type === 'get_conversations') {
      void this.pushConversationsList(client)
      return
    }

    if (msg.type === 'get_conversation_events' && typeof msg.conversationId === 'string') {
      void this.pushConversationEvents(client, msg.conversationId as string)
      return
    }

    if (msg.type === 'extension_info') {
      if (client.identityTimer) {
        clearTimeout(client.identityTimer)
        client.identityTimer = null
      }
      client.version = (msg.version as string) ?? null
      client.instanceId = typeof msg.instanceId === 'string' ? msg.instanceId : null
      if (typeof msg.browser === 'string' && msg.browser) client.browser = msg.browser
      if (typeof msg.browserName === 'string' && msg.browserName) client.name = msg.browserName
      client.browserVersion = typeof msg.browserVersion === 'string' ? msg.browserVersion : null
      client.os = typeof msg.os === 'string' && msg.os ? msg.os : null
      client.profileEmail =
        typeof msg.profileEmail === 'string' && msg.profileEmail ? msg.profileEmail : null
      void debug(
        'INFO',
        `extension_info: version=${client.version} browser=${client.browser} name=${client.name} profile=${client.profileEmail ?? 'none'} instance=${client.instanceId ?? 'none'}`
      )
      this.dedupeInstance(client)
      // Claim the instance's key slot now (idempotent) so numbering follows
      // true first-connect order, not whenever duplication first renders.
      this.slotFor(client)
      this.statusError = null
      this.refreshConnectionStatus()
      this.exposeBridge()
      this.broadcastStatus()
      wlog.info(
        TAG,
        `Extension connected: ${client.name} (${this.identifiedClients().length} browser${this.identifiedClients().length === 1 ? '' : 's'})`
      )
      void this.checkVersionAndReload(client)
      return
    }

    if (typeof msg.id === 'string') {
      const pending = this.pendingCommands.get(msg.id)
      if (pending) {
        this.pendingCommands.delete(msg.id)
        pending.resolve(msg as unknown as WolffishResponse)
        void debug('INFO', `resolved command ${msg.id}`)
      } else {
        void debug('WARN', `no pending command for id=${msg.id}`)
      }
    }
  }

  /**
   * The same browser instance reconnecting (service-worker restart, app
   * relaunch) must replace its old socket instead of appearing twice.
   * Sticky conversation selections follow the instance to the new socket.
   */
  private dedupeInstance(client: ExtensionClient): void {
    if (!client.instanceId) return
    for (const other of [...this.clients.values()]) {
      if (other.id === client.id || other.instanceId !== client.instanceId) continue
      void debug('INFO', `replacing stale socket for instance ${client.instanceId} (${other.id})`)
      wlog.info(TAG, `Reconnection from ${client.name} — replacing its previous socket`)
      for (const [conv, cid] of this.stickyByConversation) {
        if (cid === other.id) this.stickyByConversation.set(conv, client.id)
      }
      // terminate, not close: the stale socket's peer is a dead service
      // worker that will never complete a close handshake.
      other.ws.terminate()
      this.removeClient(other, 'Replaced by new connection')
    }
  }

  private sendRaw(client: ExtensionClient, data: unknown): void {
    if (client.ws.readyState === 1 /* OPEN */) {
      const json = JSON.stringify(data)
      void debug('SEND', `[${client.name}] ${json.slice(0, 300)}`)
      client.ws.send(json)
    }
  }

  private broadcastRaw(data: unknown): void {
    for (const client of this.openClients()) {
      this.sendRaw(client, data)
    }
  }

  /** Events the given browser instance executed (null matches pre-identity events). */
  private eventsFor(client: ExtensionClient, events: ExtensionEvent[]): ExtensionEvent[] {
    return events.filter((e) => (e.instanceId ?? null) === client.instanceId)
  }

  /**
   * Conversations this browser instance ran — the side panel scope. Pure
   * filtering on the per-event attribution; no merging. The internal
   * instanceIds field never crosses the wire.
   */
  private async conversationsFor(client: ExtensionClient): Promise<ConversationSummary[]> {
    const all = await listConversations()
    return all
      .filter((c) => (c.instanceIds ?? [null]).includes(client.instanceId))
      .map((c) => {
        const summary = { ...c }
        delete summary.instanceIds
        return summary
      })
  }

  private async pushEventsSync(conversationId: string, origin?: ExtensionClient): Promise<void> {
    try {
      const title = this.currentTitle || 'Untitled'
      const events = await readEvents(conversationId)
      for (const client of this.identifiedClients()) {
        const slice = this.eventsFor(client, events)
        // A browser that never ran this conversation must not have its
        // panel switched to it — only the executing browser (origin) may
        // receive an empty first sync.
        if (slice.length === 0 && client !== origin) continue
        this.sendRaw(client, {
          type: 'event',
          event: 'events_sync',
          data: { conversationId, title, events: slice }
        })
        const conversations = await this.conversationsFor(client)
        const existing = conversations.find((c) => c.conversationId === conversationId)
        if (existing) {
          existing.title = title
        } else if (client === origin) {
          conversations.unshift({
            conversationId,
            title,
            eventCount: slice.length,
            lastTimestamp: Date.now()
          })
        }
        this.sendRaw(client, {
          type: 'event',
          event: 'conversations_list',
          data: conversations
        })
      }
    } catch {
      // best-effort
    }
  }

  private async pushConversationsList(client: ExtensionClient): Promise<void> {
    try {
      const conversations = await this.conversationsFor(client)
      if (this.currentConversationId && this.currentTitle) {
        const existing = conversations.find((c) => c.conversationId === this.currentConversationId)
        if (existing) {
          existing.title = this.currentTitle
        }
      }
      this.sendRaw(client, {
        type: 'event',
        event: 'conversations_list',
        data: conversations
      })
    } catch {
      // best-effort
    }
  }

  private async pushConversationEvents(
    client: ExtensionClient,
    conversationId: string
  ): Promise<void> {
    try {
      const events = this.eventsFor(client, await readEvents(conversationId))
      this.sendRaw(client, {
        type: 'event',
        event: 'conversation_events',
        data: { conversationId, events }
      })
    } catch {
      // best-effort
    }
  }

  private pushEventLogged(client: ExtensionClient, event: ExtensionEvent): void {
    this.sendRaw(client, {
      type: 'event',
      event: 'event_logged',
      data: event
    })
  }

  private exposeBridge(): void {
    ;(globalThis as Record<string, unknown>).__wolffishExtensionBridge = {
      sendCommand: (type: string, params: Record<string, unknown>, opts?: SendCommandOptions) =>
        this.sendCommand(type, params, opts),
      isConnected: () => this.isConnected(),
      getStatus: () => this.getStatus(),
      getConfig: () => getBrowserExtensionConfig(),
      listBrowsers: () => this.listBrowsers(),
      useBrowser: (query: string, conversationId?: string | null) =>
        this.useBrowser(query, conversationId),
      // Lets the plugin heal a STALE loaded extension. The connect-time
      // version check only reloads on a version mismatch, but Chrome can keep
      // running an old service worker whose manifest still matches the synced
      // folder — and the one reliable symptom of that is the extension
      // answering "Unknown command" for a command this build defines.
      requestReload: (target?: string | null) => this.requestReload(target)
    }
    void debug('INFO', 'bridge exposed on globalThis')
  }

  private clearBridge(): void {
    ;(globalThis as Record<string, unknown>).__wolffishExtensionBridge = null
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      for (const client of [...this.clients.values()]) {
        const elapsed = Date.now() - client.lastPing
        if (elapsed > HEARTBEAT_CHECK_MS) {
          void debug('WARN', `heartbeat timeout (${client.name}): ${elapsed}ms since last ping`)
          wlog.warn(TAG, `Extension heartbeat timeout (${client.name}), dropping connection`)
          client.ws.terminate()
          this.removeClient(client, 'Extension disconnected')
        }
      }
    }, HEARTBEAT_SWEEP_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private rejectPendingFor(clientId: string, reason: string): void {
    let count = 0
    for (const [id, pending] of this.pendingCommands) {
      if (pending.clientId !== clientId) continue
      pending.reject(new Error(reason))
      this.pendingCommands.delete(id)
      count++
    }
    if (count > 0)
      void debug('INFO', `rejected ${count} pending commands for ${clientId}: ${reason}`)
  }

  private rejectAllPending(reason: string): void {
    const count = this.pendingCommands.size
    if (count > 0) void debug('INFO', `rejecting ${count} pending commands: ${reason}`)
    for (const [id, pending] of this.pendingCommands) {
      pending.reject(new Error(reason))
      this.pendingCommands.delete(id)
    }
  }

  private broadcastStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }
}
