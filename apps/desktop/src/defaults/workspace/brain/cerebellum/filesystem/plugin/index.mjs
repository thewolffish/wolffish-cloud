import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

const MAX_READ_BYTES = 200_000
const NO_RANGE_HEAD_BYTES = 4_096
const READ_CHUNK_BYTES = 1024 * 1024
// A "line" longer than this means a binary or single-line monster — bail
// with guidance instead of buffering the whole file.
const MAX_CARRY_BYTES = 8 * 1024 * 1024

const toolDefinitions = [
  {
    name: 'file_read',
    description:
      'Read a text file. With startLine/endLine it streams exactly that range — any line of any size of file is reachable (a deep range in a multi-GB file works). Without a range, large files return only a head preview plus size facts; page through them with explicit ranges.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ prefix' },
        startLine: { type: 'number', description: '1-based first line' },
        endLine: { type: 'number', description: '1-based last line' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_write',
    description: 'Create or overwrite a text file. mode=append appends instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ prefix' },
        content: { type: 'string', description: 'Text to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'] }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'file_patch',
    description: 'Find a literal string in a file and replace every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ prefix' },
        find: { type: 'string', description: 'Literal text to search for' },
        replace: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'find', 'replace']
    }
  },
  {
    name: 'image_view',
    description:
      'View an image file — returns the actual pixels in the tool result. Attached images are never auto-loaded, so this is how you SEE one. You choose the view, and the choice is a real cost/clarity trade — max_dimension sets the long edge (default 1024, which reads scenes, layout and large type; raise to 1600-2048 only when you must resolve small text), region crops in the ORIGINAL pixel grid before any resize, and format png keeps screenshots, UI, charts and text crisp while jpeg suits photographs. Prefer a tight region at a modest max_dimension over a large max_dimension on the whole frame — a crop is sharper AND cheaper, because cost tracks the pixels you send, not the size of the file. Requires a vision-capable model; on text-only models the pixels are stripped and you should rely on shell tools (exiftool/sips) for metadata instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ prefix to the image file' },
        max_dimension: {
          type: 'integer',
          description:
            'Long edge of the returned view in pixels (default 1024). Never upscales past the source, so a value larger than the image simply returns it at native size.'
        },
        region: {
          type: 'object',
          description:
            'Crop to inspect, in ORIGINAL image pixels, applied before the resize. Omit to view the whole frame. Out-of-bounds rectangles are clamped and the result says so.',
          properties: {
            x: { type: 'integer', description: 'Left edge in original pixels' },
            y: { type: 'integer', description: 'Top edge in original pixels' },
            width: { type: 'integer', description: 'Crop width in original pixels' },
            height: { type: 'integer', description: 'Crop height in original pixels' }
          },
          required: ['x', 'y', 'width', 'height']
        },
        format: {
          type: 'string',
          description: 'jpeg (default, best for photographs) or png (lossless, best for text and UI)',
          enum: ['jpeg', 'png']
        },
        quality: {
          type: 'integer',
          description: 'JPEG quality 1-100 (default 75). Ignored for png.'
        }
      },
      required: ['path']
    }
  }
]

function workspaceRoot() {
  return path.join(homedir(), '.wolffish', 'workspace')
}

// Accept absolute, ~/-relative, and workspace-relative paths. Relative paths
// resolve against the workspace root — that's where the agent keeps generated
// files (files/…, uploads/…), matching the utilities plugin's send_file —
// never against cwd (the repo in dev, "/" in a packaged app).
function resolveUserPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path is required')
  }
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2))
  }
  return path.resolve(workspaceRoot(), input)
}

/**
 * Stream a 1-based inclusive line range out of a file of any size. Scans
 * in chunks, splits only at newline bytes (a safe boundary in UTF-8), keeps
 * nothing but the requested lines, and stops reading as soon as the range
 * is collected. The old implementation sliced lines AFTER truncating the
 * file at 200KB, which made every line past that byte offset permanently
 * unreachable — fatal for querying big files.
 */
async function readLineRange(target, startLine, endLine) {
  const fh = await fs.open(target, 'r')
  try {
    const collected = []
    let collectedBytes = 0
    let capped = false
    let lineNo = 1
    let carry = Buffer.alloc(0)
    let pos = 0
    const buf = Buffer.alloc(READ_CHUNK_BYTES)

    let oversizedLine = false
    const takeLine = (lineBuf) => {
      if (lineNo >= startLine && lineNo <= endLine) {
        if (collectedBytes + lineBuf.length > MAX_READ_BYTES) {
          // A single line bigger than the whole budget still makes progress:
          // serve its head instead of capping with nothing collected.
          if (collected.length === 0) {
            collected.push(lineBuf.subarray(0, MAX_READ_BYTES).toString('utf8'))
            collectedBytes += MAX_READ_BYTES
            oversizedLine = true
          }
          capped = true
          return false
        }
        collected.push(lineBuf.toString('utf8'))
        collectedBytes += lineBuf.length + 1
      }
      lineNo++
      return lineNo <= endLine
    }

    outer: while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK_BYTES, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      let chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      let searchFrom = 0
      while (true) {
        const nl = chunk.indexOf(0x0a, searchFrom)
        if (nl === -1) break
        if (!takeLine(chunk.subarray(searchFrom, nl))) break outer
        searchFrom = nl + 1
      }
      carry = Buffer.from(chunk.subarray(searchFrom))
      if (carry.length > MAX_CARRY_BYTES) {
        return {
          success: false,
          error: `A single line in ${target} exceeds ${MAX_CARRY_BYTES / 1024 / 1024}MB — this looks like a binary or single-line file. Use shell tools (head -c, rg, jq) instead of line-based reads.`
        }
      }
    }
    if (!capped && lineNo >= startLine && lineNo <= endLine && carry.length > 0) {
      takeLine(carry)
    }

    const lastServed = startLine + collected.length - 1
    const header = `// ${target}:${startLine}-${collected.length > 0 ? lastServed : startLine}`
    const notes = []
    if (oversizedLine) {
      notes.push(
        `[Line ${lastServed} alone exceeds the ${Math.round(MAX_READ_BYTES / 1000)}KB per-call limit — its head is shown. For the rest of it use shell tools (cut -c, jq for JSON). Nothing was skipped silently.]`
      )
    } else if (capped) {
      notes.push(
        `[Stopped at the ${Math.round(MAX_READ_BYTES / 1000)}KB per-call limit after line ${lastServed}. Continue with startLine=${lastServed + 1}. Nothing was skipped silently.]`
      )
    } else if (collected.length === 0) {
      notes.push(`[No lines in that range — the file ends at line ${lineNo - 1}.]`)
    }
    return {
      success: true,
      output: [header, collected.join('\n'), notes.join('\n')].filter(Boolean).join('\n')
    }
  } finally {
    await fh.close()
  }
}

async function readFile(args) {
  const target = resolveUserPath(args?.path)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    // Auto-list parent directory so the LLM can self-correct without a second call
    const parentDir = path.dirname(target)
    let hint = ''
    try {
      const entries = await fs.readdir(parentDir)
      hint = entries.length > 0
        ? `\nParent directory ${parentDir} contains: ${entries.join(', ')}`
        : `\nParent directory ${parentDir} exists but is empty.`
    } catch {
      hint = `\nParent directory ${parentDir} also does not exist.`
    }
    return { success: false, error: `ENOENT: ${target} not found.${hint}` }
  }

  const startLine = typeof args?.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : null
  const endLine = typeof args?.endLine === 'number' ? Math.max(1, Math.floor(args.endLine)) : null

  if (startLine !== null || endLine !== null) {
    try {
      return await readLineRange(target, startLine ?? 1, endLine ?? Infinity)
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  // No range requested. Small files come back whole; large files come back
  // as a bounded head preview plus the facts needed to plan ranged reads —
  // never a silent mid-file truncation.
  if (stat.size <= MAX_READ_BYTES) {
    try {
      return { success: true, output: await fs.readFile(target, 'utf8') }
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  const fh = await fs.open(target, 'r')
  try {
    const buf = Buffer.alloc(NO_RANGE_HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, NO_RANGE_HEAD_BYTES, 0)
    let head = buf.subarray(0, bytesRead).toString('utf8')
    const lastNl = head.lastIndexOf('\n')
    if (lastNl > 0) head = head.slice(0, lastNl)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1)
    return {
      success: true,
      output:
        `${head}\n\n[This file is ${sizeMb}MB — only the first ${Math.round(NO_RANGE_HEAD_BYTES / 1024)}KB is shown above. ` +
        `Read any exact region with startLine/endLine (streams the range, works at any depth), ` +
        `count lines with your shell tool (wc -l), and search it exhaustively with rg -n. Nothing was skipped silently.]`
    }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  } finally {
    await fh.close()
  }
}

async function writeFile(args) {
  const target = resolveUserPath(args?.path)
  const content = typeof args?.content === 'string' ? args.content : ''
  const mode = args?.mode === 'append' ? 'append' : 'overwrite'
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (mode === 'append') {
      await fs.appendFile(target, content, 'utf8')
    } else {
      await fs.writeFile(target, content, 'utf8')
    }
    return {
      success: true,
      output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${content.length} bytes to ${target}`
    }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
}

async function patchFile(args) {
  const target = resolveUserPath(args?.path)
  const find = typeof args?.find === 'string' ? args.find : ''
  const replace = typeof args?.replace === 'string' ? args.replace : ''
  if (find.length === 0) {
    return { success: false, error: 'find is required and must be non-empty' }
  }
  let content
  try {
    content = await fs.readFile(target, 'utf8')
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
  const parts = content.split(find)
  const occurrences = parts.length - 1
  if (occurrences === 0) {
    return { success: false, error: `Pattern not found in ${target}` }
  }
  const updated = parts.join(replace)
  try {
    await fs.writeFile(target, updated, 'utf8')
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
  return {
    success: true,
    output: `Replaced ${occurrences} occurrence(s) in ${target}`
  }
}

const IMAGE_VIEW_MAX_DIMENSION = 1024
const IMAGE_VIEW_JPEG_QUALITY = 75

/**
 * Mirrors MAX_INLINE_IMAGE_BYTES in src/main/runtime/tool-images.ts. The
 * runtime silently drops any tool-result image above that cap and leaves
 * a note in its place. The model picks its own dimensions here, so this
 * is the only place that can notice an over-cap encode and step it down
 * instead of letting the picture vanish on the way to the wire.
 */
const IMAGE_VIEW_WIRE_CAP_BYTES = 3 * 1024 * 1024

function imageViewInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * The model's rectangle intersected with the real image. Returning a
 * clamped rect rather than an error keeps a slightly-off crop useful —
 * sharp's extract() throws on any overflow, which would cost a round trip
 * to fix an off-by-a-few guess about an image the model has only seen
 * downscaled. The caption reports the clamp so the coordinates can be
 * corrected on the next call.
 */
function imageViewRegion(raw, srcWidth, srcHeight) {
  if (!raw || typeof raw !== 'object' || !srcWidth || !srcHeight) return null
  const left = imageViewInt(raw.x, 0, srcWidth - 1, 0)
  const top = imageViewInt(raw.y, 0, srcHeight - 1, 0)
  const width = imageViewInt(raw.width, 1, srcWidth - left, srcWidth - left)
  const height = imageViewInt(raw.height, 1, srcHeight - top, srcHeight - top)
  const asked = {
    left: imageViewInt(raw.x, -1e9, 1e9, 0),
    top: imageViewInt(raw.y, -1e9, 1e9, 0),
    width: imageViewInt(raw.width, -1e9, 1e9, width),
    height: imageViewInt(raw.height, -1e9, 1e9, height)
  }
  const clamped =
    asked.left !== left || asked.top !== top || asked.width !== width || asked.height !== height
  return { left, top, width, height, clamped }
}

/**
 * Attached images are never auto-injected into model context (100%
 * model-led policy) — this tool is how a vision model actually sees one.
 * Downscales via sharp (a lazily-installed runtime dep, same pattern as
 * the pdf capability's pdf-parse) and returns the pixels through the
 * StepResult images channel, exactly like the computer-use screenshot
 * tool. Decode failures (corrupt files, >268-megapixel inputs sharp
 * refuses) come back as clear errors with a shell-tool fallback.
 *
 * Dimensions, crop and encoding are the model's call, not this tool's —
 * a fixed 1024px view cannot resolve a receipt or a code screenshot, and
 * the model is the only party that knows whether this call needs to read
 * fine print or just recognize a scene. The defaults stay at the old
 * behaviour so an unparameterized call is unchanged.
 */
async function imageView(args) {
  const target = resolveUserPath(args?.path)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { success: false, error: `ENOENT: ${target} not found.` }
  }
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(target).metadata()
    const srcWidth = meta.width ?? 0
    const srcHeight = meta.height ?? 0

    const format = args?.format === 'png' ? 'png' : 'jpeg'
    const quality = imageViewInt(args?.quality, 1, 100, IMAGE_VIEW_JPEG_QUALITY)
    const region = imageViewRegion(args?.region, srcWidth, srcHeight)
    // No arbitrary ceiling: `withoutEnlargement` already bounds the request
    // by the source's own resolution, and the step-down below bounds it by
    // what the wire will carry. A cap here would just be a number to argue
    // with later.
    let edge = imageViewInt(args?.max_dimension, 1, 1e6, IMAGE_VIEW_MAX_DIMENSION)

    let buffer
    let info
    let steppedDown = false
    for (let attempt = 0; attempt < 4; attempt++) {
      let pipeline = sharp(target)
      if (region) {
        pipeline = pipeline.extract({
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height
        })
      }
      pipeline = pipeline.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
      const encoded = await (format === 'png'
        ? pipeline.png()
        : pipeline.jpeg({ quality })
      ).toBuffer({ resolveWithObject: true })
      buffer = encoded.data
      info = encoded.info
      if (buffer.length <= IMAGE_VIEW_WIRE_CAP_BYTES) break
      steppedDown = true
      // Bytes fall with area, so the long edge scales by the square root of
      // the overshoot; the 0.9 is headroom against a bad estimate on noisy
      // sources. Floor at 256 so a pathological image still returns pixels.
      const ratio = Math.sqrt(IMAGE_VIEW_WIRE_CAP_BYTES / buffer.length) * 0.9
      edge = Math.max(256, Math.floor(Math.max(info.width, info.height) * ratio))
    }

    const original =
      srcWidth && srcHeight ? `${srcWidth}x${srcHeight}` : 'unknown dimensions'
    const regionLabel = region
      ? ` region ${region.left},${region.top} ${region.width}x${region.height}` +
        `${region.clamped ? ' (clamped to image bounds)' : ''};`
      : ''
    const qualityLabel = format === 'jpeg' ? ` q${quality}` : ''
    const stepLabel = steppedDown
      ? `, stepped down from the requested size to stay under the ${IMAGE_VIEW_WIRE_CAP_BYTES / (1024 * 1024)}MB inline limit`
      : ''
    return {
      success: true,
      output:
        `Viewing ${target} — the pixels are attached to this result (original ${original}, ` +
        `${(stat.size / 1024).toFixed(0)}KB;${regionLabel} sent at ${info.width}x${info.height} ` +
        `${format}${qualityLabel}, ${(buffer.length / 1024).toFixed(0)}KB${stepLabel}).\n` +
        `These pixels are in context for THIS turn only — later turns keep this line but not the ` +
        `image. Call image_view again on the same path to see it once more, with a region or a ` +
        `larger max_dimension if you need finer detail.`,
      images: [{ mediaType: format === 'png' ? 'image/png' : 'image/jpeg', data: buffer.toString('base64') }]
    }
  } catch (err) {
    const reason = err?.message ?? String(err)
    return {
      success: false,
      error: `Could not decode ${target} (${String(reason).slice(0, 200)}). Inspect it with shell tools instead (sips -g all, exiftool, ffprobe), or convert/downscale a copy with sips or ffmpeg and view that.`
    }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path ?? '')
  if (toolName === 'file_read') {
    const range =
      typeof args?.startLine === 'number' || typeof args?.endLine === 'number'
        ? ` (lines ${args?.startLine ?? 1}-${args?.endLine ?? 'end'})`
        : ''
    return {
      title: 'Read file',
      description: `Read ${targetPath}${range}`,
      risk: 'low'
    }
  }
  if (toolName === 'file_write') {
    const mode = args?.mode === 'append' ? 'Append to' : 'Write'
    const bytes = typeof args?.content === 'string' ? args.content.length : 0
    return {
      title: `${mode} file`,
      description: `${mode} ${bytes} bytes to ${targetPath}`,
      command: targetPath,
      impact: args?.mode === 'append' ? undefined : 'Overwrites the file if it exists.',
      risk: 'medium'
    }
  }
  if (toolName === 'file_patch') {
    return {
      title: 'Patch file',
      description: `Find-and-replace in ${targetPath}`,
      command: targetPath,
      risk: 'medium'
    }
  }
  if (toolName === 'image_view') {
    return {
      title: 'View image',
      description: `View ${targetPath}`,
      risk: 'low'
    }
  }
  return null
}

const plugin = {
  name: 'filesystem',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'file_read':
        return readFile(args)
      case 'file_write':
        return writeFile(args)
      case 'file_patch':
        return patchFile(args)
      case 'image_view':
        return imageView(args)
      default:
        return { success: false, error: `filesystem: unknown tool ${toolName}` }
    }
  }
}

export default plugin
