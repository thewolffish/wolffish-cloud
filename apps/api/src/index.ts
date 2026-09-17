/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, eleven route groups (auth + pairing, v1 client API, devices,
 * bridge, ai router, search lane, sync, capabilities, leaderboard, admin,
 * the CI publish lane), one middleware
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
import publishRoutes from '@/routes/publish'
import searchRoutes from '@/routes/search'
import leaderboardRoutes from '@/routes/leaderboard'
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
   * Expo push access token — REQUIRED for phone notifications.
   *
   * The Expo account this org's mobile app belongs to has Enhanced Security
   * for Push Notifications switched on, so exp.host answers 401 to any send
   * without this header: no token is not "degraded push", it is no push at
   * all, for every user, while the desktop and the model go on reporting that
   * notifications were sent. `GET /admin/gates` reports `push.configured`
   * for exactly this reason, and lib/expo-push.ts logs an auth failure as its
   * own distinct error rather than as transport noise.
   *
   * Mint one at https://expo.dev/settings/access-tokens, then:
   *   npx wrangler secret put EXPO_ACCESS_TOKEN
   *
   * Typed optional because the binding genuinely can be absent — in-band
   * delivery to a phone that is on screen keeps working without it.
   */
  EXPO_ACCESS_TOKEN?: string
  /**
   * Where the Expo push API lives. Unset everywhere but the local smoke lane,
   * which points it at scripts/mock-expo.mjs — a deployment that sets this is
   * sending its users' notifications somewhere other than Expo.
   */
  EXPO_PUSH_BASE?: string
  /**
   * Milliseconds between a push send and its receipt sweep, in place of the
   * fifteen minutes Expo recommends. Local smoke lane only — a deployment
   * that shortens this asks Expo for receipts that do not exist yet.
   */
  PUSH_SWEEP_DELAY_MS?: string
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
   * The CI publish key (see routes/publish.ts). Set it and `/publish/*`
   * accepts `authorization: Bearer <this>` for org capability writes and
   * nothing else — which is how a push to main mirrors `capabilities/`
   * into the registry without handing the pipeline an owner session.
   * Absent — the default — and the whole lane answers 404.
   *   openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
   */
  PUBLISH_TOKEN?: string
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
app.route('/v1', leaderboardRoutes)
// Its own door, not a sub-path of /admin: the whole point is a key that
// publishes capabilities and cannot do anything else (routes/publish.ts).
app.route('/publish', publishRoutes)

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
