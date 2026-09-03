import type { ChatMessage, UserContentBlock } from '@main/runtime/thalamus'
import { catalogVision } from '@main/cloud/catalog'

/**
 * Vision is the capability gate for multimodal content — it decides
 * whether image (and PDF document) blocks may travel to a given model.
 *
 * Maps to: the visual cortex — signals that the eyes can't process
 * never reach it.
 *
 * Text-only model APIs hard-reject multimodal content parts. DeepSeek, for
 * example, answers HTTP 400 `This model does not support image` the moment
 * an image part appears in `messages`, which kills the entire turn. The org
 * catalog (GET /v1/models) is the authority for the one lane: it carries a
 * vision flag per model. When the catalog cannot answer (cold cache), the
 * vendor-agnostic name markers below decide, and everything else is treated
 * as text-only. The asymmetry justifies the conservative default: a
 * wrongly-stripped image degrades one answer and says so in the prompt; a
 * wrongly-sent image fails the whole request.
 */

// Vendor-agnostic name markers. Vendors consistently tag their multimodal
// models: *-VL ("vl" as a hyphenated token), *-vision-*, *-omni, QVQ, and
// the open-weight llava/pixtral families.
const VISION_NAME_MARKERS = /vision|omni|llava|pixtral|qvq|(^|[-/_.:])vl([-/_.:]|$)/

export function cloudModelSupportsVision(provider: string, model: string): boolean {
  // The org catalog is authoritative for the one lane; the name markers are
  // the cold-cache fallback.
  if (provider === 'cloud') {
    const fromCatalog = catalogVision(model)
    if (fromCatalog !== null) return fromCatalog
  }
  // No catalog answer (cold cache, or a model the org has not described):
  // the vendor-agnostic name markers decide, and everything else is text-only.
  return VISION_NAME_MARKERS.test(model.toLowerCase())
}

/**
 * Whether any message carries content a text-only model can't accept:
 * image/document blocks in user messages, or images in tool results.
 */
export function hasVisualContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => messageHasVisual(m, 'all'))
}

function messageHasVisual(m: ChatMessage, scope: VisualStripScope): boolean {
  if (scope === 'all' && m.role === 'user' && typeof m.content !== 'string') {
    return m.content.some((b) => b.type === 'image' || b.type === 'document')
  }
  if (m.role === 'tool') return (m.images?.length ?? 0) > 0
  return false
}

export const TEXT_ONLY_STRIP_REASON = 'the active model is text-only and cannot view them'

/** Stage 1: only tool-result images were removed. User attachments stay. */
export const TOOL_RESULT_MODALITY_STRIP_REASON =
  'this provider rejected image parts inside a tool result'

/** Stage 2: every remaining visual was removed after stage 1 also rejected. */
export const REQUEST_MODALITY_STRIP_REASON = 'this provider rejected image parts in this request'

export type VisualStripScope = 'tool' | 'all'

/**
 * Same predicate the live harness uses to decide "this 400/422 is a
 * modality reject, not an auth/model-id failure." One regex so the two
 * cannot drift.
 */
export const MODALITY_REJECT_PATTERN = /image|multimodal|content part|unknown variant/i

export function isModalityReject(message: string): boolean {
  return MODALITY_REJECT_PATTERN.test(message)
}

/**
 * Replace visual content with a text note explaining what was removed
 * and where the original files live, so the model can reach for file
 * tools instead of hallucinating what it "saw". Returns the input array
 * unchanged (same reference) when there is nothing to strip.
 *
 * `reason` is interpolated into the notes for whatever this call removes.
 * `scope` `'tool'` strips only tool-result images (user attachments stay);
 * `'all'` (default) strips user-message images/PDFs as well.
 */
export function stripVisualContent(
  messages: ChatMessage[],
  reason: string = TEXT_ONLY_STRIP_REASON,
  scope: VisualStripScope = 'all'
): ChatMessage[] {
  if (!messages.some((m) => messageHasVisual(m, scope))) return messages
  return messages.map((m) => {
    if (scope === 'all' && m.role === 'user' && typeof m.content !== 'string') {
      let images = 0
      let documents = 0
      const kept: UserContentBlock[] = []
      for (const block of m.content) {
        if (block.type === 'image') images++
        else if (block.type === 'document') documents++
        else kept.push(block)
      }
      if (images === 0 && documents === 0) return m
      kept.push({ type: 'text', text: omittedNote(images, documents, reason) })
      return { ...m, content: kept }
    }
    if (m.role === 'tool' && m.images && m.images.length > 0) {
      const count = m.images.length
      // The imperative matters: a blind model that is merely informed its
      // screenshot was removed will happily keep clicking from imagination
      // (observed live with DeepSeek driving computer_screenshot). Telling
      // it what to do instead turns silent flailing into an actionable stop.
      const note =
        `\n[${count} image${count === 1 ? '' : 's'} from this tool result omitted — ${reason}. ` +
        `You cannot see this image, so do not guess at its contents. If the task depends on seeing it ` +
        `(screenshots, screen control, visual checks), stop that part now and tell the user to switch ` +
        `to a vision-capable model.]`
      return { ...m, images: undefined, content: m.content + note }
    }
    return m
  })
}

/** Newest tool-result images kept in full once pruning starts. */
export const TOOL_IMAGES_KEEP = 6

/**
 * Older images are dropped in batches of this size, not one per turn: each
 * drop rewrites an early message and breaks the provider prompt-cache
 * prefix, so amortizing the damage to one rewrite per BATCH new images
 * keeps long computer-use sessions cacheable.
 */
export const TOOL_IMAGES_PRUNE_BATCH = 4

/**
 * Keep only the newest tool-result images in the request; older ones are
 * replaced by a text note. Two reasons, both observed in long screen-control
 * sessions: dozens of near-identical screenshots make the model ground its
 * next click on a stale frame, and they dominate token cost. User-attached
 * images are never touched. Deterministic over message order, so identical
 * histories encode identically. Returns the input array unchanged (same
 * reference) when nothing is pruned.
 */
export function limitToolResultImages(
  messages: ChatMessage[],
  keep: number = TOOL_IMAGES_KEEP,
  batch: number = TOOL_IMAGES_PRUNE_BATCH
): ChatMessage[] {
  let total = 0
  for (const m of messages) {
    if (m.role === 'tool') total += m.images?.length ?? 0
  }
  const droppable = total - keep
  if (droppable < batch) return messages
  let toDrop = Math.floor(droppable / batch) * batch
  return messages.map((m) => {
    if (toDrop <= 0 || m.role !== 'tool' || !m.images || m.images.length === 0) return m
    const n = Math.min(toDrop, m.images.length)
    toDrop -= n
    const kept = m.images.slice(n)
    const note =
      `\n[${n} older image${n === 1 ? '' : 's'} from this tool result omitted to keep context lean — ` +
      `only the newest images in the conversation are retained. The screen has changed since; ` +
      `take a fresh screenshot (or re-view the file) instead of acting from memory of this image.]`
    return { ...m, images: kept.length > 0 ? kept : undefined, content: m.content + note }
  })
}

function omittedNote(images: number, documents: number, reason: string): string {
  const parts: string[] = []
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`)
  if (documents > 0) parts.push(`${documents} PDF document${documents === 1 ? '' : 's'}`)
  return `[${parts.join(' and ')} omitted — ${reason}. The original files are on disk; their paths are listed in the <attachments> block of this message. Use file tools if the task needs their contents.]`
}
