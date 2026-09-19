import type { Segment } from '@preload/index'

/**
 * The folders a conversation has changed files in — derived from the
 * persisted segment stream, never from live state, so the chips over the
 * transcript are the same while a turn streams, after it ends, and when the
 * conversation is reopened from history.
 *
 * A folder counts as touched when a file-changing tool call (file_edit,
 * file_write, file_patch) completed successfully inside it. Every touched
 * folder collapses to the one folder the chips name — the first path segment
 * under its working folder, or, with no working folder to read the path
 * against, the project folder its first source root or dot-directory opens
 * (projectRootCut) — so a run never costs the strip a chain of nested
 * directories, and two projects whose trees share a shape never leave two
 * chips that read the same. The path comes from the result's diff when the
 * tool recorded one (already absolute — the plugin resolved it against the
 * working folder), and from the call's own `path` argument otherwise,
 * resolved against the first working folder when relative. Failed and denied
 * calls changed nothing and are skipped.
 */

export type TouchedFolder = {
  /** Absolute directory path — what opens when the chip is clicked. */
  path: string
  /** Short display name: the top-level directory under its working folder,
   *  the working folder's own name for its root, and the project folder for
   *  paths outside every working folder. */
  label: string
  /** Distinct files changed anywhere under this folder. */
  files: number
}

const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(['file_edit', 'file_write', 'file_patch'])

type SegmentMessage = { role: string; segments?: Segment[] }

const SEP_RE = /[\\/]+/

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('~/')
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return idx === 0 ? '/' : ''
  return p.slice(0, idx)
}

function basename(p: string): string {
  const parts = p.split(SEP_RE).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function joinPath(base: string, rel: string): string {
  const parts = `${normalize(base)}/${rel.replace(/\\/g, '/')}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' && out.length > 0) continue
    if (part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/') || '/'
}

/** The working folder that contains `dir`, longest match first. */
function containingFolder(dir: string, folders: string[]): string | null {
  let best: string | null = null
  for (const raw of folders) {
    const folder = normalize(raw)
    if (dir === folder || dir.startsWith(`${folder}/`)) {
      if (!best || folder.length > best.length) best = folder
    }
  }
  return best
}

function labelFor(dir: string, folders: string[]): string {
  const root = containingFolder(dir, folders)
  if (root) {
    const rel = dir.slice(root.length).replace(/^\//, '')
    return rel || basename(root)
  }
  // Outside every working folder the chip is the project folder itself, so its
  // own name is the label.
  return basename(dir)
}

/**
 * Where the project folder ends for a path with no working folder to read it
 * against: the index of the first segment that opens a project's tree — a
 * source root (`src`, `lib`, `test`, …) or a repo-admin dot-directory
 * (`.github`, `.githooks`, …). Scanning left to right takes the OUTERMOST
 * boundary, which is what keeps the collapse at the project level: scanning
 * inward finds the second `src` of `…/src/renderer/src/pages` first and
 * leaves a chip named `src` for every project shaped that way. Containers
 * (`apps`, `pages`, `packages`) are not boundaries — they carry named things
 * — so `…/wolffish-cloud/apps/desktop/src/main/…` reads as `desktop`, the app
 * the path belongs to. Returns -1 when the path carries no boundary.
 */
const BOUNDARY_RE = /^(src|lib|test|tests|docs|doc|scripts)$/
const PROJECT_MARKER_RE = /^(\.github|\.githooks|\.gitlab|\.circleci|\.vscode|\.idea|\.husky)$/

function projectRootCut(parts: string[]): number {
  for (let i = 1; i < parts.length; i++) {
    if (BOUNDARY_RE.test(parts[i]) || PROJECT_MARKER_RE.test(parts[i])) return i
  }
  return -1
}

/**
 * The folder a changed file is charged to. Every touched directory collapses
 * to the project folder that opens its tree, so nested directories never earn
 * chips of their own — the strip names where the work happened, not the leaf
 * of every path it touched.
 *
 * Inside a working folder that folder is its first path segment. With none to
 * collapse against — a chat whose folders were never set, or whose folder was
 * since removed — the first boundary from the left settles it (projectRootCut);
 * a path with no boundary anywhere falls back to its own directory's parent,
 * keeping the directory itself when only two segments remain.
 */
function touchedDir(file: string, folders: string[]): string {
  const dir = dirname(file)
  if (!dir) return ''
  const root = containingFolder(dir, folders)
  if (root) {
    if (dir === root) return root
    const segment = dir.slice(root.length + 1).split('/')[0]
    return segment ? `${root}/${segment}` : root
  }
  const parts = dir.split('/').filter(Boolean)
  const cut = projectRootCut(parts)
  if (cut < 0) {
    if (parts.length <= 2) return dir
    const up = parts.slice(0, -1).join('/')
    return dir.startsWith('/') ? `/${up}` : up
  }
  const at = parts.slice(0, cut).join('/')
  return dir.startsWith('/') ? `/${at}` : at
}

/** The file each successful file-changing call touched, in stream order. */
export function collectChangedFiles(
  messages: SegmentMessage[],
  workingFolders: string[]
): string[] {
  const files: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.segments) continue
    const results = new Map<string, Extract<Segment, { kind: 'tool_result' }>>()
    for (const seg of message.segments) {
      if (seg.kind === 'tool_result') results.set(seg.toolCallId, seg)
    }
    for (const seg of message.segments) {
      if (seg.kind !== 'tool_call' || !FILE_CHANGING_TOOLS.has(seg.name)) continue
      const result = results.get(seg.toolCallId)
      if (!result || result.status !== 'success') continue
      const fromDiff = result.meta?.diff?.file
      const raw =
        typeof fromDiff === 'string' && fromDiff
          ? fromDiff
          : typeof seg.args.path === 'string'
            ? seg.args.path
            : ''
      if (!raw) continue
      const abs = isAbsolute(raw)
        ? normalize(raw)
        : workingFolders[0]
          ? joinPath(workingFolders[0], raw)
          : ''
      if (abs) files.push(abs)
    }
  }
  return files
}

export function collectTouchedFolders(
  messages: SegmentMessage[],
  workingFolders: string[]
): TouchedFolder[] {
  const byDir = new Map<string, Set<string>>()
  for (const file of collectChangedFiles(messages, workingFolders)) {
    const dir = touchedDir(file, workingFolders)
    if (!dir) continue
    const set = byDir.get(dir) ?? new Set<string>()
    set.add(file)
    byDir.set(dir, set)
  }
  const out: TouchedFolder[] = []
  for (const [dir, set] of byDir) {
    out.push({ path: dir, label: labelFor(dir, workingFolders), files: set.size })
  }
  return out
}
