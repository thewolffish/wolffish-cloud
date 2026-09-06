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
import {
  deleteCapability,
  manifestEntry,
  putCapability,
  servePackage,
  type CapabilityRow,
  type CapabilitySubject
} from '@/lib/capabilities'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import type { Env } from '@/index'

const capabilities = new Hono<{ Bindings: Env; Variables: AuthVars }>()

capabilities.use('*', requireAuth)

/** Who this caller is, for grant matching. One row, once per manifest. */
async function subjectOf(c: {
  env: Env
  get: (k: 'auth') => { sub: string; role: string }
}): Promise<CapabilitySubject> {
  const auth = c.get('auth')
  const row = await c.env.DB.prepare('SELECT role, team FROM users WHERE id = ?1')
    .bind(auth.sub)
    .first<{ role: string; team: string }>()
  return { userId: auth.sub, role: row?.role ?? auth.role, team: row?.team ?? '' }
}

capabilities.get('/capabilities/manifest', async (c) => {
  const auth = c.get('auth')
  const who = await subjectOf(c)
  const [org, user] = await Promise.all([
    // Org capabilities this caller may have: ungranted ones are everyone's,
    // granted ones only reach the roles, teams and people they name.
    c.env.DB.prepare(
      `SELECT c.* FROM capabilities c
       WHERE c.scope = 'org' AND c.deleted_at IS NULL
         AND (NOT EXISTS (SELECT 1 FROM capability_grants g WHERE g.slug = c.slug)
              OR EXISTS (
                SELECT 1 FROM capability_grants g WHERE g.slug = c.slug AND (
                     (g.subject_kind = 'role' AND g.subject = ?2)
                  OR (g.subject_kind = 'team' AND g.subject = ?3 AND ?3 != '')
                  OR (g.subject_kind = 'user' AND g.subject = ?1))))
       ORDER BY c.slug`
    ).bind(who.userId, who.role, who.team).all<CapabilityRow>(),
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

capabilities.get('/capabilities/org/:slug/package', async (c) =>
  servePackage(c, 'org', '', c.req.param('slug'), await subjectOf(c))
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
