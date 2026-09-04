#!/usr/bin/env node
/**
 * `npm test` — every local smoke suite, in order, against `wrangler dev`.
 *
 *   npx wrangler dev --port 8787        (with .dev.vars pointing at the mocks:
 *   node scripts/mock-deepinfra.mjs      MODEL_UPSTREAMS / SEARCH_PROVIDERS)
 *   node scripts/mock-brave.mjs
 *   npm test
 *
 * Suites that PATCH the org (admin, search) are followed by a pause before
 * the router suite: the org policy is cached at the edge for up to 60 s,
 * and a back-to-back run trips its allowlist checks on stale policy.
 */
import { spawnSync } from 'node:child_process'

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787'
const SUITES = [
  'smoke-auth.mjs',
  'smoke-admin.mjs',
  'smoke-sync.mjs',
  'smoke-leaderboard.mjs',
  'smoke-search.mjs',
  { file: 'smoke-ai.mjs', pauseMs: 65_000 },
  'smoke-archive.mjs'
]

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (!health?.ok) {
  console.error(`no API at ${BASE} — start it first: cd apps/api && npx wrangler dev --port 8787`)
  process.exit(2)
}
console.log(`API ${health.version} at ${BASE}\n`)

let failed = 0
for (const entry of SUITES) {
  const suite = typeof entry === 'string' ? { file: entry, pauseMs: 0 } : entry
  if (suite.pauseMs) {
    console.log(`… waiting ${suite.pauseMs / 1000}s for the edge policy cache before ${suite.file}`)
    await new Promise((r) => setTimeout(r, suite.pauseMs))
  }
  console.log(`\n━━━ ${suite.file} ━━━`)
  const res = spawnSync(process.execPath, [new URL(suite.file, import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, API_BASE: BASE }
  })
  if (res.status !== 0) failed++
}
console.log(failed === 0 ? '\nALL SMOKE SUITES PASS' : `\n${failed} SUITE(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
