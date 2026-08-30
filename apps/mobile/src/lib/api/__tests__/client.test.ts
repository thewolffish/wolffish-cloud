import { ApiError, get, post, request, toApiError } from '@/lib/api/client'

function mockFetchOnce(response: Partial<Response> & { jsonBody?: unknown }): jest.Mock {
  const { jsonBody, ...rest } = response
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(jsonBody),
    ...rest
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('api client', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns the parsed JSON body on success', async () => {
    mockFetchOnce({ jsonBody: { hello: 'wolffish' } })
    await expect(get<{ hello: string }>('/ping')).resolves.toEqual({ hello: 'wolffish' })
  })

  it('sends JSON bodies with the right method and headers', async () => {
    const fetchMock = mockFetchOnce({ jsonBody: { ok: true } })
    await post('/messages', { text: 'hi' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/messages$/)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }))
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('throws ApiError with the server message on HTTP errors', async () => {
    mockFetchOnce({ ok: false, status: 401, jsonBody: { message: 'unauthorized' } })
    const error = await request('/secure').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
    expect((error as ApiError).message).toBe('unauthorized')
  })

  it('falls back to a status message when the error body is not JSON', async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json'))
    })
    const error = await request('/broken').catch((e: unknown) => e)
    expect((error as ApiError).status).toBe(500)
    expect((error as ApiError).message).toMatch(/status 500/)
  })

  it('wraps network failures as ApiError with null status', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch
    const error = await request('/offline').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBeNull()
    expect((error as ApiError).message).toBe('Network request failed')
  })

  it('returns undefined for 204 responses', async () => {
    mockFetchOnce({ status: 204 })
    await expect(request('/deleted')).resolves.toBeUndefined()
  })
})

describe('toApiError', () => {
  it('passes ApiError through unchanged', () => {
    const original = new ApiError('boom', 418)
    expect(toApiError(original)).toBe(original)
  })

  it('wraps plain errors and keeps the message', () => {
    const wrapped = toApiError(new Error('plain'))
    expect(wrapped).toBeInstanceOf(ApiError)
    expect(wrapped.message).toBe('plain')
    expect(wrapped.status).toBeNull()
  })

  it('stringifies non-error values', () => {
    expect(toApiError('weird').message).toBe('weird')
  })
})
