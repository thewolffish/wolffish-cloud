import { fileHeadByPath, fileUrlByPath, fileUrlBySha, uploadUrl } from '@/lib/cloud/api'
import { bridgeClient } from '@/lib/cloud/bridge'
import { cloudSession } from '@/lib/cloud/session'
import { Rpc } from '@/lib/bridge/protocol'
import * as Crypto from 'expo-crypto'
import { File } from 'expo-file-system'
import * as Legacy from 'expo-file-system/legacy'

/**
 * Workspace file bytes, straight from the org — the paired counterpart of
 * the demo CDN.
 *
 * Down: a conversation's media keeps the desktop's own workspace-relative
 * paths, and the org holds the newest blob under every one of them, so a
 * path resolves with one authenticated download (`/v1/files/path`); an
 * attachment that carries its content hash goes by that instead. Up: the
 * phone hashes the file, uploads it content-addressed under the path it
 * chose (`uploads/conv-<id>/<name>`, with a collision check so it never
 * supersedes a file the desktop already holds there), and the desktop pulls
 * it from the org when the message that names it arrives. Nothing rides
 * the bridge — bytes never should.
 *
 * Only transfer lives here. What to fetch and where it lands is the file
 * cache's business (lib/files/fileCache.ts calls into this module), and what
 * to prefetch is the sync layer's (lib/sync/sync.ts).
 */

/**
 * How a download ended. The distinction between the last two is
 * load-bearing for every file card on screen:
 *
 *   'done'    the whole file landed in `scratch`;
 *   'absent'  the ORG ANSWERED and said the path has no live blob — the one
 *             outcome that may render as "deleted";
 *   'failed'  the transfer broke — offline, a timeout, the socket flapped
 *             mid-file. The file may be perfectly fine at the org; the only
 *             honest next move is to try again.
 */
export type CloudFileFetch = 'done' | 'absent' | 'failed'

/**
 * Download a workspace path (or, when known, a content hash) into
 * `scratch`. See CloudFileFetch for the outcomes; on anything but 'done'
 * the caller keeps its cache untouched.
 *
 * `onProgress` is called as bytes land, which is what lets a file card show
 * a real bar rather than a spinner. Advisory: throwing from it would fail
 * the transfer, so the caller keeps it cheap.
 */
export async function fetchCloudFileInto(
  source: { relPath: string; sha256?: string | null },
  scratch: File,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<CloudFileFetch> {
  let token: string
  try {
    token = await cloudSession.getAccessToken()
  } catch {
    return 'failed'
  }
  const url =
    source.sha256 && /^[0-9a-f]{64}$/.test(source.sha256)
      ? fileUrlBySha(source.sha256)
      : fileUrlByPath(source.relPath)
  try {
    if (scratch.exists) scratch.delete()
  } catch {
    // a leftover that will not delete is overwritten below
  }
  const task = Legacy.createDownloadResumable(
    url,
    scratch.uri,
    { headers: { authorization: `Bearer ${token}` } },
    (progress) => {
      onProgress?.(
        progress.totalBytesWritten,
        progress.totalBytesExpectedToWrite > 0 ? progress.totalBytesExpectedToWrite : -1
      )
    }
  )
  let result: Legacy.FileSystemDownloadResult | undefined
  try {
    result = await task.downloadAsync()
  } catch {
    return 'failed'
  }
  if (!result) return 'failed'
  if (result.status === 404) {
    try {
      scratch.delete()
    } catch {
      // nothing to clean
    }
    return 'absent'
  }
  if (result.status !== 200) {
    try {
      scratch.delete()
    } catch {
      // nothing to clean
    }
    return 'failed'
  }
  return 'done'
}

/** Content hash of a local file, as the org's upload lane wants it. */
export async function sha256OfFile(localUri: string): Promise<string> {
  const bytes = await new File(localUri).bytes()
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A workspace path for a new upload that does not collide with a live blob
 * the org already holds — the desktop's Finder-style rename, done here
 * because the phone is the one choosing the name. `report.pdf` becomes
 * `report (1).pdf` and so on. One HEAD per candidate; the first free wins.
 */
export async function chooseUploadPath(dir: string, name: string): Promise<string> {
  const safe = name.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'file'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  const token = await cloudSession.getAccessToken()
  for (let n = 0; n < 50; n++) {
    const candidate = `${dir}/${n === 0 ? safe : `${stem} (${n})${ext}`}`
    let taken: string | null = null
    try {
      taken = await fileHeadByPath(token, candidate)
    } catch {
      // The check could not run — take the plain name rather than refuse
      // to send; the org's newest-row rule keeps the phone's copy readable.
      return candidate
    }
    if (!taken) return candidate
  }
  return `${dir}/${stem}-${Date.now().toString(36)}${ext}`
}

export type CloudUpload = {
  /** The workspace-relative path the bytes now live under at the org. */
  filePath: string
  sha256: string
  sizeBytes: number
  mimeType: string
  deduped: boolean
}

/**
 * How large a file may be before the in-memory retry below refuses it. The
 * retry reads the whole file into JS memory, which a 1 GB video (the policy
 * ceiling) would not survive; a photo or a document does. Above this, an
 * upload that fails has to fail.
 */
const RETRY_IN_MEMORY_MAX_BYTES = 32 * 1024 * 1024

/**
 * Upload a local file to the org under a workspace path. Content-addressed:
 * the org dedupes identical bytes and registers the path. `onProgress`
 * reports bytes sent for the dialog's bar.
 *
 * Two transports, in order:
 *
 *  1. `createUploadTask` streams the file off disk, so memory stays flat
 *     whatever the size, and it reports progress.
 *  2. `fetch` with the bytes in memory, tried once if (1) fails on a file
 *     small enough to hold. This exists because (1) has been seen failing in
 *     the iOS simulator on multi-megabyte bodies over the QUIC/HTTP-3
 *     connection to the org (POSIX 40, "Message too long"; 1.4 MB lands,
 *     3.9 MB does not, either session type) while the org accepts the same
 *     bytes over HTTP/2 without complaint. The retry also buys a real error:
 *     the upload task reports `ERR_FILESYSTEM_CANNOT_UPLOAD: undefined
 *     reason` for everything, where fetch names the status.
 *
 * Throws on failure — the caller decides whether a message without its
 * file is worth sending.
 */
export async function uploadFileToCloud(
  localUri: string,
  filePath: string,
  mimeType: string | null,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<CloudUpload> {
  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)
  const mime = mimeType || 'application/octet-stream'
  const sha256 = await sha256OfFile(localUri)
  onProgress?.(0, sizeBytes)
  const token = await cloudSession.getAccessToken()
  const url = uploadUrl(sha256, filePath, mime)
  const done = (deduped: boolean): CloudUpload => {
    onProgress?.(sizeBytes, sizeBytes)
    return { filePath, sha256, sizeBytes, mimeType: mime, deduped }
  }

  /** Transport 2: whole body in memory, one shot, honest errors. */
  const viaFetch = async (): Promise<CloudUpload> => {
    const bytes = await source.bytes()
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': mime },
      body: bytes as unknown as BodyInit
    })
    const body = await res.text()
    if (!res.ok) {
      let detail = ''
      try {
        detail = String((JSON.parse(body) as { error?: string }).error ?? '')
      } catch {
        // no JSON body
      }
      throw new Error(`upload failed (${res.status}${detail ? ` ${detail}` : ''})`)
    }
    let deduped = false
    try {
      deduped = Boolean((JSON.parse(body) as { deduped?: boolean }).deduped)
    } catch {
      // fine
    }
    return done(deduped)
  }
  const task = Legacy.createUploadTask(
    url,
    localUri,
    {
      httpMethod: 'POST',
      uploadType: Legacy.FileSystemUploadType.BINARY_CONTENT,
      // Foreground, not the default background session: the send waits on
      // this promise while the app is open, so a background session buys
      // nothing here and costs a daemon round trip per transfer. (Known open
      // issue, either session type: in the iOS simulator the QUIC/HTTP-3
      // connection to the org fails a multi-megabyte upload with POSIX 40
      // "Message too long", cause not established; the org accepts the same
      // bytes over HTTP/2 without complaint. The failure is caught, named in
      // a toast and logged by uploadForSend.)
      sessionType: Legacy.FileSystemSessionType.FOREGROUND,
      headers: { authorization: `Bearer ${token}`, 'content-type': mime }
    },
    (progress) => onProgress?.(progress.totalBytesSent, progress.totalBytesExpectedToSend)
  )
  let result: Legacy.FileSystemUploadResult | null | undefined
  try {
    result = await task.uploadAsync()
  } catch (error) {
    // The transport broke rather than the request being refused. Retry in
    // memory when the file fits; otherwise the failure stands.
    if (sizeBytes > RETRY_IN_MEMORY_MAX_BYTES) throw error
    console.warn(`[files] upload task failed for ${filePath}, retrying in memory:`, error)
    return viaFetch()
  }
  if (!result) throw new Error('upload cancelled')
  if (result.status !== 200) {
    let detail = ''
    try {
      detail = String((JSON.parse(result.body) as { error?: string }).error ?? '')
    } catch {
      // no JSON body
    }
    // A status is the ORG's answer, not a transport fault: retrying it over a
    // second transport would only produce the same refusal.
    throw new Error(`upload failed (${result.status}${detail ? ` ${detail}` : ''})`)
  }
  let deduped = false
  try {
    deduped = Boolean((JSON.parse(result.body) as { deduped?: boolean }).deduped)
  } catch {
    // fine
  }
  return done(deduped)
}

/**
 * Attach an uploaded blob to a project, procedure or automation on the
 * desktop — the second half of the phone's Add-files. The desktop fetches
 * the bytes from the org (when it does not hold them) and adopts them
 * through its own Add-files code, answering the stored row.
 */
export async function adoptUploadedFile<T>(
  target:
    | { kind: 'project'; id: string }
    | { kind: 'procedure'; id: string }
    | { kind: 'automation'; existing: string[] },
  upload: CloudUpload,
  name: string
): Promise<T> {
  if (!bridgeClient.connected) throw new Error('not connected')
  try {
    return (await bridgeClient.rpc(Rpc.filesAdopt, {
      target,
      path: upload.filePath,
      sha256: upload.sha256,
      name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes
    })) as T
  } catch (error) {
    bridgeClient.reportRpcFailure(error)
    throw error
  }
}
