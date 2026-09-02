/**
 * The device's cloud session — the ONLY place tokens exist.
 *
 * Storage: ~/.wfc/runtime/cloud-session.json, encrypted with Electron's
 * safeStorage (OS keychain–backed) when available; the renderer only ever
 * sees a redacted AuthState. The refresh token rotates on every refresh and
 * the new one is persisted before anything else happens — a crash between
 * rotate and persist costs one re-login, never a leaked live token.
 *
 * The PIN is a LOCAL quick lock, never sent anywhere: a salted SHA-256
 * beside the session record, verified in-process. Five misses sign the
 * device out entirely (server-side revoke included) — the walk-away lock
 * degrades to the full password door, exactly as designed. The server
 * only learns the boolean (pin_set) and can request a clear, which the
 * watchdog acks by wiping the local hash.
 *
 * States: loggedOut → (mustChangePassword) → needsPin → ready, with
 * `locked` replacing ready at boot while a PIN is set.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import {
  ApiError,
  changePassword as apiChangePassword,
  changePasswordSession as apiChangePasswordSession,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  refresh as apiRefresh,
  reportPin,
  updateProfile as apiUpdateProfile,
  requestPasswordReset as apiRequestReset,
  confirmPasswordReset as apiConfirmReset,
  uploadAvatar as apiUploadAvatar,
  fetchAvatar as apiFetchAvatar,
  deleteAvatar as apiDeleteAvatar,
  type WireSession,
  type WireUser
} from '@main/cloud/api'

export type AuthStatus =
  | 'initializing'
  | 'loggedOut'
  | 'mustChangePassword'
  | 'needsPin'
  | 'locked'
  | 'ready'

export type AuthState = {
  status: AuthStatus
  user: Pick<WireUser, 'email' | 'name' | 'role'> | null
  orgName: string | null
  pinAttemptsLeft: number | null
  /** Set on the auth screens after a failed action; cleared on the next. */
  lastError: string | null
  /** Wire detail for lastError (e.g. flattened validation issues). */
  lastErrorDetail: string | null
}

type StoredRecord = {
  version: 1
  session: WireSession
  orgName: string | null
  pin: { saltHex: string; hashHex: string } | null
}

const PIN_MAX_ATTEMPTS = 5
const REFRESH_SKEW_MS = 60_000
const WATCHDOG_MS = 5 * 60_000

const runtimeDir = (): string => path.join(os.homedir(), '.wfc', 'runtime')
const sessionPath = (): string => path.join(runtimeDir(), 'cloud-session.json')
const devicePath = (): string => path.join(runtimeDir(), 'cloud-device.json')
const avatarPath = (): string => path.join(runtimeDir(), 'cloud-avatar.json')

/**
 * Browser-style avatar cache: bytes keyed by the server's content-hash etag,
 * served instantly and revalidated with If-None-Match on every read. Bound
 * to the signed-in email so an account switch can never show the old photo.
 */
type AvatarCache = {
  version: 1
  email: string
  etag: string | null
  mime: string
  base64: string
}

const hashPin = (saltHex: string, pin: string): string =>
  createHash('sha256').update(`${saltHex}:${pin}`).digest('hex')

class CloudSession {
  private record: StoredRecord | null = null
  private status: AuthStatus = 'initializing'
  private lastError: string | null = null
  private lastErrorDetail: string | null = null
  private pinAttemptsLeft = PIN_MAX_ATTEMPTS
  private pendingChange: { email: string; changeToken: string } | null = null
  private refreshInFlight: Promise<void> | null = null
  private watchdog: NodeJS.Timeout | null = null
  private listeners = new Set<(state: AuthState) => void>()
  private avatar: AvatarCache | null = null
  private avatarRevalidate: Promise<void> | null = null
  private avatarListeners = new Set<(dataUrl: string | null) => void>()

  // ── State plumbing ─────────────────────────────────────────────────────

  onState(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Fires when the cached avatar actually changes (update or removal). */
  onAvatar(listener: (dataUrl: string | null) => void): () => void {
    this.avatarListeners.add(listener)
    return () => this.avatarListeners.delete(listener)
  }

  getState(): AuthState {
    return {
      status: this.status,
      user: this.record
        ? {
            email: this.record.session.user.email,
            name: this.record.session.user.name,
            role: this.record.session.user.role
          }
        : null,
      orgName: this.record?.orgName ?? null,
      pinAttemptsLeft: this.status === 'locked' ? this.pinAttemptsLeft : null,
      lastError: this.lastError,
      lastErrorDetail: this.lastErrorDetail
    }
  }

  private setStatus(
    status: AuthStatus,
    error: string | null = null,
    detail: string | null = null
  ): void {
    this.status = status
    this.lastError = error
    this.lastErrorDetail = detail
    const state = this.getState()
    for (const l of this.listeners) l(state)
  }

  /** True once sign-in completed (locked still counts — tokens exist). */
  isAuthenticated(): boolean {
    return this.record !== null && this.status !== 'mustChangePassword'
  }

  /** The signed-in user's server id, or null when signed out. The sync
   *  engine binds the workspace to this so one user's cache can never be
   *  swept into another user's account. */
  getUserId(): string | null {
    return this.record?.session.user.id ?? null
  }

  /** This device's server id (stable across launches — see rememberDevice),
   *  or null when signed out. The sync engine uses it to tell its OWN
   *  metered calls (already in the local usage ledger) from those of the
   *  user's other devices when it reconciles usage. */
  getDeviceId(): string | null {
    return this.record?.session.deviceId || null
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.record = await this.load()
    if (this.record) await this.loadAvatar()
    if (!this.record) {
      this.setStatus('loggedOut')
    } else {
      // Prove the session is alive (and rotate) right away; a network
      // failure is tolerated — the watchdog keeps retrying and any API
      // call will surface a real revocation.
      try {
        await this.doRefresh()
      } catch (err) {
        if (this.isAuthError(err)) {
          await this.clearLocal()
          this.setStatus('loggedOut', 'session_expired')
          this.startWatchdog()
          return
        }
      }
      this.pinAttemptsLeft = PIN_MAX_ATTEMPTS
      this.setStatus(this.record.pin ? 'locked' : 'needsPin')
    }
    this.startWatchdog()
  }

  // ── Sign in / first-login change ───────────────────────────────────────

  async login(email: string, password: string): Promise<AuthState> {
    try {
      const result = await apiLogin(email.trim(), password, await this.deviceInfo())
      if (result.kind === 'must_change_password') {
        this.pendingChange = { email: email.trim(), changeToken: result.changeToken }
        this.setStatus('mustChangePassword')
        return this.getState()
      }
      await this.adopt(result.session)
      return this.getState()
    } catch (err) {
      this.setStatus('loggedOut', this.codeOf(err))
      return this.getState()
    }
  }

  async completePasswordChange(newPassword: string): Promise<AuthState> {
    const pending = this.pendingChange
    if (!pending) {
      this.setStatus('loggedOut', 'no_pending_change')
      return this.getState()
    }
    try {
      await apiChangePassword(pending.changeToken, newPassword)
      // The change token is single-purpose; sign in properly with the new
      // credential to mint the real session.
      const result = await apiLogin(pending.email, newPassword, await this.deviceInfo())
      if (result.kind !== 'session') {
        this.setStatus('loggedOut', 'unexpected_change_loop')
        return this.getState()
      }
      this.pendingChange = null
      await this.adopt(result.session)
      return this.getState()
    } catch (err) {
      // Keep the change screen up — the token may still be valid (e.g. a
      // weak_password rejection), and the error tells the user why.
      this.setStatus('mustChangePassword', this.codeOf(err))
      return this.getState()
    }
  }

  private async adopt(session: WireSession): Promise<void> {
    if (this.avatar && this.avatar.email !== session.user.email) await this.dropAvatar(false)
    this.record = { version: 1, session, orgName: null, pin: null }
    await this.persist()
    await this.rememberDevice(session.deviceId)
    // Org name is presentation sugar — fetch it best-effort.
    try {
      const info = await apiMe(session.accessToken)
      this.record.orgName = info.org?.name ?? null
      await this.persist()
    } catch {
      // ignore — the watchdog will fill it in
    }
    this.pinAttemptsLeft = PIN_MAX_ATTEMPTS
    this.setStatus('needsPin')
  }

  // ── PIN ────────────────────────────────────────────────────────────────

  async setPin(pin: string): Promise<AuthState> {
    if (!/^\d{4}$/.test(pin)) {
      this.setStatus(this.status, 'pin_format')
      return this.getState()
    }
    if (!this.record) {
      this.setStatus('loggedOut', 'not_signed_in')
      return this.getState()
    }
    const saltHex = randomBytes(16).toString('hex')
    this.record.pin = { saltHex, hashHex: hashPin(saltHex, pin) }
    await this.persist()
    void this.withAccessToken((token) => reportPin(token, true)).catch(() => undefined)
    this.setStatus('ready')
    return this.getState()
  }

  async unlock(pin: string): Promise<AuthState> {
    if (this.status !== 'locked' || !this.record?.pin) return this.getState()
    const { saltHex, hashHex } = this.record.pin
    if (hashPin(saltHex, pin) === hashHex) {
      this.pinAttemptsLeft = PIN_MAX_ATTEMPTS
      this.setStatus('ready')
      return this.getState()
    }
    this.pinAttemptsLeft -= 1
    if (this.pinAttemptsLeft <= 0) {
      // The quick lock degrades to the full password door: revoke and wipe.
      await this.signOut('pin_lockout')
      return this.getState()
    }
    this.setStatus('locked', 'pin_wrong')
    return this.getState()
  }

  /** Re-lock the app on demand (the profile card's "Lock now"). */
  lock(): AuthState {
    if (this.record?.pin && (this.status === 'ready' || this.status === 'locked')) {
      this.pinAttemptsLeft = PIN_MAX_ATTEMPTS
      this.setStatus('locked')
    }
    return this.getState()
  }

  /** Swap the local PIN after proving the current one. */
  async changePin(currentPin: string, nextPin: string): Promise<AuthState> {
    if (!this.record?.pin) {
      this.setStatus(this.status, 'not_signed_in')
      return this.getState()
    }
    const { saltHex, hashHex } = this.record.pin
    if (hashPin(saltHex, currentPin) !== hashHex) {
      this.setStatus(this.status, 'pin_wrong')
      return this.getState()
    }
    if (!/^\d{4}$/.test(nextPin)) {
      this.setStatus(this.status, 'pin_format')
      return this.getState()
    }
    const newSalt = randomBytes(16).toString('hex')
    this.record.pin = { saltHex: newSalt, hashHex: hashPin(newSalt, nextPin) }
    await this.persist()
    this.setStatus(this.status)
    return this.getState()
  }

  // ── Profile (self-service) ─────────────────────────────────────────────

  /** Fresh profile from the API — the profile card's data source. */
  async getProfile(): Promise<{
    name: string
    email: string
    phone: string
    position: string
    bio: string
    role: WireUser['role']
    orgName: string | null
    pinSet: boolean
    hasAvatar: boolean
  } | null> {
    if (!this.record) return null
    try {
      const info = await this.withAccessToken((token) => apiMe(token))
      return {
        name: info.user.name,
        email: info.user.email,
        phone: info.user.phone ?? '',
        position: info.user.position ?? '',
        bio: info.user.bio ?? '',
        role: info.user.role,
        orgName: info.org?.name ?? this.record?.orgName ?? null,
        pinSet: Boolean(this.record?.pin),
        hasAvatar: Boolean(info.user.avatar_key)
      }
    } catch {
      return null
    }
  }

  async updateProfile(patch: {
    name?: string
    phone?: string
    position?: string
    bio?: string
  }): Promise<AuthState> {
    if (!this.record) {
      this.setStatus('loggedOut', 'not_signed_in')
      return this.getState()
    }
    try {
      await this.withAccessToken((token) => apiUpdateProfile(token, patch))
      if (patch.name && this.record) {
        this.record.session.user = { ...this.record.session.user, name: patch.name }
        await this.persist()
      }
      this.setStatus(this.status)
      return this.getState()
    } catch (err) {
      this.setStatus(this.status, this.codeOf(err), this.detailOf(err))
      return this.getState()
    }
  }

  /** Emailed-code password reset — no session required. */
  async requestPasswordReset(
    email: string
  ): Promise<{ ok: boolean; code?: string; detail?: string | null }> {
    try {
      await apiRequestReset(email.trim())
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        code: this.codeOf(err),
        detail: err instanceof ApiError ? (err.detail ?? null) : null
      }
    }
  }

  async confirmPasswordReset(
    email: string,
    code: string,
    newPassword: string
  ): Promise<{ ok: boolean; code?: string; detail?: string | null }> {
    try {
      await apiConfirmReset(email.trim(), code, newPassword)
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        code: this.codeOf(err),
        detail: err instanceof ApiError ? (err.detail ?? null) : null
      }
    }
  }

  /**
   * Current avatar as a data URL, or null when none is set.
   *
   * Browser semantics: a cached copy is returned instantly and revalidated
   * in the background (If-None-Match against the content-hash etag); when
   * the server says it changed or vanished, onAvatar announces the fresh
   * value. Cold cache blocks on one full download.
   */
  async getAvatar(): Promise<string | null> {
    if (!this.record) return null
    if (this.avatar) {
      void this.revalidateAvatar()
      return this.avatarDataUrl()
    }
    try {
      const got = await this.withAccessToken((token) => apiFetchAvatar(token))
      if (got.kind !== 'ok') return null
      await this.adoptAvatar(got.bytes, got.mime, got.etag)
      return this.avatarDataUrl()
    } catch {
      return null
    }
  }

  private avatarDataUrl(): string | null {
    return this.avatar ? `data:${this.avatar.mime};base64,${this.avatar.base64}` : null
  }

  private notifyAvatar(): void {
    const dataUrl = this.avatarDataUrl()
    for (const l of this.avatarListeners) l(dataUrl)
  }

  /** Store new avatar bytes (memory + disk) without announcing them. */
  private async adoptAvatar(bytes: ArrayBuffer, mime: string, etag: string | null): Promise<void> {
    const email = this.record?.session.user.email
    if (!email) return
    this.avatar = { version: 1, email, etag, mime, base64: Buffer.from(bytes).toString('base64') }
    await this.persistAvatar()
  }

  private async dropAvatar(notify: boolean): Promise<void> {
    const had = this.avatar !== null
    this.avatar = null
    await this.persistAvatar()
    if (notify && had) this.notifyAvatar()
  }

  /**
   * Ask the server whether the cached copy is still current. 304 → done;
   * new bytes → adopt + announce; 404 → the avatar was removed (possibly
   * from another device) → drop + announce. Network errors keep the cache,
   * exactly like a browser offline.
   */
  private async revalidateAvatar(): Promise<void> {
    if (this.avatarRevalidate) return this.avatarRevalidate
    this.avatarRevalidate = (async () => {
      const cached = this.avatar
      if (!this.record || !cached) return
      try {
        const got = await this.withAccessToken((token) => apiFetchAvatar(token, cached.etag))
        // The cache moved while we were in flight (an upload or removal
        // landed) — that answer is fresher than this response; stand down.
        if (this.avatar !== cached) return
        if (got.kind === 'not_modified') return
        if (got.kind === 'none') {
          await this.dropAvatar(true)
          return
        }
        // A server without 304 support answers 200 even when nothing
        // changed — compare before announcing so identical bytes are quiet.
        const base64 = Buffer.from(got.bytes).toString('base64')
        const changed = got.etag ? got.etag !== cached.etag : base64 !== cached.base64
        await this.adoptAvatar(got.bytes, got.mime, got.etag)
        if (changed) this.notifyAvatar()
      } catch {
        // Offline or transient failure — the cached copy stands.
      }
    })()
    try {
      await this.avatarRevalidate
    } finally {
      this.avatarRevalidate = null
    }
  }

  async setAvatar(
    bytes: ArrayBuffer,
    mime: string
  ): Promise<{ ok: boolean; code?: string; detail?: string | null }> {
    try {
      await this.withAccessToken((token) => apiUploadAvatar(token, bytes, mime))
      // The server keys the blob by content sha256 (hex) and echoes it as
      // the etag — computing it locally keeps the cache exact with no
      // second download.
      const etag = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
      await this.adoptAvatar(bytes, mime, etag)
      this.notifyAvatar()
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        code: this.codeOf(err),
        detail: err instanceof ApiError ? (err.detail ?? null) : null
      }
    }
  }

  async removeAvatar(): Promise<{ ok: boolean; code?: string; detail?: string | null }> {
    try {
      await this.withAccessToken((token) => apiDeleteAvatar(token))
      await this.dropAvatar(true)
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        code: this.codeOf(err),
        detail: err instanceof ApiError ? (err.detail ?? null) : null
      }
    }
  }

  /** Voluntary password change; the server verifies the current password. */
  async changePasswordSelf(currentPassword: string, newPassword: string): Promise<AuthState> {
    if (!this.record) {
      this.setStatus('loggedOut', 'not_signed_in')
      return this.getState()
    }
    try {
      await this.withAccessToken((token) =>
        apiChangePasswordSession(token, currentPassword, newPassword)
      )
      this.setStatus(this.status)
      return this.getState()
    } catch (err) {
      this.setStatus(this.status, this.codeOf(err), this.detailOf(err))
      return this.getState()
    }
  }

  // ── Sign out ───────────────────────────────────────────────────────────

  async signOut(reason: string | null = null): Promise<AuthState> {
    const token = this.record?.session.accessToken
    if (token) {
      try {
        await apiLogout(token)
      } catch {
        // Best-effort: local wipe proceeds regardless; the server session
        // dies at idle expiry (and instantly on admin revoke).
      }
    }
    await this.clearLocal()
    this.setStatus('loggedOut', reason)
    return this.getState()
  }

  // ── Tokens for the rest of the app ─────────────────────────────────────

  /**
   * The live access token, refreshed when within the skew of expiry.
   * Throws ApiError('not_signed_in') when there is no session.
   */
  async getAccessToken(): Promise<string> {
    if (!this.record) throw new ApiError('not_signed_in', 0)
    if (Date.now() >= this.record.session.accessExpiresAt - REFRESH_SKEW_MS) {
      await this.doRefresh()
    }
    if (!this.record) throw new ApiError('not_signed_in', 0)
    return this.record.session.accessToken
  }

  /** Run an authed call, translating a mid-flight revocation into logout. */
  async withAccessToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken()
    try {
      return await fn(token)
    } catch (err) {
      if (this.isAuthError(err)) {
        await this.clearLocal()
        this.setStatus('loggedOut', 'session_revoked')
      }
      throw err
    }
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      if (!this.record) return
      const { session } = this.record
      const next = await apiRefresh(session.refreshToken, {
        deviceId: session.deviceId,
        user: session.user
      })
      this.record.session = next
      // Persist BEFORE anything can use the session: the old refresh token
      // is already dead server-side.
      await this.persist()
    })()
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  // ── Watchdog: liveness, revocation, admin PIN clears ───────────────────

  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      void this.tick()
    }, WATCHDOG_MS)
    // Timers must not keep a quitting app alive.
    this.watchdog.unref?.()
  }

  private async tick(): Promise<void> {
    if (!this.record || this.status === 'mustChangePassword') return
    try {
      const info = await this.withAccessToken((token) => apiMe(token))
      if (info.org?.name && this.record && info.org.name !== this.record.orgName) {
        this.record.orgName = info.org.name
        await this.persist()
        this.setStatus(this.status)
      }
      // Admin asked for the PIN to be cleared: wipe the local hash, ack,
      // and if the app sat locked, let the user straight in — support
      // unlock, exactly as designed.
      if (info.device?.pin_clear_requested === 1 && this.record) {
        this.record.pin = null
        await this.persist()
        await this.withAccessToken((token) => reportPin(token, false)).catch(() => undefined)
        if (this.status === 'locked') this.setStatus('needsPin')
      }
    } catch {
      // Network blips are fine; real auth errors already flipped the state
      // inside withAccessToken.
    }
  }

  // ── Storage ────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.record) return
    await fs.mkdir(runtimeDir(), { recursive: true })
    const plain = JSON.stringify(this.record)
    if (safeStorage.isEncryptionAvailable()) {
      const sealed = safeStorage.encryptString(plain).toString('base64')
      await fs.writeFile(sessionPath(), JSON.stringify({ sealed }), 'utf8')
    } else {
      // Dev machines without a keychain still work; the file is plainly
      // marked so nobody mistakes it for sealed storage.
      await fs.writeFile(sessionPath(), JSON.stringify({ plain: this.record }), 'utf8')
    }
  }

  private async load(): Promise<StoredRecord | null> {
    try {
      if (!existsSync(sessionPath())) return null
      const raw = JSON.parse(await fs.readFile(sessionPath(), 'utf8')) as {
        sealed?: string
        plain?: StoredRecord
      }
      if (raw.plain) return raw.plain
      if (raw.sealed && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(raw.sealed, 'base64')))
      }
      return null
    } catch {
      return null
    }
  }

  /** Same sealed/plain policy as the session record. Null cache = no file. */
  private async persistAvatar(): Promise<void> {
    try {
      if (!this.avatar) {
        await fs.rm(avatarPath(), { force: true })
        return
      }
      await fs.mkdir(runtimeDir(), { recursive: true })
      const plain = JSON.stringify(this.avatar)
      if (safeStorage.isEncryptionAvailable()) {
        const sealed = safeStorage.encryptString(plain).toString('base64')
        await fs.writeFile(avatarPath(), JSON.stringify({ sealed }), 'utf8')
      } else {
        await fs.writeFile(avatarPath(), JSON.stringify({ plain: this.avatar }), 'utf8')
      }
    } catch {
      // Cache only — a failed write costs one re-download, never correctness.
    }
  }

  private async loadAvatar(): Promise<void> {
    try {
      if (!existsSync(avatarPath())) return
      const raw = JSON.parse(await fs.readFile(avatarPath(), 'utf8')) as {
        sealed?: string
        plain?: AvatarCache
      }
      let cache: AvatarCache | null = raw.plain ?? null
      if (!cache && raw.sealed && safeStorage.isEncryptionAvailable()) {
        cache = JSON.parse(safeStorage.decryptString(Buffer.from(raw.sealed, 'base64')))
      }
      // A cache from another account (or a malformed file) is dead weight.
      if (
        cache?.version === 1 &&
        typeof cache.base64 === 'string' &&
        cache.email === this.record?.session.user.email
      ) {
        this.avatar = cache
      } else {
        await fs.rm(avatarPath(), { force: true })
      }
    } catch {
      this.avatar = null
    }
  }

  private async clearLocal(): Promise<void> {
    this.record = null
    this.pendingChange = null
    this.pinAttemptsLeft = PIN_MAX_ATTEMPTS
    await this.dropAvatar(false)
    try {
      await fs.rm(sessionPath(), { force: true })
    } catch {
      // nothing to clear
    }
  }

  // ── Device identity ────────────────────────────────────────────────────

  private async deviceInfo(): Promise<{
    id?: string
    platform: 'desktop'
    name: string
    app_version: string
  }> {
    let id: string | undefined
    try {
      const raw = JSON.parse(await fs.readFile(devicePath(), 'utf8')) as { id?: string }
      if (typeof raw.id === 'string' && raw.id) id = raw.id
    } catch {
      // first run — the server mints the id
    }
    return { id, platform: 'desktop', name: os.hostname(), app_version: app.getVersion() }
  }

  private async rememberDevice(id: string): Promise<void> {
    if (!id) return
    await fs.mkdir(runtimeDir(), { recursive: true })
    await fs.writeFile(devicePath(), JSON.stringify({ id }), 'utf8')
  }

  // ── Error mapping ──────────────────────────────────────────────────────

  private codeOf(err: unknown): string {
    return err instanceof ApiError ? err.code : 'network'
  }

  private detailOf(err: unknown): string | null {
    return err instanceof ApiError ? (err.detail ?? null) : null
  }

  private isAuthError(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false
    return (
      err.status === 401 ||
      err.code === 'account_disabled' ||
      err.code === 'session_revoked' ||
      err.code === 'invalid_refresh' ||
      err.code === 'refresh_reuse_detected'
    )
  }
}

export const cloudSession = new CloudSession()
