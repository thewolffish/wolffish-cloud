import * as cheerio from 'cheerio'
import fs from 'node:fs/promises'
import path from 'node:path'

// Web search is an org-provided service, exactly like the models: every
// query goes to the org API's /v1/search lane with the device's session
// token (the `cloud` host the cerebellum hands us at init). The org holds
// the one Brave Search key behind that door, queues everyone's searches
// fairly behind the plan's rate limit, enforces the per-person and
// per-month allowances, and meters each query — nothing is configured on
// this device. The DuckDuckGo scrapers below remain the fallback for when
// the lane is unavailable (org switched it off, not set up yet, upstream
// down, offline); an allowance refusal is final and is reported as such.

const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_LENGTH = 15_000
const ORG_SEARCH_TIMEOUT_MS = 30_000

// Workspace root captured at init() for the local usage ledger line.
let workspaceRoot = null
// The org API seam: { apiBase, withAccessToken } — null when the host runs
// without a cloud session (tests, headless), which means DDG only.
let cloud = null

// DDG rate-limit guard — enforce a minimum gap between consecutive scrapes.
const DDG_MIN_GAP_MS = 10_000
let lastDdgSearchAt = 0

function ddgThrottle() {
  const wait = DDG_MIN_GAP_MS - (Date.now() - lastDdgSearchAt)
  if (wait > 0) return new Promise((r) => setTimeout(r, wait))
}

// Real browser UA — DDG rate-limits requests with bot-looking UAs.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PRIVATE_IP_RE =
  /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|.*\.local)(:\d+)?(\/|$)/i

const toolDefinitions = [
  {
    name: 'web_search',
    description:
      "Search the web. Returns titles, snippets and URLs — never a page. Fast, and each query is metered against the user's organization allowance, so use it to settle one fact or to find which URL to open. To actually read or work with a site, prefer the browser-extension capability.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default 5)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description:
      'One plain HTTP GET of a URL, returned as text. Instant and free, but it sees only what the server sends — JS-rendered pages come back empty, and paywalls, logins, consent walls and bot checks defeat it. When that happens, or when the page needs a click or scroll, switch to the browser-extension capability rather than retrying.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the web page to fetch' },
        maxLength: {
          type: 'number',
          description: 'Maximum characters to return (default 15000)'
        },
        timeout: {
          type: 'number',
          description:
            'Optional. Seconds to wait before giving up on a slow or unresponsive page. Omit to wait indefinitely (no timeout).'
        }
      },
      required: ['url']
    }
  }
]

// Helpers

// DDG wraps outbound URLs in /l/?uddg=<encoded>. Unwrap them so callers get
// the real destination, not the redirector.
function unwrapDdgUrl(url) {
  if (!url) return url
  const m = url.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return url
    }
  }
  if (url.startsWith('//')) return `https:${url}`
  return url
}

// Fetch with an OPTIONAL timeout. We never impose a timeout by default — the
// request runs to completion unless a caller explicitly passes `timeoutMs`
// (e.g. the web_fetch tool, when the model asks for one). This keeps timeouts
// a deliberate choice rather than a hard-coded limit.
async function fetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options)
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    // Distinguish our timeout abort from other fetch errors so callers can
    // surface a clear, classifiable message ("timed out") rather than the
    // opaque "This operation was aborted".
    if (timedOut) {
      const e = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
      e.name = 'TimeoutError'
      throw e
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Search providers — both scrape DuckDuckGo via different endpoints. They are
// independent CDNs/hosts, so rate-limiting one rarely affects the other.

const PROVIDERS = [
  {
    name: 'duckduckgo-html',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: ($, max) => {
      const results = []
      $('.result, .web-result').each((_, el) => {
        if (results.length >= max) return
        const $el = $(el)
        const $a = $el.find('.result__title a, h2 a').first()
        const title = $a.text().trim()
        const url = unwrapDdgUrl($a.attr('href') || '')
        const snippet = $el.find('.result__snippet').text().trim()
        if (title && /^https?:/i.test(url)) results.push({ title, snippet, url })
      })
      return results
    }
  },
  {
    name: 'duckduckgo-lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: ($, max) => {
      const results = []
      $('a.result-link').each((_, el) => {
        if (results.length >= max) return
        const $el = $(el)
        const title = $el.text().trim()
        const url = unwrapDdgUrl($el.attr('href') || '')
        const snippet = $el
          .closest('tr')
          .nextAll('tr')
          .find('.result-snippet')
          .first()
          .text()
          .trim()
        if (title && /^https?:/i.test(url)) results.push({ title, snippet, url })
      })
      return results
    }
  }
]

async function runProvider(provider, query, maxResults) {
  const res = await fetchWithTimeout(
    provider.url(query),
    {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    },
  )
  if (!res.ok) throw new Error(`${provider.name} returned HTTP ${res.status}`)
  const html = await res.text()
  if (/anomaly|unusual traffic|rate limit/i.test(html)) {
    throw new Error(`${provider.name} rate-limited (anomaly detected)`)
  }
  return provider.parse(cheerio.load(html), maxResults)
}

// The org lane — POST {apiBase}/v1/search with the session token. The lane
// answers in exactly the shape this tool returns (provider + results), so
// the model sees the same thing whichever road the query took.
//
// Errors carry the wire code (`err.code`: search_quota_exceeded,
// search_quota_exhausted, search_busy, search_disabled,
// search_not_configured, upstream_error, …) so executeSearch can tell a
// final refusal from an unavailable lane.
async function searchOrg(query, maxResults) {
  return cloud.withAccessToken(async (token) => {
    const res = await fetchWithTimeout(
      `${cloud.apiBase}/v1/search`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query, count: Math.min(20, maxResults) })
      },
      ORG_SEARCH_TIMEOUT_MS
    )
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {}
    if (!res.ok) {
      const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`
      const err = new Error(`org search lane: ${code}`)
      err.code = code
      err.status = res.status
      err.body = body
      throw err
    }
    const raw = Array.isArray(body?.results) ? body.results : []
    return raw
      .slice(0, maxResults)
      .map((r) => ({ title: r.title ?? '', snippet: r.snippet ?? '', url: r.url ?? '' }))
      .filter((r) => r.title && /^https?:/i.test(r.url))
  })
}

// A refusal the org meant: the agent must relay it, not route around it.
const FINAL_LANE_CODES = new Set(['search_quota_exceeded', 'search_quota_exhausted', 'search_busy'])

function describeLaneRefusal(err) {
  const body = err?.body ?? {}
  switch (err?.code) {
    case 'search_quota_exceeded':
      return body.scope === 'org_monthly'
        ? `Web search is paused: the organization's monthly search budget is used up (${body.used} of ${body.cap}). An admin can raise it under the org settings.`
        : `Web search is paused: your daily search allowance is used up (${body.used} of ${body.cap}). It resets at midnight UTC; an admin can raise your cap if you need more today.`
    case 'search_quota_exhausted':
      return "Web search is paused: the organization's Brave Search plan has no queries left for this month."
    case 'search_busy': {
      const secs = Math.max(1, Math.round((body.retry_after_ms ?? 2000) / 1000))
      return `The organization's search lane is busy right now — retry in about ${secs}s.`
    }
    default:
      return `Web search refused: ${err?.code ?? err?.message ?? 'unknown error'}`
  }
}

// Brave usage tracking — appends one line per successful query to the
// workspace usage directory so the Usage panel can show search cost right
// away. The org meters the same query authoritatively (kind=search on
// /v1/usage); the cloud sync rebuilds this file from that record after a
// purge and folds in the user's other devices' searches.
// Appends are chained through one queue: the "is there a header for today
// yet" probe and the write run as a single step, so two searches landing
// together (one turn often fires several) can't both read an empty file and
// both write the title and date header.
let braveLedgerQueue = Promise.resolve()

function recordBraveUsage(query) {
  if (!workspaceRoot) return
  const root = workspaceRoot
  braveLedgerQueue = braveLedgerQueue
    .then(() => appendBraveLedgerLine(root, query))
    .catch(() => {})
}

async function appendBraveLedgerLine(root, query) {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const date = `${yyyy}-${mm}-${dd}`
  const time = `${hh}:${mi}:${ss}`

  const dir = path.join(root, 'usage', 'providers')
  const filepath = path.join(dir, 'brave.md')

  const safe = query.replace(/[|\n\r]/g, ' ').slice(0, 120)
  const line = `- ${date} ${time} | web_search | ${safe}\n`

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch { return }

  let existing = ''
  try { existing = await fs.readFile(filepath, 'utf8') } catch { existing = '' }

  const dateHeader = `## ${date}`
  if (!existing.includes(dateHeader)) {
    const body = existing.length === 0
      ? `# Brave Search\n\n${dateHeader}\n\n${line}`
      : `\n${dateHeader}\n\n${line}`
    try { await fs.appendFile(filepath, body, 'utf8') } catch { return }
  } else {
    try { await fs.appendFile(filepath, line, 'utf8') } catch { return }
  }
}

// web_search

async function executeSearch(args) {
  const query = String(args?.query ?? '').trim()
  if (!query) return { success: false, error: 'empty search query' }

  const maxResults = Math.max(1, Math.round(Number(args?.maxResults) || DEFAULT_MAX_RESULTS))

  let results
  let provider
  const errors = []

  // The org lane first. An allowance or capacity refusal is the org's
  // decision and is reported as such; anything that means "the lane is not
  // available right now" (switched off, not set up, upstream down, offline)
  // falls through to the DDG scrapers so the tool still answers.
  if (cloud) {
    try {
      results = await searchOrg(query, maxResults)
      provider = 'brave'
      recordBraveUsage(query)
    } catch (err) {
      if (FINAL_LANE_CODES.has(err?.code)) {
        return { success: false, error: describeLaneRefusal(err) }
      }
      errors.push(err?.message ?? String(err))
    }
  }

  if (!provider) {
    for (const p of PROVIDERS) {
      try {
        await ddgThrottle()
        results = await runProvider(p, query, maxResults)
        lastDdgSearchAt = Date.now()
        provider = p.name
        break
      } catch (err) {
        lastDdgSearchAt = Date.now()
        errors.push(`${p.name}: ${err?.message ?? err}`)
      }
    }
  }

  if (!provider) {
    return {
      success: false,
      error: `All search providers failed.\n${errors.join('\n')}\nTry a different query or wait 30 seconds before retrying.`
    }
  }

  if (!results || results.length === 0) {
    return {
      success: true,
      output: JSON.stringify({
        provider,
        results: [],
        message: 'No results found. Try a different or more specific query.'
      })
    }
  }

  return { success: true, output: JSON.stringify({ provider, results }) }
}

// web_fetch

const HEADING_PREFIX = { h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ' }

function extractContent($) {
  $('script, style, nav, footer, header, aside, iframe, noscript, svg').remove()
  let root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) root = $('body')

  const lines = []
  root.find('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, code, blockquote').each((_, el) => {
    const tag = el.tagName?.toLowerCase()
    let text = $(el).text().trim()
    if (!text) return
    if (HEADING_PREFIX[tag]) text = HEADING_PREFIX[tag] + text
    else if (tag === 'li') text = `- ${text}`
    else if (tag === 'blockquote') text = `> ${text}`
    else if (tag === 'pre' || tag === 'code') text = `\`\`\`\n${text}\n\`\`\``
    lines.push(text)
  })
  return lines.join('\n\n')
}

async function executeFetch(args) {
  const url = String(args?.url ?? '').trim()
  if (!url) return { success: false, error: 'empty URL' }

  if (!/^https?:\/\//i.test(url)) {
    return { success: false, error: 'URL must start with http:// or https://' }
  }
  if (PRIVATE_IP_RE.test(url)) {
    return { success: false, error: 'Blocked: cannot fetch private/local network addresses' }
  }

  const maxLength = Number(args?.maxLength) || DEFAULT_MAX_LENGTH

  // No timeout unless the model explicitly asks for one (in seconds).
  const timeoutSec = Number(args?.timeout)
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined

  let response
  try {
    response = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      },
      timeoutMs
    )
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      return { success: false, error: err.message }
    }
    return { success: false, error: `Fetch failed: ${err?.message ?? err}` }
  }

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('application/octet-stream') ||
    contentType.startsWith('application/zip') ||
    contentType.startsWith('application/pdf')
  ) {
    return { success: false, error: `Cannot read binary content (Content-Type: ${contentType})` }
  }

  let text
  try {
    const buffer = await response.arrayBuffer()
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i)
    const charset = charsetMatch ? charsetMatch[1] : 'utf-8'
    text = new TextDecoder(charset).decode(buffer)
  } catch (err) {
    return { success: false, error: `Failed to decode response: ${err?.message ?? err}` }
  }

  if (!contentType.includes('html')) {
    const truncated = text.slice(0, maxLength)
    if (!truncated.trim()) return { success: true, output: '(Page returned no readable content)' }
    return { success: true, output: truncated }
  }

  const $ = cheerio.load(text)
  let content = extractContent($)
  content = content.replace(/\n{3,}/g, '\n\n').trim()

  if (!content) return { success: true, output: '(Page returned no readable content)' }
  return { success: true, output: content.slice(0, maxLength) }
}

// Plugin export

export default {
  name: 'web-search',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
    const host = context?.cloud
    cloud =
      host && typeof host.apiBase === 'string' && typeof host.withAccessToken === 'function'
        ? host
        : null
  },

  describeAction(toolName, args) {
    if (toolName === 'web_search') {
      return {
        title: 'Web search',
        description: `Search for: ${args?.query ?? '(empty)'}`,
        risk: 'low'
      }
    }
    if (toolName === 'web_fetch') {
      return {
        title: 'Fetch web page',
        description: `Read: ${args?.url ?? '(empty)'}`,
        risk: 'low'
      }
    }
    return null
  },

  async execute(toolName, args) {
    if (toolName === 'web_search') return executeSearch(args)
    if (toolName === 'web_fetch') return executeFetch(args)
    return { success: false, error: `web-search: unknown tool ${toolName}` }
  }
}
