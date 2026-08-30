/**
 * The overlay stack's state: what the wire is allowed to say, and what the
 * three-row cap does with it.
 *
 * Two failure modes are worth pinning and neither crashes. The first is version
 * skew — every field past `id`/`label` was added for these cards, so a phone
 * talking to an older desktop is handed rows without them, and a card built
 * from `undefined` renders `NaN` and a clock counting from 1970. The second is
 * ordering: the cap only takes the first three, so what "first" means decides
 * which run the user is not told about.
 */

const mockRpc = jest.fn()
const link = { connected: true }
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return link.connected
    },
    get active() {
      return link.connected ? { rpc: mockRpc, connected: true } : null
    },
    reportRpcFailure: jest.fn()
  }
}))

import {
  applyOverlayReindex,
  applyOverlayRuns,
  clearOverlays,
  composeOverlays,
  MAX_OVERLAYS,
  readReindex,
  readRuns,
  seedOverlays,
  useOverlayStore
} from '@/lib/sync/overlays'
import type { AutomationRun, AutomationRuns } from '@/lib/tunnel/protocol'

function run(id: string, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    label: id,
    body: `prompt for ${id}`,
    kind: 'automation',
    startedAt: 1_000,
    mode: null,
    ...over
  }
}

function pool(running: AutomationRun[], queued: AutomationRuns['queued'] = []): AutomationRuns {
  return { running, queued }
}

beforeEach(() => {
  mockRpc.mockReset()
  link.connected = true
  clearOverlays()
})

describe('reading the wire', () => {
  it('fills in every field an older desktop does not send', () => {
    const runs = readRuns({ running: [{ id: 'j', label: 'Daily' }], queued: [{ id: 'q' }] })
    expect(runs.running[0]).toEqual({
      id: 'j',
      label: 'Daily',
      body: '',
      kind: 'automation',
      // 0, not Date.now(): a clock seeded from "now" on every push would reset
      // each tick and never advance. The UI reads 0 as "no start time".
      startedAt: 0,
      mode: null
    })
    expect(runs.queued[0]).toEqual({ id: 'q', label: '', kind: 'automation', queuedAt: 0 })
  })

  it('drops rows with no id and junk payloads', () => {
    expect(readRuns({ running: [{ label: 'nameless' }, null, 7], queued: 'nope' })).toEqual({
      running: [],
      queued: []
    })
    expect(readRuns(null)).toEqual({ running: [], queued: [] })
  })

  it('refuses a kind it does not know, rather than rendering an undefined tone', () => {
    // The tone table is indexed by kind; an unknown one would look up
    // undefined and throw inside the card.
    expect(readRuns({ running: [{ id: 'j', kind: 'telepathy' }] }).running[0].kind).toBe(
      'automation'
    )
    expect(readRuns({ running: [{ id: 'j', kind: 'reflection' }] }).running[0].kind).toBe(
      'reflection'
    )
  })

  it('reads a reindex, and treats the end of one as null', () => {
    expect(readReindex({ status: { startedAt: 5, done: 3, total: 10 } })).toEqual({
      startedAt: 5,
      done: 3,
      total: 10
    })
    expect(readReindex({ status: null })).toBeNull()
    expect(readReindex(null)).toBeNull()
  })

  it('ignores a rebuild with no files, and clamps done past total', () => {
    // A bar over zero files means nothing, and a bar past 100% is a lie.
    expect(readReindex({ status: { startedAt: 5, done: 0, total: 0 } })).toBeNull()
    expect(readReindex({ status: { startedAt: 5, done: 99, total: 10 } })?.done).toBe(10)
  })
})

describe('composing the stack', () => {
  it('leads with the reindex, then runs oldest first', () => {
    const { active } = composeOverlays(
      pool([run('b', { startedAt: 3_000 }), run('a', { startedAt: 1_000 })]),
      { startedAt: 9_999, done: 1, total: 2 }
    )
    expect(active.map((overlay) => overlay.id)).toEqual(['reindex', 'a', 'b'])
  })

  it('caps at three rows and counts what it left out', () => {
    const { active, hidden } = composeOverlays(
      pool([run('a', { startedAt: 1 }), run('b', { startedAt: 2 }), run('c', { startedAt: 3 })]),
      { startedAt: 0, done: 1, total: 2 }
    )
    // The pool caps itself at three, but a reindex can overlap it and make
    // four — so the newest run is the one that goes unshown, not silently
    // dropped.
    expect(active).toHaveLength(MAX_OVERLAYS)
    expect(active.map((overlay) => overlay.id)).toEqual(['reindex', 'a', 'b'])
    expect(hidden).toBe(1)
  })

  it('hides nothing when everything fits', () => {
    const { active, hidden } = composeOverlays(pool([run('a')]), null)
    expect(active).toHaveLength(1)
    expect(hidden).toBe(0)
  })

  it('passes the queue through untouched', () => {
    const queued = [{ id: 'q', label: 'Weekly', kind: 'automation' as const, queuedAt: 5 }]
    expect(composeOverlays(pool([], queued), null).queued).toEqual(queued)
  })

  it('drops a family whose cards are switched off — card, queue row and count', () => {
    // Off is not "shown smaller": a hidden run must not survive as a "+1 more"
    // the user cannot open, or the strip becomes the interruption instead.
    const { active, queued, hidden } = composeOverlays(
      pool(
        [
          run('auto', { kind: 'automation', startedAt: 1 }),
          run('daily', { kind: 'compaction', startedAt: 2 }),
          run('nightly', { kind: 'reflection', startedAt: 3 })
        ],
        [{ id: 'q', label: 'Weekly', kind: 'automation' as const, queuedAt: 5 }]
      ),
      null,
      { automation: false, compaction: true, reflection: false }
    )
    expect(active.map((overlay) => overlay.id)).toEqual(['daily'])
    expect(queued).toEqual([])
    expect(hidden).toBe(0)
  })

  it('lets a procedure run ride the automations switch', () => {
    const pooled = pool([
      run('proc', { kind: 'procedure', startedAt: 1 }),
      run('auto', { kind: 'automation', startedAt: 2 })
    ])
    const on = composeOverlays(pooled, null, {
      automation: true,
      compaction: false,
      reflection: false
    })
    expect(on.active.map((overlay) => overlay.id)).toEqual(['proc', 'auto'])
    const off = composeOverlays(pooled, null, {
      automation: false,
      compaction: true,
      reflection: true
    })
    expect(off.active).toEqual([])
  })

  it('never hides the reindex — it has no switch', () => {
    const { active } = composeOverlays(
      pool([run('auto')]),
      { startedAt: 0, done: 1, total: 2 },
      {
        automation: false,
        compaction: false,
        reflection: false
      }
    )
    expect(active.map((overlay) => overlay.id)).toEqual(['reindex'])
  })

  it('carries the prompt and mode onto the card', () => {
    const [card] = composeOverlays(
      pool([run('a', { body: 'Summarise the day', mode: 'workflow', kind: 'reflection' })]),
      null
    ).active
    expect(card).toEqual({
      kind: 'reflection',
      id: 'a',
      label: 'a',
      body: 'Summarise the day',
      startedAt: 1_000,
      mode: 'workflow'
    })
  })
})

describe('the store', () => {
  it('folds a run push and a reindex push independently', () => {
    applyOverlayRuns(pool([run('a')]))
    applyOverlayReindex({ startedAt: 1, done: 1, total: 2 })
    expect(useOverlayStore.getState().runs.running).toHaveLength(1)
    expect(useOverlayStore.getState().reindex).not.toBeNull()

    // A rebuild ending must not take the running automations with it.
    applyOverlayReindex(null)
    expect(useOverlayStore.getState().reindex).toBeNull()
    expect(useOverlayStore.getState().runs.running).toHaveLength(1)
  })

  it('empties on a dropped tunnel', () => {
    // Every card asserts something is happening right now on a machine this
    // one can no longer see.
    applyOverlayRuns(pool([run('a')]))
    applyOverlayReindex({ startedAt: 1, done: 1, total: 2 })
    clearOverlays()
    expect(useOverlayStore.getState()).toEqual({
      runs: { running: [], queued: [] },
      reindex: null
    })
  })
})

describe('seeding on connect', () => {
  it('takes the desktop’s answer whole', async () => {
    mockRpc.mockResolvedValue({
      runs: { running: [{ id: 'a', label: 'Daily', kind: 'compaction' }], queued: [] },
      reindex: { startedAt: 4, done: 2, total: 8 }
    })
    await seedOverlays()
    const state = useOverlayStore.getState()
    expect(state.runs.running[0].kind).toBe('compaction')
    expect(state.reindex).toEqual({ startedAt: 4, done: 2, total: 8 })
  })

  it('leaves the stack empty when the desktop is too old to answer', async () => {
    // An unsupported method is not a sick tunnel and nothing the user asked
    // for has failed, so this must neither throw nor report a failure — the
    // stack simply waits for the next push, as it did before these existed.
    mockRpc.mockRejectedValue(new Error('unknown method'))
    await expect(seedOverlays()).resolves.toBeUndefined()
    expect(useOverlayStore.getState().runs.running).toEqual([])
  })

  it('does not call out over a dead tunnel', async () => {
    link.connected = false
    await seedOverlays()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('loses to a push that landed while it was in flight', async () => {
    // The seed goes out on the same edge that attaches the push handlers, so
    // this is not a rare interleaving — it is one round trip wide, every
    // reconnect. Without the guard the answer arrives describing a world that
    // has already moved on and puts the finished run back on screen, and the
    // push that ended it was very likely the last one that pool had to send.
    let answer!: (value: unknown) => void
    mockRpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const seeding = seedOverlays()

    applyOverlayRuns(pool([]))
    answer({ runs: pool([run('a')]), reindex: null })
    await seeding

    expect(useOverlayStore.getState().runs.running).toEqual([])
  })

  it('applies when nothing else wrote while it waited', async () => {
    // The other half of the guard: a quiet round trip must still seed, or a
    // phone connecting mid-run shows nothing until that run ends.
    mockRpc.mockResolvedValue({ runs: pool([run('a')]), reindex: null })
    await seedOverlays()
    expect(useOverlayStore.getState().runs.running).toHaveLength(1)
  })
})
