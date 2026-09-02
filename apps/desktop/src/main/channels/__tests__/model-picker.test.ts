/**
 * Tests for the shared /model command helpers (channels/model-picker.ts)
 * behind the WhatsApp + Telegram `/model` command. One lane in Wolffish
 * Cloud: options are just model ids, and until the org API's per-user
 * catalog is wired in the only option is the current selection.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/model-picker.test.ts
 */

import { collectModelOptions, filterModelOptions, MODEL_LIST_CAP } from '../model-picker'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  }
}

// collectModelOptions
{
  ok('no selection → no options', collectModelOptions(null).length === 0)
  const options = collectModelOptions('deepseek-ai/DeepSeek-V4-Flash-0731')
  ok('selection → exactly one option', options.length === 1)
  ok('option carries the model id', options[0]?.model === 'deepseek-ai/DeepSeek-V4-Flash-0731')
  ok('cap is sane for future catalogs', MODEL_LIST_CAP > 0)
}

// filterModelOptions
{
  const options = collectModelOptions('deepseek-ai/DeepSeek-V4-Flash-0731')
  ok('empty query returns everything', filterModelOptions(options, '').length === 1)
  ok('substring match, case-insensitive', filterModelOptions(options, 'DEEPSEEK').length === 1)
  ok('non-match filters out', filterModelOptions(options, 'grok').length === 0)
  ok('whitespace-only query returns everything', filterModelOptions(options, '   ').length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
