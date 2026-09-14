/**
 * Brave Search — an org-provided service, like the models.
 *
 * There is nothing to configure on this device: the organization holds
 * the one Brave Search key behind the API's /v1/search lane, and the
 * web-search capability's plugin calls that lane with the session token
 * (through the cerebellum's cloud host). This module is the status view
 * the settings panel, the phone snapshot and the CLI render — one read of
 * GET /v1/search/status, cached briefly so a panel mount does not hit the
 * edge on every render, with a forced refresh for the panel's button.
 */
import { API_BASE } from '@main/cloud/api'
import { ApiError } from '@main/cloud/api'
import { cloudSession } from '@main/cloud/session'

export type BraveLaneState = 'ready' | 'disabled' | 'unconfigured' | 'signed_out' | 'unreachable'

export type BraveStatus = {
  provider: 'brave'
  /** Always true: the lane is the org's, never a device key. */
  managed: true
  state: BraveLaneState
  /** The org has a Brave key on the API. */
  configured: boolean
  /** The org's switch for the lane. */
  enabled: boolean
  /** This user's searches today against their daily cap (0 = unlimited). */
  usedToday: number
  dailyCap: number
  /** The whole org this month against its monthly cap (0 = unlimited). */
  orgUsedMonth: number
  orgMonthlyCap: number
  /** Plan price per query, USD. */
  pricePerQueryUsd: number
  /** The plan's per-second limit the gate runs against. */
  planQps: number
  /** What the org's gate admits per second right now (null before the first search). */
  limitPerSec: number | null
  /** Wire detail when the lane could not be read. */
  error: string | null
  fetchedAt: number
}

type WireStatus = {
  provider?: string
  configured?: boolean
  enabled?: boolean
  ready?: boolean
  daily_cap?: number
  used_today?: number
  org_monthly_cap?: number
  org_used_month?: number
  price_per_query_microusd?: number
  plan_qps?: number
  gate?: { limitPerSec?: number } | null
}

const FRESH_MS = 20_000
const FETCH_TIMEOUT_MS = 15_000

const EMPTY: Omit<BraveStatus, 'state' | 'error' | 'fetchedAt'> = {
  provider: 'brave',
  managed: true,
  configured: false,
  enabled: false,
  usedToday: 0,
  dailyCap: 0,
  orgUsedMonth: 0,
  orgMonthlyCap: 0,
  pricePerQueryUsd: 0,
  planQps: 0,
  limitPerSec: null
}

class BraveService {
  private last: BraveStatus | null = null
  private inflight: Promise<BraveStatus> | null = null

  /** The lane's status; `refresh` bypasses the short cache. */
  async getStatus(refresh = false): Promise<BraveStatus> {
    if (!refresh && this.last && Date.now() - this.last.fetchedAt < FRESH_MS) return this.last
    if (this.inflight) return this.inflight
    this.inflight = this.fetchStatus().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Forget the cached read (e.g. after sign-in/out) so the next read is live. */
  resetCache(): void {
    this.last = null
  }

  private async fetchStatus(): Promise<BraveStatus> {
    const base = this.last ?? EMPTY
    try {
      const wire = await cloudSession.withAccessToken(async (token) => {
        const res = await fetch(`${API_BASE}/v1/search/status`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
        if (!res.ok) throw new ApiError(`http_${res.status}`, res.status)
        return (await res.json()) as WireStatus
      })
      const configured = Boolean(wire.configured)
      const enabled = Boolean(wire.enabled)
      const next: BraveStatus = {
        provider: 'brave',
        managed: true,
        state: configured && enabled ? 'ready' : !enabled ? 'disabled' : 'unconfigured',
        configured,
        enabled,
        usedToday: wire.used_today ?? 0,
        dailyCap: wire.daily_cap ?? 0,
        orgUsedMonth: wire.org_used_month ?? 0,
        orgMonthlyCap: wire.org_monthly_cap ?? 0,
        pricePerQueryUsd: (wire.price_per_query_microusd ?? 0) / 1_000_000,
        planQps: wire.plan_qps ?? 0,
        limitPerSec: wire.gate?.limitPerSec ?? null,
        error: null,
        fetchedAt: Date.now()
      }
      this.last = next
      return next
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ((err as Error)?.message ?? String(err))
      const signedOut = err instanceof ApiError && err.code === 'not_signed_in'
      const next: BraveStatus = {
        ...base,
        state: signedOut ? 'signed_out' : 'unreachable',
        error: signedOut ? null : code,
        fetchedAt: Date.now()
      }
      // An unreachable read is not cached: the next mount tries again.
      return next
    }
  }
}

export const braveService = new BraveService()
