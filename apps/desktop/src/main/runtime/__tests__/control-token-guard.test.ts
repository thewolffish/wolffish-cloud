/**
 * Behavior tests for the control-token guard — the three detectors that
 * surface (never strip) a model faking silence: a trailing tokenizer control
 * token, a reply that is punctuation and nothing else, and a bracketed phrase
 * typed in place of an empty reply.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/control-token-guard.test.ts
 */
import assert from 'node:assert/strict'
import {
  armContentFreeReplyNotice,
  armControlTokenNotice,
  armSilencePlaceholderNotice,
  contentFreeReply,
  contentFreeReplyNotice,
  controlTokenNotice,
  drainControlTokenNotice,
  silencePlaceholder,
  silencePlaceholderNotice,
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
  assert.match(notice, /empty reply/, 'the notice names the silent ending as the fix')
  assert.doesNotMatch(
    notice,
    /\(no output\)|\(nothing to add\)/i,
    'the notice never prints a stand-in it forbids — printing one is how the model learns it'
  )
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

function testContentFreeDetectsFakedSilence(): void {
  // The observed leak (2026-09-06, deepseek-v4): a lone period as the whole reply.
  assert.equal(contentFreeReply('.'), '.')
  assert.equal(contentFreeReply('...'), '...')
  assert.equal(contentFreeReply('…'), '…')
  assert.equal(contentFreeReply('-'), '-')
  // Surrounding whitespace and invisible format chars are not content either.
  assert.equal(contentFreeReply('  .\n'), '.')
  assert.equal(contentFreeReply('\u200b.'), '.')
  console.log('ok: punctuation-only replies are detected as faked silence')
}

function testContentFreeNeverTripsOnContent(): void {
  // Truly empty is the empty-turn guard's job — nothing has reached the user yet.
  assert.equal(contentFreeReply(''), null)
  assert.equal(contentFreeReply('   \n'), null)
  // Real replies, however short, in any script.
  assert.equal(contentFreeReply('Done.'), null)
  assert.equal(contentFreeReply('Yes'), null)
  assert.equal(contentFreeReply('42'), null)
  assert.equal(contentFreeReply('نعم'), null)
  // Emoji are symbols, not punctuation — a thumbs-up IS a reply.
  assert.equal(contentFreeReply('👍'), null)
  assert.equal(contentFreeReply('✅'), null)
  // A long punctuation run is plausibly the content asked for; the guard defers.
  assert.equal(contentFreeReply('-----------'), null)
  console.log('ok: content, emoji, empty text and long rules never trip')
}

function testContentFreeNoticeEchoesAndDefers(): void {
  const notice = contentFreeReplyNotice('.')
  assert.match(notice, /`\.`/, 'the notice echoes the characters the user saw')
  assert.match(notice, /zero characters/, 'the notice names the silent ending as the fix')
  assert.doesNotMatch(
    notice,
    /\(no output\)|\(nothing to add\)/i,
    'the notice never prints a stand-in it forbids'
  )
  assert.match(notice, /disregard/, 'the notice defers to deliberate punctuation')
  console.log('ok: the content-free notice echoes, offers the silent exit, and defers')
}

function testContentFreeSharesTheNoticeSlot(): void {
  armContentFreeReplyNotice('conv-d', '.')
  const drained = drainControlTokenNotice('conv-d')
  assert.ok(drained && drained.includes('CONTENT-FREE'), 'drains through the shared slot')
  assert.equal(drainControlTokenNotice('conv-d'), undefined, 'drain clears')
  armContentFreeReplyNotice(null, '.')
  assert.equal(drainControlTokenNotice(null), undefined, 'null conversation id is a no-op')
  console.log('ok: the content-free notice rides the same per-conversation slot')
}

function testSilencePlaceholderDetectsTheObservedLeaks(): void {
  // The two shapes that actually shipped to users.
  assert.deepEqual(silencePlaceholder('(no content)'), { text: '(no content)', trailing: false })
  assert.deepEqual(silencePlaceholder('(no output)'), { text: '(no output)', trailing: false })
  assert.deepEqual(silencePlaceholder('  (No Output)\n'), {
    text: '(No Output)',
    trailing: false
  })
  // Stapled under a real reply, which is how 2026-09-12 landed.
  assert.deepEqual(
    silencePlaceholder('Done — the report is on your desktop.\n\n(no output)'),
    { text: '(no output)', trailing: true },
    'a marker on its own line after prose is the trailing shape'
  )
  // The rest of the vocabulary, in every bracket the models reach for.
  for (const reply of [
    '(nothing to add)',
    '[no reply]',
    '(empty response)',
    '(staying silent)',
    '(end of turn)',
    '(silence)',
    '(no further output)',
    '{nothing further}'
  ]) {
    assert.ok(silencePlaceholder(reply), `detects ${reply}`)
  }
  console.log('ok: bracketed stand-ins trip, alone and stapled onto prose')
}

function testSilencePlaceholderNeverTripsOnContent(): void {
  assert.equal(silencePlaceholder(''), null)
  assert.equal(silencePlaceholder('Done.'), null)
  assert.equal(silencePlaceholder('.'), null, "punctuation is the other detector's job")
  // An ordinary parenthetical inside a sentence is content, not a marker.
  assert.equal(
    silencePlaceholder('The command printed nothing (no output) and exited 0.'),
    null,
    'mid-sentence parentheticals are English, not a faked silence'
  )
  assert.equal(
    silencePlaceholder('The build ran clean (no output)'),
    null,
    'a trailing parenthetical on the SAME line as its sentence is still prose'
  )
  // Phrases with an ordinary use as content stay off the vocabulary.
  assert.equal(silencePlaceholder('Blockers: (none)'), null)
  assert.equal(silencePlaceholder('(n/a)'), null)
  assert.equal(silencePlaceholder('(see the attached diff for the full list of changes)'), null)
  console.log('ok: parentheticals, (none) and long asides never trip')
}

function testSilencePlaceholderNoticeSeparatesTheTwoShapes(): void {
  const alone = silencePlaceholderNotice({ text: '(no content)', trailing: false })
  assert.match(alone, /`\(no content\)`/, 'echoes what the user saw')
  assert.match(alone, /zero characters/, 'names the silent ending as the fix')
  assert.match(alone, /entire previous reply/, 'says the whole reply was the stand-in')
  assert.match(alone, /disregard/, 'defers to deliberate content')

  const stapled = silencePlaceholderNotice({ text: '(no output)', trailing: true })
  assert.match(stapled, /last real character/, 'names the appended-marker shape')
  assert.doesNotMatch(stapled, /entire previous reply/, 'a different mistake gets different copy')
  console.log('ok: the notice echoes, splits the two shapes, and defers')
}

function testSilencePlaceholderSharesTheNoticeSlot(): void {
  armSilencePlaceholderNotice('conv-e', { text: '(no content)', trailing: false })
  const drained = drainControlTokenNotice('conv-e')
  assert.ok(drained && drained.includes('SILENCE-PLACEHOLDER'), 'drains through the shared slot')
  assert.equal(drainControlTokenNotice('conv-e'), undefined, 'drain clears')
  armSilencePlaceholderNotice(null, { text: '(no content)', trailing: false })
  assert.equal(drainControlTokenNotice(null), undefined, 'null conversation id is a no-op')
  console.log('ok: the silence-placeholder notice rides the same per-conversation slot')
}

function main(): void {
  testCleanTextNeverTrips()
  testObservedLeakShapesTrip()
  testKnownTokenListTrips()
  testNoticeNamesTokenAndDefers()
  testArmAndDrainPerConversation()
  testContentFreeDetectsFakedSilence()
  testContentFreeNeverTripsOnContent()
  testContentFreeNoticeEchoesAndDefers()
  testSilencePlaceholderDetectsTheObservedLeaks()
  testSilencePlaceholderNeverTripsOnContent()
  testSilencePlaceholderNoticeSeparatesTheTwoShapes()
  testSilencePlaceholderSharesTheNoticeSlot()
  testContentFreeSharesTheNoticeSlot()
  console.log('\nAll control-token-guard tests passed.')
}

main()
