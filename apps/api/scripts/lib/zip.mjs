/**
 * Deterministic STORE-only zip writer shared by the ops scripts
 * (seed-capabilities.mjs) and the live gate (verify-live.mjs).
 *
 * Same input tree → same bytes, always: entries are written in the order
 * given (callers sort), timestamps are fixed, nothing is compressed. That
 * makes sha256 equality mean "content unchanged", which is what both the
 * seeder's skip logic and the sync clients' diffing rely on.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// Fixed DOS timestamp (2026-01-01 00:00:00) — determinism over honesty;
// real modification history lives in git, not in package metadata.
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

/** files: [{ name: 'SKILL.md', data: Buffer }] (pre-sorted) → zip Buffer. */
export function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 names
    localHeader.writeUInt16LE(0, 8) // STORE
    localHeader.writeUInt16LE(DOS_TIME, 10)
    localHeader.writeUInt16LE(DOS_DATE, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(f.data.length, 18)
    localHeader.writeUInt32LE(f.data.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)
    locals.push(localHeader, nameBytes, f.data)

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
  const cdStart = offset
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...locals, cd, eocd])
}
