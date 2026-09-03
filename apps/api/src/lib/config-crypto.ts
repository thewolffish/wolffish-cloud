/**
 * The synced config row, sealed at rest.
 *
 * A user's config.json carries their integration credentials (GitHub
 * tokens, MCP OAuth state, the secrets capability's variables), and
 * it syncs to the org as one row. With CONFIG_ENC_KEY set (32 random bytes,
 * base64), the row is stored as AES-256-GCM ciphertext under a versioned
 * prefix and decrypted only inside the Worker for the user who owns it (and
 * for the audited admin read). Without the key, rows are plain JSON — the
 * historical form — so an existing deployment keeps working and migrates
 * lazily: a plain row is read as is and re-written sealed on its next PUT.
 */
import type { Env } from '@/index'

const PREFIX = 'enc1:'

let cached: { raw: string; key: CryptoKey | null } | null = null

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function keyFor(env: Env): Promise<CryptoKey | null> {
  const raw = (env.CONFIG_ENC_KEY ?? '').trim()
  if (cached && cached.raw === raw) return cached.key
  let key: CryptoKey | null = null
  if (raw) {
    try {
      const bytes = unb64(raw)
      if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`)
      key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt'
      ])
    } catch (err) {
      console.error('CONFIG_ENC_KEY unusable — storing config rows unsealed', {
        message: (err as Error).message
      })
      key = null
    }
  }
  cached = { raw, key }
  return key
}

/** Serialize a config object for storage — sealed when the key is configured. */
export async function sealConfig(env: Env, config: unknown): Promise<string> {
  const json = JSON.stringify(config)
  const key = await keyFor(env)
  if (!key) return json
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json))
  return `${PREFIX}${b64(iv)}:${b64(new Uint8Array(ct))}`
}

/**
 * Read a stored row back into an object. Null = the row is sealed and this
 * deployment cannot open it (key missing or wrong) — a loud misconfiguration
 * the caller reports as an error rather than an empty config.
 */
export async function openConfig(
  env: Env,
  stored: string | null | undefined
): Promise<Record<string, unknown> | null> {
  if (!stored) return {}
  if (!stored.startsWith(PREFIX)) {
    try {
      const parsed = JSON.parse(stored)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  const key = await keyFor(env)
  if (!key) return null
  const [ivB64, ctB64] = stored.slice(PREFIX.length).split(':')
  if (!ivB64 || !ctB64) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB64) },
      key,
      unb64(ctB64)
    )
    const parsed = JSON.parse(new TextDecoder().decode(plain))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return null
  }
}
