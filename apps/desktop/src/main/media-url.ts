/**
 * The workspace media scheme: `wolffish-media://<workspace-relative path>`.
 *
 * The renderer's markdown pipeline and the browser capability's screenshot
 * links both emit it; the main process serves it from ~/.wfc/workspace. One
 * parser, shared by the protocol handler and its test, so the scheme the
 * renderer writes and the prefix the handler strips can never drift apart
 * again (they did once, and every inline image 404'd).
 */
export const WORKSPACE_MEDIA_SCHEME = 'wolffish-media'

const PREFIX = `${WORKSPACE_MEDIA_SCHEME}://`

/** The workspace-relative path a media URL names, or null when the URL is not
 *  ours, is empty, or tries to climb out of the workspace. */
export function workspaceMediaPath(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null
  let rel: string
  try {
    rel = decodeURIComponent(url.slice(PREFIX.length))
  } catch {
    return null
  }
  rel = (rel.split('?')[0] ?? '').replace(/^\/+/, '')
  if (!rel) return null
  const parts = rel.split(/[\\/]/)
  if (parts.some((p) => p === '..')) return null
  return rel
}
