/**
 * wfc-api — the Wolffish Cloud master API.
 *
 * One Worker, seven route groups (auth, v1 client API, ai router, search
 * lane, sync, capabilities, admin), one middleware chain: verify token →
 * resolve user → resolve role → policy/quota gates → handler. Plus one
 * Durable Object, the SearchGate — the org's single queue in front of
 * Brave, exported here so the runtime can bind it.
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

export { SearchGate }

export type Env = {
  DB: D1Database
  AUTH_KV: KVNamespace
  CONFIG_KV: KVNamespace
  BLOBS: R2Bucket
  SEARCH_GATE: DurableObjectNamespace<SearchGate>
  RESEND_API_KEY: string
  JWT_SECRET: string
  DEEPINFRA_API_KEY: string
  /** Override for tests/mocks; defaults to the real DeepInfra endpoint. */
  DEEPINFRA_BASE_URL?: string
  /** The org's Brave Search key. Absent = the search lane reports itself unconfigured. */
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

const DAY_MS = 86_400_000

/**
 * Nightly tidy: drop long-dead sessions (expiry itself is enforced live) and
 * collect the blobs nothing references any more.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const now = Date.now()
  const cutoff = new Date(now - 30 * DAY_MS).toISOString()
  await env.DB.prepare('DELETE FROM device_sessions WHERE expires_at < ?1').bind(cutoff).run()
  await collectOrphanBlobs(env, now)
  await purgeDeletedConversationRecords(env, now)
}

/**
 * A deleted conversation keeps its tombstone row forever (a stale device
 * replaying the conversation must still be refused), but its transcript
 * records — the bulk — go 30 days after the delete. "Wipe my data" is a
 * real wipe a month later, and the records table stops growing with what
 * nobody can read any more. Bounded per run; the backlog drains nightly.
 */
async function purgeDeletedConversationRecords(env: Env, now: number): Promise<void> {
  const stale = new Date(now - 30 * DAY_MS).toISOString()
  const doomed = await env.DB.prepare(
    `SELECT c.id FROM conversations c
     WHERE c.deleted_at IS NOT NULL AND c.deleted_at < ?1
       AND EXISTS (SELECT 1 FROM conversation_records r WHERE r.conversation_id = c.id)
     LIMIT 200`
  )
    .bind(stale)
    .all<{ id: string }>()
  const ids = (doomed.results ?? []).map((r) => r.id)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    await env.DB.prepare(
      `DELETE FROM conversation_records
       WHERE conversation_id IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
    )
      .bind(...chunk)
      .run()
  }
}

/**
 * Blob garbage collection. A file row is tombstoned when its path is
 * deleted, wiped, or superseded by newer content, but the content-addressed
 * blob stays until NO live row (any user) and no avatar references it — and
 * even then it waits a day, so a sweep that deduped against the object
 * minutes ago can't lose it. Rows of a collected blob go with it (the
 * tombstone has done its job: a re-upload simply inserts), and tombstones
 * whose blob lives on elsewhere are dropped after 30 days. Bounded per run;
 * the backlog drains over successive nights.
 */
async function collectOrphanBlobs(env: Env, now: number): Promise<void> {
  const grace = new Date(now - DAY_MS).toISOString()
  const orphans = await env.DB.prepare(
    `SELECT sha256 FROM files GROUP BY sha256
     HAVING SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) = 0 AND MAX(deleted_at) < ?1
     LIMIT 500`
  )
    .bind(grace)
    .all<{ sha256: string }>()
  const avatars = new Set(
    ((await env.DB.prepare('SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL').all<{
      avatar_key: string
    }>()).results ?? []).map((r) => r.avatar_key)
  )
  const doomed = (orphans.results ?? []).map((r) => r.sha256).filter((s) => !avatars.has(s))
  if (doomed.length) {
    await env.BLOBS.delete(doomed.map((s) => `files/${s}`))
    for (let i = 0; i < doomed.length; i += 90) {
      const chunk = doomed.slice(i, i + 90)
      await env.DB.prepare(
        `DELETE FROM files WHERE deleted_at IS NOT NULL
         AND sha256 IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
      )
        .bind(...chunk)
        .run()
    }
  }
  const stale = new Date(now - 30 * DAY_MS).toISOString()
  await env.DB.prepare('DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?1')
    .bind(stale)
    .run()
}

export default { fetch: app.fetch, scheduled }
