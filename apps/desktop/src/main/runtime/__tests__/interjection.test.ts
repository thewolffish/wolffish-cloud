/**
 * Mid-turn messages, runtime side (see agent/interjection.ts):
 *  - the history entry a delivered message becomes mirrors a first message's
 *    shape (voice note block, attachment reference list);
 *  - (the cloud routes every model call through the org's OpenAI-shaped
 *    lane, where a user message after tool messages is already valid — the
 *    Anthropic merge checks of the personal edition do not apply here);
 *  - the runtime tail renders the one-iteration notice;
 *  - the channel-side rebuild replays a `user_message` segment as a real
 *    user entry between the iterations it split;
 *  - the doctrine, the notice and the segment docs share the vocabulary.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/interjection.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Module from 'node:module'
import os from 'node:os'

// channel.ts pulls the workspace root, which reads electron's app paths.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

let n = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    n++
    console.log(`✅ ${name}`)
  } catch (err) {
    n++
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const { INTERJECTION_NOTICE, interjectionToHistoryMessage, interjectionAckText } =
    await import('../agent/interjection')
  const { formatRuntimeStatus } = await import('../outbound')
  const { assistantSegmentsToHistory } = await import('@main/channels/channel')
  type Segment = import('../broca').Segment

  check('history entry: plain text passes through', () => {
    const m = interjectionToHistoryMessage({ text: 'skip the tests folder', attachments: [] })
    assert.equal(m.role, 'user')
    assert.equal(m.content, 'skip the tests folder')
    assert.equal(m.attachments, undefined)
  })

  check('history entry: voice note becomes the <voice_note> block, audio never attached', () => {
    const m = interjectionToHistoryMessage({
      text: 'use the other file',
      attachments: [],
      voicePrompt: true,
      voiceLang: 'en'
    })
    assert.equal(m.content, '<voice_note lang="en">\nuse the other file')
  })

  check('history entry: attachments become the model-led reference list', () => {
    const m = interjectionToHistoryMessage({
      text: 'and this one',
      attachments: [
        {
          type: 'pdf',
          filePath: 'uploads/conv-1/spec.pdf',
          originalName: 'spec.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1234
        }
      ]
    })
    assert.match(String(m.content), /<attachments>/)
    assert.match(String(m.content), /spec\.pdf/)
    assert.equal(m.attachments?.length, 1)
  })

  check('runtime tail: renders the interjection notice when set, nothing otherwise', () => {
    const withNotice = formatRuntimeStatus({
      iteration: 3,
      toolsCalled: 4,
      interjection: INTERJECTION_NOTICE
    })
    assert.ok(withNotice.includes(INTERJECTION_NOTICE))
    const without = formatRuntimeStatus({ iteration: 3, toolsCalled: 4 })
    assert.ok(!without.includes('arrived while you were working'))
  })

  check('rebuild: a user_message segment splits the turn into real history', () => {
    const segments: Segment[] = [
      { kind: 'active_model', turnId: 't', segmentId: 's1', provider: 'anthropic', model: 'm' },
      { kind: 'text', turnId: 't', segmentId: 's2', delta: 'reading' },
      {
        kind: 'tool_call',
        turnId: 't',
        segmentId: 's3',
        toolCallId: 'c1',
        name: 'file_read',
        args: {}
      },
      {
        kind: 'tool_result',
        turnId: 't',
        segmentId: 's4',
        toolCallId: 'c1',
        status: 'success',
        output: 'A'
      },
      {
        kind: 'user_message',
        turnId: 't',
        segmentId: 's5',
        messageId: 'm1',
        text: 'skip tests',
        timestamp: 1
      },
      { kind: 'active_model', turnId: 't', segmentId: 's6', provider: 'anthropic', model: 'm' },
      { kind: 'text', turnId: 't', segmentId: 's7', delta: 'got it, skipping' },
      { kind: 'turn_end', turnId: 't', segmentId: 's8', stopReason: 'end_turn', iterationCount: 2 }
    ]
    const out = assistantSegmentsToHistory({
      id: 'a1',
      role: 'assistant',
      content: 'readinggot it, skipping',
      timestamp: 1,
      segments
    } as never)
    assert.deepEqual(
      out.map((m) => m.role),
      ['assistant', 'tool', 'user', 'assistant']
    )
    assert.equal(out[2].content, 'skip tests')
    assert.equal((out[0] as { toolUses?: unknown[] }).toolUses?.length, 1)
    assert.equal(out[3].content, 'got it, skipping')
  })

  check('rebuild: the renderer applies the same rule (source parity)', () => {
    const chat = read('src/renderer/src/pages/Chat.tsx')
    assert.ok(chat.includes("s.kind === 'user_message'"), 'renderer textHistory handles the kind')
    assert.ok(chat.includes('flushIteration()\n          if (s.voicePrompt)'), 'flushes first')
  })

  check('doctrine, notice and ack share the vocabulary', () => {
    const core = read('src/defaults/workspace/brain/prefrontal/agents.core.md')
    assert.match(core, /message you while you work/)
    assert.match(core, /authoritative over the current plan/)
    assert.match(INTERJECTION_NOTICE, /arrived while you were working/)
    assert.match(INTERJECTION_NOTICE, /never restart work it does not affect/)
    assert.match(interjectionAckText(0), /after the current step/)
    assert.match(interjectionAckText(2), /2 files/)
  })

  console.log(`\n${n} checks`)
}

void main()
