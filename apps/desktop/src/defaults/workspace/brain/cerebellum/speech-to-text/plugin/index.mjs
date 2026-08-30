import { spawn } from 'node:child_process'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_OUTPUT = 200_000
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(PLUGIN_DIR, 'transcribe.py')
const IS_WIN = process.platform === 'win32'

// On Windows, a stale Microsoft Visual C++ runtime makes the native engine fail
// to load — onnxruntime as "DLL load failed ... initialization routine failed",
// or CTranslate2 as a 0xC0000005 crash inside MSVCP140.dll at model load. The
// python runtime backfills a current VC++ runtime automatically; if that ever
// couldn't run (e.g. offline first use), translate the cryptic failure into the
// real cause and remedy instead of a raw crash code.
function vcRuntimeHint(detail, code) {
  if (!IS_WIN) return null
  const sig = /DLL load failed|initialization routine failed|onnxruntime_pybind11_state/i.test(
    detail || ''
  )
  const crashed = code === 3221225477 || code === -1073741819 // 0xC0000005
  if (!sig && !crashed) return null
  return (
    "Couldn't load the local speech-to-text engine — this PC's Microsoft Visual C++ " +
    'Redistributable is likely out of date. Install the latest x64 build from ' +
    'https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.'
  )
}

// Engine: faster-whisper (CTranslate2 + PyAV). No PyTorch, no external ffmpeg.
const FW_PACKAGES = ['faster-whisper']
// CTranslate2-converted models are downloaded from Hugging Face on first use.
// Named distinctly from the old openai-whisper venv ('whisper') so the launch
// migration can reclaim that stale ~2 GB PyTorch venv unambiguously.
const VENV_NAME = 'faster-whisper'

let workspaceRoot = ''
// { python: <venv python> } once the faster-whisper venv is provisioned.
let executor = null
let initError = null
// 'small', not 'base': base misdetects the language of short accented clips
// badly enough to transcribe English speech into Arabic script. Overridden per
// call by config.stt.defaultModel (Settings → Speech-to-Text).
let defaultModel = 'small'
// Configured transcription language (config.stt.language). '' = unset, which
// resolves to PINNED ENGLISH — detection is the explicit 'auto' opt-in, never
// the silent default (see resolveLanguage).
let defaultLanguage = ''
let getConversationId = () => null

// Locate the shared python runtime, tolerating the dot-prefix rename bundled
// capabilities get in the user workspace (python -> .python at runtime).
async function locatePythonRuntime() {
  const cerebellum = path.resolve(PLUGIN_DIR, '..', '..')
  for (const dirName of ['.python', 'python']) {
    const candidate = path.join(cerebellum, dirName, 'lib', 'runtime.mjs')
    try {
      await access(candidate)
      return import(pathToFileURL(candidate).href)
    } catch {
      /* try next */
    }
  }
  throw new Error('the `python` capability is not installed')
}

function binBase() {
  if (workspaceRoot) return path.join(path.dirname(workspaceRoot), 'bin')
  return path.join(homedir(), '.wolffish', 'bin')
}

function modelDownloadRoot() {
  return path.join(binBase(), 'whisper-models')
}

const toolDefinitions = [
  {
    name: 'stt_transcribe',
    description:
      'Transcribe an audio file by absolute or workspace-relative path. Returns text, language, and segments.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path or workspace-relative path' },
        language: { type: 'string', description: "Whisper ISO 639-1 code or 'auto'. Omit to use the configured default (Settings → Speech-to-Text; factory default en)" },
        model: { type: 'string', description: 'tiny/base/small/medium/large, default small' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'stt_transcribe_upload',
    description:
      'Transcribe an uploaded audio file in the current conversation. Resolves the path inside workspace/uploads/{conversationDir}/.',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Filename of the uploaded audio' },
        language: { type: 'string', description: "Whisper ISO 639-1 code or 'auto'. Omit to use the configured default (Settings → Speech-to-Text; factory default en)" },
        model: { type: 'string', description: 'tiny/base/small/medium/large, default small' }
      },
      required: ['fileName']
    }
  },
  {
    name: 'stt_transcribe_voice_memo',
    description: 'Transcribe a voice memo file under workspace/voice/.',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Voice memo filename (.mp3)' },
        language: { type: 'string', description: "Whisper ISO 639-1 code or 'auto'. Omit to use the configured default (Settings → Speech-to-Text; factory default en)" },
        model: { type: 'string', description: 'tiny/base/small/medium/large, default small' }
      },
      required: ['fileName']
    }
  },
  {
    name: 'stt_detect_language',
    description: 'Detect the spoken language of an audio file without a full transcription.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path or workspace-relative path' }
      },
      required: ['filePath']
    }
  }
]

// ---------- runtime provisioning ----------

async function ensureReady(corpus) {
  if (executor) return { ok: true }

  corpus?.('stt.dep.checking', { dependency: 'faster-whisper' })
  try {
    const mod = await locatePythonRuntime()
    const plat = mod.platformInfo()

    // Preflight: bail with a clear message on targets faster-whisper's engine
    // (CTranslate2 + onnxruntime) has no wheels for, instead of a raw pip error.
    if (plat.isMuslLinux) {
      initError =
        'Speech-to-text is not available on musl/Alpine Linux — CTranslate2 and ' +
        'onnxruntime have no musl builds. Use a glibc-based Linux (most desktop distros).'
      corpus?.('stt.dep.failed', { dependency: 'faster-whisper', error: initError })
      return { ok: false, error: initError }
    }
    const py = mod.pythonRuntime(workspaceRoot)
    // Intel Macs: pin onnxruntime to the last version with x86_64 wheels.
    const packages = plat.isIntelMac ? [...FW_PACKAGES, mod.ONNXRUNTIME_INTEL_MAC] : FW_PACKAGES
    // Windows on ARM: CTranslate2 ships no win-arm64 wheel, so run an x64 Python
    // — the x64 wheels install and execute under Windows 11's built-in x64
    // emulation. (Native arm64 everywhere else.)
    const python = plat.isWindowsArm ? 'cpython-3.12-windows-x86_64-none' : undefined
    corpus?.('stt.dep.installing', {
      dependency: 'faster-whisper',
      note: 'first run installs the engine and downloads the chosen model'
    })
    await py.ensureVenv(VENV_NAME, packages, python)
    executor = { python: py.paths.venvPython(VENV_NAME) }
    corpus?.('stt.dep.ready', { dependency: 'faster-whisper' })
    return { ok: true }
  } catch (err) {
    initError = `Could not prepare the local speech-to-text runtime: ${err?.message ?? err}`
    corpus?.('stt.dep.failed', { dependency: 'faster-whisper', error: initError })
    return { ok: false, error: initError }
  }
}

// ---------- path resolution ----------

function conversationDirName(id) {
  const safe = (id ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  return `conv-${safe}`
}

function resolveAbsolute(filePath) {
  if (!filePath) return null
  if (path.isAbsolute(filePath)) return filePath
  if (workspaceRoot) return path.resolve(workspaceRoot, filePath)
  return path.resolve(filePath)
}

async function resolveUploadByName(fileName) {
  const id = getConversationId()
  if (!id) {
    return {
      ok: false,
      error:
        'No active conversation — stt_transcribe_upload can only run during a chat turn. Use stt_transcribe with an absolute path instead.'
    }
  }
  const dir = path.join(workspaceRoot, 'uploads', conversationDirName(id))
  const candidate = path.join(dir, fileName)
  try {
    await access(candidate)
    return { ok: true, path: candidate }
  } catch {
    return { ok: false, error: `Uploaded file not found: ${fileName} (in ${dir})` }
  }
}

async function resolveVoiceMemoByName(fileName) {
  const root = path.join(workspaceRoot, 'voice')
  const found = await findFileRecursive(root, fileName)
  if (found) return { ok: true, path: found }
  // Fall back to speech/ — some installs put TTS output there.
  const altRoot = path.join(workspaceRoot, 'speech')
  const altFound = await findFileRecursive(altRoot, fileName)
  if (altFound) return { ok: true, path: altFound }
  return { ok: false, error: `Voice memo not found: ${fileName}` }
}

async function findFileRecursive(dir, target) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === target) return full
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(full, target)
      if (nested) return nested
    }
  }
  return null
}

// ---------- transcription ----------

const SUPPORTED_AUDIO_EXTS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.oga',
  '.flac',
  '.webm',
  '.aac',
  '.mp4',
  '.mov'
])

// faster-whisper accepts these sizes; 'large' maps to the newest large model.
function pickModel(model) {
  const allowed = new Set(['tiny', 'base', 'small', 'medium', 'large'])
  const chosen =
    typeof model === 'string' && allowed.has(model.toLowerCase()) ? model.toLowerCase() : defaultModel
  return chosen === 'large' ? 'large-v3' : chosen
}

// Every language code faster-whisper's tokenizer accepts (SYSTRAN/faster-whisper
// _LANGUAGE_CODES, 100 entries). Mirrored — with labels — in the desktop panel
// (SpeechToTextPanel), the CLI settings table and the phone's services screen;
// an unknown code here would crash the python worker, so membership is checked
// before anything reaches --language.
const WHISPER_LANGUAGES = new Set([
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy',
  'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl', 'gu', 'ha', 'haw',
  'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn',
  'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt',
  'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si',
  'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl',
  'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'yue', 'zh'
])

/**
 * The language a transcription runs in. An explicit per-call `language`
 * argument wins; otherwise the configured default applies; otherwise pinned
 * English. '' (autodetect) comes out ONLY from an explicit 'auto' — never as
 * a fallback: on short clips Whisper's detection misfires (English speech
 * transcribed into Arabic script was the shipped failure), so detection is
 * strictly opt-in. Returns { ok, language } — an unknown explicit code is an
 * error the model can act on; an unknown CONFIG value degrades to autodetect
 * instead (a settings typo must not brick every voice note).
 */
function resolveLanguage(explicit) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const code = explicit.trim().toLowerCase()
    if (code === 'auto') return { ok: true, language: '' }
    if (WHISPER_LANGUAGES.has(code)) return { ok: true, language: code }
    return {
      ok: false,
      error: `Unknown language "${explicit}". Pass a Whisper ISO 639-1 code (e.g. en, ar, zh) or "auto".`
    }
  }
  const configured = (defaultLanguage || 'en').toLowerCase()
  if (configured === 'auto') return { ok: true, language: '' }
  return { ok: true, language: WHISPER_LANGUAGES.has(configured) ? configured : '' }
}

// Run the bundled worker with the venv interpreter. Never rejects.
function runScript(args, timeoutMs, label) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executor.python, [SCRIPT, ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    let timer = null
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: `${label} timed out after ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
    }
    child.stdout?.on('data', (c) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString()
    })
    child.stderr?.on('data', (c) => {
      if (stderr.length < MAX_OUTPUT) stderr += c.toString()
    })
    child.on('error', (err) => finish({ ok: false, error: err?.message ?? String(err) }))
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout })
        return
      }
      const base = stderr.slice(-2000) || `${label} exited with code ${code}`
      const hint = vcRuntimeHint(base, code)
      finish({ ok: false, error: hint ? `${hint}\n\n(engine error: ${base})` : base })
    })
  })
}

async function transcribeFile(absPath, language, model, corpus) {
  const ready = await ensureReady(corpus)
  if (!ready.ok) return { success: false, error: ready.error }

  let st
  try {
    st = await stat(absPath)
  } catch {
    return { success: false, error: `File not found: ${absPath}` }
  }
  if (!st.isFile()) return { success: false, error: `Not a file: ${absPath}` }

  const ext = path.extname(absPath).toLowerCase()
  if (!SUPPORTED_AUDIO_EXTS.has(ext)) {
    return {
      success: false,
      error: `Unsupported extension ${ext}. Supported: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`
    }
  }

  const chosenModel = pickModel(model)
  const resolved = resolveLanguage(language)
  if (!resolved.ok) return { success: false, error: resolved.error }
  corpus?.('stt.transcribing', {
    filePath: absPath,
    model: chosenModel,
    language: resolved.language || 'auto'
  })

  const args = ['--audio', absPath, '--model-size', chosenModel, '--download-root', modelDownloadRoot()]
  if (resolved.language) {
    args.push('--language', resolved.language)
  }

  const res = await runScript(args, 0, 'faster-whisper')
  if (!res.ok) {
    corpus?.('stt.failed', { error: res.error })
    return { success: false, error: res.error }
  }

  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (err) {
    return {
      success: false,
      error: `Could not parse transcription output: ${err?.message ?? err}\n${res.stdout.slice(-500)}`
    }
  }

  const outputPath = await persistTranscription(absPath, parsed)
  corpus?.('stt.transcribed', {
    language: parsed.language ?? '',
    segmentCount: parsed.segments?.length ?? 0,
    textLength: parsed.text?.length ?? 0
  })

  return {
    success: true,
    output: JSON.stringify({
      text: parsed.text,
      language: parsed.language,
      segmentCount: parsed.segments?.length ?? 0,
      filePath: absPath,
      model: chosenModel,
      outputPath
    })
  }
}

async function persistTranscription(audioPath, parsed) {
  const id = getConversationId()
  const baseDir = id
    ? path.join(workspaceRoot, 'speech', conversationDirName(id))
    : path.join(workspaceRoot, 'speech', 'orphan')
  await mkdir(baseDir, { recursive: true }).catch(() => undefined)
  const audioName = path.basename(audioPath)
  const outPath = path.join(baseDir, `${audioName}.txt`)
  const header = `# Transcription of ${audioName}\n\nLanguage: ${parsed.language || 'unknown'}\nGenerated: ${new Date().toISOString()}\n\n`
  const body = parsed.text || ''
  try {
    await writeFile(outPath, header + body + '\n', 'utf8')
  } catch {
    return null
  }
  return outPath
}

async function detectLanguage(absPath, corpus) {
  const ready = await ensureReady(corpus)
  if (!ready.ok) return { success: false, error: ready.error }

  try {
    await access(absPath)
  } catch {
    return { success: false, error: `File not found: ${absPath}` }
  }

  corpus?.('stt.detecting', { filePath: absPath })

  const res = await runScript(
    ['--audio', absPath, '--model-size', defaultModel, '--download-root', modelDownloadRoot(), '--detect-only'],
    0,
    'faster-whisper'
  )
  if (!res.ok) {
    corpus?.('stt.failed', { error: res.error })
    return { success: false, error: res.error }
  }

  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (err) {
    return { success: false, error: `Parse failure: ${err?.message ?? err}\n${res.stdout.slice(-500)}` }
  }
  corpus?.('stt.detected', { language: parsed.detected, confidence: parsed.confidence })
  return { success: true, output: JSON.stringify(parsed) }
}

// ---------- plugin shell ----------

const plugin = {
  name: 'speech-to-text',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context.workspaceRoot
    if (typeof context.getCurrentConversationId === 'function') {
      getConversationId = context.getCurrentConversationId
    }
    // Provisioning (a uv venv + first model download) is deferred to the first
    // call so app launch never blocks on a download.
  },

  async execute(toolName, args) {
    // Read the defaults from config on each call so Settings changes take
    // effect without a reload. Best-effort. The truthiness guard matters: an
    // empty-string defaultModel persisted by a partial settings write would
    // otherwise blank the model and crash the worker.
    try {
      const cfgPath = path.join(workspaceRoot, 'config.json')
      const raw = await readFile(cfgPath, 'utf8')
      const cfg = JSON.parse(raw)
      const m = cfg?.stt?.defaultModel
      if (typeof m === 'string' && m.trim().length > 0) defaultModel = m
      const l = cfg?.stt?.language
      if (typeof l === 'string') defaultLanguage = l.trim()
    } catch {
      // keep defaults
    }

    switch (toolName) {
      case 'stt_transcribe': {
        const filePath = args?.filePath
        if (typeof filePath !== 'string' || filePath.trim().length === 0) {
          return { success: false, error: 'filePath is required' }
        }
        const abs = resolveAbsolute(filePath)
        if (!abs) return { success: false, error: `Could not resolve path: ${filePath}` }
        return transcribeFile(abs, args?.language, args?.model)
      }
      case 'stt_transcribe_upload': {
        const fileName = args?.fileName
        if (typeof fileName !== 'string' || fileName.trim().length === 0) {
          return { success: false, error: 'fileName is required' }
        }
        const resolved = await resolveUploadByName(fileName)
        if (!resolved.ok) return { success: false, error: resolved.error }
        return transcribeFile(resolved.path, args?.language, args?.model)
      }
      case 'stt_transcribe_voice_memo': {
        const fileName = args?.fileName
        if (typeof fileName !== 'string' || fileName.trim().length === 0) {
          return { success: false, error: 'fileName is required' }
        }
        const resolved = await resolveVoiceMemoByName(fileName)
        if (!resolved.ok) return { success: false, error: resolved.error }
        return transcribeFile(resolved.path, args?.language, args?.model)
      }
      case 'stt_detect_language': {
        const filePath = args?.filePath
        if (typeof filePath !== 'string' || filePath.trim().length === 0) {
          return { success: false, error: 'filePath is required' }
        }
        const abs = resolveAbsolute(filePath)
        if (!abs) return { success: false, error: `Could not resolve path: ${filePath}` }
        return detectLanguage(abs)
      }
      default:
        return { success: false, error: `speech-to-text: unknown tool ${toolName}` }
    }
  }
}

export default plugin
