/**
 * The floating run cards, and the four switches that decide whether anything
 * is drawn at all.
 *
 * Three families share one run pool — automations from heartbeat.md, the
 * built-in compaction jobs, the built-in reflection jobs — plus procedure runs,
 * which ride the automations switch. Each family's card has its own switch, and
 * every one of them ships OFF: these cards float over the chat unbidden,
 * nightly, for work nobody asked to watch.
 *
 * What is checked here is the part that fails silently. A default that read as
 * `undefined` instead of `false` would still be falsy in the renderer today and
 * would light every card up the moment someone wrote `?? true` somewhere; a
 * setter that rebuilt its config section would quietly reset the neighbouring
 * switch; and the family classifier is what tells a compaction card from an
 * automation one on BOTH surfaces — get it wrong and a switch turns off
 * somebody else's card.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/run-card-visibility.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-run-cards-'))
process.env.HOME = SANDBOX

// Shim `electron` so the workspace module loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => SANDBOX,
        getVersion: () => '0.0.0-test'
      }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const {
    ensureWorkspace,
    getInAppConfig,
    setInAppConfig,
    getCompactionConfig,
    setCompactionConfig,
    getReflectionConfig,
    setReflectionConfig,
    patchConfig
  } = await import('@main/workspace/workspace')
  const { runFamily } = await import('@main/runtime/brainstem')

  await ensureWorkspace()

  console.log('\nnothing is shown until it is asked for')
  {
    const inapp = await getInAppConfig()
    const compaction = await getCompactionConfig()
    const reflection = await getReflectionConfig()
    // `=== false`, not `!x`: undefined is falsy today and a lie tomorrow.
    ok('a fresh workspace draws no automation card', inapp.runCards === false)
    ok('a fresh workspace draws no compaction card', compaction.cards === false)
    ok('a fresh workspace draws no reflection card', reflection.cards === false)
    ok('the feed is still clean by default', inapp.verbose === false)
  }

  console.log('\na config written before the switches existed reads as off')
  {
    // The real upgrade path: sections that predate these fields entirely.
    await patchConfig((c) => ({
      ...c,
      inapp: { verbose: true } as never,
      compaction: { dailyHour: 4, weeklyDay: 2, weeklyHour: 5 } as never,
      reflection: { hour: 2, quietHours: 6 } as never
    }))
    const inapp = await getInAppConfig()
    const compaction = await getCompactionConfig()
    const reflection = await getReflectionConfig()
    ok('an older in-app section still reads as no card', inapp.runCards === false)
    ok('an older in-app section keeps its verbose value', inapp.verbose === true)
    ok('an older compaction section still reads as no card', compaction.cards === false)
    ok('an older compaction section keeps its schedule', compaction.dailyHour === 4)
    ok('an older reflection section still reads as no card', reflection.cards === false)
    ok('an older reflection section keeps its hour', reflection.hour === 2)
  }

  console.log('\neach switch moves alone')
  {
    await setInAppConfig({ runCards: true })
    const inapp = await getInAppConfig()
    ok('the automation card can be switched on', inapp.runCards === true)
    ok('switching cards on leaves verbose alone', inapp.verbose === true)

    await setCompactionConfig({ cards: true })
    const compaction = await getCompactionConfig()
    ok('the compaction card can be switched on', compaction.cards === true)
    ok('switching cards on leaves the schedule alone', compaction.dailyHour === 4)

    await setReflectionConfig({ cards: true })
    const withCards = await getReflectionConfig()
    ok('the reflection card can be switched on', withCards.cards === true)
    ok('switching cards on leaves the quiet gate alone', withCards.quietHours === 6)

    // The neighbouring write is the one that used to reset things: reflection
    // rebuilds its whole section on every patch (see normalizeReflectionConfig).
    await setReflectionConfig({ quietHours: 8 })
    const afterQuiet = await getReflectionConfig()
    ok('a quiet-gate write leaves the card switch alone', afterQuiet.cards === true)
    ok('a quiet-gate write writes what it was asked to', afterQuiet.quietHours === 8)

    await setInAppConfig({ verbose: false })
    ok('writing verbose leaves the card switch alone', (await getInAppConfig()).runCards === true)
  }

  console.log('\nthe family a job id names')
  {
    // These ids are the scheduler's own (registerCompaction / registerReflection),
    // and both surfaces filter cards by what this returns.
    ok('the daily compaction is compaction', runFamily('compaction-daily') === 'compaction')
    ok('the weekly consolidation is compaction', runFamily('compaction-weekly') === 'compaction')
    ok('the nightly review is reflection', runFamily('reflection-nightly') === 'reflection')
    ok('the deep clean is reflection', runFamily('reflection-deepclean') === 'reflection')
    ok('a procedure run is a procedure', runFamily('procedure:abc123') === 'procedure')
    // Anything from a heading in heartbeat.md — including a label that merely
    // starts with the word, which must not be mistaken for a built-in.
    ok('a heartbeat job is an automation', runFamily('Daily sweep') === 'automation')
    ok('"compaction notes" is still an automation', runFamily('compaction notes') === 'automation')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
