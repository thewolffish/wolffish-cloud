/**
 * Empty-turn guard tests — pins the guardrail that intercepts a silent empty
 * end_turn (no tool calls, empty text) and injects a bounded number of "nudge"
 * messages to keep the loop going, instead of ending the turn on nothing.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx src/main/runtime/__tests__/empty-turn-guard.test.ts
 *
 * Imports stay on Electron-free leaf modules. The guard is a pure helper
 * (emptyTurnNudge); ParsedResponse inputs are manufactured via Wernicke.parse
 * over a fake StreamChunk generator, exactly matching what runRespond sees, so
 * the test also pins the parser contract the guard depends on.
 */

import { Wernicke, type ParsedResponse } from '../wernicke'
import type { StreamChunk } from '../thalamus'
import { emptyTurnNudge, MAX_EMPTY_TURN_NUDGES } from '../agent/empty-turn-guard'

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

async function* fakeStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c
}

const wernicke = new Wernicke()

// Empty end_turn: no text, no tool calls, end_turn — optionally with reasoning.
function emptyEndTurn(withReasoning = false): Promise<ParsedResponse> {
  const chunks: StreamChunk[] = []
  if (withReasoning) chunks.push({ type: 'reasoning', text: 'let me continue and add the rest' })
  chunks.push({
    type: 'turn_meta',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 0 }
  })
  return wernicke.parse(fakeStream(chunks))
}

// A turn that produced a tool call (iteration 1 in the real repro).
function toolCallTurn(): Promise<ParsedResponse> {
  return wernicke.parse(
    fakeStream([
      { type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
      { type: 'turn_meta', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
    ])
  )
}

// A normal, legitimate end_turn that produced real text.
function textEndTurn(): Promise<ParsedResponse> {
  return wernicke.parse(
    fakeStream([
      { type: 'text', text: 'All done.' },
      { type: 'turn_meta', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3 } }
    ])
  )
}

async function main(): Promise<void> {
  // Sanity: the fake stream really does parse to an empty end_turn.
  const empty = await emptyEndTurn()
  ok(
    'empty end_turn parses to no text / no tools',
    empty.text === '' && empty.toolCalls.length === 0
  )
  ok('empty end_turn keeps stopReason end_turn', empty.stopReason === 'end_turn')

  // 1. A first empty end_turn produces a provider-safe injection pair.
  const nudge = emptyTurnNudge(empty, 0)
  ok('first empty end_turn produces a nudge', nudge !== null)
  ok('nudge is a two-message pair', nudge?.length === 2)
  ok(
    'nudge[0] is a non-empty assistant (keeps provider alternation valid)',
    nudge?.[0].role === 'assistant' &&
      typeof nudge[0].content === 'string' &&
      nudge[0].content.length > 0
  )
  ok(
    'nudge[1] is a non-empty user prompt',
    nudge?.[1].role === 'user' &&
      typeof nudge[1].content === 'string' &&
      (nudge[1].content as string).length > 0
  )
  ok(
    'injected assistant carries no tool calls (no orphaned tool_use)',
    nudge?.[0].role === 'assistant' && nudge[0].toolUses === undefined
  )

  // 2. Reasoning content is threaded onto the placeholder when present.
  const emptyWithReasoning = await emptyEndTurn(true)
  const reasoningNudge = emptyTurnNudge(emptyWithReasoning, 0)
  ok(
    'reasoning is preserved on the injected assistant',
    reasoningNudge?.[0].role === 'assistant' && !!reasoningNudge[0].reasoningContent
  )

  // 3. A turn that produced a tool call is NOT an empty turn — never nudged.
  const withTool = await toolCallTurn()
  ok('tool-call turn is never nudged', emptyTurnNudge(withTool, 0) === null)

  // 4. A turn with real text is a legitimate end — never nudged.
  const withText = await textEndTurn()
  ok('text end_turn is never nudged', emptyTurnNudge(withText, 0) === null)

  // 5. Bounded: once the cap is reached, stop (no off-by-one at the boundary).
  ok('no nudge once the cap is reached', emptyTurnNudge(empty, MAX_EMPTY_TURN_NUDGES) === null)
  ok('nudge cap is small', MAX_EMPTY_TURN_NUDGES >= 1 && MAX_EMPTY_TURN_NUDGES <= 3)

  // 6. Repeated empty turns nudge exactly MAX_EMPTY_TURN_NUDGES times, then give up.
  let nudges = 0
  for (let count = 0; count < MAX_EMPTY_TURN_NUDGES + 2; count++) {
    if (emptyTurnNudge(empty, count) !== null) nudges++
  }
  ok(
    'bounded to exactly MAX_EMPTY_TURN_NUDGES nudges',
    nudges === MAX_EMPTY_TURN_NUDGES,
    String(nudges)
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
