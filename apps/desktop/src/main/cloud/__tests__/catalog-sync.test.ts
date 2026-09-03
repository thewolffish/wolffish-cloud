/**
 * Catalog sync tests — pins the contract the composer's model picker
 * relies on now that it renders the catalog from launch instead of
 * fetching on open:
 *
 *   1. a cold cache waits for the one fetch and answers it — and answers
 *      empty, not a rejection, when that fetch fails,
 *   2. a fresh cache answers without touching the network,
 *   3. a stale cache answers the old list AT ONCE and revalidates behind
 *      the caller: a different list reaches onCatalogChanged, an identical
 *      one stays silent, a failed fetch keeps the old list,
 *   4. concurrent refreshes share one request; a removed listener is quiet.
 *
 * The cloud session, fetch and the clock are fakes. Standalone — no
 * vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/cloud/__tests__/catalog-sync.test.ts
 */

import Module from 'node:module'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === '@main/cloud/session') {
    return {
      cloudSession: {
        withAccessToken: async <T>(fn: (token: string) => Promise<T>): Promise<T> => fn('tok_test')
      }
    }
  }
  return origLoad.apply(this, args)
}

type Wire = { id: string; name: string; reasoning: boolean; default?: boolean }
const A: Wire = { id: 'a', name: 'A', reasoning: true, default: true }
const B: Wire = { id: 'b', name: 'B', reasoning: false }
const C: Wire = { id: 'c', name: 'C', reasoning: true }

let served: Wire[] = []
let fetches = 0
let failNext = false
let hold: Promise<void> | null = null
let release: () => void = () => {}
/** Parks the next fetch until release() — lets a test observe "before it lands". */
function park(): void {
  hold = new Promise<void>((resolve) => {
    release = () => {
      hold = null
      resolve()
    }
  })
}

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  fetches++
  const url = new URL(String(input))
  if (url.pathname !== '/v1/models') throw new Error(`unexpected route ${url.pathname}`)
  const gate = hold
  if (gate) await gate
  if (failNext) {
    failNext = false
    return new Response('nope', { status: 500 })
  }
  return new Response(JSON.stringify({ default_model: served[0]?.id ?? null, models: served }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}) as typeof fetch

let now = 1_000_000
Date.now = () => now

// ── Harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function until(cond: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return cond()
}

const ids = (models: Array<{ id: string }>): string => models.map((m) => m.id).join(',')

async function run(): Promise<void> {
  const sync = await import('@main/cloud/catalogSync')
  const cache = await import('@main/cloud/catalog')
  const pushes: string[] = []
  const off = sync.onCatalogChanged((models) => pushes.push(ids(models)))

  // 1. Cold + failure: answers empty, no throw, no push, still cold.
  failNext = true
  const empty = await sync.getCatalog()
  ok('cold failure answers empty', empty.length === 0)
  ok('cold failure fetched once', fetches === 1, String(fetches))
  ok('cold failure pushes nothing', pushes.length === 0)
  ok('cold failure leaves the cache cold', cache.catalogAgeMs() === Number.POSITIVE_INFINITY)

  // 1b. Cold: waits for the fetch and answers it.
  served = [A, B]
  const first = await sync.getCatalog()
  ok('cold answer is the fetched list', ids(first) === 'a,b', ids(first))
  ok('cold fetched once more', fetches === 2, String(fetches))
  ok('cold landing pushes once', pushes.length === 1 && pushes[0] === 'a,b', pushes.join('|'))
  ok('default model primed', cache.catalogDefaultModel() === 'a')

  // 2. Fresh: no network.
  now += 60_000
  const fresh = await sync.getCatalog()
  ok('fresh answers from cache', ids(fresh) === 'a,b' && fetches === 2, String(fetches))

  // 3. Stale + changed: the old list at once, the new one pushed when it lands.
  now += 10 * 60_000
  served = [A, B, C]
  park()
  const stale = await sync.getCatalog()
  ok('stale answers the old list immediately', ids(stale) === 'a,b', ids(stale))
  ok('stale kicked one background fetch', fetches === 3, String(fetches))
  ok('nothing pushed before the fetch lands', pushes.length === 1)
  release()
  ok('changed list pushed', await until(() => pushes.length === 2 && pushes[1] === 'a,b,c'))
  ok('cache holds the new list', ids(cache.catalogModels()) === 'a,b,c')
  ok('cache is fresh again', cache.catalogAgeMs() === 0)

  // 3b. Stale + identical: refreshed, silent.
  now += 10 * 60_000
  park()
  await sync.getCatalog()
  release()
  ok('identical refresh re-primes', await until(() => cache.catalogAgeMs() === 0))
  ok('identical refresh stays silent', pushes.length === 2, String(pushes.length))
  ok('identical refresh fetched', fetches === 4, String(fetches))

  // 3c. Stale + failure: the old list survives, silently.
  now += 10 * 60_000
  failNext = true
  const kept = await sync.getCatalog()
  ok('stale failure answers the old list', ids(kept) === 'a,b,c')
  await until(() => fetches === 5)
  await new Promise((r) => setTimeout(r, 50))
  ok('stale failure keeps the old list', ids(cache.catalogModels()) === 'a,b,c')
  ok('stale failure stays silent', pushes.length === 2)
  ok('stale failure leaves the copy stale', cache.catalogAgeMs() === 10 * 60_000)

  // 4. Concurrent refreshes share one request.
  park()
  const p1 = sync.refreshCatalog()
  const p2 = sync.refreshCatalog()
  ok('concurrent refreshes share the promise', p1 === p2)
  ok('shared refresh fetched once', fetches === 6, String(fetches))
  release()
  await p1
  const p3 = sync.refreshCatalog()
  ok('a refresh after the shared one lands starts anew', p3 !== p1)
  await p3
  ok('the new refresh fetched', fetches === 7, String(fetches))

  // 4b. A removed listener is quiet.
  off()
  served = [A]
  await sync.refreshCatalog()
  ok('removed listener not called', pushes.length === 2, String(pushes.length))
  ok('but the cache moved on', ids(cache.catalogModels()) === 'a')

  console.log(`catalog-sync: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
