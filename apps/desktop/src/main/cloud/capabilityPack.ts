/**
 * Capability packaging — the byte format capabilities travel in.
 *
 * Packing is deterministic on purpose: entries sorted, STORE method (no
 * compression), fixed timestamps. The same folder always produces the same
 * bytes, so sha256 equality IS the change detector — across syncs, across
 * a user's devices, and against the seeded org packages (the API repo's
 * scripts/lib/zip.mjs writes the identical format).
 *
 * Junk (node_modules, install/test markers, VCS and OS litter) never
 * enters a package: clients rematerialize node_modules locally via the
 * cerebellum's lazy npm install, and markers must be earned per-install.
 *
 * Electron-free so the sync engine and its tests run headless.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const JUNK = new Set([
  'node_modules',
  '.git',
  '.ds_store',
  '__macosx',
  '.wfc-installed',
  '.wfc-tested'
])

const isJunk = (name: string): boolean => JUNK.has(name.toLowerCase())

export const sha256Hex = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex')

async function collectFiles(root: string, rel: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (isJunk(entry.name)) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) await collectFiles(root, childRel, out)
    else if (entry.isFile()) out.push(childRel)
  }
}

// ── Deterministic STORE-only zip writer ──────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// Fixed DOS timestamp (2026-01-01) — determinism over honesty; history
// lives in the registry's version chain, not in zip metadata.
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // STORE
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(f.data.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, f.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(f.data.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + f.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** Deterministically package a capability folder; null when it has no files. */
export async function packCapability(dir: string): Promise<Buffer | null> {
  const rels: string[] = []
  await collectFiles(dir, '', rels)
  if (rels.length === 0) return null
  rels.sort()
  const files: Array<{ name: string; data: Buffer }> = []
  for (const rel of rels) {
    files.push({ name: rel, data: await fs.readFile(path.join(dir, rel)) })
  }
  return buildZip(files)
}

/**
 * Extract a downloaded package into destDir (created fresh). Slip-guarded
 * like capabilityImport's zip path: no entry may resolve outside destDir,
 * junk segments are skipped even if a package somehow carries them.
 */
export async function extractPackage(zip: Buffer, destDir: string): Promise<void> {
  const JSZip = (await import('jszip')).default
  const archive = await JSZip.loadAsync(zip)
  await fs.mkdir(destDir, { recursive: true })
  for (const [entryName, entry] of Object.entries(archive.files)) {
    if (entryName.split(/[/\\]/).some((seg) => seg.length > 0 && isJunk(seg))) continue
    const dest = path.join(destDir, entryName)
    const rel = path.relative(destDir, dest)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`package contains an unsafe path ("${entryName}")`)
    }
    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, await entry.async('nodebuffer'))
  }
}
