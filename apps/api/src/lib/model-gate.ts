/**
 * ModelGate — the org's one admission queue in front of the model hosts.
 *
 * A model host enforces its concurrency limit per ACCOUNT (DeepInfra: 200
 * concurrent requests per model by default, 429 "Rate limited" above it), so
 * five hundred agents share one budget per host. Without a coordinator a
 * busy hour turns into random 429s, and every client's retry ladder makes
 * the next second worse. This Durable Object is the coordinator: a single
 * global instance (idFromName('org')) that every model call passes through
 * before it is forwarded, holding
 *
 *   - one slot pool per upstream host and model, sized from the pool config
 *     the Worker sends (MODEL_UPSTREAMS). Nothing above the configured
 *     concurrency is ever in flight; everything else WAITS — a queue, fair
 *     by employee (a person may hold PER_USER_INFLIGHT streams at once;
 *     beyond that their extra calls wait behind everyone else's), with no
 *     deadline: slower is fine, an error is not;
 *   - sticky routing: calls sharing a prompt cache key (one conversation)
 *     prefer the same host, so the host's prefix cache keeps hitting; a full
 *     or cooling host spills the call to the freest other host;
 *   - cooldowns: a host that answered 429 or 5xx is rested for the time it
 *     named (Retry-After) or an escalating few seconds, while the queue
 *     drains to the others — and simply waits if there are no others;
 *   - leases with a heartbeat: a slot belongs to a lease the Worker renews
 *     while its stream runs, so a Worker that dies mid-stream can never
 *     leak a slot for longer than the lease TTL. Leases live in this
 *     object's durable storage, not only in memory: an object with no
 *     request in flight is evicted after seconds of quiet, and a gate that
 *     forgot its running streams on every quiet moment would over-admit at
 *     the next burst. On wake the leases are read back and the in-flight
 *     counts rebuilt from them;
 *   - the token quota counters (per user per UTC day, org per UTC month),
 *     kept in this object's durable storage and bumped on release with the
 *     tokens the host actually reported. Single-threaded and durable, so
 *     they are exact — the KV counters they replace were neither.
 *
 * The upstream call itself does NOT run here (unlike the SearchGate): a
 * stream lasts seconds to minutes, and holding hundreds of them inside one
 * object would pin its memory and its request budget. The object hands out
 * the slot; the Worker streams.
 */
import { DurableObject } from 'cloudflare:workers'
import { wireModel, type PoolEntry } from '@/lib/upstreams'
import type { Env } from '@/index'

/** Streams one employee may hold at once; extra calls queue fairly. */
export const PER_USER_INFLIGHT = 8
/** A lease not renewed within this window is reclaimed (Worker died). */
const LEASE_TTL_MS = 90_000
/**
 * No single stream holds a slot longer than this, renewed or not — a
 * safety valve for slot ACCOUNTING only (the stream itself is untouched):
 * the longest legitimate generation is minutes, and a slot held for half
 * an hour is a leak by definition.
 */
const LEASE_MAX_MS = 30 * 60_000
/**
 * A granted lease the Worker never claims (its client vanished while it was
 * queued, so nobody received the grant) is reclaimed this soon — a slot
 * must not idle for a full lease TTL on a request that no longer exists.
 */
const CLAIM_TTL_MS = 15_000
/** How often the alarm sweeps for stale leases while any lease is open. */
const SWEEP_MS = 30_000
/** Safety valve only — 500 employees at the per-user cap is 4,000 waiters. */
const MAX_QUEUE = 20_000
/**
 * A call queued this long is told to come back (503 + Retry-After) rather
 * than kept pending: below the point where a client's own connection
 * timeout (Node's fetch: 300 s to first byte) would turn the wait into an
 * error it cannot classify. The client's retry re-queues it — the wait
 * continues, only the connection is fresh.
 */
const MAX_WAIT_MS = 240_000
/**
 * A cancelled stream's slot is freed after a short grace: the host stops
 * generating when the upstream connection closes, but its own in-flight
 * count may lag by a moment, and re-filling the slot inside that moment is
 * how a single stray 429 happens.
 */
const CANCEL_GRACE_MS = 2_000
const COOLDOWN_429_MS = 5_000
const COOLDOWN_5XX_MS = 10_000
const COOLDOWN_MAX_MS = 60_000

export type AdmitRequest = {
  userId: string
  model: string
  /** The conversation's prompt cache key: what keeps a task on one host. */
  cacheKey?: string
  pool: PoolEntry[]
  /** Token caps: per user per day, org per month. 0 = unlimited. */
  caps: { userDaily: number; orgMonthly: number }
  /** Hosts that just failed this call; skipped unless nothing else serves the model. */
  avoid?: string[]
}

export type Standing = { userDayUsed: number; orgMonthUsed: number }

export type AdmitResult =
  | {
      ok: true
      lease: string
      upstreamId: string
      wireModel: string
      waitedMs: number
      queuedAhead: number
    }
  | { ok: false; reason: 'quota'; scope: 'user_daily' | 'org_monthly'; used: number; cap: number }
  | { ok: false; reason: 'no_upstream' }
  | { ok: false; reason: 'overloaded'; retryAfterMs: number }

export type ReleaseStatus =
  | 'ok'
  | 'upstream_429'
  | 'upstream_5xx'
  | 'upstream_unreachable'
  | 'error'
  | 'cancelled'

export type ReleaseReport = {
  tokensIn?: number
  tokensOut?: number
  status: ReleaseStatus
  /** From the host's Retry-After, when it sent one. */
  retryAfterMs?: number
}

export type PoolStats = {
  id: string
  concurrency: number
  weight: number
  inflight: Record<string, number>
  inflightTotal: number
  cooldownForMs: number
  failures: number
  served: number
}

export type GateStats = {
  pools: PoolStats[]
  queued: number
  queuedByModel: Record<string, number>
  oldestWaitMs: number
  leases: number
  admitted: number
  /** Admitted calls that waited for a slot at all (queue depth > 0 at arrival). */
  queuedAdmits: number
  maxWaitMs: number
  /** Stale-lease sweeps run so far, and when the next one is due (null = none armed). */
  sweeps: number
  nextSweepInMs: number | null
  reclaimed: number
}

type Pool = PoolEntry & {
  inflight: Map<string, number>
  cooldownUntil: number
  failures: number
  served: number
}

type Lease = {
  userId: string
  upstreamId: string
  model: string
  issuedAt: number
  renewedAt: number
  claimed: boolean
}

type Grant = { lease: string; upstreamId: string; wireModel: string; queuedAhead: number }

type Waiter = {
  userId: string
  model: string
  cacheKey: string
  avoid: Set<string>
  enqueuedAt: number
  resolve: (grant: Grant | 'busy') => void
}

const dayKey = (userId: string, now: number) =>
  `tok:d:${userId}:${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}`
const monthKey = (now: number) => `tok:m:${new Date(now).toISOString().slice(0, 7).replace(/-/g, '')}`

/** FNV-1a: cheap, stable, good enough to spread conversations over hosts. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function newLeaseId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

const LEASE_PREFIX = 'lease:'

export class ModelGate extends DurableObject<Env> {
  private pools = new Map<string, Pool>()
  private poolSig = ''
  private hydrated: Promise<void> | null = null
  private queue: Waiter[] = []
  private leases = new Map<string, Lease>()
  private userInflight = new Map<string, number>()
  private counters = new Map<string, number>()
  private lastDayKeyDay = ''
  private pump: ReturnType<typeof setTimeout> | null = null
  private admitted = 0
  private queuedAdmits = 0
  private maxWaitMs = 0
  private sweeps = 0
  private reclaimed = 0

  // ── RPC surface ──────────────────────────────────────────────────────

  async admit(req: AdmitRequest): Promise<AdmitResult> {
    await this.hydrate()
    this.adoptPool(req.pool)
    const now = Date.now()

    // Governance first: a capped employee is told so at once, never queued.
    const [userUsed, orgUsed] = await Promise.all([
      this.counter(dayKey(req.userId, now)),
      this.counter(monthKey(now))
    ])
    if (req.caps.userDaily > 0 && userUsed >= req.caps.userDaily) {
      return { ok: false, reason: 'quota', scope: 'user_daily', used: userUsed, cap: req.caps.userDaily }
    }
    if (req.caps.orgMonthly > 0 && orgUsed >= req.caps.orgMonthly) {
      return { ok: false, reason: 'quota', scope: 'org_monthly', used: orgUsed, cap: req.caps.orgMonthly }
    }

    if (!this.anyServes(req.model)) return { ok: false, reason: 'no_upstream' }
    if (this.queue.length >= MAX_QUEUE) {
      return { ok: false, reason: 'overloaded', retryAfterMs: 5_000 }
    }

    const queuedAhead = this.queue.length
    const grant = await new Promise<Grant | 'busy'>((resolve) => {
      this.queue.push({
        userId: req.userId,
        model: req.model,
        cacheKey: req.cacheKey || req.userId,
        avoid: new Set(req.avoid ?? []),
        enqueuedAt: now,
        resolve
      })
      this.dispatch()
    })
    if (grant === 'busy') {
      // Told to come back: the wait continues on a fresh connection. The
      // hint is jittered at the source so a batch that aged out together
      // does not return together.
      return { ok: false, reason: 'overloaded', retryAfterMs: 3_000 + Math.floor(Math.random() * 5_000) }
    }
    const waitedMs = Date.now() - now
    this.admitted++
    if (queuedAhead > 0 || waitedMs > 50) this.queuedAdmits++
    if (waitedMs > this.maxWaitMs) this.maxWaitMs = waitedMs
    return { ok: true, ...grant, waitedMs }
  }

  /** Frees the slot, rests a failing host, and books the tokens the host reported. */
  async release(lease: string, r: ReleaseReport): Promise<Standing | null> {
    await this.hydrate()
    const l = this.leases.get(lease)
    if (!l) return null // expired or already released — idempotent
    this.leases.delete(lease)
    await this.ctx.storage.delete(LEASE_PREFIX + lease)
    if (r.status === 'cancelled') {
      setTimeout(() => {
        this.freeSlot(l)
        this.dispatch()
      }, CANCEL_GRACE_MS)
    } else {
      this.freeSlot(l)
    }

    const pool = this.pools.get(l.upstreamId)
    if (pool) {
      if (r.status === 'upstream_429' || r.status === 'upstream_5xx' || r.status === 'upstream_unreachable') {
        this.rest(pool, r)
      } else if (r.status === 'ok') {
        pool.failures = 0
        pool.served++
      }
    }

    const tokens = Math.max(0, Math.floor(r.tokensIn ?? 0)) + Math.max(0, Math.floor(r.tokensOut ?? 0))
    const now = Date.now()
    if (tokens > 0) await this.bump(l.userId, tokens, now)
    this.dispatch()
    return {
      userDayUsed: await this.counter(dayKey(l.userId, now)),
      orgMonthUsed: await this.counter(monthKey(now))
    }
  }

  /**
   * The Worker's acknowledgement that it received the grant, and its
   * heartbeat while the stream runs. False = the lease was reclaimed.
   */
  async renew(lease: string): Promise<boolean> {
    await this.hydrate()
    const l = this.leases.get(lease)
    if (!l) return false
    l.renewedAt = Date.now()
    l.claimed = true
    await this.ctx.storage.put(LEASE_PREFIX + lease, l)
    return true
  }

  async standing(userId: string): Promise<Standing> {
    await this.hydrate()
    const now = Date.now()
    return {
      userDayUsed: await this.counter(dayKey(userId, now)),
      orgMonthUsed: await this.counter(monthKey(now))
    }
  }

  async stats(): Promise<GateStats> {
    await this.hydrate()
    const now = Date.now()
    const queuedByModel: Record<string, number> = {}
    let oldest = 0
    for (const w of this.queue) {
      queuedByModel[w.model] = (queuedByModel[w.model] ?? 0) + 1
      oldest = Math.max(oldest, now - w.enqueuedAt)
    }
    return {
      pools: [...this.pools.values()].map((p) => ({
        id: p.id,
        concurrency: p.concurrency,
        weight: p.weight,
        inflight: Object.fromEntries(p.inflight),
        inflightTotal: [...p.inflight.values()].reduce((a, b) => a + b, 0),
        cooldownForMs: Math.max(0, p.cooldownUntil - now),
        failures: p.failures,
        served: p.served
      })),
      queued: this.queue.length,
      queuedByModel,
      oldestWaitMs: oldest,
      leases: this.leases.size,
      admitted: this.admitted,
      queuedAdmits: this.queuedAdmits,
      maxWaitMs: this.maxWaitMs,
      sweeps: this.sweeps,
      nextSweepInMs: await this.ctx.storage.getAlarm().then((at) => (at === null ? null : Math.max(0, at - now))),
      reclaimed: this.reclaimed
    }
  }

  // ── The alarm: stale-lease sweep ─────────────────────────────────────

  async alarm(): Promise<void> {
    await this.hydrate()
    const now = Date.now()
    this.sweeps++
    for (const [id, l] of this.leases) {
      const stale =
        now - l.renewedAt > LEASE_TTL_MS ||
        (!l.claimed && now - l.issuedAt > CLAIM_TTL_MS) ||
        now - l.issuedAt > LEASE_MAX_MS
      if (stale) {
        this.leases.delete(id)
        await this.ctx.storage.delete(LEASE_PREFIX + id)
        this.freeSlot(l)
        this.reclaimed++
        console.warn('model gate: reclaimed lease', {
          upstream: l.upstreamId,
          model: l.model,
          claimed: l.claimed
        })
      }
    }
    this.dispatch()
    await this.armSweep()
  }

  private async armSweep(): Promise<void> {
    if (this.leases.size === 0 && this.queue.length === 0) return
    const current = await this.ctx.storage.getAlarm()
    // Unclaimed grants are checked on the claim horizon, everything else on
    // the sweep interval.
    const unclaimed = [...this.leases.values()].some((l) => !l.claimed)
    const delay = unclaimed ? CLAIM_TTL_MS : SWEEP_MS
    if (current === null || current > Date.now() + delay) {
      await this.ctx.storage.setAlarm(Date.now() + delay)
    }
  }

  // ── Pools ────────────────────────────────────────────────────────────

  private adoptPool(entries: PoolEntry[]): void {
    const sig = JSON.stringify(entries)
    if (sig === this.poolSig) return
    const next = new Map<string, Pool>()
    for (const e of entries) {
      const prev = this.pools.get(e.id)
      next.set(e.id, {
        ...e,
        inflight: prev?.inflight ?? this.inflightFromLeases(e.id),
        cooldownUntil: prev?.cooldownUntil ?? 0,
        failures: prev?.failures ?? 0,
        served: prev?.served ?? 0
      })
    }
    this.pools = next
    this.poolSig = sig
  }

  /** In-flight per model on one host, derived from the leases (the durable truth). */
  private inflightFromLeases(upstreamId: string): Map<string, number> {
    const m = new Map<string, number>()
    for (const l of this.leases.values()) {
      if (l.upstreamId === upstreamId) m.set(l.model, (m.get(l.model) ?? 0) + 1)
    }
    return m
  }

  /**
   * Read the leases back from storage once per instance: an evicted object
   * wakes with empty memory, and the streams those leases stand for are
   * still running on the hosts.
   */
  private hydrate(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = (async () => {
        const stored = await this.ctx.storage.list<Lease>({ prefix: LEASE_PREFIX })
        for (const [key, l] of stored) {
          const id = key.slice(LEASE_PREFIX.length)
          if (this.leases.has(id)) continue
          this.leases.set(id, l)
          this.userInflight.set(l.userId, (this.userInflight.get(l.userId) ?? 0) + 1)
          const pool = this.pools.get(l.upstreamId)
          if (pool) pool.inflight.set(l.model, (pool.inflight.get(l.model) ?? 0) + 1)
        }
        await this.armSweep()
      })()
    }
    return this.hydrated
  }

  private anyServes(model: string): boolean {
    for (const p of this.pools.values()) if (wireModel(p, model) !== null) return true
    return false
  }

  private free(p: Pool, model: string): number {
    return p.concurrency - (p.inflight.get(model) ?? 0)
  }

  /** The host a conversation prefers: stable over the hosts serving its model, by weight. */
  private preferred(cacheKey: string, model: string): string | null {
    const serving = [...this.pools.values()].filter((p) => wireModel(p, model) !== null)
    if (serving.length === 0) return null
    const total = serving.reduce((a, p) => a + p.weight, 0)
    let slot = hash32(cacheKey) % total
    for (const p of serving) {
      if (slot < p.weight) return p.id
      slot -= p.weight
    }
    return serving[0]!.id
  }

  private pick(w: Waiter, now: number): { pool: Pool; wire: string } | null {
    const serving = [...this.pools.values()].filter((p) => wireModel(p, w.model) !== null)
    // A host that just failed this call is skipped — unless it is the only one.
    const candidates = serving.filter((p) => !w.avoid.has(p.id))
    const eligible = (candidates.length ? candidates : serving).filter(
      (p) => p.cooldownUntil <= now && this.free(p, w.model) > 0
    )
    if (eligible.length === 0) return null
    const pref = this.preferred(w.cacheKey, w.model)
    const sticky = eligible.find((p) => p.id === pref)
    const pool =
      sticky ??
      eligible.reduce((best, p) =>
        this.free(p, w.model) / p.concurrency > this.free(best, w.model) / best.concurrency ? p : best
      )
    return { pool, wire: wireModel(pool, w.model)! }
  }

  private rest(pool: Pool, r: ReleaseReport): void {
    pool.failures++
    const base = r.status === 'upstream_429' ? COOLDOWN_429_MS : COOLDOWN_5XX_MS
    const escalated = Math.min(COOLDOWN_MAX_MS, base * 2 ** Math.min(4, pool.failures - 1))
    const named = r.retryAfterMs && r.retryAfterMs > 0 ? Math.min(COOLDOWN_MAX_MS, r.retryAfterMs) : 0
    pool.cooldownUntil = Math.max(pool.cooldownUntil, Date.now() + Math.max(named, escalated))
  }

  private freeSlot(l: Lease): void {
    const pool = this.pools.get(l.upstreamId)
    if (pool) {
      const n = (pool.inflight.get(l.model) ?? 1) - 1
      if (n <= 0) pool.inflight.delete(l.model)
      else pool.inflight.set(l.model, n)
    }
    const u = (this.userInflight.get(l.userId) ?? 1) - 1
    if (u <= 0) this.userInflight.delete(l.userId)
    else this.userInflight.set(l.userId, u)
  }

  // ── The queue ────────────────────────────────────────────────────────

  private dispatch(): void {
    const now = Date.now()
    // Nobody waits past the client-timeout horizon: an aged waiter is told
    // to come back, and never takes a slot from a live one.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i]!
      if (now - w.enqueuedAt > MAX_WAIT_MS) {
        this.queue.splice(i, 1)
        w.resolve('busy')
      }
    }
    let i = 0
    while (i < this.queue.length) {
      const w = this.queue[i]!
      if ((this.userInflight.get(w.userId) ?? 0) >= PER_USER_INFLIGHT) {
        i++
        continue
      }
      const picked = this.pick(w, now)
      if (!picked) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      const lease = newLeaseId()
      const record: Lease = {
        userId: w.userId,
        upstreamId: picked.pool.id,
        model: w.model,
        issuedAt: now,
        renewedAt: now,
        claimed: false
      }
      this.leases.set(lease, record)
      void this.ctx.storage.put(LEASE_PREFIX + lease, record).catch((err: unknown) => {
        console.error('model gate: lease not persisted', { message: (err as Error).message })
      })
      picked.pool.inflight.set(w.model, (picked.pool.inflight.get(w.model) ?? 0) + 1)
      this.userInflight.set(w.userId, (this.userInflight.get(w.userId) ?? 0) + 1)
      w.resolve({ lease, upstreamId: picked.pool.id, wireModel: picked.wire, queuedAhead: i })
    }
    if (this.queue.length) {
      // Waiters remain: re-check when the earliest cooldown ends, and at
      // least every second regardless — a release may never come (the sweep
      // frees the slot) and waiters must age out on time.
      let soonest = now + 1_000
      for (const p of this.pools.values()) {
        if (p.cooldownUntil > now) soonest = Math.min(soonest, p.cooldownUntil)
      }
      this.schedule(Math.max(50, soonest - now))
    }
    void this.armSweep()
  }

  private schedule(delayMs: number): void {
    if (this.pump) return
    this.pump = setTimeout(() => {
      this.pump = null
      this.dispatch()
    }, delayMs)
  }

  // ── Quota counters (durable, exact) ──────────────────────────────────

  private async counter(key: string): Promise<number> {
    const cached = this.counters.get(key)
    if (cached !== undefined) return cached
    const stored = (await this.ctx.storage.get<number>(key)) ?? 0
    this.counters.set(key, stored)
    return stored
  }

  private async bump(userId: string, tokens: number, now: number): Promise<void> {
    const dk = dayKey(userId, now)
    const mk = monthKey(now)
    const d = (await this.counter(dk)) + tokens
    const m = (await this.counter(mk)) + tokens
    this.counters.set(dk, d)
    this.counters.set(mk, m)
    await this.ctx.storage.put({ [dk]: d, [mk]: m })
    await this.tidyCounters(now)
  }

  /** Once per UTC day: drop day keys older than yesterday and month keys older than last month. */
  private async tidyCounters(now: number): Promise<void> {
    const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
    if (this.lastDayKeyDay === today) return
    this.lastDayKeyDay = today
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')
    const thisMonth = today.slice(0, 6)
    const lastMonth = new Date(now - 31 * 86_400_000).toISOString().slice(0, 7).replace(/-/g, '')
    const doomed: string[] = []
    for (const key of (await this.ctx.storage.list<number>({ prefix: 'tok:' })).keys()) {
      if (key.startsWith('tok:d:')) {
        const day = key.slice(key.lastIndexOf(':') + 1)
        if (day !== today && day !== yesterday) doomed.push(key)
      } else if (key.startsWith('tok:m:')) {
        const month = key.slice(6)
        if (month !== thisMonth && month !== lastMonth) doomed.push(key)
      }
    }
    for (const key of doomed) this.counters.delete(key)
    for (let i = 0; i < doomed.length; i += 128) await this.ctx.storage.delete(doomed.slice(i, i + 128))
  }
}
