/**
 * Capability registry helpers — shared by the client surface
 * (routes/capabilities.ts) and the admin surface (routes/admin.ts).
 *
 * A capability travels as ONE zip package: SKILL.md at the root plus
 * whatever the skill ships (plugin/, assets, package.json — never
 * node_modules, clients reinstall those). The bucket keeps every version
 * (capabilities/org/<slug>/v<n>.zip, capabilities/user/<uid>/<slug>/v<n>.zip);
 * the D1 row points at the latest.
 *
 * Validation here is the org-wide blast-radius gate: a package an admin
 * uploads lands on every device, so beyond sha256 integrity we parse the
 * zip's central directory (names only, no inflate) to prove there is a
 * root SKILL.md and no path that could escape an extraction dir.
 */
import type { Context } from 'hono'
import { newId, toHex } from '@/lib/crypto'
import type { Env } from '@/index'

/** Who is asking for an org capability — matched against capability_grants. */
export type CapabilitySubject = { userId: string; role: string; team: string }

/**
 * Grant semantics: a capability with NO grant rows is open to the whole org
 * (which is what every row meant before grants existed, so nothing changes
 * until an admin says otherwise); one with grants reaches only the subjects
 * they name. The manifest applies the same rule in SQL — keep them in step.
 */
export async function isGranted(
  env: Env,
  slug: string,
  who: CapabilitySubject
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM capability_grants WHERE slug = ?1) AS total,
       (SELECT COUNT(*) FROM capability_grants WHERE slug = ?1 AND (
            (subject_kind = 'role' AND subject = ?2)
         OR (subject_kind = 'team' AND subject = ?3 AND ?3 != '')
         OR (subject_kind = 'user' AND subject = ?4))) AS mine`
  )
    .bind(slug, who.role, who.team, who.userId)
    .first<{ total: number; mine: number }>()
  return (row?.total ?? 0) === 0 || (row?.mine ?? 0) > 0
}

export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 5000
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type CapabilityScope = 'org' | 'user'

export type CapabilityRow = {
  id: string
  scope: CapabilityScope
  owner_user_id: string
  slug: string
  name: string
  description: string
  version: number
  sha256: string
  size: number
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

export function packageKey(scope: CapabilityScope, ownerUserId: string, slug: string, version: number): string {
  return scope === 'org'
    ? `capabilities/org/${slug}/v${version}.zip`
    : `capabilities/user/${ownerUserId}/${slug}/v${version}.zip`
}

/** Manifest/wire projection — everything a client needs to diff and pull. */
export function manifestEntry(row: CapabilityRow): Record<string, unknown> {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    sha256: row.sha256,
    size: row.size,
    updated_at: row.updated_at
  }
}

/**
 * Walk the zip central directory and return entry names, or a human
 * -readable refusal. Names-only parsing: signatures and lengths are
 * fixed-offset, so no decompression and no dependency. Zip64 is refused
 * outright — a legitimate capability is nowhere near 4 GB or 65k files.
 */
function zipEntryNames(bytes: Uint8Array): string[] | { error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // End-of-central-directory: scan back over the (bounded) trailing comment.
  const min = Math.max(0, bytes.byteLength - 22 - 65_535)
  let eocd = -1
  for (let i = bytes.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { error: 'not a zip archive' }
  const total = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (total === 0) return { error: 'zip is empty' }
  if (total > MAX_PACKAGE_ENTRIES) return { error: `too many files (limit ${MAX_PACKAGE_ENTRIES})` }
  if (cdOffset === 0xffffffff || total === 0xffff) return { error: 'zip64 archives are not supported' }

  const names: string[] = []
  let p = cdOffset
  const decoder = new TextDecoder()
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) {
      return { error: 'corrupt central directory' }
    }
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** Structural gate for an uploaded package. Null means acceptable. */
export function packageProblem(bytes: Uint8Array): string | null {
  const names = zipEntryNames(bytes)
  if (!Array.isArray(names)) return names.error
  let rootSkills = 0
  for (const name of names) {
    if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes(':')) {
      return `unsafe entry path "${name}"`
    }
    if (name.split('/').some((seg) => seg === '..')) {
      return `unsafe entry path "${name}"`
    }
    if (!name.includes('/') && name.toLowerCase() === 'skill.md') rootSkills++
  }
  if (rootSkills !== 1) {
    return rootSkills === 0 ? 'package has no root SKILL.md' : 'package has multiple SKILL.md files'
  }
  return null
}

/**
 * The one upload path, org and user scope alike: verify the address
 * (sha256 query param) against the actual bytes, gate the structure, put
 * the versioned object, then move the row to it. Object-before-row order:
 * a failed D1 write can orphan one zip (harmless), the row can never point
 * at bytes that don't exist.
 */
export async function putCapability<E extends { Bindings: Env }>(
  c: Context<E>,
  scope: CapabilityScope,
  ownerUserId: string,
  slug: string,
  actorUserId: string
): Promise<Response> {
  if (!validSlug(slug)) {
    return c.json({ error: 'invalid_request', detail: 'slug must match ^[a-z0-9][a-z0-9_-]{0,63}$' }, 400)
  }
  const sha256 = (c.req.query('sha256') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return c.json({ error: 'invalid_request', detail: 'sha256 query param required' }, 400)
  }
  const name = (c.req.query('name') ?? slug).slice(0, 200)
  const description = (c.req.query('description') ?? '').slice(0, 1000)

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'empty_body' }, 400)
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return c.json({ error: 'too_large' }, 413)

  const actual = toHex(await crypto.subtle.digest('SHA-256', bytes))
  if (actual !== sha256) return c.json({ error: 'hash_mismatch', actual }, 400)

  const problem = packageProblem(bytes)
  if (problem) return c.json({ error: 'invalid_package', detail: problem }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT id, version FROM capabilities WHERE scope = ?1 AND owner_user_id = ?2 AND slug = ?3'
  )
    .bind(scope, ownerUserId, slug)
    .first<{ id: string; version: number }>()
  const version = existing ? existing.version + 1 : 1
  const now = new Date().toISOString()

  await c.env.BLOBS.put(packageKey(scope, ownerUserId, slug, version), bytes)

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE capabilities SET name = ?1, description = ?2, version = ?3, sha256 = ?4, size = ?5,
         updated_by = ?6, updated_at = ?7, deleted_at = NULL WHERE id = ?8`
    )
      .bind(name, description, version, sha256, bytes.byteLength, actorUserId, now, existing.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO capabilities
         (id, scope, owner_user_id, slug, name, description, version, sha256, size, updated_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
    )
      .bind(newId('cap'), scope, ownerUserId, slug, name, description, version, sha256, bytes.byteLength, actorUserId, now)
      .run()
  }
  return c.json({ ok: true, slug, version, sha256, size: bytes.byteLength })
}

/** Tombstone the latest row; R2 keeps the version history. */
export async function deleteCapability<E extends { Bindings: Env }>(
  c: Context<E>,
  scope: CapabilityScope,
  ownerUserId: string,
  slug: string
): Promise<Response> {
  const res = await c.env.DB.prepare(
    `UPDATE capabilities SET deleted_at = ?1, updated_at = ?1
     WHERE scope = ?2 AND owner_user_id = ?3 AND slug = ?4 AND deleted_at IS NULL`
  )
    .bind(new Date().toISOString(), scope, ownerUserId, slug)
    .run()
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
}

/** Stream the latest package for a live (non-deleted) capability. */
export async function servePackage<E extends { Bindings: Env }>(
  c: Context<E>,
  scope: CapabilityScope,
  ownerUserId: string,
  slug: string,
  /** For org scope: who is asking, so a grant can be checked. Omitted =
   *  no grant check (the admin's own reads). */
  reader?: CapabilitySubject
): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM capabilities
     WHERE scope = ?1 AND owner_user_id = ?2 AND slug = ?3 AND deleted_at IS NULL`
  )
    .bind(scope, ownerUserId, slug)
    .first<CapabilityRow>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  // A capability the manifest would not list must not be downloadable by
  // guessing its slug — the grant is the gate, not the listing.
  if (scope === 'org' && reader && !(await isGranted(c.env, slug, reader))) {
    return c.json({ error: 'not_found' }, 404)
  }
  const obj = await c.env.BLOBS.get(packageKey(scope, ownerUserId, slug, row.version))
  if (!obj) return c.json({ error: 'blob_missing' }, 404)
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(obj.size),
      etag: row.sha256,
      'x-capability-version': String(row.version)
    }
  })
}
