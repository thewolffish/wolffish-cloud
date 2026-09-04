/**
 * The router — the reason the choke point exists.
 *
 * POST /ai/v1/chat/completions, OpenAI-compatible, so the desktop's
 * provider layer points here with the session token as its bearer.
 * Chain: session → allowlist → ModelGate (quota, then a slot on a host,
 * queued fairly for as long as it takes) → forward with the host's key →
 * stream back through a pump that watches for the usage block → meter →
 * release the slot.
 *
 * Graceful by contract: capacity never produces an error. When every host
 * is full the call waits in the gate; when a host answers 429 or 5xx before
 * a byte has reached the client, the slot is released, the host rests, and
 * the call is re-admitted (possibly to another host) — up to MAX_ATTEMPTS
 * times, each admission waiting as long as it needs to. Only a hard
 * upstream refusal (4xx other than 429) or a stream that breaks after the
 * client has started receiving surfaces as an error.
 *
 * Privacy: nothing identity-shaped is sent upstream — the outbound request
 * is the client's body with the wire model id and the org's key. Prompt
 * content is never logged or stored here; only metering metadata is.
 */
import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import { getEffectivePolicy, getOrgConfig, modelAllowed } from '@/lib/policy'
import { normalizeSurface } from '@/lib/plans'
import { loadUpstreams, poolSummary, type Upstream } from '@/lib/upstreams'
import { recordUsageSafe, type UsageEvent } from '@/lib/meter'
import type { AdmitResult, ReleaseReport, ReleaseStatus } from '@/lib/model-gate'
import type { Env } from '@/index'

/** Above this the body is refused outright — a 1M-token context is ~4 MB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Admissions per call: the first, plus re-admissions after transient host failures. */
const MAX_ATTEMPTS = 3
/** Lease heartbeat while a stream runs (the gate reclaims after 90 s of silence). */
const LEASE_RENEW_MS = 30_000
/** A streaming host that sends nothing at all for this long has stalled. */
const STREAM_IDLE_MS = 180_000
/**
 * A client that accepts nothing for this long is gone: a healthy client
 * drains an SSE chunk in microseconds, and a socket left open by a suspended
 * laptop or a dead mobile link would otherwise block the pump on a write
 * forever — heartbeat still renewing the slot, host long finished.
 */
const CLIENT_STALL_MS = 60_000
/** A non-streaming completion (reasoning models think first) may take this long. */
const NONSTREAM_TIMEOUT_MS = 600_000
/** A scanner carry-over larger than this cannot be a usage line; drop the head. */
const SCAN_CARRY_MAX = 512 * 1024
/** Metering and release after a stream: bounded, so a storage hiccup cannot pin a slot. */
const BOOKKEEPING_MS = 30_000

const ai = new Hono<{ Bindings: Env; Variables: AuthVars }>()

ai.use('*', requireAuth)

const gateOf = (env: Env) => env.MODEL_GATE.get(env.MODEL_GATE.idFromName('org'))

type UpstreamUsage = { in: number; out: number; cached: number; costUsd?: number }

/** The usage block of one upstream response (JSON body or an SSE chunk). */
export function readUsage(raw: unknown): UpstreamUsage | null {
  const u = (raw as { usage?: Record<string, any> } | null)?.usage
  if (!u || typeof u !== 'object') return null
  return {
    in: u.prompt_tokens ?? 0,
    out: u.completion_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: typeof u.estimated_cost === 'number' ? u.estimated_cost : undefined
  }
}

/**
 * Watches an SSE byte stream for its usage block without retaining the
 * body: only the current partial line is kept, and only lines that mention
 * "usage" are parsed. Counts content-bearing chunks too, so a cancelled
 * stream can still be metered by estimate.
 */
export class UsageScanner {
  usage: UpstreamUsage | null = null
  chunks = 0
  private carry = ''
  private readonly decoder = new TextDecoder()

  feed(bytes: Uint8Array): void {
    this.carry += this.decoder.decode(bytes, { stream: true })
    let nl: number
    while ((nl = this.carry.indexOf('\n')) !== -1) {
      const line = this.carry.slice(0, nl)
      this.carry = this.carry.slice(nl + 1)
      this.line(line)
    }
    if (this.carry.length > SCAN_CARRY_MAX) this.carry = this.carry.slice(-1024)
  }

  private line(raw: string): void {
    if (!raw.startsWith('data:')) return
    const payload = raw.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    if (payload.includes('"choices"')) this.chunks++
    if (!payload.includes('"usage"')) return
    try {
      const found = readUsage(JSON.parse(payload))
      if (found) this.usage = found
    } catch {
      // a keepalive or partial line — not the usage block
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new Error('timeout'))
    }, ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function affinityId(cacheKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheKey))
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

ai.post('/v1/chat/completions', async (c) => {
  const auth = c.get('auth')

  // ── The body, bounded ────────────────────────────────────────────────
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413)
  }
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413)
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  } catch {
    body = null
  }
  const model = typeof body?.model === 'string' ? body.model : ''
  if (!body || !model) return c.json({ error: 'invalid_request', detail: 'model required' }, 400)
  if (body.n !== undefined && body.n !== 1) {
    return c.json({ error: 'invalid_request', detail: 'n must be 1' }, 400)
  }
  const stream = body.stream === true
  if (stream) {
    // Usage arrives in the final SSE chunk only when asked for.
    body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }
  }
  const cacheKey = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined
  // Cache affinity, both ways the OpenAI wire expresses it: the client's
  // prompt_cache_key passes through, and the `user` field (which some hosts
  // use to route a session's calls to one replica) is derived from it — a
  // hash, so nothing identity-shaped ever goes upstream. Measured live on
  // DeepInfra 2026-09-02 (two 31-call agentic runs, 3–5 s between calls):
  // warm calls cache 94–98% of the prompt, but ~40% of calls land on a cold
  // replica with either field, so on that host this hint changes nothing;
  // it stays for hosts that honor it.
  if (cacheKey && body.user === undefined) body.user = await affinityId(cacheKey)

  // ── Governance ───────────────────────────────────────────────────────
  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  const policy = await getEffectivePolicy(c.env, auth.sub)
  // Which surface spent this: the client names it, and an unrecognised or
  // absent label records as '' rather than failing the call — attribution is
  // reporting, never a gate.
  const base: Omit<UsageEvent, 'decision'> = {
    userId: auth.sub,
    deviceId: auth.dev,
    kind: 'chat',
    model,
    surface: normalizeSurface(c.req.header('x-wfc-surface'))
  }

  if (!modelAllowed(model, policy, org)) {
    await recordUsageSafe(c.env, { ...base, decision: 'denied_model' })
    return c.json(
      {
        error: 'model_not_allowed',
        allowed: policy.allowed.length > 0 ? policy.allowed : [org.default_model],
        default_model: org.default_model
      },
      403
    )
  }

  const pool = loadUpstreams(c.env)
  if (pool.length === 0) {
    await recordUsageSafe(c.env, { ...base, decision: 'error', error: 'no_upstream' })
    return c.json({ error: 'model_unavailable', detail: 'no model host configured' }, 503, {
      'retry-after': '30'
    })
  }
  const summary = poolSummary(pool)
  const caps = {
    userDaily: policy.dailyCap,
    orgMonthly: org.org_monthly_token_cap,
    userMonthlyIn: policy.ceilings.monthlyIn,
    userMonthlyOut: policy.ceilings.monthlyOut
  }
  const gate = gateOf(c.env)

  // ── Admission → forward, re-admitting after a transient host failure ──
  const avoid: string[] = []
  let queuedMs = 0
  let lastTransient: { status: number; retryAfterMs?: number; detail: string } | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let admit: AdmitResult
    try {
      admit = await gate.admit({ userId: auth.sub, model, cacheKey, pool: summary, caps, avoid })
    } catch (err) {
      // A client that hung up while queued takes its request down with it:
      // nothing to retry, nobody to answer.
      if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 })
      console.error('model gate unavailable', { message: (err as Error).message })
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * attempt)
        continue
      }
      await recordUsageSafe(c.env, { ...base, decision: 'error', error: 'gate_unavailable' })
      return c.json({ error: 'model_unavailable', detail: 'admission gate unavailable' }, 503, {
        'retry-after': '5'
      })
    }

    if (!admit.ok) {
      if (admit.reason === 'quota') {
        await recordUsageSafe(c.env, { ...base, decision: 'denied_quota' })
        return c.json(
          {
            error: 'quota_exceeded',
            scope: admit.scope,
            used: admit.used,
            cap: admit.cap,
            // The plan is part of the answer: "you are out" reads very
            // differently from "you are out, and you are on standard".
            plan: policy.plan
          },
          429
        )
      }
      if (admit.reason === 'no_upstream') {
        await recordUsageSafe(c.env, { ...base, decision: 'error', error: 'no_upstream' })
        return c.json({ error: 'model_unavailable', detail: `no host serves ${model}` }, 503, {
          'retry-after': '30'
        })
      }
      await recordUsageSafe(c.env, { ...base, decision: 'error', error: 'gate_overloaded' })
      return c.json({ error: 'model_busy', retry_after_ms: admit.retryAfterMs }, 503, {
        'retry-after': String(Math.ceil(admit.retryAfterMs / 1000))
      })
    }

    queuedMs += admit.waitedMs
    const upstream = pool.find((u) => u.id === admit.upstreamId) as Upstream
    const lease = admit.lease
    const release = (r: ReleaseReport) => gate.release(lease, r).catch(() => null)
    // Claim the grant: the gate reclaims an unclaimed slot within seconds,
    // which is what stops a vanished client's request from holding one. A
    // client already gone at this point releases at once.
    if (c.req.raw.signal?.aborted) {
      await release({ status: 'cancelled' })
      return new Response(null, { status: 499 })
    }
    c.executionCtx.waitUntil(gate.renew(lease).catch(() => false))
    // The heartbeat runs from admission, not from the first byte: a host
    // that thinks for minutes before answering (a non-streaming reasoning
    // call) must not have its slot reclaimed as abandoned meanwhile.
    const heartbeat = setInterval(() => {
      gate.renew(lease).catch(() => false)
    }, LEASE_RENEW_MS)
    const stop = () => clearInterval(heartbeat)
    const controller = new AbortController()
    const started = Date.now()

    let res: Response
    try {
      const wire = JSON.stringify({ ...body, model: admit.wireModel })
      res = await withTimeout(
        fetch(`${upstream.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${upstream.key}`
          },
          body: wire,
          signal: controller.signal
        }),
        stream ? STREAM_IDLE_MS : NONSTREAM_TIMEOUT_MS,
        () => controller.abort()
      )
    } catch (err) {
      stop()
      await release({ status: 'upstream_unreachable' })
      avoid.push(upstream.id)
      lastTransient = { status: 0, detail: (err as Error).message.slice(0, 200) }
      if (attempt < MAX_ATTEMPTS) continue
      break
    }
    const latencyMs = Date.now() - started

    if (!res.ok) {
      stop()
      const detail = (await res.text().catch(() => '')).slice(0, 500)
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
      const transient = res.status === 429 || res.status >= 500
      await release({
        status: res.status === 429 ? 'upstream_429' : transient ? 'upstream_5xx' : 'error',
        retryAfterMs
      })
      if (transient) {
        avoid.push(upstream.id)
        lastTransient = { status: res.status, retryAfterMs, detail }
        if (attempt < MAX_ATTEMPTS) continue
        break
      }
      await recordUsageSafe(c.env, {
        ...base,
        upstream: upstream.id,
        latencyMs,
        decision: 'error',
        error: `upstream_${res.status}`
      })
      return c.json({ error: 'upstream_error', status: res.status, detail }, 502)
    }

    const responseHeaders = {
      'x-wfc-upstream': upstream.id,
      'x-wfc-queue-ms': String(queuedMs)
    }

    // ── Non-streaming: one JSON body ───────────────────────────────────
    if (!stream) {
      let json: Record<string, unknown>
      try {
        json = await withTimeout(res.json<Record<string, unknown>>(), NONSTREAM_TIMEOUT_MS, () =>
          controller.abort()
        )
      } catch (err) {
        stop()
        await release({ status: 'error' })
        await recordUsageSafe(c.env, {
          ...base,
          upstream: upstream.id,
          latencyMs,
          decision: 'error',
          error: 'upstream_body_failed'
        })
        return c.json({ error: 'upstream_error', status: 502, detail: (err as Error).message }, 502)
      }
      stop()
      const usage = readUsage(json) ?? { in: 0, out: 0, cached: 0 }
      c.executionCtx.waitUntil(
        (async () => {
          await recordUsageSafe(c.env, {
            ...base,
            upstream: upstream.id,
            tokensIn: usage.in,
            tokensOut: usage.out,
            tokensCached: usage.cached,
            latencyMs,
            decision: 'allowed',
            upstreamCostUsd: usage.costUsd
          })
          await release({ status: 'ok', tokensIn: usage.in, tokensOut: usage.out })
        })()
      )
      return c.json(json, 200, responseHeaders)
    }

    // ── Streaming: the pump ────────────────────────────────────────────
    // Bytes go to the client untouched. The scanner sees each chunk on its
    // way through and remembers only the usage block. A client that goes
    // away is noticed at the next write: the upstream is aborted (so the
    // host stops generating and billing), what was seen is metered, and
    // the slot is released — all within the post-disconnect grace window.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const reader = res.body!.getReader()
    const scanner = new UsageScanner()
    const requestChars = text.length
    let clientGone = false
    const onClientAbort = () => {
      clientGone = true
      controller.abort()
    }
    c.req.raw.signal?.addEventListener('abort', onClientAbort, { once: true })

    const pump = (async () => {
      let status: ReleaseStatus = 'ok'
      let error: string | undefined
      try {
        while (true) {
          const next = await withTimeout(reader.read(), STREAM_IDLE_MS, () => controller.abort())
          if (next.done) break
          scanner.feed(next.value)
          try {
            await withTimeout(writer.write(next.value), CLIENT_STALL_MS, () => undefined)
          } catch {
            clientGone = true
            break
          }
        }
        if (!clientGone) {
          // close() resolves only once the client has drained the last
          // chunks; a client that stopped reading but kept its socket open
          // would hold this forever — and with it the slot.
          try {
            await withTimeout(writer.close(), CLIENT_STALL_MS, () => undefined)
          } catch {
            clientGone = true
          }
        }
        if (clientGone) {
          controller.abort()
          status = 'cancelled'
          error = 'client_cancelled'
          // Never awaited: aborting the writer of a stream whose reader is a
          // dead-but-open connection can itself never settle.
          void writer.abort('client disconnected').catch(() => undefined)
        }
      } catch (err) {
        controller.abort()
        if (clientGone) {
          status = 'cancelled'
          error = 'client_cancelled'
        } else {
          status = 'error'
          error = 'upstream_stream_failed'
        }
        void writer.abort((err as Error).message).catch(() => undefined)
      } finally {
        stop()
        c.req.raw.signal?.removeEventListener('abort', onClientAbort)
        // The host's own count when the stream completed; an estimate when
        // it did not (the host billed for what it generated, so the ledger
        // must not read zero). Marked in `error` so the row is honest.
        const usage = scanner.usage
        const tokensIn = usage?.in ?? Math.ceil(requestChars / 4)
        const tokensOut = usage?.out ?? scanner.chunks
        const tokensCached = usage?.cached ?? 0
        // Bookkeeping is bounded too: the lease TTL covers a lost release,
        // and a metering hiccup is logged by recordUsageSafe — neither may
        // keep this pump, and its slot, alive.
        await withTimeout(
          recordUsageSafe(c.env, {
            ...base,
            upstream: upstream.id,
            tokensIn,
            tokensOut,
            tokensCached,
            latencyMs,
            decision: 'allowed',
            error: usage ? error : (error ?? 'usage_missing_estimated'),
            upstreamCostUsd: usage?.costUsd
          }),
          BOOKKEEPING_MS,
          () => undefined
        ).catch(() => undefined)
        await withTimeout(release({ status, tokensIn, tokensOut }), BOOKKEEPING_MS, () => undefined).catch(
          () => undefined
        )
      }
    })()
    c.executionCtx.waitUntil(pump)

    return new Response(readable, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'text/event-stream',
        'cache-control': 'no-cache',
        ...responseHeaders
      }
    })
  }

  // Every host answered 429/5xx (or was unreachable) on every admission.
  // The hosts are resting inside the gate; the client's own retry ladder
  // takes it from here, told exactly how long to wait.
  const retryAfterMs = Math.max(2_000, lastTransient?.retryAfterMs ?? 5_000)
  await recordUsageSafe(c.env, {
    ...base,
    decision: 'error',
    error: lastTransient?.status ? `upstream_${lastTransient.status}` : 'upstream_unreachable'
  })
  return c.json(
    {
      error: 'model_busy',
      upstream_status: lastTransient?.status ?? null,
      detail: lastTransient?.detail ?? null,
      retry_after_ms: retryAfterMs
    },
    503,
    { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) }
  )
})

export default ai
