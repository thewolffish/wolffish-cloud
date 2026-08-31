/**
 * Minimal compact-JWT, HS256 only. The Worker is the sole issuer and the
 * sole verifier (clients just hold tokens), so a symmetric secret is the
 * whole story — no JWKS until a second verifier exists.
 */

export type AccessClaims = {
  iss: 'wfc-api'
  sub: string // user id
  dev: string // device id
  sid: string // session id
  role: 'owner' | 'admin' | 'support' | 'employee'
  scope: 'session' | 'password_change'
  iat: number
  exp: number
}

const enc = new TextEncoder()

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ])
}

export async function signJwt(claims: AccessClaims, secret: string): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(claims))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`
}

/** Returns claims if the signature is valid and exp is in the future, else null. */
export async function verifyJwt(token: string, secret: string): Promise<AccessClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts as [string, string, string]
  let ok = false
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sig),
      enc.encode(`${head}.${body}`)
    )
  } catch {
    return null
  }
  if (!ok) return null
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as AccessClaims
    if (claims.iss !== 'wfc-api') return null
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}
