import type { Segment } from '@preload/index'

/**
 * The folders a conversation has changed files in — derived from the
 * persisted segment stream, never from live state, so the chips over the
 * transcript are the same while a turn streams, after it ends, and when the
 * conversation is reopened from history.
 *
 * A folder counts as touched when a file-changing tool call (file_edit,
 * file_write, file_patch) completed successfully inside it. Every touched
 * folder collapses to its parent folder under the working folder — the first
 * path segment — so the chips name the top-level folders a run worked in,
 * never a chain of nested ones. The path comes from the result's diff when
 * the tool recorded one (already absolute — the plugin resolved it against
 * the working folder), and from the call's own `path` argument otherwise,
 * resolved against the first working folder when relative. Failed and denied
 * calls changed nothing and are skipped.
 */

export type TouchedFolder = {
  /** Absolute directory path — what opens when the chip is clicked. */
  path: string
  /** Short display name: the top-level directory under its working folder,
   *  or the folder's own name for the working folder root and paths outside
   *  every working folder. */
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
  return basename(dir)
}

/**
 * The folder a changed file is charged to: the file's directory collapsed to
 * the first path segment under its working folder, so nested folders never
 * earn chips of their own. Files directly in the working folder collapse to
 * the working folder itself; paths outside every working folder keep their
 * own directory.
 */
function touchedDir(file: string, folders: string[]): string {
  const dir = dirname(file)
  if (!dir) return ''
  const root = containingFolder(dir, folders)
  if (!root) return dir
  if (dir === root) return root
  const segment = dir.slice(root.length + 1).split('/')[0]
  return segment ? `${root}/${segment}` : root
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
