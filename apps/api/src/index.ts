/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, seven route groups (auth, v1 client API, ai router, search
 * lane, sync, capabilities, admin), one middleware chain: verify token →
 * resolve user → resolve role → policy/quota gates → handler. Plus two
 * Durable Objects, exported here so the runtime can bind them: the
 * SearchGate (the org's single queue in front of its search plans) and the
 * ModelGate (the org's single admission queue in front of its model hosts).
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
import { SearchGate } from '@/lib/search-gate'
import { ModelGate } from '@/lib/model-gate'
import { runNightly } from '@/lib/nightly'

export { SearchGate, ModelGate }

export type Env = {
  DB: D1Database
  AUTH_KV: KVNamespace
  CONFIG_KV: KVNamespace
  BLOBS: R2Bucket
  SEARCH_GATE: DurableObjectNamespace<SearchGate>
  MODEL_GATE: DurableObjectNamespace<ModelGate>
  RESEND_API_KEY: string
  JWT_SECRET: string
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
app.route('/v1', meRoutes)
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
