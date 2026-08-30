/**
 * Behavior tests for the control-token guard — the trailing-control-token
 * detector that surfaces (never strips) a "you sent the user a literal
 * tokenizer token" signal.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/control-token-guard.test.ts
 */
import assert from 'node:assert/strict'
import {
  armControlTokenNotice,
  controlTokenNotice,
  drainControlTokenNotice,
  trailingControlToken
} from '@main/runtime/agent/control-token-guard'

function testCleanTextNeverTrips(): void {
  assert.equal(trailingControlToken('All set — the report is on your desktop.'), null)
  assert.equal(trailingControlToken(''), null)
  // A mid-prose MENTION is content, not a leak — the user may be discussing
  // tokenizers (or this very bug). Only a trailing token trips.
  assert.equal(trailingControlToken('The token <|eos|> is an end-of-sequence marker.'), null)
  // `</s>` is deliberately off the list: legitimate closing-tag markup.
  assert.equal(trailingControlToken('That was <s>wrong</s>'), null)
  console.log('ok: clean text, mid-prose mentions, and </s> endings never trip')
}

function testObservedLeakShapesTrip(): void {
  // The two shapes observed live (grok-4.6): the token as the ENTIRE reply of
  // a telemetry continuation, and the token appended to otherwise-good text
  // (the Aug 14 conversation title).
  assert.equal(trailingControlToken('<|eos|>'), '<|eos|>')
  assert.equal(trailingControlToken('Daily (15:22): Younes AI Daily Arabic PDF<|eos|>'), '<|eos|>')
  // Trailing whitespace after the token still counts as trailing.
  assert.equal(trailingControlToken('Done.<|eos|>\n'), '<|eos|>')
  console.log('ok: both observed leak shapes are detected')
}

function testKnownTokenListTrips(): void {
  for (const token of [
    '<|eos|>',
    '<|endoftext|>',
    '<|im_end|>',
    '<|eot_id|>',
    '<|end_of_text|>',
    '<|end▁of▁sentence|>'
  ]) {
    assert.equal(trailingControlToken(`reply text${token}`), token, `detects trailing ${token}`)
  }
  console.log('ok: every token on the conservative list is detected when trailing')
}

function testNoticeNamesTokenAndDefers(): void {
  const notice = controlTokenNotice('<|eos|>')
  assert.match(notice, /<\|eos\|>/, 'the notice names the leaked token')
  assert.match(notice, /disregard/, 'the notice defers to deliberate quoting')
  assert.match(notice, /no output at all/, 'the notice names the silent ending as the fix')
  console.log('ok: the notice names the token, offers the silent exit, and defers')
}

function testArmAndDrainPerConversation(): void {
  assert.equal(drainControlTokenNotice('conv-a'), undefined, 'nothing pending initially')
  armControlTokenNotice('conv-a', '<|eos|>')
  assert.equal(drainControlTokenNotice('conv-b'), undefined, 'other conversations unaffected')
  const drained = drainControlTokenNotice('conv-a')
  assert.ok(drained && drained.includes('<|eos|>'), 'armed notice drains for its conversation')
  assert.equal(
    drainControlTokenNotice('conv-a'),
    undefined,
    'drain clears — announced exactly once'
  )
  // Null conversation id (no conversation to tell) is a no-op on both sides.
  armControlTokenNotice(null, '<|eos|>')
  assert.equal(drainControlTokenNotice(null), undefined)
  // Latest leak wins when two arm before a drain.
  armControlTokenNotice('conv-c', '<|eos|>')
  armControlTokenNotice('conv-c', '<|im_end|>')
  const latest = drainControlTokenNotice('conv-c')
  assert.ok(latest && latest.includes('<|im_end|>'), 'latest arm overwrites')
  console.log('ok: arm/drain is per-conversation, once-only, null-safe, latest-wins')
}

function main(): void {
  testCleanTextNeverTrips()
  testObservedLeakShapesTrip()
  testKnownTokenListTrips()
  testNoticeNamesTokenAndDefers()
  testArmAndDrainPerConversation()
  console.log('\nAll control-token-guard tests passed.')
}

main()
