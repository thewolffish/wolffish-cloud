/**
 * The router — the reason the choke point exists.
 *
 * POST /ai/v1/chat/completions, OpenAI-compatible, so the desktop's
 * provider layer points here with the session token as its bearer.
 * Chain: session → allowlist → quota → forward to DeepInfra → stream
 * back → meter (usage row + KV counters) after the response finishes.
 *
 * Privacy: nothing identity-shaped is sent upstream — the outbound
 * request is model + messages + params with the org's key. Prompt
 * content is never logged or stored here; only metering metadata is.
 */
import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '../middleware/auth'
import {
  bumpQuota,
  getEffectivePolicy,
  getOrgConfig,
  modelAllowed,
  quotaStanding
} from '../lib/policy'
import { costMicroUsd } from '../lib/models'
import type { Env } from '../index'

const DEEPINFRA_DEFAULT_BASE = 'https://api.deepinfra.com/v1/openai'

const ai = new Hono<{ Bindings: Env & { DEEPINFRA_BASE_URL?: string }; Variables: AuthVars }>()

ai.use('*', requireAuth)

type Meter = {
  userId: string
  deviceId: string
  model: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  decision: 'allowed' | 'denied_model' | 'denied_quota' | 'error'
  error?: string
}

async function meter(env: Env, m: Meter): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (user_id, device_id, model, tokens_in, tokens_out, cost_microusd,
       latency_ms, decision, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      m.userId,
      m.deviceId,
      m.model,
      m.tokensIn,
      m.tokensOut,
      costMicroUsd(m.model, m.tokensIn, m.tokensOut),
      m.latencyMs,
      m.decision,
      m.error ?? null
    )
    .run()
  if (m.decision === 'allowed') await bumpQuota(env, m.userId, m.tokensIn + m.tokensOut)
}

/** Pull `usage` out of a completed SSE body (final chunk carries it). */
function usageFromSse(text: string): { in: number; out: number } {
  let usage = { in: 0, out: 0 }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      if (obj?.usage) {
        usage = {
          in: obj.usage.prompt_tokens ?? 0,
          out: obj.usage.completion_tokens ?? 0
        }
      }
    } catch {
      // partial or non-JSON keepalive line — ignore
    }
  }
  return usage
}

ai.post('/v1/chat/completions', async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  const model = typeof body?.model === 'string' ? body.model : ''
  if (!body || !model) return c.json({ error: 'invalid_request', detail: 'model required' }, 400)

  const org = await getOrgConfig(c.env)
  if (!org) return c.json({ error: 'org_not_provisioned' }, 500)
  const policy = await getEffectivePolicy(c.env, auth.sub)

  if (!modelAllowed(model, policy, org)) {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      model,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      decision: 'denied_model'
    })
    return c.json(
      {
        error: 'model_not_allowed',
        allowed: policy.allowed.length > 0 ? policy.allowed : [org.default_model],
        default_model: org.default_model
      },
      403
    )
  }

  const quota = await quotaStanding(c.env, auth.sub, policy, org)
  if (!quota.ok) {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      model,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      decision: 'denied_quota'
    })
    return c.json(
      { error: 'quota_exceeded', scope: quota.scope, used: quota.used, cap: quota.cap },
      429
    )
  }

  const stream = body.stream === true
  if (stream) {
    // Usage arrives in the final SSE chunk only when asked for.
    body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }
  }

  const base = c.env.DEEPINFRA_BASE_URL || DEEPINFRA_DEFAULT_BASE
  const started = Date.now()
  let upstream: Response
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.env.DEEPINFRA_API_KEY}`
      },
      body: JSON.stringify(body)
    })
  } catch (err) {
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      model,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: Date.now() - started,
      decision: 'error',
      error: 'upstream_unreachable'
    })
    return c.json({ error: 'upstream_unreachable' }, 502)
  }
  const latencyMs = Date.now() - started

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500)
    await meter(c.env, {
      userId: auth.sub,
      deviceId: auth.dev,
      model,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs,
      decision: 'error',
      error: `upstream_${upstream.status}`
    })
    return c.json({ error: 'upstream_error', status: upstream.status, detail }, 502)
  }

  if (!stream) {
    const json = await upstream.json<Record<string, any>>()
    const tokensIn = json?.usage?.prompt_tokens ?? 0
    const tokensOut = json?.usage?.completion_tokens ?? 0
    c.executionCtx.waitUntil(
      meter(c.env, {
        userId: auth.sub,
        deviceId: auth.dev,
        model,
        tokensIn,
        tokensOut,
        latencyMs,
        decision: 'allowed'
      })
    )
    return c.json(json)
  }

  // Stream: hand one branch to the client untouched, read the other to
  // meter once the stream completes.
  const [toClient, toMeter] = upstream.body!.tee()
  c.executionCtx.waitUntil(
    (async () => {
      const text = await new Response(toMeter).text()
      const usage = usageFromSse(text)
      await meter(c.env, {
        userId: auth.sub,
        deviceId: auth.dev,
        model,
        tokensIn: usage.in,
        tokensOut: usage.out,
        latencyMs,
        decision: 'allowed'
      })
    })()
  )
  return new Response(toClient, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache'
    }
  })
})

export default ai
