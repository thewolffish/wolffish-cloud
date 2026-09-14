import { describe, expect, test } from 'bun:test'
import {
  applySegment,
  createAppStore,
  endAssistant,
  extractDeliveries,
  loadConversation
} from '../tui/store'

function seg(kind: string, extra: Record<string, unknown> = {}) {
  return { kind, turnId: 't1', segmentId: `s_${Math.random().toString(36).slice(2)}`, ...extra }
}

describe('segment reducer', () => {
  test('folds consecutive text deltas into one part even with distinct segment ids', () => {
    const store = createAppStore()
    applySegment(store, seg('text', { delta: 'hel' }), { live: true })
    applySegment(store, seg('text', { delta: 'lo' }), { live: true })
    const [state] = store
    const last = state.feed[state.feed.length - 1]
    expect(last.kind).toBe('assistant')
    if (last.kind !== 'assistant') return
    expect(last.parts.length).toBe(1)
    expect(last.parts[0].kind === 'text' && last.parts[0].text).toBe('hello')
  })

  test('reasoning then text closes the reasoning run and starts a text part', () => {
    const store = createAppStore()
    applySegment(store, seg('reasoning', { delta: 'think' }), { live: true })
    applySegment(store, seg('reasoning', { delta: 'ing' }), { live: true })
    applySegment(store, seg('text', { delta: 'answer' }), { live: true })
    applySegment(store, seg('reasoning', { delta: 'again' }), { live: true })
    const [state] = store
    const last = state.feed[state.feed.length - 1]
    if (last.kind !== 'assistant') throw new Error('expected assistant')
    expect(last.parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'reasoning'])
    const first = last.parts[0]
    expect(first.kind === 'reasoning' && first.text).toBe('thinking')
    expect(first.kind === 'reasoning' && first.endedAt !== undefined).toBe(true)
  })

  test('tool call pairs with its result and extracts delivered files', () => {
    const store = createAppStore()
    applySegment(
      store,
      seg('tool_call', { toolCallId: 'c1', name: 'send_file', args: { path: '/tmp/a.pdf' } }),
      { live: true }
    )
    applySegment(
      store,
      seg('tool_result', {
        toolCallId: 'c1',
        status: 'success',
        output: '[wolffish-output: /tmp/a.pdf (document)]'
      }),
      { live: true }
    )
    const [state] = store
    const last = state.feed[state.feed.length - 1]
    if (last.kind !== 'assistant') throw new Error('expected assistant')
    const tool = last.parts[0]
    expect(tool.kind).toBe('tool')
    if (tool.kind !== 'tool') return
    expect(tool.status).toBe('ok')
    expect(tool.files.length).toBe(1)
    expect(tool.files[0].index).toBe(1)
    expect(state.files.length).toBe(1)
    expect(state.activity).toBe('Thinking')
  })

  test('a quoted marker mid-line is not a delivery', () => {
    const { files, rest } = extractDeliveries(
      'use the template [wolffish-output: x (file)] in code'
    )
    expect(files.length).toBe(0)
    expect(rest.length).toBeGreaterThan(0)
  })

  test('todo replaces by list id across turns', () => {
    const store = createAppStore()
    applySegment(store, seg('todo', { items: [{ content: 'a', status: 'pending' }] }), {
      live: true
    })
    applySegment(
      store,
      seg('todo', { listId: 't1', items: [{ content: 'a', status: 'completed' }] }),
      { live: true }
    )
    const [state] = store
    const last = state.feed[state.feed.length - 1]
    if (last.kind !== 'assistant') throw new Error('expected assistant')
    const todos = last.parts.filter((p) => p.kind === 'todo')
    expect(todos.length).toBe(1)
    expect(todos[0].kind === 'todo' && todos[0].items[0].status).toBe('completed')
  })

  test('endAssistant seals the message and closes running tools', () => {
    const store = createAppStore()
    applySegment(
      store,
      seg('tool_call', { toolCallId: 'c2', name: 'shell', args: { command: 'ls' } }),
      { live: true }
    )
    endAssistant(store, 'boom')
    const [state] = store
    const last = state.feed[state.feed.length - 1]
    if (last.kind !== 'assistant') throw new Error('expected assistant')
    expect(last.endedAt).toBeDefined()
    expect(last.error).toBe('boom')
    expect(last.parts[0].kind === 'tool' && last.parts[0].status).toBe('error')
  })

  test('loadConversation replays stored segments and flat content', () => {
    const store = createAppStore()
    loadConversation(store, [
      { role: 'user', content: 'hi', timestamp: 1 },
      { role: 'assistant', content: 'flat answer', timestamp: 2 },
      {
        role: 'assistant',
        content: '',
        timestamp: 3,
        segments: [
          seg('text', { delta: 'seg' }),
          seg('text', { delta: 'mented' }),
          seg('turn_end', { stopReason: 'end_turn', iterationCount: 2 })
        ]
      }
    ])
    const [state] = store
    expect(state.feed.length).toBe(3)
    const flat = state.feed[1]
    expect(flat.kind === 'assistant' && flat.parts[0].kind === 'text' && flat.parts[0].text).toBe(
      'flat answer'
    )
    const replayed = state.feed[2]
    expect(
      replayed.kind === 'assistant' && replayed.parts[0].kind === 'text' && replayed.parts[0].text
    ).toBe('segmented')
    expect(replayed.kind === 'assistant' && replayed.iterations).toBe(2)
    expect(replayed.kind === 'assistant' && replayed.endedAt).toBe(3)
  })
})
