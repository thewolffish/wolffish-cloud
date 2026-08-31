/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, five route groups (auth, v1 client API, ai router, sync,
 * admin), one middleware chain: verify token → resolve user → resolve
 * role → policy/quota gates → handler.
 */
import { Hono } from 'hono'
import pkg from '../package.json'
import { landingPage } from '@/page'
import authRoutes from '@/routes/auth'
import meRoutes from '@/routes/me'
import adminRoutes from '@/routes/admin'
import aiRoutes from '@/routes/ai'
import syncRoutes from '@/routes/sync'

export type Env = {
  DB: D1Database
  AUTH_KV: KVNamespace
  CONFIG_KV: KVNamespace
  BLOBS: R2Bucket
  JWT_SECRET: string
  DEEPINFRA_API_KEY: string
  /** Override for tests/mocks; defaults to the real DeepInfra endpoint. */
  DEEPINFRA_BASE_URL?: string
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

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error('unhandled', { message: err.message })
  return c.json({ error: 'internal' }, 500)
})

/** Nightly tidy: drop long-dead sessions (expiry itself is enforced live). */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  await env.DB.prepare('DELETE FROM device_sessions WHERE expires_at < ?1').bind(cutoff).run()
}

export default { fetch: app.fetch, scheduled }
