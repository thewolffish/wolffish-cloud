import * as SecureStore from 'expo-secure-store'
import {
  ApiError,
  logout as apiLogout,
  refresh as apiRefresh,
  type WireSession,
  type WireUser
} from '@/lib/cloud/api'

/**
 * The phone's org session — the ONLY place tokens exist.
 *
 * Pairing mints it (the desktop offers, this phone claims — see
 * lib/cloud/pairing), and from then on every request to the org carries its
 * access token, refreshed when within a minute of expiry. The refresh token
 * rotates on every refresh and the new one is written to the keystore
 * BEFORE anything else happens — a crash between rotate and persist costs
 * one re-pair, never a leaked live token.
 *
 * Storage is the OS keystore (Keychain / Keystore-encrypted preferences),
 * readable only while the device is unlocked — never AsyncStorage.
 *
 * A session that the org refuses (revoked from the desktop's Mobile panel,
 * signed out by an admin, reuse of a rotated-out refresh token) is cleared
 * here and announced: the app returns to the door, and the next pairing
 * starts clean. Network failures never sign out — the tokens stay, and the
 * next call tries again.
 */

const KEY_SESSION = 'wolffish.cloud.session.v1'
const KEY_DEVICE = 'wolffish.cloud.device.v1'
const REFRESH_SKEW_MS = 60_000

export type StoredSession = {
  version: 1
  session: WireSession
  /** The org, as the claim answered it — presentation only. */
  orgName: string | null
  /** The desktop that offered the pairing, as the claim answered it. */
  desktop: { id: string; name: string } | null
  pairedAt: number
}

export type SessionListener = (session: StoredSession | null, reason: string | null) => void

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  })
}

class CloudSession {
  private record: StoredSession | null = null
  private loaded: Promise<void> | null = null
  private refreshInFlight: Promise<void> | null = null
  private readonly listeners = new Set<SessionListener>()

  /** Restore from the keystore once; every later call is a cache read. */
  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = readJson<StoredSession>(KEY_SESSION).then((stored) => {
        if (stored?.version === 1 && stored.session?.refreshToken) this.record = stored
      })
    }
    return this.loaded
  }

  /** The stored session, if any — after load(). */
  get current(): StoredSession | null {
    return this.record
  }

  get isSignedIn(): boolean {
    return this.record !== null
  }

  get user(): WireUser | null {
    return this.record?.session.user ?? null
  }

  /** This phone's org device id — what the bridge keys presence and push on. */
  get deviceId(): string | null {
    return this.record?.session.deviceId ?? null
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private announce(reason: string | null): void {
    for (const listener of this.listeners) listener(this.record, reason)
  }

  /** A freshly claimed session becomes THE session. */
  async adopt(next: StoredSession): Promise<void> {
    await this.load()
    this.record = next
    await writeJson(KEY_SESSION, next)
    // Remembered outside the session so a re-pair after an unpair can
    // present the same device id (the org mints a new row regardless once
    // the old one was revoked; this keeps an un-revoked one stable).
    await writeJson(KEY_DEVICE, { id: next.session.deviceId }).catch(() => undefined)
    this.announce('paired')
  }

  /** The device id a previous pairing used, for the claim body. */
  async rememberedDeviceId(): Promise<string | null> {
    const stored = await readJson<{ id?: string }>(KEY_DEVICE)
    return typeof stored?.id === 'string' && stored.id ? stored.id : null
  }

  /**
   * The live access token, refreshed when within the skew of expiry.
   * Throws ApiError('not_signed_in') when there is no session.
   */
  async getAccessToken(): Promise<string> {
    await this.load()
    if (!this.record) throw new ApiError('not_signed_in', 0)
    if (Date.now() >= this.record.session.accessExpiresAt - REFRESH_SKEW_MS) {
      await this.doRefresh()
    }
    if (!this.record) throw new ApiError('not_signed_in', 0)
    return this.record.session.accessToken
  }

  /** Run an authed call, translating a revocation into a sign-out. */
  async withAccessToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken()
    try {
      return await fn(token)
    } catch (err) {
      if (this.isAuthError(err)) await this.clearLocal('session_revoked')
      throw err
    }
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      if (!this.record) return
      const { session } = this.record
      let next: WireSession
      try {
        next = await apiRefresh(session.refreshToken, {
          deviceId: session.deviceId,
          user: session.user
        })
      } catch (err) {
        if (this.isAuthError(err)) await this.clearLocal('session_revoked')
        throw err
      }
      this.record = { ...this.record, session: next }
      // Persist BEFORE anything can use the session: the old refresh token
      // is already dead server-side.
      await writeJson(KEY_SESSION, this.record)
    })()
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  /**
   * Sign this phone out of the org: revoke the session (best-effort — an
   * offline phone still forgets locally; the org's idle expiry finishes the
   * job) and drop the keystore record.
   */
  async signOut(reason = 'signed_out'): Promise<void> {
    await this.load()
    const token = this.record?.session.accessToken
    if (token) {
      try {
        await apiLogout(token)
      } catch {
        // offline, or already revoked — nothing more to do here
      }
    }
    await this.clearLocal(reason)
  }

  private async clearLocal(reason: string): Promise<void> {
    this.record = null
    await SecureStore.deleteItemAsync(KEY_SESSION).catch(() => undefined)
    this.announce(reason)
  }

  private isAuthError(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.code === 'account_disabled' ||
      err.code === 'session_revoked' ||
      err.code === 'invalid_refresh' ||
      err.code === 'refresh_reuse_detected'
    )
  }
}

export const cloudSession = new CloudSession()
