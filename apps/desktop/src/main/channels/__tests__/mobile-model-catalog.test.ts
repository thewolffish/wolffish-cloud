/**
 * The model catalog as the phone receives it, and what the phone may send back.
 *
 * The phone picks the model now — its Model screen is a chip per allowed model
 * — and it can only pick from what this snapshot hands it, so two things are
 * load-bearing and neither fails loudly on its own:
 *
 * First, the list has to RIDE the snapshot. Without it the phone has one chip
 * (whatever the desktop is on) and no way to change it, which is exactly the
 * state this feature replaced; and because a missing section renders as a
 * documented default rather than an error, nothing on either device would say
 * so. The list must also travel in the API's own order — the order IS the
 * picker's order on both surfaces.
 *
 * Second, an EMPTY cache must omit the key rather than send `[]`. They are
 * different claims: absent means "this desktop has not fetched the catalog
 * yet" (cold start, signed out), and the phone answers it by showing the
 * current model alone; `[]` would read as "your organization allows nothing".
 * The snapshot is built on every config change, most of them long before a
 * catalog lands.
 *
 * And the way back: a phone that slept through a policy change would write a
 * withdrawn model and leave every turn failing upstream, so a known catalog
 * refuses it here — while an unfetched one still allows anything, or a phone
 * driving a desktop that has just launched could select nothing at all.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-model-catalog.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-model-catalog-'))
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

type WireModel = {
  id: string
  name: string
  reasoning: boolean
  vision: boolean
  contextWindow: number
  default: boolean
}

async function run(): Promise<void> {
  const { buildConfigSnapshot, modelSelectable } = await import('@main/channels/mobile/snapshot')
  const { primeCatalog } = await import('@main/cloud/catalog')
  const { setModel } = await import('@main/workspace/workspace')

  const readLlm = async (): Promise<{ brainModel?: string; models?: WireModel[] }> =>
    (
      (await buildConfigSnapshot({
        agent: {},
        serializeCapabilities: async () => []
      } as never)) as { llm?: { brainModel?: string; models?: WireModel[] } }
    ).llm ?? {}

  const FLASH = {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    vision: false,
    contextWindow: 1_048_576,
    inPerMtokMicroUsd: 80_000,
    outPerMtokMicroUsd: 180_000,
    default: true
  }
  const VISION = {
    id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    name: 'DeepSeek V4 Flash Vision',
    reasoning: true,
    vision: true,
    contextWindow: 1_048_576,
    inPerMtokMicroUsd: 215_600,
    outPerMtokMicroUsd: 646_800,
    default: false
  }

  // ------------------------------------------------- a cold cache says nothing

  {
    const llm = await readLlm()
    ok('an unfetched catalog omits the list', !('models' in llm), JSON.stringify(llm.models))
    ok('an unfetched catalog selects anything', modelSelectable('anything/at-all'))
  }

  // ------------------------------------------------------ what the phone gets

  {
    primeCatalog([FLASH, VISION], FLASH.id)
    const llm = await readLlm()
    const models = llm.models ?? []
    ok('the catalog reaches the phone', models.length === 2, JSON.stringify(llm))
    ok(
      'in the API’s own order — the picker’s order on both surfaces',
      models.map((m) => m.id).join(',') === `${FLASH.id},${VISION.id}`
    )

    const [flash, vision] = models
    ok('a model carries its display name', flash?.name === 'DeepSeek V4 Flash')
    ok('…its reasoning flag', flash?.reasoning === true)
    ok('…its context window', flash?.contextWindow === 1_048_576)
    ok('…and which one is the org default', flash?.default === true && vision?.default === false)
    // The phone decides whether an image may be attached from this flag; a
    // text-only model that reads as vision-capable fails at the API instead.
    ok('vision is per model, not per lane', flash?.vision === false && vision?.vision === true)
    // Prices are the one field that goes stale in silence (the host discounts
    // them out of band), and the ledger already carries what a turn cost.
    ok(
      'no prices ride along',
      !models.some((m) => 'inPerMtokMicroUsd' in m || 'outPerMtokMicroUsd' in m)
    )
  }

  // ------------------------------------------------ the selected model shows

  {
    await setModel(VISION.id)
    const llm = await readLlm()
    ok('the snapshot names what is selected', llm.brainModel === VISION.id)
    ok(
      'and the selected model is one of the chips',
      (llm.models ?? []).some((m) => m.id === llm.brainModel)
    )
  }

  // ----------------------------------------------------- what may come back

  {
    ok('a listed model may be selected', modelSelectable(VISION.id))
    ok('a withdrawn one may not', !modelSelectable('deepseek-ai/DeepSeek-V4-Retired'))

    // The policy narrowed while the phone slept: the model it still shows as
    // selected is gone from the catalog, and picking it again must be refused.
    primeCatalog([FLASH], FLASH.id)
    ok('a narrowed policy refuses the model it dropped', !modelSelectable(VISION.id))
    ok('and still accepts what survived', modelSelectable(FLASH.id))

    // A signed-out or freshly launched desktop knows no catalog. That is not
    // "nothing is allowed" — selection has to keep working there.
    primeCatalog([], null)
    ok('an emptied cache allows anything again', modelSelectable(VISION.id))
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
