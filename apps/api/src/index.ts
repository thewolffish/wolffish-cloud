/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, five route groups (auth, v1 client API, ai router, sync,
 * admin), one middleware chain: verify token → resolve user → resolve
 * role → policy/quota gates → handler.
 */
import { Hono } from 'hono'

export type Env = {
  DB: D1Database
  AUTH_KV: KVNamespace
  CONFIG_KV: KVNamespace
  BLOBS: R2Bucket
  JWT_SECRET: string
  DEEPINFRA_API_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) =>
  c.json({ ok: true, service: 'wfc-api', time: new Date().toISOString() })
)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error('unhandled', { message: err.message })
  return c.json({ error: 'internal' }, 500)
})

export default app
