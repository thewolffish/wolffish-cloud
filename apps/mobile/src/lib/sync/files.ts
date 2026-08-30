import { fromBase64Url, toBase64Url } from '@/lib/tunnel/pairing'
import { CHUNK_SIZE, Rpc } from '@/lib/tunnel/protocol'
import { tunnelClient } from '@/lib/tunnel/client'
import { File, FileMode } from 'expo-file-system'

/**
 * Workspace file bytes over the tunnel — the paired counterpart of the demo
 * CDN. Bytes ride ordinary RPC frames as base64url in CHUNK_SIZE windows, so
 * nothing here touches the transport layer; the desktop validates every path
 * against its workspace root and picks the final name for every upload.
 *
 * Only transfer lives here. What to fetch and where it lands is the file
 * cache's business (lib/files/fileCache.ts calls into this module), and what
 * to prefetch is the sync layer's (lib/sync/sync.ts) — keeping this file free
 * of both avoids an import cycle between the cache and sync.
 */

type FileStat = { exists: boolean; sizeBytes: number }
type FileChunk = { data: string; sizeBytes: number }

/** Attachment metadata as the desktop stores it — what uploadCommit answers. */
export type DesktopAttachment = {
  type: 'audio' | 'video' | 'image' | 'pdf' | 'other'
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

/**
 * How a desktop file transfer ended. The distinction between the last two is
 * load-bearing for every file card on screen:
 *
 *   'done'    the whole file landed in `scratch`;
 *   'absent'  the DESKTOP ANSWERED and said the path does not exist — the one
 *             outcome that may render as "deleted";
 *   'failed'  the transfer broke — not connected, an RPC timed out under a
 *             busy link, the socket flapped mid-file, the file shrank. The
 *             file may be perfectly fine on the desktop; the only honest next
 *             move is to try again.
 *
 * Collapsing 'failed' into 'absent' was how a transient stall during a busy
 * sync pass painted "file was deleted or unavailable" over files that were
 * fine, permanently, until the conversation was reopened.
 */
export type DesktopFileFetch = 'done' | 'absent' | 'failed'

/**
 * Download a workspace file into `scratch`, chunk by chunk. See
 * DesktopFileFetch for the outcomes; on anything but 'done' the caller keeps
 * its cache untouched.
 *
 * `onProgress` is called with the size before the first chunk and after every
 * one after it, which is what lets a file card show a real bar rather than a
 * spinner. It is advisory: throwing from it would fail the transfer, so the
 * caller keeps it cheap.
 */
export async function fetchDesktopFileInto(
  relPath: string,
  scratch: File,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<DesktopFileFetch> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return 'failed'

  try {
    const stat = (await tunnel.rpc(Rpc.fileStat, { path: relPath })) as FileStat
    if (!stat?.exists) return 'absent'
    // The size is known a full round-trip before any bytes are — publish it
    // now so the bar is sized correctly from its first frame.
    onProgress?.(0, stat.sizeBytes)

    scratch.create({ intermediates: true, overwrite: true })
    const handle = scratch.open(FileMode.Append)
    try {
      let offset = 0
      while (offset < stat.sizeBytes) {
        const chunk = (await tunnel.rpc(Rpc.fileRead, {
          path: relPath,
          offset,
          length: CHUNK_SIZE
        })) as FileChunk
        const bytes = fromBase64Url(chunk?.data ?? '')
        // An empty window before the end means the file shrank mid-transfer —
        // a truncated cache entry would read as a valid hit forever, so bail.
        if (bytes.length === 0) return 'failed'
        handle.writeBytes(bytes)
        offset += bytes.length
        onProgress?.(offset, stat.sizeBytes)
      }
      return 'done'
    } finally {
      handle.close()
    }
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    return 'failed'
  }
}

export type UploadResult = { attachment: DesktopAttachment; conversationId: string }

/**
 * Upload a local file into the desktop's workspace. The desktop stores it as
 * a conversation upload — same folder, naming and collision behavior as a
 * file dropped on its composer — and answers with the attachment metadata the
 * message should carry. Passing a null conversationId asks the desktop to
 * create the conversation first, so a first message's file has somewhere to
 * land; the returned id is the one to send the message into.
 *
 * Returns null when nothing is connected. Transfer failures throw — the
 * caller decides whether a message without its file is worth sending.
 */
export async function uploadFileToDesktop(
  localUri: string,
  name: string,
  mimeType: string | null,
  conversationId: string | null
): Promise<UploadResult | null> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return null

  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)

  const begin = (await tunnel.rpc(Rpc.uploadBegin, {
    name,
    mimeType,
    sizeBytes,
    conversationId
  })) as { uploadId: string; conversationId: string }

  const handle = source.open(FileMode.ReadOnly)
  try {
    let offset = 0
    while (offset < sizeBytes) {
      const bytes = handle.readBytes(Math.min(CHUNK_SIZE, sizeBytes - offset))
      if (bytes.length === 0) throw new Error('local file truncated mid-upload')
      await tunnel.rpc(Rpc.uploadChunk, {
        uploadId: begin.uploadId,
        offset,
        data: toBase64Url(bytes)
      })
      offset += bytes.length
    }
  } finally {
    handle.close()
  }

  const attachment = (await tunnel.rpc(Rpc.uploadCommit, {
    uploadId: begin.uploadId
  })) as DesktopAttachment & { conversationId: string }
  return {
    attachment: {
      type: attachment.type,
      filePath: attachment.filePath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    },
    conversationId: attachment.conversationId ?? begin.conversationId
  }
}
