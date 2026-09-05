/**
 * The agent can now change the Text-to-Speech and Speech-to-Text defaults
 * itself (voice_settings_set / stt_settings_set), which makes one thing
 * load-bearing that was not before: the values it is allowed to write must be
 * exactly the values the panels can RENDER.
 *
 * The failure this guards is silent, not loud. TextToSpeechPanel re-seeds from
 * config on mount and rewrites any voice or speed it does not recognize back to
 * the default — so a default the agent set, confirmed to the user, and stored
 * correctly would quietly revert the next time anyone opened Settings. Nothing
 * would error; the user would just find their voice changed back. Kokoro
 * genuinely ships six voices that no picker offers (af_alloy, af_jessica,
 * af_river, am_echo, am_fenrir, am_santa), so the plugin's synthesis catalog is
 * deliberately WIDER than its settable one, and only the narrow list may be
 * written as a default.
 *
 * So: the plugin's settable catalogs, the desktop panels' catalogs and the
 * phone's must stay one list. Adding a voice to the panel without adding it
 * here (or the reverse) fails this test rather than shipping a setting that
 * reverts itself.
 *
 * Reads the sources as text on purpose — the plugins are runtime-loaded ESM
 * from <repo>/capabilities and the panels are TSX; parsing the literals is what
 * lets one test see all three surfaces at once.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/__tests__/voice-settings-catalog.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// apps/desktop/src/main/__tests__ -> repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..', '..')

const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

/**
 * The source text between a named declaration's `[` and its matching `]`.
 * Bracket-counted rather than "find the next ]" so a window can never bleed
 * into the declaration that follows — the bug that made the first draft of this
 * test read 101 language codes out of a 100-code array.
 */
function arrayBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  assert.notEqual(start, -1, `${declaration} not found`)
  // Anchor past the ` = `, not on the declaration: a TS annotation carries its
  // own brackets (`const VOICES: Voice[] = [`) and taking the first `[` after
  // the name reads the empty type bracket instead of the literal.
  const assign = source.indexOf(' = ', start)
  assert.notEqual(assign, -1, `${declaration} has no assignment`)
  const open = source.indexOf('[', assign)
  assert.notEqual(open, -1, `${declaration} has no array literal`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++
    else if (source[i] === ']') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`${declaration} array is unterminated`)
}

const matchAll = (body: string, re: RegExp): string[] => [...body.matchAll(re)].map((m) => m[1])

const ids = (body: string): string[] => matchAll(body, /id: '([a-z_]+)'/g)

const ttsPlugin = read('capabilities/text-to-speech/plugin/index.mjs')
const sttPlugin = read('capabilities/speech-to-text/plugin/index.mjs')
const desktopTts = read('apps/desktop/src/renderer/src/pages/settings/TextToSpeechPanel.tsx')
const desktopStt = read('apps/desktop/src/renderer/src/pages/settings/SpeechToTextPanel.tsx')
const desktopLangs = read('apps/desktop/src/renderer/src/pages/settings/whisperLanguages.ts')
const mobileServices = read('apps/mobile/src/app/settings/services.tsx')

let n = 0
const check = (name: string, fn: () => void): void => {
  n++
  try {
    fn()
    console.log(`✅ ${name}`)
  } catch (err) {
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

const sorted = (xs: string[]): string[] => [...new Set(xs)].sort()

// ── voices ────────────────────────────────────────────────────────────────
const settable = ids(arrayBody(ttsPlugin, 'const SELECTABLE_VOICES'))
const synthesizable = ids(arrayBody(ttsPlugin, 'const VOICES'))
const desktopVoices = ids(arrayBody(desktopTts, 'const VOICES'))
const mobileVoices = ids(arrayBody(mobileServices, 'const VOICES'))

check('the voices the agent may set are exactly the desktop panel’s', () => {
  assert.equal(settable.length, 22)
  assert.deepEqual(sorted(settable), sorted(desktopVoices))
})

check('…and exactly the phone’s', () => {
  assert.deepEqual(sorted(settable), sorted(mobileVoices))
})

check('every settable voice is one the engine can actually synthesize', () => {
  const missing = settable.filter((id) => !synthesizable.includes(id))
  assert.deepEqual(missing, [], `settable but not synthesizable: ${missing.join(', ')}`)
})

check('the synthesis catalog stays the wider one (the unpicked Kokoro extras)', () => {
  // Not a nicety: if these ever became equal by someone deleting the extras,
  // the refusal message in voice_settings_set that explains them would be lying.
  const extras = synthesizable.filter((id) => !settable.includes(id))
  assert.deepEqual(sorted(extras), [
    'af_alloy',
    'af_jessica',
    'af_river',
    'am_echo',
    'am_fenrir',
    'am_santa'
  ])
})

// ── speeds ────────────────────────────────────────────────────────────────
check('the speeds the agent may set are exactly the panel’s options', () => {
  const re = /value: '([\d.]+)'/g
  const plugin = matchAll(arrayBody(ttsPlugin, 'const SELECTABLE_SPEEDS'), re)
  const panel = matchAll(arrayBody(desktopTts, 'const SPEEDS'), re)
  assert.equal(plugin.length, 4)
  assert.deepEqual(plugin, panel)
})

// ── models ────────────────────────────────────────────────────────────────
check('the models the agent may set are exactly the panel’s five', () => {
  const plugin = ids(arrayBody(sttPlugin, 'const SELECTABLE_MODELS'))
  const panel = matchAll(arrayBody(desktopStt, 'const MODEL_IDS'), /'([a-z]+)'/g)
  assert.equal(plugin.length, 5)
  assert.deepEqual(plugin, panel)
})

// ── languages ─────────────────────────────────────────────────────────────
const panelLangs = matchAll(arrayBody(desktopLangs, 'WHISPER_LANGUAGES'), /code: '([a-z]{2,3})'/g)

check('every language the agent may set is one the panel lists', () => {
  // The plugin's WHISPER_LANGUAGES is the validation set stt_settings_set checks
  // against; the panel's list is what the Select renders. A code in one and not
  // the other is either a language the agent can set but nobody can see, or one
  // the user can pick but the agent would refuse.
  const plugin = matchAll(arrayBody(sttPlugin, 'const WHISPER_LANGUAGES'), /'([a-z]{2,3})'/g)
  assert.equal(plugin.length, 100, `plugin codes: ${plugin.length}`)
  assert.deepEqual(sorted(plugin), sorted(panelLangs))
})

check('the phone’s language list matches too', () => {
  const mobile = matchAll(
    arrayBody(mobileServices, 'const STT_LANGUAGES'),
    /value: '([a-z]{2,3})'/g
  )
  assert.deepEqual(sorted(panelLangs), sorted(mobile))
})

// ── the seam itself ───────────────────────────────────────────────────────
check('both plugins take their settings seam from the host, not config.json', () => {
  // The host is the only write path that also announces the change; a plugin
  // that wrote config.json directly would leave every open panel and the phone
  // on a stale value. hostUnavailable() is the refusal that keeps it that way.
  for (const [name, src] of [
    ['text-to-speech', ttsPlugin],
    ['speech-to-text', sttPlugin]
  ] as const) {
    assert.ok(src.includes('voiceHost = context.voice ?? null'), `${name}: host not read from init`)
    assert.ok(src.includes('function hostUnavailable()'), `${name}: no refusal when unwired`)
  }
})

console.log(`\n${n} checks run`)
