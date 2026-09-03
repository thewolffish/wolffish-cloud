import i18n from '@/lib/i18n'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { claimPairing, getApiBase, setApiBase, type ClaimResult } from '@/lib/cloud/api'
import { cloudSession } from '@/lib/cloud/session'
import {
  CODE_ALPHABET,
  CODE_CHARS,
  decodePairingPayload,
  normalizeCode
} from '@/lib/bridge/protocol'

/**
 * Pairing — how this phone becomes a signed-in device of the org.
 *
 * The desktop shows an offer the org minted: a QR (carrying the org's API
 * address and a one-time token) or a short typed code. Claiming either at
 * the org answers a session — the same kind a password login issues — and
 * from then on the phone talks to the org directly. No relay, no key
 * exchange, nothing pinned: the org's session IS the trust, and unpairing
 * is the org revoking it.
 */

function deviceDescription(): { name: string; app_version: string } {
  return {
    name: Device.deviceName ?? Device.modelName ?? 'Phone',
    app_version: Constants.expoConfig?.version ?? ''
  }
}

async function adopt(result: ClaimResult): Promise<void> {
  await cloudSession.adopt({
    version: 1,
    session: result.session,
    orgName: result.orgName,
    desktop: result.desktop,
    pairedAt: Date.now()
  })
}

/**
 * Pair from a scanned QR. The payload names the API it was minted at, so a
 * fork's desktop points this phone at the fork's API for the life of the
 * pairing.
 */
export async function pairWithQr(scanned: string): Promise<void> {
  const payload = decodePairingPayload(scanned) // throws on a foreign code
  if (payload.api !== getApiBase()) await setApiBase(payload.api)
  let result: ClaimResult
  try {
    result = await claimPairing({
      token: payload.token,
      device: { id: await cloudSession.rememberedDeviceId(), ...deviceDescription() }
    })
  } catch (err) {
    throw new Error(claimFailure(err))
  }
  await adopt(result)
}

/** Pair from a typed code, against the built-in API. */
export async function pairWithCode(code: string): Promise<void> {
  const normalized = normalizeCode(code) // throws on a malformed code
  let result: ClaimResult
  try {
    result = await claimPairing({
      code: normalized,
      device: { id: await cloudSession.rememberedDeviceId(), ...deviceDescription() }
    })
  } catch (err) {
    throw new Error(claimFailure(err))
  }
  await adopt(result)
}

/** What a failed claim says on screen — the org's code, translated. */
function claimFailure(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'pairing_not_found' || code === 'invalid_code') return i18n.t('pair.failed')
  if (code === 'rate_limited') return i18n.t('pair.rateLimited')
  if (code === 'account_disabled') return i18n.t('pair.accountDisabled')
  if (code === 'network' || code === 'timeout') return i18n.t('pair.offline')
  return err instanceof Error && err.message ? err.message : i18n.t('pair.failed')
}

// ─────────────────────────────────────────────────────── code entry helpers

/** Size of a code's first group when shown: `K7M9-2QXR`. */
const CODE_GROUP = 4

/** Everything `normalizeCode` accepts, minus its length check: upper case,
 *  dashes and spaces dropped, and the look-alike substitutions. */
function foldCode(input: string): string {
  return String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/**
 * Tidy a finished pairing code for display: `k7m9 2qxr` → `K7M9-2QXR`.
 *
 * Post-processing, not live formatting — call it when the user leaves the
 * field, never on every keystroke. Rewriting mid-entry fights whoever is
 * typing: the caret jumps, backspace stalls on a re-inserted dash, and a
 * half-typed code gets "corrected" into something they did not write.
 */
export function formatPairingCode(input: string): string {
  const folded = foldCode(input)
  if (folded.length !== CODE_CHARS || /[^0-9A-Z]/.test(folded)) return input.trim()
  return `${folded.slice(0, CODE_GROUP)}-${folded.slice(CODE_GROUP)}`
}

/** Why a typed code cannot be used, or null when it can. */
export type PairingCodeIssue = 'empty' | 'character' | 'length'

/**
 * Validates what the user typed, in any spelling: dashes and spaces optional,
 * case-insensitive, O/0 and I/L/1 and U/V interchangeable — exactly what
 * `normalizeCode` will accept at submit time, so the button never enables a
 * code that pairing then rejects.
 */
export function pairingCodeIssue(input: string): PairingCodeIssue | null {
  const folded = foldCode(input)
  if (folded.length === 0) return 'empty'
  // Checked before length: "which character is wrong" is the more useful
  // complaint when the code is both mistyped and the wrong size.
  for (const ch of folded) if (!CODE_ALPHABET.includes(ch)) return 'character'
  if (folded.length !== CODE_CHARS) return 'length'
  return null
}
