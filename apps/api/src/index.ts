/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, nine route groups (auth + pairing, v1 client API, devices,
 * bridge, ai router, search lane, sync, capabilities, admin), one middleware
 * chain: verify token → resolve user → resolve role → policy/quota gates →
 * handler. Plus three Durable Objects, exported here so the runtime can bind
 * them: the SearchGate (the org's single queue in front of its search
 * plans), the ModelGate (the org's single admission queue in front of its
 * model hosts) and the UserBridge (one per user — the live desktop↔phone
 * link that replaced the external relay).
 */
import { Hono } from 'hono'
import pkg from '../package.json'
import { landingPage } from '@/page'
import authRoutes from '@/routes/auth'
import meRoutes from '@/routes/me'
import adminRoutes from '@/routes/admin'
import aiRoutes from '@/routes/ai'
import syncRoutes from '@/routes/sync'
import capabilityRoutes from '@/routes/capabilities'
import searchRoutes from '@/routes/search'
import pairRoutes, { pairClaim } from '@/routes/pair'
import deviceRoutes from '@/routes/devices'
import bridgeRoutes from '@/routes/bridge'
import { SearchGate } from '@/lib/search-gate'
import { ModelGate } from '@/lib/model-gate'
import { UserBridge } from '@/lib/bridge'
import { runNightly } from '@/lib/nightly'

export { SearchGate, ModelGate, UserBridge }

export type Env = {
  DB: D1Database
  AUTH_KV: KVNamespace
  CONFIG_KV: KVNamespace
  BLOBS: R2Bucket
  SEARCH_GATE: DurableObjectNamespace<SearchGate>
  MODEL_GATE: DurableObjectNamespace<ModelGate>
  /** One per user: the live desktop↔phone link (see lib/bridge.ts). */
  USER_BRIDGE: DurableObjectNamespace<UserBridge>
  /**
   * Optional Expo push access token. Only needed when the Expo project has
   * "enhanced push security" switched on; the bridge sends pushes without it
   * otherwise.
   */
  EXPO_ACCESS_TOKEN?: string
  RESEND_API_KEY: string
  JWT_SECRET: string
  /**
   * 32 random bytes, base64 — seals every user's synced config row (their
   * integration credentials ride in it) at rest in D1. Absent: rows are
   * stored as plain JSON, exactly as before (see lib/config-crypto.ts).
   */
  CONFIG_ENC_KEY?: string
  /**
   * "1" lets an admin read a user's pending password-reset code
   * (GET /admin/users/:id/reset-code) — the release gate needs it to prove
   * the e-mail flow. A fork leaves it unset and the route answers 404.
   */
  ADMIN_RESET_CODE_READ?: string
  /**
   * The org's model hosts as a JSON list (see lib/upstreams.ts). Absent:
   * the single DeepInfra host below is the pool.
   */
  MODEL_UPSTREAMS?: string
  DEEPINFRA_API_KEY: string
  /** Override for tests/mocks; defaults to the real DeepInfra endpoint. */
  DEEPINFRA_BASE_URL?: string
  /** The account's concurrent-request limit per model (DeepInfra default 200). */
  DEEPINFRA_CONCURRENCY?: string
  /**
   * The org's search plans as a JSON list (see lib/search-gate.ts). Absent:
   * the single Brave plan below is the pool; no key at all = the lane
   * reports itself unconfigured.
   */
  SEARCH_PROVIDERS?: string
  BRAVE_API_KEY?: string
  /** Override for tests/mocks; defaults to the real Brave endpoint. */
  BRAVE_BASE_URL?: string
  /** The plan's per-second limit; the gate learns the real one from Brave's headers. */
  BRAVE_QPS?: string
}

const app = new Hono<{ Bindings: Env }>()

const API_VERSION = pkg.version

app.get('/', (c) =>
  c.html(landingPage(API_VERSION), 200, {
    'cache-control': 'public, max-age=300',
    'content-security-policy':
      "default-src 'none'; img-src https://cdn.wolffi.sh; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
  })
)

app.get('/health', (c) =>
  c.json({ ok: true, service: 'wfc-api', version: API_VERSION, time: new Date().toISOString() })
)

app.route('/auth', authRoutes)
app.route('/auth', pairClaim)
// The bridge mounts FIRST under /v1: its WebSocket door authenticates
// itself (a browser-style socket can only carry the token as a query
// parameter), and every other /v1 router installs the header-only
// requireAuth on '*' — which would answer the upgrade with a 401 before
// the door ever saw it.
app.route('/v1', bridgeRoutes)
app.route('/v1', meRoutes)
app.route('/v1', pairRoutes)
app.route('/v1', deviceRoutes)
app.route('/admin', adminRoutes)
app.route('/ai', aiRoutes)
app.route('/v1', syncRoutes)
app.route('/v1', capabilityRoutes)
app.route('/v1', searchRoutes)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error('unhandled', { message: err.message })
  return c.json({ error: 'internal' }, 500)
})

/**
 * Nightly tidy (see lib/nightly.ts): dead sessions, orphan blobs, purge of
 * deleted conversations, archive of idle conversations to R2, retirement of
 * raw usage rows past retention — each bounded, together inside the cron's
 * 15-minute allowance.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  await runNightly(env, Date.now())
}

export default { fetch: app.fetch, scheduled }
