/**
 * The admin transcript's data path: the org's records → the messages the
 * chat renderers draw → the action log.
 *
 * This is the half of that screen that can be wrong without looking wrong.
 * A message whose payload is dropped still renders — as a bare line of text,
 * missing its tool cards — and an admin would have no way to tell they were
 * reading an abridged version. So the rules are asserted directly:
 * last-version-wins, seq ordering, and the payload arriving intact.
 */
import { rebuildConversation, rebuiltToMessages } from '@/lib/sync/rebuild'
import { actionLog } from '@/lib/admin/actionLog'
import type { WireRecord } from '@/lib/cloud/api'

const rec = (over: Partial<WireRecord> & Pick<WireRecord, 'id'>): WireRecord => ({
  seq: 1,
  kind: 'message',
  content: {},
  created_at: '2026-09-04T00:00:00.000Z',
  ...over
})

describe('rebuilding another person’s conversation', () => {
  it('keeps the version the org received LAST, not the highest seq', () => {
    // Seq is the message's TIMESTAMP, and a writer can re-stamp a message
    // between pushes — so the newest copy is sometimes the lower seq.
    const messages = rebuiltToMessages(
      rebuildConversation([
        rec({
          id: 'm_1.aaaaaaaa',
          seq: 1_700_000_000_500,
          content: { role: 'user', content: 'stale' }
        }),
        rec({
          id: 'm_1.bbbbbbbb',
          seq: 1_700_000_000_100,
          content: { role: 'user', content: 'fresh' }
        })
      ])
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('fresh')
  })

  it('orders by seq and keeps a prompt above its own reply', () => {
    const messages = rebuiltToMessages(
      rebuildConversation([
        rec({ id: 'm_2.aaaaaaaa', seq: 2, content: { role: 'assistant', content: 'reply' } }),
        rec({ id: 'm_1.bbbbbbbb', seq: 1, content: { role: 'user', content: 'prompt' } })
      ])
    )
    expect(messages.map((m) => m.content)).toEqual(['prompt', 'reply'])
  })

  it('carries the payload through, so every card the owner saw still renders', () => {
    const messages = rebuiltToMessages(
      rebuildConversation([
        rec({
          id: 'm_1.aaaaaaaa',
          seq: 1,
          content: {
            role: 'assistant',
            content: 'done',
            segments: [{ kind: 'tool_call', segmentId: 's1', name: 'bash', args: { cmd: 'ls' } }],
            stopReason: 'end_turn'
          }
        })
      ])
    )
    expect(messages[0]!.segments).toHaveLength(1)
    expect(messages[0]!.stopReason).toBe('end_turn')
  })

  it('takes the envelope from the snapshot without turning it into a message', () => {
    const rebuilt = rebuildConversation([
      rec({
        id: 'c.snapshot',
        kind: 'snapshot',
        seq: 9,
        content: { updatedAt: 1_700_000_000_000 }
      }),
      rec({ id: 'm_1.aaaaaaaa', seq: 1, content: { role: 'user', content: 'hi' } })
    ])
    expect(rebuilt.updatedAt).toBe(1_700_000_000_000)
    expect(rebuilt.messages).toHaveLength(1)
  })
})

describe('the action log', () => {
  const messages = rebuiltToMessages(
    rebuildConversation([
      rec({
        id: 'm_1.aaaaaaaa',
        seq: 1,
        content: {
          role: 'assistant',
          content: '',
          segments: [
            { kind: 'text', delta: 'thinking' },
            {
              kind: 'tool_call',
              segmentId: 's1',
              name: 'browser_navigate',
              args: { url: 'https://x.test' }
            },
            {
              kind: 'tool_call',
              segmentId: 's2',
              name: 'write_file',
              args: { path: '/tmp/a.txt', content: 'one\ntwo\n\tthree' }
            }
          ]
        }
      }),
      rec({ id: 'm_2.bbbbbbbb', seq: 2, content: { role: 'user', content: 'and again' } })
    ])
  )

  it('lists every tool call, in order, and nothing else', () => {
    const log = actionLog(messages)
    expect(log.map((e) => e.name)).toEqual(['browser_navigate', 'write_file'])
  })

  it('flags the browser tools, which is how extension work is told apart', () => {
    const log = actionLog(messages)
    expect(log[0]!.browser).toBe(true)
    expect(log[1]!.browser).toBe(false)
  })

  it('keeps a multi-line argument on one row', () => {
    // A write_file or bash call carries whole files; clipping alone leaves
    // any newline inside the limit intact, and one of those breaks the row.
    const detail = actionLog(messages)[1]!.detail
    expect(detail).not.toContain('\n')
    expect(detail).toContain('one two three')
  })

  it('is empty for a conversation nobody ran a tool in', () => {
    const plain = rebuiltToMessages(
      rebuildConversation([
        rec({ id: 'm_1.aaaaaaaa', seq: 1, content: { role: 'user', content: 'hi' } })
      ])
    )
    expect(actionLog(plain)).toEqual([])
  })
})
