// Utilities — small, always-available helper tools that are too small to
// each warrant their own capability. Add new general-purpose tools here:
// register them in toolDefinitions, handle them in execute(), and (if they
// take a notable argument) describe them in describeAction().
//
// Tools:
//   - send_file: deliver a file to the user as a native attachment on
//     whatever channel they're on (in-app, WhatsApp, Telegram).
//   - show_path: push an openable location card for a folder/file on disk
//     into the in-app chat (folder → Open, file → Reveal in folder).

import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// No size ceiling here on purpose. This tool is CHANNEL-BLIND — it emits a
// marker and the surface the user is actually on decides what to do with it —
// so a bot API's 50 MB upload limit does not belong at this layer: it made the
// in-app chat and the CLI, which upload nothing and read the file straight off
// local disk, refuse files they could have delivered instantly. Telegram and
// WhatsApp enforce their own limits at the point of upload (they stat before
// reading, and Telegram re-encodes oversized video), which is the only place
// the limit is real.

// Type buckets mirror the channel + renderer extractors so the
// `[wolffish-output: <path> (<type>)]` marker we emit is recognized and
// delivered everywhere. Anything not in these sets is delivered as a
// generic `(file)` (rendered as a file card / sent as a document).
// One suffix-based type rides above the buckets: `*.chart.json` → `(chart)`,
// the interactive chart-card spec (see the dataviz capability) — the in-app
// renderer draws it as a live chart; channels fall back to a document send.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm'])
const DOCUMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv'])

function workspaceRoot() {
  return path.join(homedir(), '.wolffish', 'workspace')
}

function classify(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  return 'file'
}

// Accept absolute, ~/-relative, and workspace-relative paths. Relative
// paths resolve against the workspace root — that's where the agent saves
// generated files (files/…, uploads/…).
function resolveInput(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const p = raw.trim()
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2))
  if (path.isAbsolute(p)) return p
  return path.resolve(workspaceRoot(), p)
}

// The in-app renderer can only read files inside the workspace. If the
// file lives elsewhere (~/Desktop, /tmp, …) copy it into workspace/files/
// so the in-app viewer can load it. Remote channels read the path directly
// either way. Mirrors the shell plugin's opened-file surfacing.
async function ensureInWorkspace(abs) {
  const wsRoot = workspaceRoot()
  if (abs === wsRoot || abs.startsWith(wsRoot + path.sep)) return abs

  const filesDir = path.join(wsRoot, 'files')
  await mkdir(filesDir, { recursive: true })

  const ext = path.extname(abs)
  const baseName = path.basename(abs)
  const stem = path.basename(baseName, ext)
  const srcSize = (await stat(abs)).size

  let destPath = path.join(filesDir, baseName)
  let suffix = 0
  while (existsSync(destPath)) {
    const destSize = await stat(destPath)
      .then((s) => s.size)
      .catch(() => -1)
    // Same name and size ⇒ already copied; reuse instead of piling up copies.
    if (destSize === srcSize) return destPath
    suffix++
    destPath = path.join(filesDir, `${stem}_${suffix}${ext}`)
  }
  await copyFile(abs, destPath)
  return destPath
}

async function sendFile(args) {
  const input = resolveInput(args?.file ?? args?.path)
  if (!input) return { success: false, error: 'file is required (path to the file to deliver)' }

  let st
  try {
    st = await stat(input)
  } catch {
    return { success: false, error: `file not found: ${input}` }
  }
  if (!st.isFile()) return { success: false, error: `not a file: ${input}` }
  if (st.size === 0) return { success: false, error: `file is empty: ${input}` }

  let markerPath = input
  try {
    markerPath = await ensureInWorkspace(input)
  } catch {
    // Copy failed — remote channels can still send the original absolute path.
  }

  // `.chart.json` outranks the extension buckets: the full suffix — not the
  // bare `.json` — is what routes a chart spec to the in-app chart card.
  const isChart = markerPath.toLowerCase().endsWith('.chart.json')
  const type = isChart ? 'chart' : classify(path.extname(markerPath).toLowerCase())
  // The marker is what every channel + the in-app renderer parse to deliver
  // the file. Emit it as the whole output so nothing leaks as stray text.
  return { success: true, output: `[wolffish-output: ${markerPath} (${type})]` }
}

async function showPath(args) {
  const input = resolveInput(args?.path ?? args?.file)
  if (!input) return { success: false, error: 'path is required (folder or file to show)' }
  let st
  try {
    st = await stat(input)
  } catch {
    return { success: false, error: `path not found: ${input}` }
  }
  // The marker is what the in-app renderer parses into the openable location
  // card (folder → Open, file → Reveal in folder). Emit it as the whole
  // output so nothing leaks as stray text. The type is captured at call time
  // so a card in a resumed conversation still knows what it pointed at after
  // the path is deleted (it renders disabled with an "unavailable" note).
  // Channels don't recognize it — nothing to open on WhatsApp/Telegram.
  return {
    success: true,
    output: `[wolffish-path: ${input} (${st.isDirectory() ? 'folder' : 'file'})]`
  }
}

function describeAction(toolName, args) {
  if (toolName === 'send_file') {
    const f = String(args?.file ?? args?.path ?? '').trim()
    return {
      title: 'Send file',
      description: f
        ? `Deliver ${path.basename(f)} to the conversation`
        : 'Deliver a file to the conversation',
      risk: 'low'
    }
  }
  if (toolName === 'show_path') {
    const p = String(args?.path ?? args?.file ?? '').trim()
    return {
      title: 'Show location',
      description: p
        ? `Show ${path.basename(p.replace(/[/\\]+$/, '')) || p} as an openable card`
        : 'Show a location as an openable card',
      risk: 'low'
    }
  }
  return null
}

const toolDefinitions = [
  {
    name: 'send_file',
    description:
      'Deliver a file to the user as a downloadable attachment in the current conversation (in-app chat, CLI, WhatsApp, or Telegram). Works for any file type. THE ONLY WAY a file reaches the user — no tool auto-delivers its output. In-app and CLI have no size limit; WhatsApp and Telegram enforce their own upload ceilings and say so if a file is too big to send there.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Path to the file to deliver. Absolute, ~/-relative, or workspace-relative.'
        }
      },
      required: ['file']
    }
  },
  {
    name: 'show_path',
    description:
      'Push an openable location card for a folder or file on disk into the in-app chat: a folder gets an Open button (opens in the OS file manager), a file gets a Reveal button (opens its folder with the file selected). The path must exist. In-app desktop chat only — on WhatsApp/Telegram nothing renders, so name the path in prose there instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder or file to show. Absolute, ~/-relative, or workspace-relative.'
        }
      },
      required: ['path']
    }
  }
]

const plugin = {
  name: 'utilities',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'send_file':
        return sendFile(args)
      case 'show_path':
        return showPath(args)
      default:
        return { success: false, error: `utilities: unknown tool ${toolName}` }
    }
  }
}

export default plugin
