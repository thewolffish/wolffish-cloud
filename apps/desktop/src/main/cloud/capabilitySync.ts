/**
 * Capability sync — what makes brain/cerebellum a mere cache of the org
 * registry.
 *
 * The server's manifest is the source of truth, one pull per pass:
 *
 *   org scope  → dot-prefixed folders (.git, .browser, …), the "official"
 *                set. Mirrored exactly: new/changed packages download and
 *                swap in, slugs absent from the manifest are removed —
 *                which also retires leftovers from the old bundled era.
 *   user scope → plain folders, this member's own imports. Two-way: local
 *                imports/edits push (content-addressed, so unchanged
 *                folders cost one hash), remote adds/updates/deletes from
 *                the user's other devices pull.
 *
 * A pass is silent and boring by design: fires on session ready, after an
 * import/delete, and on a slow interval; downloads stage off to the side;
 * the actual folder swaps — the only disruptive moment — happen ONLY when
 * no agent runs are active, else the pass parks and retries. Deletes made
 * while offline persist in the state file (pendingDeletes) until the
 * server confirms, so a dropped connection never resurrects a capability.
 *
 * State lives in <cerebellum>/.wfc-caps.json: per-slug {version, sha256}
 * for both scopes. Packages hash deterministically (capabilityPack), so
 * "sha matches and the folder exists" is the whole up-to-date check.
 *
 * node_modules survive swaps: packages never contain them, and the
 * cerebellum's lazy npm install (keyed on package.json hash markers)
 * rebuilds them only when an update actually changed dependencies.
 *
 * Electron-free: deps are injected (index.ts wires the real session,
 * runs-gate and reload hook), so the engine tests headless against a
 * local HTTP server.
 */
import { extractPackage, packCapability, sha256Hex } from '@main/cloud/capabilityPack'
import { parseSkillMd } from '@main/runtime/capabilityImport'
import fs from 'node:fs/promises'
import path from 'node:path'

const STATE_FILE = '.wfc-caps.json'
const STAGING_DIR = '.capability-staging'
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SHA_RE = /^[0-9a-f]{64}$/
const INTERVAL_MS = 30 * 60_000
const RETRY_MS = 60_000
const TRIGGER_DEBOUNCE_MS = 2_000

export type CapabilitySyncDeps = {
  apiBase: string
  withAccessToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>
  /** Absolute path of <workspace>/brain/cerebellum. */
  cerebellumDir: () => string
  /** True while any agent turn or autonomous run is in flight. */
  runsActive: () => boolean
  /** Called once after a pass that changed folders (reload + broadcast). */
  onApplied: () => Promise<void>
  log?: (message: string) => void
}

export type CapabilitySyncOutcome = {
  ok: boolean
  /** Folder swaps were ready but runs were active; a retry is scheduled. */
  deferred?: boolean
  pushed: number
  pulled: number
  removed: number
  reason?: string
}

type CapState = { version: number; sha256: string }
type SyncState = {
  org: Record<string, CapState>
  user: Record<string, CapState>
  pendingDeletes: string[]
}
type ManifestEntry = { slug: string; version: number; sha256: string; size: number }

let deps: CapabilitySyncDeps | null = null
let syncing = false
let pendingTimer: NodeJS.Timeout | null = null
let interval: NodeJS.Timeout | null = null

const log = (message: string): void => deps?.log?.(`[caps] ${message}`)

export function initCapabilitySync(d: CapabilitySyncDeps): void {
  deps = d
  if (!interval) {
    interval = setInterval(() => scheduleCapabilitySync(0), INTERVAL_MS)
    interval.unref?.()
  }
}

/** Debounced trigger — session ready, post-import, post-delete, interval. */
export function scheduleCapabilitySync(delayMs: number = TRIGGER_DEBOUNCE_MS): void {
  if (!deps) return
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void syncCapabilitiesNow().then((out) => {
      if (out.deferred) scheduleCapabilitySync(RETRY_MS)
    })
  }, delayMs)
  pendingTimer.unref?.()
}

/**
 * Record that the user deleted one of their own capabilities, so the next
 * pass propagates it (and never re-downloads it in the meantime).
 */
export async function queueUserCapabilityDelete(slug: string): Promise<void> {
  if (!deps || !SLUG_RE.test(slug)) return
  const dir = deps.cerebellumDir()
  const state = await loadState(dir)
  if (!state.pendingDeletes.includes(slug)) state.pendingDeletes.push(slug)
  await saveState(dir, state)
  scheduleCapabilitySync()
}

// ── State file ───────────────────────────────────────────────────────────

const emptyState = (): SyncState => ({ org: {}, user: {}, pendingDeletes: [] })

function validCapState(v: unknown): v is CapState {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as CapState).version === 'number' &&
    SHA_RE.test(String((v as CapState).sha256))
  )
}

async function loadState(dir: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, STATE_FILE), 'utf8')) as SyncState
    const clean = emptyState()
    for (const scope of ['org', 'user'] as const) {
      for (const [slug, v] of Object.entries(raw[scope] ?? {})) {
        if (SLUG_RE.test(slug) && validCapState(v))
          clean[scope][slug] = { version: v.version, sha256: v.sha256 }
      }
    }
    clean.pendingDeletes = (raw.pendingDeletes ?? []).filter((s) => SLUG_RE.test(String(s)))
    return clean
  } catch {
    return emptyState()
  }
}

async function saveState(dir: string, state: SyncState): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2))
}

// ── Wire helpers ─────────────────────────────────────────────────────────

async function apiFetch(method: string, route: string, body?: Buffer): Promise<Response> {
  const d = deps!
  return d.withAccessToken(async (token) => {
    const res = await fetch(`${d.apiBase}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(120_000)
    })
    return res
  })
}

// ── Local scans ──────────────────────────────────────────────────────────

async function listCapabilityDirs(dir: string): Promise<{ plain: string[]; dotted: string[] }> {
  const plain: string[] = []
  const dotted: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { plain, dotted }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) dotted.push(entry.name)
    else plain.push(entry.name)
  }
  return { plain, dotted }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** name/description for an upload, straight from the SKILL.md frontmatter. */
async function capabilityMeta(
  capDir: string,
  slug: string
): Promise<{ name: string; description: string }> {
  try {
    const raw = await fs.readFile(path.join(capDir, 'SKILL.md'), 'utf8')
    const { frontmatter } = parseSkillMd(raw)
    return {
      name:
        typeof frontmatter?.name === 'string' && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : slug,
      description: typeof frontmatter?.description === 'string' ? frontmatter.description : ''
    }
  } catch {
    return { name: slug, description: '' }
  }
}

// ── Apply (the only disruptive part) ─────────────────────────────────────

/** Refuse to rm anything that isn't a direct child capability folder. */
async function guardedRemove(cerebellumDir: string, target: string): Promise<void> {
  const rel = path.relative(cerebellumDir, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || /[/\\]/.test(rel)) {
    throw new Error(`refusing to remove non-capability path ${target}`)
  }
  await fs.rm(target, { recursive: true, force: true })
}

/**
 * Swap a staged tree into place, carrying node_modules over from the old
 * copy so an update that didn't touch dependencies skips the reinstall
 * (the cerebellum's package.json-hash markers make that decision).
 */
async function swapInto(cerebellumDir: string, target: string, staged: string): Promise<void> {
  const old = `${target}.wfc-old`
  await fs.rm(old, { recursive: true, force: true })
  const hadOld = await exists(target)
  if (hadOld) await fs.rename(target, old)
  try {
    await fs.rename(staged, target)
  } catch (err) {
    if (hadOld) await fs.rename(old, target).catch(() => {})
    throw err
  }
  if (hadOld) {
    for (const nm of ['node_modules', path.join('plugin', 'node_modules')]) {
      const from = path.join(old, nm)
      const to = path.join(target, nm)
      if ((await exists(from)) && !(await exists(to))) {
        await fs.rename(from, to).catch(() => {})
      }
    }
    await guardedRemove(cerebellumDir, old)
  }
}

// ── The pass ─────────────────────────────────────────────────────────────

export async function syncCapabilitiesNow(): Promise<CapabilitySyncOutcome> {
  const none = { pushed: 0, pulled: 0, removed: 0 }
  if (!deps) return { ok: false, reason: 'uninitialized', ...none }
  if (syncing) return { ok: false, reason: 'busy', ...none }
  syncing = true
  const cerebellumDir = deps.cerebellumDir()
  const stagingRoot = path.join(path.dirname(cerebellumDir), STAGING_DIR)
  let pushed = 0
  let pulled = 0
  let removed = 0
  try {
    await fs.mkdir(cerebellumDir, { recursive: true })
    const state = await loadState(cerebellumDir)

    // 1 · confirm deletes queued while offline (404 = already gone).
    for (const slug of [...state.pendingDeletes]) {
      try {
        const res = await apiFetch('DELETE', `/v1/capabilities/user/${slug}`)
        if (res.ok || res.status === 404) {
          state.pendingDeletes = state.pendingDeletes.filter((s) => s !== slug)
          delete state.user[slug]
          await saveState(cerebellumDir, state)
        }
      } catch {
        // still offline — keep it queued
      }
    }

    // 2 · push local user capabilities that are new or edited.
    const { plain, dotted } = await listCapabilityDirs(cerebellumDir)
    for (const slug of plain) {
      if (!SLUG_RE.test(slug) || state.pendingDeletes.includes(slug)) continue
      const capDir = path.join(cerebellumDir, slug)
      if (!(await exists(path.join(capDir, 'SKILL.md')))) continue
      const zip = await packCapability(capDir)
      if (!zip) continue
      const sha = sha256Hex(zip)
      if (state.user[slug]?.sha256 === sha) continue
      try {
        const meta = await capabilityMeta(capDir, slug)
        const q = new URLSearchParams({
          sha256: sha,
          name: meta.name,
          description: meta.description
        })
        const res = await apiFetch('PUT', `/v1/capabilities/user/${slug}?${q}`, zip)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { version: number }
        state.user[slug] = { version: json.version, sha256: sha }
        await saveState(cerebellumDir, state)
        pushed++
        log(`pushed ${slug} → v${json.version}`)
      } catch (err) {
        log(`push failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 3 · the manifest — org set + this user's own, one call.
    const manifestRes = await apiFetch('GET', '/v1/capabilities/manifest')
    if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status}: manifest`)
    const manifest = (await manifestRes.json()) as { org: ManifestEntry[]; user: ManifestEntry[] }
    const valid = (e: ManifestEntry): boolean => SLUG_RE.test(e.slug) && SHA_RE.test(e.sha256)
    const orgWanted = new Map(manifest.org.filter(valid).map((e) => [e.slug, e]))
    const userWanted = new Map(manifest.user.filter(valid).map((e) => [e.slug, e]))

    // 4 · plan.
    const downloads: Array<{ scope: 'org' | 'user'; entry: ManifestEntry; target: string }> = []
    for (const [slug, entry] of orgWanted) {
      const target = path.join(cerebellumDir, `.${slug}`)
      if (state.org[slug]?.sha256 === entry.sha256 && (await exists(target))) continue
      downloads.push({ scope: 'org', entry, target })
    }
    for (const [slug, entry] of userWanted) {
      if (state.pendingDeletes.includes(slug)) continue
      const target = path.join(cerebellumDir, slug)
      if (state.user[slug]?.sha256 === entry.sha256 && (await exists(target))) continue
      downloads.push({ scope: 'user', entry, target })
    }
    const removals: Array<{ scope: 'org' | 'user'; slug: string; target: string }> = []
    // Dot-dirs the manifest doesn't list: retired org capabilities, plus
    // any leftover from the bundled era or a crashed swap (.x.wfc-old).
    for (const name of dotted) {
      if (name === STAGING_DIR) continue
      if (!orgWanted.has(name.slice(1))) {
        removals.push({ scope: 'org', slug: name.slice(1), target: path.join(cerebellumDir, name) })
      }
    }
    for (const slug of Object.keys(state.user)) {
      if (!userWanted.has(slug) && !state.pendingDeletes.includes(slug)) {
        removals.push({ scope: 'user', slug, target: path.join(cerebellumDir, slug) })
      }
    }

    if (downloads.length === 0 && removals.length === 0) {
      return { ok: true, pushed, pulled, removed }
    }

    // 5 · stage every download off to the side (network while runs go on).
    await fs.rm(stagingRoot, { recursive: true, force: true })
    const staged: Array<{
      scope: 'org' | 'user'
      entry: ManifestEntry
      target: string
      dir: string
    }> = []
    for (const dl of downloads) {
      try {
        const res = await apiFetch('GET', `/v1/capabilities/${dl.scope}/${dl.entry.slug}/package`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        if (sha256Hex(bytes) !== dl.entry.sha256) throw new Error('sha mismatch after download')
        const dir = path.join(stagingRoot, `${dl.scope}-${dl.entry.slug}`)
        await extractPackage(bytes, dir)
        staged.push({ ...dl, dir })
      } catch (err) {
        log(
          `download failed for ${dl.entry.slug}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    // 6 · the idle gate: swaps and removals wait for a quiet moment.
    if (deps.runsActive()) {
      log(`${staged.length + removals.length} change(s) ready — runs active, deferring`)
      return { ok: true, deferred: true, pushed, pulled, removed }
    }

    // 7 · apply, recording state per item so a crash resumes cleanly.
    for (const item of staged) {
      try {
        await swapInto(cerebellumDir, item.target, item.dir)
        state[item.scope][item.entry.slug] = {
          version: item.entry.version,
          sha256: item.entry.sha256
        }
        await saveState(cerebellumDir, state)
        pulled++
        log(`installed ${item.scope}/${item.entry.slug} v${item.entry.version}`)
      } catch (err) {
        log(
          `install failed for ${item.entry.slug}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    for (const item of removals) {
      try {
        await guardedRemove(cerebellumDir, item.target)
        delete state[item.scope][item.slug]
        await saveState(cerebellumDir, state)
        removed++
        log(`removed ${item.scope}/${item.slug}`)
      } catch (err) {
        log(`removal failed for ${item.slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (pulled + removed > 0) {
      await deps.onApplied().catch((err) => log(`reload after sync failed: ${String(err)}`))
    }
    return { ok: true, pushed, pulled, removed }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`sync pass failed: ${reason}`)
    return { ok: false, reason, pushed, pulled, removed }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    syncing = false
  }
}
