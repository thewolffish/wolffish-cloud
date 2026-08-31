/**
 * Crypto primitives. All WebCrypto, no dependencies.
 *
 * Passwords: PBKDF2-SHA256, 100k iterations, 16-byte per-user salt.
 * The same parameters are mirrored in scripts/hash-password.mjs (Node)
 * for seeding — keep them in sync.
 */

export const PBKDF2_ITERATIONS = 100_000

const HEX = '0123456789abcdef'

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function randomHex(n: number): string {
  return toHex(randomBytes(n))
}

/** Prefixed opaque id, e.g. usr_9f2c… — sortable enough, collision-safe. */
export function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return toHex(digest)
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  )
  return toHex(bits)
}

/** Constant-time comparison of equal-length hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Readable one-time password for invites: wf-XXXX-XXXX over an alphabet
 * with no ambiguous glyphs. ~41 bits — plenty for a short-lived,
 * single-use, rate-limited credential.
 */
export function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const pick = (n: number) =>
    Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]!).join('')
  return `wf-${pick(4)}-${pick(4)}`
}
