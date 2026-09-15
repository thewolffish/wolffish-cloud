/**
 * The publish lane — how a git push becomes the org registry.
 *
 * `capabilities/` in the repo is the single editing path for org
 * capabilities, and a push to main is what moves it into the registry
 * (.github/workflows/ci.yml). That pipeline needs to write capabilities
 * and nothing else, so it does NOT come in through /admin: the admin
 * surface authenticates a *person* — an owner or admin session that can
 * also read transcripts, reset passwords and mint activation codes — and
 * a CI secret with those powers is a much larger thing to lose than a
 * publish key.
 *
 * So this is a second, deliberately tiny door: bearer PUBLISH_TOKEN, four
 * routes, org capability scope only. Absent secret = the whole lane
 * answers 404, the same opt-in shape as ADMIN_RESET_CODE_READ, so a fork
 * that never sets it has no extra door at all.
 *
 * Two deliberate differences from the admin path, both of which make this
 * the more correct publisher:
 *
 *  - The manifest here is the registry as it IS — every live org row,
 *    unfiltered. The client manifest (routes/capabilities.ts) filters by
 *    capability_grants, which is right for a device and wrong for a
 *    publisher: a capability granted to a team the publishing account is
 *    not in would read as "not in the registry", so every run would
 *    re-upload it and --check would report drift that isn't there.
 *  - Package downloads skip the grant check too (the round-trip proof in
 *    seed-capabilities.mjs re-reads what it just wrote).
 *
 * Writes are audited like any other mutation, with `ci:publish` as the
 * actor, so the admin audit view shows pipeline pushes beside human ones.
 */
import { Hono } from 'hono'
import { audit } from '@/lib/audit'
import {
  deleteCapability,
  manifestEntry,
  putCapability,
  servePackage,
  type CapabilityRow
} from '@/lib/capabilities'
import type { Env } from '@/index'

const publish = new Hono<{ Bindings: Env }>()

/** Who the audit log names for a pipeline push. Not a user id by design. */
export const PUBLISH_ACTOR = 'ci:publish'

const sha256 = async (s: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

/**
 * Compare two secrets without leaking their length or prefix through
 * timing: hash both to fixed-width digests, then diff every byte.
 */
const sameSecret = async (a: string, b: string): Promise<boolean> => {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  // Both digests are 32 bytes, so the fallback below is unreachable; it is
  // there because it fails closed and keeps the index checker happy.
  let diff = da.length ^ db.length
  for (const [i, byte] of da.entries()) diff |= byte ^ (db[i] ?? 0xff)
  return diff === 0
}

publish.use('*', async (c, next) => {
  const expected = c.env.PUBLISH_TOKEN ?? ''
  // No token configured: this deployment has no publish lane. 404 rather
  // than 401 — an unset feature should not advertise itself.
  if (!expected) return c.json({ error: 'not_found' }, 404)
  const header = c.req.header('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!presented || !(await sameSecret(presented, expected))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

/** The registry as it is: every live org capability, no grant filtering. */
publish.get('/capabilities', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM capabilities WHERE scope = 'org' AND deleted_at IS NULL ORDER BY slug`
  ).all<CapabilityRow>()
  return c.json({ org: (rows.results ?? []).map(manifestEntry) })
})

publish.put('/capabilities/:slug', async (c) => {
  const slug = c.req.param('slug')
  const res = await putCapability(c, 'org', '', slug, PUBLISH_ACTOR)
  if (res.status === 200) {
    await audit(c.env, PUBLISH_ACTOR, 'capability.put', slug, { sha256: c.req.query('sha256') })
  }
  return res
})

publish.delete('/capabilities/:slug', async (c) => {
  const slug = c.req.param('slug')
  const res = await deleteCapability(c, 'org', '', slug)
  if (res.status === 200) await audit(c.env, PUBLISH_ACTOR, 'capability.delete', slug)
  return res
})

/** Read back what was just written — the publisher's round-trip proof. */
publish.get('/capabilities/:slug/package', (c) =>
  servePackage(c, 'org', '', c.req.param('slug'))
)

export default publish
