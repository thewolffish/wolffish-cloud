import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'

export const DEFAULT_ENDPOINT = 'http://localhost:11434'
const DETECT_TIMEOUT_MS = 1500
// Bound /api/show so an unreachable host (silently-dropped SYN — stale remote
// endpoint, VPN down) can't hang the request until the OS TCP connect timeout
// (~75s). showModel resolves null on failure, so without this its callers —
// including the up-front context-window warm at the start of a local turn —
// would block for that whole duration. More generous than the liveness ping
// because /api/show reads (and returns) the model manifest, not just a 200.
const SHOW_TIMEOUT_MS = 5000

export type OllamaPullStatus =
  | { kind: 'progress'; status: string; completed: number | null; total: number | null }
  | { kind: 'success' }

export type OllamaTag = { name: string; size: number }

function endpointUrl(endpoint: string | undefined, path: string): URL {
  return new URL(path, endpoint ?? DEFAULT_ENDPOINT)
}

export async function detect(endpoint: string = DEFAULT_ENDPOINT): Promise<boolean> {
  return new Promise((resolve) => {
    const url = endpointUrl(endpoint, '/')
    const req = request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: DETECT_TIMEOUT_MS
      },
      (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

export type OllamaShowResponse = {
  capabilities?: string[]
  details?: { families?: string[]; family?: string }
  model_info?: Record<string, unknown>
}

export async function showModel(
  modelName: string,
  endpoint: string = DEFAULT_ENDPOINT
): Promise<OllamaShowResponse | null> {
  const url = endpointUrl(endpoint, '/api/show')
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: modelName })
    const req = request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        timeout: SHOW_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              resolve(null)
              return
            }
            const text = Buffer.concat(chunks).toString('utf8')
            resolve(JSON.parse(text) as OllamaShowResponse)
          } catch {
            resolve(null)
          }
        })
      }
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.write(body)
    req.end()
  })
}

export async function listTags(endpoint: string = DEFAULT_ENDPOINT): Promise<OllamaTag[]> {
  const url = endpointUrl(endpoint, '/api/tags')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(body) as { models?: Array<{ name: string; size: number }> }
            resolve((parsed.models ?? []).map((m) => ({ name: m.name, size: m.size })))
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

export async function pullModel(options: {
  endpoint?: string
  model: string
  signal?: AbortSignal
  onStatus: (status: OllamaPullStatus) => void
}): Promise<void> {
  const url = endpointUrl(options.endpoint, '/api/pull')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: { 'content-type': 'application/json' }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`pull failed: HTTP ${res.statusCode}`))
          return
        }
        consumeJsonLines(res, (line) => {
          let parsed: { status?: string; completed?: number; total?: number; error?: string }
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          if (parsed.error) {
            reject(new Error(parsed.error))
            req.destroy()
            return
          }
          if (parsed.status === 'success') {
            options.onStatus({ kind: 'success' })
            return
          }
          options.onStatus({
            kind: 'progress',
            status: parsed.status ?? 'downloading',
            completed: typeof parsed.completed === 'number' ? parsed.completed : null,
            total: typeof parsed.total === 'number' ? parsed.total : null
          })
        })
          .then(resolve)
          .catch(reject)
      }
    )

    req.on('error', reject)
    options.signal?.addEventListener('abort', () => {
      req.destroy()
      reject(new DOMException('aborted', 'AbortError'))
    })

    req.write(JSON.stringify({ model: options.model, stream: true }))
    req.end()
  })
}

function consumeJsonLines(res: IncomingMessage, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.length > 0) onLine(line)
      }
    })
    res.on('end', () => {
      const tail = buffer.trim()
      if (tail.length > 0) onLine(tail)
      resolve()
    })
    res.on('error', reject)
  })
}

export function platformInstallUrl(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'https://ollama.com/download/mac'
  if (platform === 'win32') return 'https://ollama.com/download/windows'
  return 'https://ollama.com/download/linux'
}

/**
 * Check whether Ollama is installed on this machine, without launching it.
 * We look at the standard install locations for each OS — covering recent
 * Ollama versions on macOS (Intel + Apple Silicon use the same .app),
 * Windows (per-user installer), and Linux (system + user-local + script
 * installer paths).
 */
export function isOllamaInstalled(): boolean {
  const platform = process.platform
  if (platform === 'darwin') {
    return existsSync('/Applications/Ollama.app')
  }
  if (platform === 'win32') {
    const home = os.homedir()
    const candidates = [
      path.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama app.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe'
    ]
    return candidates.some((p) => existsSync(p))
  }
  // Linux — apt/curl-script installers drop the binary in one of these.
  const linuxCandidates = [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    '/opt/ollama/bin/ollama',
    path.join(os.homedir(), '.local', 'bin', 'ollama')
  ]
  return linuxCandidates.some((p) => existsSync(p))
}

/**
 * Best-effort launch of Ollama on the host. Detached + unref so we don't
 * keep the Electron process tied to whatever shell we spawn. Doesn't wait
 * for the server to come up — the renderer continues polling /api/tags
 * until detect() succeeds.
 */
export function startOllama(): { ok: boolean; error?: string } {
  try {
    const platform = process.platform
    if (platform === 'darwin') {
      const child = spawn('open', ['-a', 'Ollama'], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      return { ok: true }
    }
    if (platform === 'win32') {
      const home = os.homedir()
      const candidates = [
        path.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama app.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
        'C:\\Program Files\\Ollama\\ollama.exe'
      ]
      const exe = candidates.find((p) => existsSync(p))
      if (exe) {
        const child = spawn(exe, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.unref()
        return { ok: true }
      }
      // No exe on disk — fall through to PATH lookup.
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: true
      })
      child.unref()
      return { ok: true }
    }
    // Linux: prefer systemd, fall back to launching `ollama serve` headless.
    const child = spawn(
      'sh',
      [
        '-c',
        'systemctl --user start ollama 2>/dev/null ' +
          '|| systemctl start ollama 2>/dev/null ' +
          '|| nohup ollama serve >/dev/null 2>&1 &'
      ],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Filesystem-based model scanning — detect models even when Ollama is offline
// ---------------------------------------------------------------------------

export type ScannedOllamaModel = {
  name: string
  tag: string
  fullName: string
  sizeBytes: number
}

export type OllamaModelDetail = ScannedOllamaModel & {
  family: string | null
  parameterSize: string | null
  quantization: string | null
  format: string | null
}

export function defaultModelsFolder(): string {
  const env = process.env.OLLAMA_MODELS
  if (env) return env
  const platform = process.platform
  if (platform === 'darwin' || platform === 'linux') {
    return path.join(os.homedir(), '.ollama', 'models')
  }
  return path.join(os.homedir(), '.ollama', 'models')
}

export async function scanModelManifests(folder: string): Promise<ScannedOllamaModel[]> {
  const libraryDir = path.join(folder, 'manifests', 'registry.ollama.ai', 'library')
  try {
    await fs.access(libraryDir)
  } catch {
    return []
  }

  const results: ScannedOllamaModel[] = []
  let modelDirs: string[]
  try {
    modelDirs = await fs.readdir(libraryDir)
  } catch {
    return []
  }

  for (const modelName of modelDirs) {
    const modelPath = path.join(libraryDir, modelName)
    let stat
    try {
      stat = await fs.stat(modelPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    let tags: string[]
    try {
      tags = await fs.readdir(modelPath)
    } catch {
      continue
    }

    for (const tag of tags) {
      const manifestPath = path.join(modelPath, tag)
      let manifestStat
      try {
        manifestStat = await fs.stat(manifestPath)
      } catch {
        continue
      }
      if (!manifestStat.isFile()) continue

      try {
        const raw = await fs.readFile(manifestPath, 'utf8')
        const manifest = JSON.parse(raw) as {
          layers?: Array<{ size?: number }>
        }
        const sizeBytes = (manifest.layers ?? []).reduce(
          (sum, l) => sum + (typeof l.size === 'number' ? l.size : 0),
          0
        )
        const fullName = `${modelName}:${tag}`
        results.push({ name: modelName, tag, fullName, sizeBytes })
      } catch {
        // corrupt manifest, skip
      }
    }
  }

  return results
}

export async function enrichWithDetails(
  models: ScannedOllamaModel[],
  endpoint: string = DEFAULT_ENDPOINT
): Promise<OllamaModelDetail[]> {
  const reachable = await detect(endpoint)
  if (!reachable) {
    return models.map((m) => ({
      ...m,
      family: null,
      parameterSize: null,
      quantization: null,
      format: null
    }))
  }

  return Promise.all(
    models.map(async (m) => {
      const info = await showModel(m.fullName, endpoint)
      const details = info?.details as
        | {
            family?: string
            parameter_size?: string
            quantization_level?: string
            format?: string
          }
        | undefined
      return {
        ...m,
        family: details?.family ?? null,
        parameterSize: details?.parameter_size ?? null,
        quantization: details?.quantization_level ?? null,
        format: details?.format ?? null
      }
    })
  )
}
