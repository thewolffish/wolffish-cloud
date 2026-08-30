/**
 * Every string an overlay card or its opened sheet can put on screen, in both
 * locales — the same guard workspaceKeys.test.ts puts on the three workspace
 * screens, and for the same reason: i18next answers a MISSING key with the key
 * itself, so a gap renders `overlays.noPrompt` on a card instead of throwing.
 *
 * Two groups here, and the second is the one worth explaining.
 *
 * `overlays.*` is the phone's own copy. `heartbeat.overlay.*` is NOT — those
 * four keys are sent BY THE DESKTOP, verbatim, as the `body` of its built-in
 * compaction and reflection jobs (see OverlayKind in the protocol, and
 * brainstem.ts where the strings are minted). The phone translates whatever it
 * is handed, so the key names are a wire contract: rename one here and the card
 * renders the raw key, with nothing failing anywhere to say so. They are listed
 * out one by one, not derived, so that renaming one on either side breaks this
 * test rather than a card.
 */

import ar from '@/lib/i18n/locales/ar.json'
import en from '@/lib/i18n/locales/en.json'
import { OVERLAY_KINDS } from '@/lib/tunnel/protocol'

const LOCALES = { en, ar } as Record<string, Record<string, unknown>>

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      bundle
    )
}

const KEYS = [
  'overlays.openHint',
  'overlays.noPrompt',
  'overlays.queuedCount',
  'overlays.moreActive',
  'overlays.startedAt',
  'overlays.reindexBody',
  'overlays.runsOnDesktop',
  // The desktop's own body keys. See the note above — these are wire, not copy.
  'heartbeat.overlay.compactionDaily',
  'heartbeat.overlay.compactionWeekly',
  'heartbeat.overlay.reflection',
  'heartbeat.overlay.deepClean',
  // Derived, so a kind added to the protocol cannot ship without a title.
  ...OVERLAY_KINDS.map((kind) => `overlays.kind.${kind}`),
  // The mode badge borrows the settings wording rather than minting its own.
  'settings.chatModes.single',
  'settings.chatModes.workflow'
]

describe.each(Object.keys(LOCALES))('%s', (locale) => {
  it.each(KEYS)('has real text for %s', (key) => {
    const value = lookup(LOCALES[locale], key)
    expect(typeof value).toBe('string')
    expect(value).not.toBe('')
    expect(value).not.toBe(key)
  })
})
