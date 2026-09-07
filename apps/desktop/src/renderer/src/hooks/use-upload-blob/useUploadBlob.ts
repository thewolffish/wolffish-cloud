import { isPathHydrating, useHydrationFileVersion } from '@lib/hydration/hydrationStore'
import { useEffect, useRef, useState } from 'react'

/**
 * Fetch an uploaded file's bytes through the upload IPC channel and wrap
 * them in an object URL the renderer can feed to `<img>`, `<audio>`,
 * `<video>` etc. Mirrors the Blob-URL pattern voice memos use — keeps the
 * URL scoped to the renderer's lifetime, avoids registering a custom
 * Electron protocol, and gives every media element a stable string source
 * across re-renders.
 *
 * Pass `mimeType` so the Blob carries the right content-type for the
 * underlying decoder (Safari's quicktime decoder is MIME-strict; HEIC
 * preview also requires the right hint).
 *
 * Returns `{ url, error }`. While loading, both are null. On failure
 * `error` is true and the caller should render a "deleted" placeholder.
 *
 * ABSENT IS NOT GONE. A conversation's media downloads when the conversation
 * is OPENED — nothing is predownloaded at restore — so on a fresh install (or
 * after a purge) the first read of a file races its own download, and that
 * race is seconds long, not milliseconds. `error` therefore means "the file
 * is not coming": it is withheld while the path is queued or mid-flight, and
 * the read is retried whenever hydration reports that a file may have landed.
 * Without that, one early miss latched the "deleted" placeholder for the life
 * of the mount, and a delivered screenshot read "Image file was deleted or
 * unavailable" in the feed while the very same file rendered fine in the files
 * sheet (AttachmentList already re-checks on this signal) — and it stayed that
 * way, because nothing else ever re-ran this hook.
 */
export function useUploadBlob(
  filePath: string,
  mimeType: string
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  // Bumps when a hydration flight starts, lands a file, or ends — see
  // hydrationStore. Purely a retry trigger here; byte ticks never reach it.
  const hydrationFileVersion = useHydrationFileVersion()

  // The object URL handed out, revoked exactly once — when the path changes
  // or the component unmounts. It lives OUTSIDE the loading effect on
  // purpose: that effect re-runs on every hydration bump, and a revoke in its
  // cleanup would tear down bytes already on screen.
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [filePath, mimeType])

  useEffect(() => {
    // Bytes already in hand: a hydration tick is not a reason to re-read.
    if (urlRef.current) return
    let cancelled = false

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    void (async () => {
      // The read can also lose a much shorter race with the file still being
      // written — e.g. a screenshot the agent just captured but hasn't
      // flushed to disk yet — which no hydration event would ever report.
      // Those bytes normally land within a few hundred ms, so spin briefly
      // before settling either way.
      for (let attempt = 0; ; attempt++) {
        try {
          const buffer = await window.api.upload.readFile(filePath)
          if (!buffer) throw new Error(`missing upload: ${filePath}`)
          if (cancelled) return
          const blob = new Blob([buffer], { type: mimeType })
          const objectUrl = URL.createObjectURL(blob)
          urlRef.current = objectUrl
          setUrl(objectUrl)
          setError(false)
          return
        } catch {
          if (cancelled) return
          if (attempt >= 3) {
            setUrl(null)
            // A file still queued or mid-download is not deleted — hold the
            // loading state; the next hydration bump re-runs this effect, and
            // the bump that ends the flight settles it as gone if it never
            // arrived.
            setError(!isPathHydrating(filePath))
            return
          }
          await sleep(200)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [filePath, mimeType, hydrationFileVersion])

  return { url, error }
}
