// Text-to-speech via Kokoro — a fully local neural TTS engine.
//
// This plugin has NO cloud dependency and NO Microsoft / edge-tts anymore.
// Synthesis runs entirely on-device:
//   1. the shared `python` capability provisions a hermetic uv-managed CPython,
//   2. we create an isolated venv with kokoro-onnx (+ soundfile) in it,
//   3. the Kokoro ONNX model is downloaded once into ~/.wolffish/bin/kokoro,
//   4. synth.py renders the text to a 24 kHz WAV,
//   5. ffmpeg transcodes WAV -> MP3 so the rest of the app (renderer card,
//      Telegram/WhatsApp voice memos) is byte-for-byte unchanged.
//
// Tool names (voice_generate / voice_respond / voice_list) and the JSON output
// contract are identical to the previous engine, so nothing downstream changes.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import https from 'node:https'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const IS_WIN = process.platform === 'win32'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

// Locate the shared python runtime, tolerating the dot-prefix rename bundled
// capabilities get in the user workspace (cerebellum/python in source ->
// cerebellum/.python at runtime). A static import can't span that rename, so we
// probe both names and dynamic-import the module.
async function locatePythonRuntime() {
  const cerebellum = path.resolve(PLUGIN_DIR, '..', '..')
  for (const dirName of ['.python', 'python']) {
    const candidate = path.join(cerebellum, dirName, 'lib', 'runtime.mjs')
    if (await fileExists(candidate)) {
      return import(pathToFileURL(candidate).href)
    }
  }
  throw new Error('the `python` capability is not installed')
}
const MAX_OUTPUT = 50_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

// Default voice when neither Settings nor the model specify one.
// Female US English — matches the Settings panel default.
const DEFAULT_VOICE = 'af_bella'

const VENV_NAME = 'kokoro-tts'
// kokoro-onnx is pinned for reproducibility; soundfile writes the WAV.
const PACKAGES = ['kokoro-onnx==0.4.9', 'soundfile']

// Kokoro v1.0 model files (Apache-2.0 / MIT). Downloaded once and cached.
const MODEL_RELEASE =
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
const MODEL_FILES = {
  'kokoro-v1.0.onnx': `${MODEL_RELEASE}/kokoro-v1.0.onnx`,
  'voices-v1.0.bin': `${MODEL_RELEASE}/voices-v1.0.bin`
}

// Pinned SHA-256 of the model-files-v1.0 artifacts, for a PASSIVE integrity
// signal only: a download is reported as verified / mismatch / unverified and
// used either way. A stale pin yields an informational "mismatch", never a fail.
const MODEL_SHA256 = {
  'kokoro-v1.0.onnx': '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5',
  'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'
}

// English voices (American + British), each with a human-readable language.
// Used to validate/fall back; the Settings UI shows the same labels.
const VOICES = [
  { id: 'af_heart', language: 'English (US)', gender: 'female' },
  { id: 'af_bella', language: 'English (US)', gender: 'female' },
  { id: 'af_nicole', language: 'English (US)', gender: 'female' },
  { id: 'af_aoede', language: 'English (US)', gender: 'female' },
  { id: 'af_kore', language: 'English (US)', gender: 'female' },
  { id: 'af_sarah', language: 'English (US)', gender: 'female' },
  { id: 'af_nova', language: 'English (US)', gender: 'female' },
  { id: 'af_sky', language: 'English (US)', gender: 'female' },
  { id: 'af_alloy', language: 'English (US)', gender: 'female' },
  { id: 'af_jessica', language: 'English (US)', gender: 'female' },
  { id: 'af_river', language: 'English (US)', gender: 'female' },
  { id: 'am_adam', language: 'English (US)', gender: 'male' },
  { id: 'am_michael', language: 'English (US)', gender: 'male' },
  { id: 'am_echo', language: 'English (US)', gender: 'male' },
  { id: 'am_eric', language: 'English (US)', gender: 'male' },
  { id: 'am_fenrir', language: 'English (US)', gender: 'male' },
  { id: 'am_liam', language: 'English (US)', gender: 'male' },
  { id: 'am_onyx', language: 'English (US)', gender: 'male' },
  { id: 'am_puck', language: 'English (US)', gender: 'male' },
  { id: 'am_santa', language: 'English (US)', gender: 'male' },
  { id: 'bf_emma', language: 'English (UK)', gender: 'female' },
  { id: 'bf_isabella', language: 'English (UK)', gender: 'female' },
  { id: 'bf_alice', language: 'English (UK)', gender: 'female' },
  { id: 'bf_lily', language: 'English (UK)', gender: 'female' },
  { id: 'bm_george', language: 'English (UK)', gender: 'male' },
  { id: 'bm_daniel', language: 'English (UK)', gender: 'male' },
  { id: 'bm_fable', language: 'English (UK)', gender: 'male' },
  { id: 'bm_lewis', language: 'English (UK)', gender: 'male' }
]
const KNOWN_VOICES = new Set(VOICES.map((v) => v.id))

let workspaceRoot = ''
let getConversationId = () => null

const toolDefinitions = [
  {
    name: 'voice_generate',
    description:
      'Convert text to a voice memo (MP3). Returns the file path of the generated audio.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to convert to speech' },
        voice: {
          type: 'string',
          description:
            "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice from Settings. American voices start af_/am_, British voices bf_/bm_."
        },
        speed: {
          type: 'string',
          description: 'Speech rate multiplier 0.5–1.5 (default 1.0). Omit to use the default.'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'voice_respond',
    description: 'Respond entirely as a voice memo. The voice IS the response.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The full response text to speak' },
        voice: {
          type: 'string',
          description:
            "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice from Settings."
        },
        speed: {
          type: 'string',
          description: 'Speech rate multiplier 0.5–1.5 (default 1.0). Omit to use the default.'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'voice_list',
    description: 'List all voice memo files in the workspace.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

// ---------------------------------------------------------------------------
// Small local helpers (kept in-file like sibling plugins; no shared imports
// beyond the python runtime, to survive the bundled dot-prefix rename).
// ---------------------------------------------------------------------------

async function fileExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function clampOutput(buf, chunk) {
  if (buf.length >= MAX_OUTPUT) return buf
  return buf + chunk.toString().slice(0, MAX_OUTPUT - buf.length)
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

async function sha256File(p) {
  return createHash('sha256').update(await readFile(p)).digest('hex')
}

function binBase() {
  if (workspaceRoot) return path.join(path.dirname(workspaceRoot), 'bin')
  return path.join(homedir(), '.wolffish', 'bin')
}

function modelDir() {
  return path.join(binBase(), 'kokoro')
}

async function which(cmd) {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileP = promisify(execFile)
    const bin = IS_WIN ? 'where' : 'which'
    const { stdout } = await execFileP(bin, [cmd])
    return stdout.trim().split('\n')[0].trim() || null
  } catch {
    return null
  }
}

// Resolve ffmpeg: the wolffish-managed copy under ~/.wolffish/bin/ffmpeg first
// (flat or nested gyan.dev layout), then PATH. TTS `requires: ['ffmpeg']`, so
// cerebellum has already ensured one of these exists before we run.
async function resolveFfmpeg() {
  const dir = path.join(binBase(), 'ffmpeg')
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
  const flat = path.join(dir, exe)
  if (await fileExists(flat)) return flat
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = path.join(dir, entry.name, 'bin', exe)
      if (await fileExists(nested)) return nested
    }
  } catch {
    /* dir absent */
  }
  return which('ffmpeg')
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error(`too many redirects fetching ${url}`))
      return
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'wolffish' }, timeout: DOWNLOAD_TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(
            resolve,
            reject
          )
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status} fetching ${url}`))
          return
        }
        const expected = Number(res.headers['content-length'] || 0)
        pipeline(res, createWriteStream(dest)).then(async () => {
          // Guard against silent truncation on a dropped connection: a partial
          // body still "completes" the pipeline, so verify the byte count. The
          // caller only renames .part -> final on success, so a short read is
          // discarded and retried next time rather than caching a corrupt file.
          if (expected) {
            const { size } = await stat(dest)
            if (size !== expected) {
              reject(new Error(`incomplete download (${size}/${expected} bytes) for ${url}`))
              return
            }
          }
          resolve()
        }, reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)))
    req.on('error', reject)
  })
}

// Ensure both Kokoro model files exist locally; download any that are missing
// (atomic via a .part rename) and cache forever after. The only network call
// the whole engine ever makes — and only on first use.
async function ensureModel() {
  const dir = modelDir()
  await mkdir(dir, { recursive: true })
  const integrity = {}
  for (const [name, url] of Object.entries(MODEL_FILES)) {
    const dest = path.join(dir, name)
    let ok = false
    try {
      ok = (await stat(dest)).size > 0
    } catch {
      ok = false
    }
    if (ok) continue
    const part = `${dest}.part`
    await unlink(part).catch(() => {})
    await download(url, part)
    // Passive integrity: report verified / mismatch / unverified, never block.
    const expected = MODEL_SHA256[name]
    const actual = (await sha256File(part)).toLowerCase()
    integrity[name] = !expected ? 'unverified' : actual === expected ? 'verified' : 'mismatch'
    if (integrity[name] === 'mismatch') {
      console.warn(
        `[text-to-speech] sha256 mismatch for ${name} (expected ${expected}, got ${actual}) — using it anyway`
      )
    }
    await rename(part, dest)
  }
  return {
    model: path.join(dir, 'kokoro-v1.0.onnx'),
    voices: path.join(dir, 'voices-v1.0.bin'),
    integrity: Object.keys(integrity).length ? integrity : null
  }
}

// Speech files are scoped per conversation: workspace/speech/conv-<id>/.
function speechDir() {
  const base = path.join(workspaceRoot, 'speech')
  const id = (getConversationId() ?? '').trim()
  if (!id) return path.join(base, 'orphan')
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(base, `conv-${safe}`)
}

// Accept either a Kokoro float multiplier ("1.0", 1.2) or a legacy edge-tts
// rate string ("+0%", "-50%") for backward compatibility with old configs.
function parseSpeed(value) {
  if (value == null || value === '') return 1.0
  if (typeof value === 'number') return clampSpeed(value)
  const s = String(value).trim()
  const pct = s.match(/^([+-]?\d+(?:\.\d+)?)%$/)
  if (pct) return clampSpeed(1 + Number(pct[1]) / 100)
  const f = Number(s)
  return Number.isFinite(f) ? clampSpeed(f) : 1.0
}
function clampSpeed(x) {
  return Math.min(1.5, Math.max(0.5, x))
}

// English-only voice resolution: a known arg wins, then a known config voice,
// else the default. Unknown ids fall back rather than risk a synth failure.
function resolveVoice(argVoice, cfgVoice) {
  const arg = (argVoice ?? '').trim()
  const cfg = (cfgVoice ?? '').trim()
  if (arg && KNOWN_VOICES.has(arg)) return arg
  if (cfg && KNOWN_VOICES.has(cfg)) return cfg
  return DEFAULT_VOICE
}

function runSpawn(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => {
      stdout = clampOutput(stdout, c)
    })
    child.stderr?.on('data', (c) => {
      stderr = clampOutput(stderr, c)
    })
    child.on('error', (err) =>
      resolve({ code: -1, stdout, stderr: stderr + '\n' + (err?.message ?? String(err)) })
    )
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

// On Windows, a stale Microsoft Visual C++ runtime makes the native engine fail
// to load — onnxruntime as "DLL load failed ... initialization routine failed",
// or a 0xC0000005 crash. The python runtime backfills a current VC++ runtime
// automatically; if that ever couldn't run (e.g. offline first use), translate
// the cryptic failure into the real cause and remedy instead of a raw DLL dump.
function vcRuntimeHint(detail, code) {
  if (!IS_WIN) return null
  const sig = /DLL load failed|initialization routine failed|onnxruntime_pybind11_state/i.test(
    detail || ''
  )
  const crashed = code === 3221225477 || code === -1073741819 // 0xC0000005
  if (!sig && !crashed) return null
  return (
    "Couldn't load the local voice engine — this PC's Microsoft Visual C++ " +
    'Redistributable is likely out of date. Install the latest x64 build from ' +
    'https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.'
  )
}

// ---------------------------------------------------------------------------
// Core synthesis
// ---------------------------------------------------------------------------

async function generateVoice(text, voice, speed, isResponse) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { success: false, error: 'Text is required' }

  // 1. Hermetic Python + kokoro-onnx venv (idempotent after first run).
  let py
  try {
    const mod = await locatePythonRuntime()
    const plat = mod.platformInfo()
    // Preflight: bail with a clear message on targets the engine can't install
    // on, rather than a raw onnxruntime pip failure. Intel Macs ARE supported
    // via an onnxruntime version pin (below); only musl/Alpine is unsupported.
    if (plat.isMuslLinux) {
      return {
        success: false,
        error:
          'Kokoro TTS is not available on musl/Alpine Linux — its onnxruntime engine ' +
          'has no musl build. Use a glibc-based Linux (most desktop distros).'
      }
    }
    py = mod.pythonRuntime(workspaceRoot)
    // Intel Macs: pin onnxruntime to the last version that ships x86_64 wheels.
    const packages = plat.isIntelMac ? [...PACKAGES, mod.ONNXRUNTIME_INTEL_MAC] : PACKAGES
    await py.ensureVenv(VENV_NAME, packages)
  } catch (err) {
    return {
      success: false,
      error: `Could not prepare the local Python TTS runtime: ${err?.message ?? err}`
    }
  }

  // 2. Model files (downloaded once).
  let model
  try {
    model = await ensureModel()
  } catch (err) {
    return {
      success: false,
      error: `Could not download the Kokoro voice model: ${err?.message ?? err}`
    }
  }

  // 3. ffmpeg for WAV -> MP3.
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) {
    return {
      success: false,
      error: 'ffmpeg is required to encode voice memos but was not found.'
    }
  }

  const voiceName = voice || DEFAULT_VOICE
  const rate = clampSpeed(speed)
  const dir = speechDir()
  await mkdir(dir, { recursive: true })

  const timestamp = Date.now()
  const hash = shortHash(trimmed)
  const fileName = `${timestamp}-${hash}.mp3`
  const filePath = path.join(dir, fileName)

  // Scratch files in a private temp dir (text in, wav out) — avoids all
  // shell-quoting / arg-length concerns and keeps the workspace clean.
  const scratch = await mkdtemp(path.join(tmpdir(), 'wolffish-tts-'))
  const textFile = path.join(scratch, 'input.txt')
  const wavFile = path.join(scratch, 'out.wav')

  try {
    await writeFile(textFile, trimmed, 'utf8')

    const script = path.join(PLUGIN_DIR, 'synth.py')
    const synth = await py.runInVenv(VENV_NAME, [
      script,
      '--model',
      model.model,
      '--voices',
      model.voices,
      '--text-file',
      textFile,
      '--out',
      wavFile,
      '--voice',
      voiceName,
      '--speed',
      String(rate)
    ])
    if (synth.code !== 0) {
      const detail = synth.stderr.slice(-500) || synth.stdout.slice(-500)
      const hint = vcRuntimeHint(detail, synth.code)
      return {
        success: false,
        error: hint ? `${hint}\n\n(engine error: ${detail})` : `Kokoro synthesis failed: ${detail}`
      }
    }

    const mp3 = await runSpawn(ffmpeg, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      wavFile,
      '-codec:a',
      'libmp3lame',
      '-qscale:a',
      '2',
      filePath
    ])
    if (mp3.code !== 0) {
      return {
        success: false,
        error: `Failed to encode MP3: ${mp3.stderr.slice(-400) || 'ffmpeg error'}`
      }
    }

    let st
    try {
      st = await stat(filePath)
    } catch {
      return { success: false, error: 'Output file was not created' }
    }
    if (st.size === 0) {
      await unlink(filePath).catch(() => {})
      return { success: false, error: 'Output file is empty' }
    }

    return {
      success: true,
      output: JSON.stringify({
        filePath,
        fileName,
        sizeBytes: st.size,
        voice: voiceName,
        speed: rate,
        isResponse: !!isResponse,
        textLength: trimmed.length,
        ...(model.integrity ? { modelIntegrity: model.integrity } : {})
      })
    }
  } finally {
    await unlink(textFile).catch(() => {})
    await unlink(wavFile).catch(() => {})
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

async function listSpeechFiles() {
  const root = path.join(workspaceRoot, 'speech')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { success: true, output: JSON.stringify({ files: [], count: 0 }) }
  }

  const files = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.mp3')) {
      await collectFile(path.join(root, entry.name), null, files)
    } else if (entry.isDirectory()) {
      const conv = entry.name.startsWith('conv-') ? entry.name.slice('conv-'.length) : null
      const subDir = path.join(root, entry.name)
      let subEntries
      try {
        subEntries = await readdir(subDir)
      } catch {
        continue
      }
      for (const name of subEntries) {
        if (!name.endsWith('.mp3')) continue
        await collectFile(path.join(subDir, name), conv, files)
      }
    }
  }
  files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { success: true, output: JSON.stringify({ files, count: files.length }) }
}

async function collectFile(filePath, conversationId, sink) {
  try {
    const st = await stat(filePath)
    sink.push({
      name: path.basename(filePath),
      path: filePath,
      conversationId,
      sizeBytes: st.size,
      createdAt: st.birthtime.toISOString()
    })
  } catch {
    /* skip unreadable */
  }
}

const plugin = {
  name: 'text-to-speech',
  tools: toolDefinitions,
  // Exposed so the Settings UI / main process can show voices with languages
  // without duplicating the list. Pure data, safe to read at any time.
  voices: VOICES,

  async init(context) {
    workspaceRoot = context.workspaceRoot
    if (typeof context.getCurrentConversationId === 'function') {
      getConversationId = context.getCurrentConversationId
    }
  },

  async execute(toolName, args) {
    // Read user-selected defaults from config.json on each call so changes in
    // Settings take effect without a reload. Best-effort.
    let cfgVoice = ''
    let cfgSpeed = ''
    try {
      const raw = await readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
      const cfg = JSON.parse(raw)
      if (typeof cfg?.tts?.defaultVoice === 'string') cfgVoice = cfg.tts.defaultVoice
      if (cfg?.tts?.defaultSpeed != null) cfgSpeed = cfg.tts.defaultSpeed
    } catch {
      /* keep empty fallbacks */
    }
    const voice = resolveVoice(args?.voice, cfgVoice)
    const speed = parseSpeed(args?.speed != null && args.speed !== '' ? args.speed : cfgSpeed)
    switch (toolName) {
      case 'voice_generate':
        return generateVoice(args?.text, voice, speed, false)
      case 'voice_respond':
        return generateVoice(args?.text, voice, speed, true)
      case 'voice_list':
        return listSpeechFiles()
      default:
        return { success: false, error: `text-to-speech: unknown tool ${toolName}` }
    }
  }
}

export default plugin
