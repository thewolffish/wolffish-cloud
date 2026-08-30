/**
 * Typed fetch client for the Wolffish Cloudflare Worker API that bridges the
 * desktop and mobile apps. TanStack Query owns caching/retries; these helpers
 * are the queryFn/mutationFn building blocks. The base URL comes from
 * EXPO_PUBLIC_API_URL so dev/staging/production can point at different
 * workers without a code change. Real endpoints and auth land once the
 * worker exists.
 */
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.wolffi.sh'

const DEFAULT_TIMEOUT_MS = 30_000

export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(error instanceof Error ? error.message : String(error), null)
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  timeoutMs?: number
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Auth token attachment goes here once pairing with the desktop app lands.
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!res.ok) {
      let message = `Request failed with status ${res.status}`
      try {
        const data: unknown = await res.json()
        if (
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof data.message === 'string'
        ) {
          message = data.message
        }
      } catch {
        // Non-JSON error body — keep the status message.
      }
      throw new ApiError(message, res.status)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (error) {
    throw toApiError(error)
  } finally {
    clearTimeout(timer)
  }
}

export function get<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' })
}

export function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body })
}

export function put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body })
}

export function del<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' })
}
