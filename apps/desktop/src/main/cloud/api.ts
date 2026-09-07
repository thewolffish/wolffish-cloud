/**
 * The Wolffish Cloud org API client — auth + session endpoints.
 *
 * Deliberately free of Electron imports so it can be exercised headlessly
 * (scripts/live-auth-check.mjs drives the same flows against the real
 * edge). Session state, token storage and the PIN live in session.ts;
 * this module only speaks HTTP.
 *
 * Errors: every non-OK response is thrown as ApiError carrying the wire
 * `error` code (email_not_found, wrong_password, rate_limited, account_disabled,
 * temp_password_expired, session_revoked, …) so callers map codes — never
 * strings — to UI messages.
 */

export const API_BASE = process.env.WFC_API_URL ?? 'https://api.wolffi.sh'

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

export type DeviceInfo = {
  id?: string
  platform: 'desktop'
  name: string
  app_version: string
}

export type WireUser = {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'support' | 'employee'
}

export type LoginResult =
  | { kind: 'session'; session: WireSession }
  | { kind: 'must_change_password'; changeToken: string }

export type WireSession = {
  accessToken: string
  /** Epoch ms when the access token expires (computed from expires_in). */
  accessExpiresAt: number
  refreshToken: string
  sessionId: string
  deviceId: string
  user: WireUser
}

export type MeResult = {
  user: WireUser & {
    phone: string
    position: string
    bio: string
    avatar_key: string | null
    status: string
    last_login_at: string | null
  }
  org: { name: string; default_model: string } | null
  device: {
    id: string
    platform: string
    name: string
    pin_set: 0 | 1
    pin_clear_requested: 0 | 1
  } | null
  session_id: string
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>('POST', path, body, token)
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new ApiError('network', 0)
  }
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // non-JSON body — fall through to the status check
  }
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`
    let detail = typeof json?.detail === 'string' ? json.detail : undefined
    // Validation responses carry issues[{path,message}] — flatten them so
    // the client can show WHAT was wrong, not just that something was.
    if (!detail && Array.isArray(json?.issues)) {
      detail = (json.issues as Array<{ path?: string; message?: string }>)
        .map((i) => [i.path, i.message].filter(Boolean).join(': '))
        .join('; ')
    }
    throw new ApiError(code, res.status, detail)
  }
  return json as T
}

type LoginWire = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  session_id?: string
  device_id?: string
  user?: WireUser
  must_change_password?: boolean
  change_token?: string
}

function toSession(wire: LoginWire, fallbackUser?: WireUser): WireSession {
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

export async function login(
  email: string,
  password: string,
  device: DeviceInfo
): Promise<LoginResult> {
  const wire = await post<LoginWire>('/auth/login', { email, password, device })
  if (wire.must_change_password && wire.change_token) {
    return { kind: 'must_change_password', changeToken: wire.change_token }
  }
  return { kind: 'session', session: toSession(wire) }
}

export async function changePassword(changeToken: string, newPassword: string): Promise<void> {
  await post<{ ok: true }>('/auth/password', { new_password: newPassword }, changeToken)
}

/**
 * Rotate the refresh token. The old token is dead the moment this returns —
 * the caller must persist the new one before doing anything else.
 * device_id/user aren't in the refresh response, so the caller supplies the
 * ones it already holds.
 */
export async function refresh(
  refreshToken: string,
  carry: { deviceId: string; user: WireUser }
): Promise<WireSession> {
  const wire = await post<LoginWire>('/auth/refresh', { refresh_token: refreshToken })
  const session = toSession(wire, carry.user)
  return { ...session, deviceId: carry.deviceId, user: carry.user }
}

export async function logout(accessToken: string): Promise<void> {
  await post<{ ok: true }>('/v1/logout', {}, accessToken)
}

export async function me(accessToken: string): Promise<MeResult> {
  return request<MeResult>('GET', '/v1/me', undefined, accessToken)
}

/** Self-service profile edit; returns nothing the caller can't re-fetch. */
export async function updateProfile(
  accessToken: string,
  patch: { name?: string; phone?: string; position?: string; bio?: string }
): Promise<void> {
  await request<{ ok: true }>('PATCH', '/v1/profile', patch, accessToken)
}

/** Voluntary password change — proves the current password server-side. */
export async function changePasswordSession(
  accessToken: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  await post<{ ok: true }>(
    '/auth/password',
    { current_password: currentPassword, new_password: newPassword },
    accessToken
  )
}

/** Report the device's local PIN state (also acks an admin clear request). */
export async function requestPasswordReset(email: string): Promise<void> {
  await post<{ ok: true }>('/auth/reset/request', { email })
}

export async function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  await post<{ ok: true }>('/auth/reset/confirm', {
    email,
    code,
    new_password: newPassword
  })
}

/** Re-send the emailed activation code for an account still awaiting it. */
export async function requestActivation(email: string): Promise<void> {
  await post<{ ok: true }>('/auth/activate/request', { email })
}

/** Turn the emailed code into the account's first password. */
export async function confirmActivation(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  await post<{ ok: true }>('/auth/activate/confirm', {
    email,
    code,
    new_password: newPassword
  })
}

/** Raw-byte avatar calls — the one non-JSON corner of the wire. */
export async function uploadAvatar(
  accessToken: string,
  bytes: ArrayBuffer,
  mime: string
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/v1/profile/avatar`, {
      method: 'PUT',
      headers: { 'content-type': mime, authorization: `Bearer ${accessToken}` },
      body: bytes,
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw new ApiError('network', 0)
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`
    throw new ApiError(code, res.status, typeof json?.detail === 'string' ? json.detail : undefined)
  }
}

export type AvatarFetchResult =
  | { kind: 'ok'; bytes: ArrayBuffer; mime: string; etag: string | null }
  | { kind: 'not_modified' }
  | { kind: 'none' }

export async function fetchAvatar(
  accessToken: string,
  etag?: string | null
): Promise<AvatarFetchResult> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/v1/profile/avatar`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(etag ? { 'if-none-match': etag } : {})
      },
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw new ApiError('network', 0)
  }
  if (res.status === 304) return { kind: 'not_modified' }
  if (res.status === 404) return { kind: 'none' }
  if (!res.ok) throw new ApiError(`http_${res.status}`, res.status)
  return {
    kind: 'ok',
    bytes: await res.arrayBuffer(),
    mime: res.headers.get('content-type') ?? 'image/png',
    etag: res.headers.get('etag')
  }
}

export async function deleteAvatar(accessToken: string): Promise<void> {
  await request<{ ok: true }>('DELETE', '/v1/profile/avatar', undefined, accessToken)
}

export async function reportPin(accessToken: string, pinSet: boolean): Promise<void> {
  await post<{ ok: true }>('/v1/device/pin', { pin_set: pinSet }, accessToken)
}

// ── Pairing + devices (the phone's way in) ──────────────────────────────

export type PairOfferWire = { id: string; code: string; qr: string; expires_at: string }

/** Open a pairing offer: the code to type and the QR payload to scan. */
export async function offerPairing(accessToken: string): Promise<PairOfferWire> {
  return post<PairOfferWire>('/v1/pair/offer', {}, accessToken)
}

export async function pairingStatus(
  accessToken: string,
  id: string
): Promise<{ status: 'pending' | 'claimed' | 'expired'; device: Record<string, unknown> | null }> {
  return request('GET', `/v1/pair/offer/${encodeURIComponent(id)}`, undefined, accessToken)
}

export async function withdrawPairing(accessToken: string, id: string): Promise<void> {
  await request<{ ok: true }>(
    'DELETE',
    `/v1/pair/offer/${encodeURIComponent(id)}`,
    undefined,
    accessToken
  )
}

export type DeviceWire = {
  id: string
  platform: string
  name: string
  app_version: string
  /** What the device is and how it was paired, as the org recorded it at the
   *  claim and refreshed on every connect. Empty when it never said. */
  model: string
  os: string
  os_version: string
  pair_method: string
  created_at: string
  last_seen_at: string | null
  paired: boolean
  current: boolean
}

export async function listDevices(accessToken: string): Promise<DeviceWire[]> {
  const res = await request<{ devices: DeviceWire[] }>('GET', '/v1/devices', undefined, accessToken)
  return res.devices ?? []
}

/** Revoke another of this user's devices — unpairing a phone. */
export async function revokeDevice(accessToken: string, id: string): Promise<void> {
  await request<{ ok: true }>(
    'DELETE',
    `/v1/devices/${encodeURIComponent(id)}`,
    undefined,
    accessToken
  )
}

// ── Leaderboard ─────────────────────────────────────────────────────────
//
// The org's standing, readable by every signed-in user (no admin tier).
// Wire shape verbatim from apps/api routes/leaderboard.ts: the server owns
// the ranking and the paging, so the client never sorts or renumbers — a
// rank stays the rank in the whole org even when the page is filtered.

export type LeaderboardRowWire = {
  rank: number
  user_id: string
  name: string
  role: string
  tokens: number
  conversations: number
  agentic_tasks: number
}

export type LeaderboardPageWire = {
  generated_at: string
  /** Rows matching the search (the whole board when there is none). */
  total: number
  /** People on the board, regardless of the search — the denominator. */
  board_size: number
  /** The org outgrew the server's board cap; the tail is not listed. */
  truncated: boolean
  limit: number
  offset: number
  rows: LeaderboardRowWire[]
  /** The signed-in user's own row, on every page and past every filter. */
  me: LeaderboardRowWire | null
}

export async function fetchLeaderboard(
  accessToken: string,
  params: { limit?: number; offset?: number; q?: string } = {}
): Promise<LeaderboardPageWire> {
  const query = new URLSearchParams()
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  if (params.q) query.set('q', params.q)
  const suffix = query.toString()
  return request<LeaderboardPageWire>(
    'GET',
    `/v1/leaderboard${suffix ? `?${suffix}` : ''}`,
    undefined,
    accessToken
  )
}
