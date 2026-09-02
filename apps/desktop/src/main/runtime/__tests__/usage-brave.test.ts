/**
 * Brave metering seam — the web-search capability's plugin searches through
 * the org's /v1/search lane (the cloud host in its init context) and writes
 * usage/providers/brave.md; Usage (main/runtime/usage.ts) reads that file
 * back into the summary, stats and per-day rows the Usage panel, the phone
 * and `wfc usage` render. The two sides live in different trees (the plugin
 * at <repo>/capabilities/web-search, published through the capability
 * registry; the reader in this app), so nothing else pins their line format
 * together — and nothing else proves the plugin honours the lane's answers
 * (a session bearer on every call, an allowance refusal relayed rather than
 * scraped around, an unavailable lane falling through to DuckDuckGo).
 *
 * Runs the REAL plugin against a temp workspace: cheerio (only the DDG
 * scrapers touch it) is stubbed through a node_modules shim beside a copy of
 * the plugin, and fetch is mocked so no request leaves the process.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/usage-brave.test.ts
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Usage } from '../usage'

const PLUGIN_SOURCE = path.resolve(
  __dirname,
  '../../../../../../capabilities/web-search/plugin/index.mjs'
)
const BRAVE_COST_PER_QUERY = 0.005

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`)
}

function ok(label: string, cond: boolean): void {
  check(label, cond, true)
}

function near(label: string, actual: number, expected: number): void {
  ok(`${label} (${actual} ≈ ${expected})`, Math.abs(actual - expected) < 1e-9)
}

type CloudHost = {
  apiBase: string
  withAccessToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>
}

type Plugin = {
  init: (context: { workspaceRoot: string; cloud?: CloudHost }) => Promise<void>
  execute: (
    tool: string,
    args: Record<string, unknown>
  ) => Promise<{ success: boolean; output?: string; error?: string }>
}

async function loadPlugin(root: string): Promise<Plugin> {
  const dir = path.join(root, 'plugin')
  const cheerio = path.join(dir, 'node_modules', 'cheerio')
  await fs.mkdir(cheerio, { recursive: true })
  await fs.copyFile(PLUGIN_SOURCE, path.join(dir, 'index.mjs'))
  await fs.writeFile(
    path.join(cheerio, 'package.json'),
    JSON.stringify({ name: 'cheerio', version: '0.0.0-stub', type: 'module', main: 'index.js' })
  )
  // A `$` that finds nothing: every DDG parser reduces to "no results", which
  // is all the fallback path needs here.
  await fs.writeFile(
    path.join(cheerio, 'index.js'),
    'export function load() {\n  return () => ({ each() {} })\n}\n'
  )
  const mod = (await import(pathToFileURL(path.join(dir, 'index.mjs')).href)) as {
    default: Plugin
  }
  return mod.default
}

const API_BASE = 'https://api.test'
let laneMode: 'ok' | 'quota' | 'disabled' = 'ok'
const laneCalls: Array<{ url: string; auth: string | undefined; body: unknown }> = []

function installFetchMock(): void {
  const mock = async (
    input: string | URL,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<Response> => {
    const url = String(input)
    if (url === `${API_BASE}/v1/search`) {
      laneCalls.push({
        url,
        auth: init?.headers?.authorization,
        body: init?.body ? JSON.parse(init.body) : null
      })
      if (laneMode === 'quota') {
        return new Response(
          JSON.stringify({
            error: 'search_quota_exceeded',
            scope: 'user_daily',
            used: 200,
            cap: 200
          }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
      }
      if (laneMode === 'disabled') {
        return new Response(JSON.stringify({ error: 'search_disabled' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
      }
      const body = {
        provider: 'brave',
        results: [{ title: 'Wolffish', snippet: 'The employee agent', url: 'https://wolffi.sh' }],
        meta: { latency_ms: 12, waited_ms: 0, coalesced: false, used_today: 1, daily_cap: 200 }
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      throw new Error('the plugin must never call Brave directly — the org lane holds the key')
    }
    if (url.includes('duckduckgo.com')) {
      return new Response('<html><body></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  globalThis.fetch = mock as unknown as typeof fetch
}

function braveFile(ws: string): string {
  return path.join(ws, 'usage', 'providers', 'brave.md')
}

async function braveLines(ws: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(braveFile(ws), 'utf8')
    return raw.split(/\r?\n/).filter((line) => line.startsWith('- '))
  } catch {
    return []
  }
}

// The plugin records fire-and-forget (`void recordBraveUsage(query)`), so the
// line can land after execute() resolves.
async function waitForLines(ws: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const lines = await braveLines(ws)
    if (lines.length >= count || Date.now() > deadline) return lines
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function localToday(): string {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function providerOf(result: { output?: string }): unknown {
  return (JSON.parse(result.output ?? '{}') as { provider?: unknown }).provider
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-usage-brave-'))
  const ws = path.join(root, 'workspace')
  await fs.mkdir(ws, { recursive: true })
  // A legacy device key in config.json must be ignored: the lane is the org's.
  await fs.writeFile(
    path.join(ws, 'config.json'),
    JSON.stringify({ brave: { enabled: true, apiKey: 'BSA_legacy_ignored' } })
  )
  installFetchMock()
  const plugin = await loadPlugin(root)
  await plugin.init({
    workspaceRoot: ws,
    cloud: { apiBase: API_BASE, withAccessToken: async (fn) => fn('session-token') }
  })

  // -- writer: two successful searches through the lane -> two ledger lines, one header --

  const first = await plugin.execute('web_search', { query: 'wolffish | cloud' })
  ok('search 1 succeeds', first.success)
  check('search 1 answered by brave', providerOf(first), 'brave')
  check(
    'search 1 went to the org lane with the session bearer',
    laneCalls[0]?.auth,
    'Bearer session-token'
  )
  check(
    'search 1 sent the query and count on the wire',
    JSON.stringify(laneCalls[0]?.body),
    JSON.stringify({ query: 'wolffish | cloud', count: 5 })
  )
  const second = await plugin.execute('web_search', { query: 'wolffish pricing' })
  ok('search 2 succeeds', second.success)
  check('search 2 answered by brave', providerOf(second), 'brave')

  const lines = await waitForLines(ws, 2)
  check('writer: two ledger lines', lines.length, 2)
  const raw = await fs.readFile(braveFile(ws), 'utf8')
  check('writer: file titled', raw.startsWith('# Brave Search\n'), true)
  check(
    'writer: one date header for one day',
    (raw.match(/^## \d{4}-\d{2}-\d{2}$/gm) ?? []).length,
    1
  )
  check('writer: a pipe in the query cannot add a column', lines[0]?.split(' | ').length, 3)
  ok(
    'writer: line carries the local date and time the reader parses',
    /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| web_search \| /.test(lines[0] ?? '')
  )

  // -- reader: the same file, folded the way the panel, the phone and the CLI read it --

  const usage = new Usage({ workspaceRoot: ws })
  const summary = await usage.getSummary('all_time')
  check('summary: brave queries', summary.brave.totalQueries, 2)
  near('summary: brave cost', summary.brave.totalCost, 2 * BRAVE_COST_PER_QUERY)
  check('summary: the cloud lane is still zero-filled', summary.providers.length, 1)
  check('summary: lane id', summary.providers[0]?.provider, 'cloud')
  check('summary: lane cost untouched by brave', summary.providers[0]?.totalCost, 0)

  const stats = await usage.getStats('today')
  near('stats: brave fees land in totalCost', stats.totalCost, 2 * BRAVE_COST_PER_QUERY)
  check('stats: no LLM turns -> no messages', stats.messages, 0)
  check('stats: a brave-only day is not an active day', stats.activeDays, 0)
  check('stats: top spend day is today', stats.topSpendDay?.date, localToday())
  near('stats: top spend day cost', stats.topSpendDay?.cost ?? 0, 2 * BRAVE_COST_PER_QUERY)

  const days = await usage.getDays()
  check('days: one day', days.length, 1)
  check('days: dated by the local calendar', days[0]?.date, localToday())
  check('days: braveQueries', days[0]?.braveQueries, 2)
  check('days: no model rows', days[0]?.models.length, 0)

  const daily = await usage.getDaily(new Date().getFullYear())
  check('heatmap: brave queries are not tokens', daily.length, 0)

  // -- an allowance refusal is the org's decision: relayed, never scraped around, never billed --

  laneMode = 'quota'
  const third = await plugin.execute('web_search', { query: 'over the cap' })
  ok('cap refusal is relayed as a failure', !third.success)
  ok('…naming the allowance', /allowance|search budget/.test(third.error ?? ''))
  ok('…and the query stayed out of DuckDuckGo', laneCalls.length === 3)
  await new Promise((resolve) => setTimeout(resolve, 150))
  check('writer: no ledger line for the refused query', (await braveLines(ws)).length, 2)

  // -- an unavailable lane (switched off) falls through to DuckDuckGo, unbilled --

  laneMode = 'disabled'
  const fourth = await plugin.execute('web_search', { query: 'lane off' })
  ok('lane off falls through to DDG', fourth.success && providerOf(fourth) !== 'brave')
  await new Promise((resolve) => setTimeout(resolve, 150))
  check('writer: no ledger line for the fallback', (await braveLines(ws)).length, 2)
  laneMode = 'ok'
  await usage.sync()
  check(
    'reader: still two after a resync',
    (await usage.getSummary('all_time')).brave.totalQueries,
    2
  )

  // -- no ledger, no brave --

  const empty = new Usage({ workspaceRoot: path.join(root, 'empty') })
  check('empty workspace: zero queries', (await empty.getSummary('all_time')).brave.totalQueries, 0)
  check('empty workspace: zero cost', (await empty.getStats('all_time')).totalCost, 0)

  await fs.rm(root, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
