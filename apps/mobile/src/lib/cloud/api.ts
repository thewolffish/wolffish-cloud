/**
 * The org API client — everything the phone reads and writes over REST.
 *
 * The base URL is EXPO_PUBLIC_API_URL (a fork's build points at its own
 * API); a scanned QR carries the API it was minted at and overrides it for
 * that pairing. Session state lives in lib/cloud/session; this module only
 * speaks HTTP, and every non-OK response is thrown as an ApiError carrying
 * the wire `error` code so callers map codes — never strings — to UI.
 */
import * as SecureStore from 'expo-secure-store'

const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.wolffi.sh'
const KEY_API_BASE = 'wolffish.cloud.apiBase.v1'
const DEFAULT_TIMEOUT_MS = 30_000

let apiBase = DEFAULT_API_BASE
let apiBaseLoaded: Promise<void> | null = null

/** The API this phone talks to. Read after loadApiBase(). */
export function getApiBase(): string {
  return apiBase
}

export function loadApiBase(): Promise<void> {
  if (!apiBaseLoaded) {
    apiBaseLoaded = SecureStore.getItemAsync(KEY_API_BASE)
      .then((stored) => {
        if (stored && /^https?:\/\//.test(stored)) apiBase = stored.replace(/\/+$/, '')
      })
      .catch(() => undefined)
  }
  return apiBaseLoaded
}

/** A pairing named a different API (a fork's QR) — remember it. */
export async function setApiBase(base: string): Promise<void> {
  const clean = base.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(clean)) throw new Error(`not an API base: ${base}`)
  apiBase = clean
  await SecureStore.setItemAsync(KEY_API_BASE, clean).catch(() => undefined)
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(`${code} (HTTP ${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'ApiError'
  }
}

export type WireUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'support' | 'employee'
}

export type WireSession = {
  accessToken: string
  /** Epoch ms when the access token expires (computed from expires_in). */
  accessExpiresAt: number
  refreshToken: string
  sessionId: string
  deviceId: string
  user: WireUser
}

type RequestOptions = {
  method?: string
  body?: unknown
  token?: string
  timeoutMs?: number
  headers?: Record<string, string>
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(timer)
    throw new ApiError(
      err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
      0,
      err instanceof Error ? err.message : undefined
    )
  }
  clearTimeout(timer)
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // non-JSON body — fall through to the status check
  }
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`
    let detail = typeof json?.detail === 'string' ? json.detail : undefined
    if (!detail && Array.isArray(json?.issues)) {
      detail = (json.issues as Array<{ path?: string; message?: string }>)
        .map((i) => [i.path, i.message].filter(Boolean).join(': '))
        .join('; ')
    }
    throw new ApiError(code, res.status, detail)
  }
  return json as T
}

type SessionWire = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  session_id?: string
  device_id?: string
  user?: WireUser
}

function toSession(wire: SessionWire, fallbackUser?: WireUser): WireSession {
  if (!wire.access_token || !wire.refresh_token || !wire.session_id) {
    throw new ApiError('malformed_response', 200)
  }
  const user = wire.user ?? fallbackUser
  if (!user) throw new ApiError('malformed_response', 200)
  return {
    accessToken: wire.access_token,
    accessExpiresAt: Date.now() + (wire.expires_in ?? 900) * 1000,
    refreshToken: wire.refresh_token,
    sessionId: wire.session_id,
    deviceId: wire.device_id ?? '',
    user
  }
}

// ── Pairing + session ───────────────────────────────────────────────────

export type ClaimResult = {
  session: WireSession
  orgName: string | null
  desktop: { id: string; name: string } | null
  api: string | null
}

/** Claim a pairing offer with the typed code or the scanned token. */
export async function claimPairing(input: {
  code?: string
  token?: string
  device: {
    id?: string | null
    name: string
    app_version: string
    model?: string
    os?: 'ios' | 'android'
    os_version?: string
  }
}): Promise<ClaimResult> {
  const wire = await request<
    SessionWire & {
      org?: { name?: string } | null
      desktop?: { id?: string; name?: string } | null
      api?: string
    }
  >('/auth/pair/claim', {
    method: 'POST',
    body: {
      ...(input.code ? { code: input.code } : {}),
      ...(input.token ? { token: input.token } : {}),
      device: {
        ...(input.device.id ? { id: input.device.id } : {}),
        name: input.device.name,
        app_version: input.device.app_version,
        // Descriptive only, and only when known: the org rejects an empty
        // enum, so an unknown OS is simply absent rather than ''.
        ...(input.device.model ? { model: input.device.model } : {}),
        ...(input.device.os ? { os: input.device.os } : {}),
        ...(input.device.os_version ? { os_version: input.device.os_version } : {})
      }
    }
  })
  return {
    session: toSession(wire),
    orgName: wire.org?.name ?? null,
    desktop:
      wire.desktop && typeof wire.desktop.id === 'string'
        ? { id: wire.desktop.id, name: wire.desktop.name ?? '' }
        : null,
    api: typeof wire.api === 'string' ? wire.api : null
  }
}

/** Rotate the refresh token. The old token is dead the moment this returns. */
export async function refresh(
  refreshToken: string,
  carry: { deviceId: string; user: WireUser }
): Promise<WireSession> {
  const wire = await request<SessionWire>('/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
    timeoutMs: 15_000
  })
  const session = toSession(wire, carry.user)
  return { ...session, deviceId: carry.deviceId, user: carry.user }
}

export async function logout(accessToken: string): Promise<void> {
  await request<{ ok: true }>('/v1/logout', { method: 'POST', body: {}, token: accessToken })
}

export type MeResult = {
  user: WireUser & { phone?: string; position?: string; avatar_key?: string | null }
  org: { name: string; default_model: string } | null
  device: { id: string; platform: string; name: string } | null
}

export async function me(accessToken: string): Promise<MeResult> {
  return request<MeResult>('/v1/me', { token: accessToken })
}

// ── Presence ────────────────────────────────────────────────────────────

export type BridgePresence = {
  desktop: {
    deviceId: string
    name: string
    platform: string
    appVersion: string
    connectedAt: number
  } | null
  phones: Array<{ deviceId: string; name: string; connectedAt: number }>
  at: string
}

/** Is the desktop on the bridge right now — one small read. */
export async function bridgeStatus(accessToken: string): Promise<BridgePresence> {
  return request<BridgePresence>('/v1/bridge/status', { token: accessToken, timeoutMs: 8_000 })
}

// ── Conversations ───────────────────────────────────────────────────────

/** One row of the phone's index — the org's conversation row plus what the
 *  desktop's envelope record carries (`include=meta`). */
export type WireConversationRow = {
  id: string
  title: string
  device_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  model?: string | null
  channel?: string | null
  icon?: string | null
  project_id?: string | null
  sealed?: number | boolean | null
  summary?: string | null
  stats?: unknown
  message_count?: number | null
}

export async function conversationsSince(
  accessToken: string,
  since: string,
  limit = 500
): Promise<{ conversations: WireConversationRow[]; next: string | null; cursor: string | null }> {
  return request(
    `/v1/conversations?since=${encodeURIComponent(since)}&include=meta&limit=${limit}`,
    { token: accessToken, timeoutMs: 60_000 }
  )
}

export type WireRecord = {
  id: string
  seq: number
  kind: string
  content: unknown
  created_at: string
}

export async function conversationRecords(
  accessToken: string,
  conversationId: string,
  after: number,
  limit = 200
): Promise<{ records: WireRecord[]; next_after: number | null }> {
  return request(
    `/v1/conversations/${encodeURIComponent(conversationId)}/records?after=${after}&limit=${limit}`,
    { token: accessToken, timeoutMs: 60_000 }
  )
}

// ── Files ───────────────────────────────────────────────────────────────

/** Is there a live blob under this workspace path? Answers its sha. */
export async function fileHeadByPath(accessToken: string, name: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${apiBase}/v1/files/path?name=${encodeURIComponent(name)}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    })
    if (res.status === 404) return null
    if (!res.ok) throw new ApiError(`http_${res.status}`, res.status)
    return res.headers.get('etag')
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('network', 0)
  } finally {
    clearTimeout(timer)
  }
}

/** The URL a blob streams from, by workspace path or by content hash. */
export function fileUrlByPath(name: string): string {
  return `${apiBase}/v1/files/path?name=${encodeURIComponent(name)}`
}

export function fileUrlBySha(sha256: string): string {
  return `${apiBase}/v1/files/${sha256}`
}

export function uploadUrl(sha256: string, name: string, mime: string): string {
  return `${apiBase}/v1/files/upload?sha256=${sha256}&name=${encodeURIComponent(name.slice(0, 500))}&mime=${encodeURIComponent(mime.slice(0, 100))}`
}

// ── Usage ───────────────────────────────────────────────────────────────

export type WireUsageDay = {
  day: string
  model: string
  kind: string
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  entries: number
}

export async function usageDays(
  accessToken: string,
  tzOffsetMinutes: number
): Promise<{ days: WireUsageDay[] }> {
  return request(`/v1/usage/days?tz=${Math.round(tzOffsetMinutes)}`, {
    token: accessToken,
    timeoutMs: 30_000
  })
}

// ── Config snapshot (the synced file) ───────────────────────────────────

/** The phone's config snapshot as the desktop last wrote it to the org. */
export async function fetchSnapshotFile(
  accessToken: string,
  path: string
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(fileUrlByPath(path), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    })
    if (res.status === 404) return null
    if (!res.ok) throw new ApiError(`http_${res.status}`, res.status)
    const json = (await res.json()) as unknown
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('network', 0)
  } finally {
    clearTimeout(timer)
  }
}

// ── Leaderboard ─────────────────────────────────────────────────────────
//
// The org's standing, readable by every signed-in user (no admin tier).
// Wire shape verbatim from apps/api routes/leaderboard.ts: the server owns
// the ranking and the paging, so the phone never sorts or renumbers — a rank
// stays the rank in the whole org even when the page is filtered by name.

export type WireLeaderboardRow = {
  rank: number
  user_id: string
  name: string
  role: string
  tokens: number
  conversations: number
  agentic_tasks: number
}

export type WireLeaderboardPage = {
  generated_at: string
  /** Rows matching the search (the whole board when there is none). */
  total: number
  /** People on the board, regardless of the search — the denominator. */
  board_size: number
  /** The org outgrew the server's board cap; the tail is not listed. */
  truncated: boolean
  limit: number
  offset: number
  rows: WireLeaderboardRow[]
  /** This phone's own user row, on every page and past every filter. */
  me: WireLeaderboardRow | null
}

export async function leaderboard(
  accessToken: string,
  params: { limit?: number; offset?: number; q?: string } = {}
): Promise<WireLeaderboardPage> {
  const query = new URLSearchParams()
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  if (params.q) query.set('q', params.q)
  const suffix = query.toString()
  return request(`/v1/leaderboard${suffix ? `?${suffix}` : ''}`, { token: accessToken })
}
