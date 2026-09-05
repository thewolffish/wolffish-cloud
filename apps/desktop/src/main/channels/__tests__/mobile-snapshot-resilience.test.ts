/**
 * The phone's snapshot must always get built, even when a section cannot be.
 *
 * This is a regression test for a live failure, and the failure is worth
 * stating because nothing about it looked broken: one source promise that
 * never settled took the WHOLE snapshot with it. The phone's
 * `desktop.config.snapshot` RPC then never answered, so the phone quietly fell
 * back to the copy last synced to the org; that copy was written by the same
 * stalled function, so it never advanced either; and the in-flight latch in
 * writePhoneSnapshot never cleared, so every later config change coalesced
 * into a promise that could not resolve. No exception, no log line, no failed
 * request — just a phone showing settings hours out of date, on a desktop that
 * looked healthy. Five hours of a model switch not reaching a paired phone.
 *
 * Every source here is a promise from somewhere else in the app — a token
 * refresh, an API status, a workspace scan, an OS query — so "one of them
 * hangs" is a matter of when, not if. Bounding each one turns that into a
 * missing card on one screen, which is what every optional field in this
 * snapshot is already documented to survive.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-snapshot-resilience.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-snapshot-stall-'))
process.env.HOME = SANDBOX

// Shim `electron` so the snapshot's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0-test'
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
    }
  }
  return origLoad.apply(this, args)
}

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

/** A promise that never settles — the exact shape of the live failure. */
const forever = <T>(): Promise<T> => new Promise<T>(() => {})

async function run(): Promise<void> {
  // The source timeout is deliberately unref'd — a pending snapshot must never
  // hold the app open at quit — so in a bare node process it is the ONLY
  // pending work and the process would exit before it fires, ending this test
  // with no output and a passing exit code. This keeps the loop alive the way
  // Electron's own does.
  const keepAlive = setInterval(() => {}, 250)
  const { buildConfigSnapshot } = await import('@main/channels/mobile/snapshot')

  type Snapshot = {
    llm?: { brainModel?: string }
    preferences?: Record<string, unknown>
    capabilities?: unknown[]
    projects?: unknown[]
    data?: unknown
  }

  const build = (sources: Record<string, unknown>): Promise<Snapshot> =>
    buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => [],
      ...sources
    } as never) as Promise<Snapshot>

  // ------------------------------------------------------ one source stalls

  {
    const started = Date.now()
    // Two at once, because the sources run concurrently: the bound has to be
    // per-source AND overall, not a queue of timeouts served one after another.
    const snapshot = await build({
      dataAnalytics: () => forever<Record<string, unknown>>(),
      projects: () => forever<unknown[]>()
    })
    const elapsed = Date.now() - started

    ok('a stalled source still yields a snapshot', snapshot !== null)
    // The sections that CAN be resolved are all there — losing one card is the
    // price, losing the phone's whole settings surface is not.
    ok('the rest of the snapshot survives it', snapshot.llm !== undefined)
    ok('…including the sections after the stalled one', snapshot.preferences !== undefined)
    ok('the stalled section is omitted, not faked', snapshot.data === undefined)
    // Bounded, and bounded ONCE: two stalled sources must not cost two waits.
    ok(`it waits seconds, not forever (${elapsed}ms)`, elapsed < 8_000, `${elapsed}ms`)
  }

  // ----------------------------------------------- the serializer stalls too

  {
    // Capabilities are awaited ahead of the rest, which is what made this one
    // able to stall the snapshot before anything else even started.
    const snapshot = await build({ serializeCapabilities: () => forever<unknown[]>() })
    ok('a stalled capability serializer still yields a snapshot', snapshot.llm !== undefined)
    ok('capabilities degrade to empty', Array.isArray(snapshot.capabilities))
  }

  // ------------------------------------------------------- a source throws

  {
    const snapshot = await build({
      projects: async () => {
        throw new Error('projects unreadable')
      }
    })
    ok('a throwing source costs only its own section', snapshot.llm !== undefined)
    ok('and that section is absent', snapshot.projects === undefined)
  }

  clearInterval(keepAlive)
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
