/**
 * Capabilities, client surface — what makes the installed capability set a
 * mere cache of the org.
 *
 * The manifest is the whole sync contract: org capabilities every client
 * must mirror, plus the caller's own user-scoped imports. Clients diff it
 * against local state — download what's new or changed, remove what's
 * absent — so admin add/update/remove propagates on the next pull with no
 * per-client bookkeeping server-side.
 *
 * Users manage only their own scope here (PUT/DELETE under /user/). The
 * org scope mutates exclusively through /admin/capabilities (admin.ts).
 */
import { Hono } from 'hono'
import { deleteCapability, manifestEntry, putCapability, servePackage, type CapabilityRow } from '@/lib/capabilities'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import type { Env } from '@/index'

const capabilities = new Hono<{ Bindings: Env; Variables: AuthVars }>()

capabilities.use('*', requireAuth)

capabilities.get('/capabilities/manifest', async (c) => {
  const auth = c.get('auth')
  const [org, user] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM capabilities WHERE scope = 'org' AND deleted_at IS NULL ORDER BY slug`
    ).all<CapabilityRow>(),
    c.env.DB.prepare(
      `SELECT * FROM capabilities WHERE scope = 'user' AND owner_user_id = ?1 AND deleted_at IS NULL ORDER BY slug`
    )
      .bind(auth.sub)
      .all<CapabilityRow>()
  ])
  return c.json({
    org: (org.results ?? []).map(manifestEntry),
    user: (user.results ?? []).map(manifestEntry)
  })
})

capabilities.get('/capabilities/org/:slug/package', (c) =>
  servePackage(c, 'org', '', c.req.param('slug'))
)

capabilities.get('/capabilities/user/:slug/package', (c) =>
  servePackage(c, 'user', c.get('auth').sub, c.req.param('slug'))
)

capabilities.put('/capabilities/user/:slug', (c) => {
  const auth = c.get('auth')
  return putCapability(c, 'user', auth.sub, c.req.param('slug'), auth.sub)
})

capabilities.delete('/capabilities/user/:slug', (c) =>
  deleteCapability(c, 'user', c.get('auth').sub, c.req.param('slug'))
)

export default capabilities
