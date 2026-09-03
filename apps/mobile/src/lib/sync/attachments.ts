import type { MessageAttachment, MessageAttachmentType } from '@/lib/conversations/types'
import {
  discardStagedFile,
  importLocalFile,
  stageOutgoingFile,
  type StagedFile
} from '@/lib/files/fileCache'
import { classifyFile } from '@/lib/files/fileKinds'
import type { PickedFile } from '@/lib/files/pickAttachments'
import { chooseUploadPath, uploadFileToCloud } from '@/lib/sync/files'
import { mintConversationId } from '@/lib/conversations/types'

/**
 * Getting the composer's staged files onto the desktop, in the order that keeps
 * the chat honest at every step.
 *
 * The file lands in the org first — content-addressed, under the workspace
 * path this phone chooses the way the desktop would (`uploads/conv-…/`,
 * renamed Finder-style on a collision) — and the desktop fetches it from
 * there when the message that names it arrives. Uploading a photo is a
 * second or two; the message is on screen from the tap.
 *
 * So the bytes move twice:
 *
 *   pick   → staged path in the workspace   (bubble renders from the cache)
 *   upload → the chosen workspace path      (bubble re-renders, same bytes)
 *
 * Both are cache hits, so neither transition costs a download or a frame — the
 * second one is invisible. And because the phone keeps a copy under the real
 * path, opening the conversation later never re-fetches what it just sent.
 */

/** A picked file whose bytes are parked in the workspace, ready to send. */
export type StagedAttachment = {
  picked: PickedFile
  staged: StagedFile
}

/** How a batch ended, per file, so the caller can say what did not go. */
export type DeliveryResult = {
  attachments: MessageAttachment[]
  /** Names of files whose transfer broke. The rest of the message still sends. */
  failed: string[]
  /** The conversation the files landed in — minted HERE when the message
   *  that carries them is the first one; the desktop creates it under this
   *  id when the send arrives. */
  conversationId: string | null
}

/**
 * Move each picked file into the workspace so the optimistic bubble has
 * something to render. A file that cannot be staged is dropped here rather
 * than sent: without local bytes there is nothing to upload either.
 */
export async function stageForSend(files: PickedFile[]): Promise<StagedAttachment[]> {
  const out: StagedAttachment[] = []
  for (const picked of files) {
    const staged = await stageOutgoingFile(picked.uri, picked.id, picked.name)
    if (staged) out.push({ picked, staged })
  }
  return out
}

/**
 * The attachment a staged file becomes while it is still only on the phone —
 * what the optimistic bubble draws, and what the demo and offline paths send.
 * The type is re-derived from the name, the same way the desktop derives it,
 * so a card looks identical before and after the round trip.
 */
export function stagedAttachment(entry: StagedAttachment): MessageAttachment {
  return {
    type: attachmentTypeFor(entry.picked.name),
    filePath: entry.staged.relPath,
    originalName: entry.picked.name,
    mimeType: entry.picked.mimeType,
    sizeBytes: entry.staged.sizeBytes || entry.picked.sizeBytes,
    ...media(entry.picked)
  }
}

/**
 * Upload every staged file to the org and answer with the attachments the
 * message should carry — the workspace path each landed under, its content
 * hash (how the desktop fetches it from the org before the turn runs), and
 * the phone's measurements (width/height/duration for a library asset).
 *
 * The path is the phone's to choose now, so it is chosen the way the
 * desktop would: `uploads/conv-<id>/<name>`, renamed Finder-style when the
 * org already holds a live blob there. A message without a conversation yet
 * MINTS one here — the desktop creates it under this id when the send
 * arrives — so the files have a home before the prompt is even sent.
 *
 * Sequential on purpose: one upload at a time keeps the progress honest and
 * a broken transfer costs its own file only. Only call this signed in; a
 * transfer that breaks mid-batch is reported as what it is.
 */
export async function uploadForSend(
  entries: StagedAttachment[],
  conversationId: string | null
): Promise<DeliveryResult> {
  const attachments: MessageAttachment[] = []
  const failed: string[] = []
  const target = conversationId ?? mintConversationId()

  for (const entry of entries) {
    try {
      const filePath = await chooseUploadPath(`uploads/conv-${target}`, entry.picked.name)
      const uploaded = await uploadFileToCloud(entry.staged.uri, filePath, entry.picked.mimeType)
      // The staged bytes ARE the file the org now holds: move them to the
      // path they were uploaded under, so the bubble's re-render is a cache
      // hit rather than a download of what this phone just sent.
      await importLocalFile(entry.staged.uri, filePath, target)
      discardStagedFile(entry.staged.relPath)
      attachments.push({
        type: attachmentTypeFor(entry.picked.name),
        filePath,
        originalName: entry.picked.name,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        sha256: uploaded.sha256,
        ...media(entry.picked)
      })
    } catch (error) {
      // The transfer broke. Say so rather than sending a message that claims a
      // file the org has no bytes for — the desktop would drop the attachment
      // on arrival and the model would never learn there was one. The reason
      // goes to the console: the toast names the file, not the cause.
      console.warn(`[attachments] upload of ${entry.picked.name} failed:`, error)
      discardStagedFile(entry.staged.relPath)
      failed.push(entry.picked.name)
    }
  }

  return { attachments, failed, conversationId: target }
}

/**
 * File the staged bytes locally under a conversation's uploads folder — the
 * demo agent's path, and the one a paired phone takes when its desktop is out
 * of reach. Same shape the desktop would have produced, so the feed renders
 * one kind of attachment either way; the desktop's own copy replaces the
 * conversation wholesale when the link comes back.
 */
export async function fileLocally(
  entries: StagedAttachment[],
  conversationId: string
): Promise<MessageAttachment[]> {
  const attachments: MessageAttachment[] = []
  for (const entry of entries) {
    const relPath = `uploads/conv-${conversationId}/${entry.picked.name}`
    const landed = await importLocalFile(entry.staged.uri, relPath, conversationId)
    discardStagedFile(entry.staged.relPath)
    if (!landed) continue
    attachments.push({ ...stagedAttachment(entry), filePath: relPath })
  }
  return attachments
}

/** Give back every staged file — a send that never happened. */
export function discardStaged(entries: StagedAttachment[]): void {
  for (const entry of entries) discardStagedFile(entry.staged.relPath)
}

function media(picked: PickedFile): Partial<MessageAttachment> {
  return {
    ...(picked.width ? { width: picked.width } : {}),
    ...(picked.height ? { height: picked.height } : {}),
    ...(picked.durationSeconds ? { durationSeconds: picked.durationSeconds } : {})
  }
}

/**
 * The desktop's five attachment buckets, from the name. `classifyFile` is the
 * app's one classifier, and its richer kinds (code, sheet, markdown, html,
 * chart) all collapse into the desktop's `other` — which is exactly what the
 * desktop stores for them too.
 */
function attachmentTypeFor(name: string): MessageAttachmentType {
  const { kind } = classifyFile(name)
  switch (kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
      return kind
    default:
      return 'other'
  }
}
