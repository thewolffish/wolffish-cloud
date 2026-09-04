jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockRpc = jest.fn()
const mockConnection = { connected: true }

jest.mock('@/lib/cloud/bridge', () => ({
  bridgeClient: {
    get connected() {
      return mockConnection.connected
    },
    get active() {
      return mockConnection.connected ? { rpc: mockRpc, connected: true } : null
    },
    reportRpcFailure: jest.fn(),
    subscribe: jest.fn(() => () => undefined)
  }
}))

import { resetOutboxForTests } from '@/lib/sync/outbox'
import { Rpc } from '@/lib/bridge/protocol'
import { useAppStore } from '@/state/appStore'
import {
  refreshConfigSnapshot,
  saveDesktopSetting,
  setConfigValue,
  useDemoConfig,
  type ConfigSnapshot
} from '@/state/demoConfig'

/**
 * The preference toggles' write-through path: a flip leaves the phone as a
 * configSet patch, holds its ground against a snapshot that was already in
 * the air when the user tapped, and reverts to desktop truth when the desktop
 * refuses. The race case is the load-bearing one — without the outbox mark a
 * racing refresh puts the old value back under the user's thumb for the
 * second it takes the desktop's confirmation push to arrive, and the switch
 * visibly snaps back and forth.
 */

/** Smallest snapshot the applier accepts, with knobs where the tests look. */
function snapshotWith(overrides: {
  bypassPermissions?: boolean
  blockCredentials?: boolean
  /** Absent = the pre-mobile-settings shape, which is its own test below. */
  mobile?: { notifications?: boolean; verbose?: boolean }
}): ConfigSnapshot {
  return {
    capabilities: [],
    mcpServers: [],
    variables: [],
    services: {
      braveEnabled: true,
      sttModel: 'stt',
      ttsVoice: 'voice',
      ttsSpeed: '1.0',
      screenshotMaxWidth: '1280',
      screenshotFormat: 'jpeg'
    },
    channels: {
      ...(overrides.mobile ? { mobile: overrides.mobile } : {})
    },
    llm: {
      brainProvider: 'anthropic',
      brainModel: 'claude-opus-4-8',
      chatMode: 'single'
    },
    preferences: {
      launchAtStartup: false,
      bypassPermissions: overrides.bypassPermissions ?? false,
      blockCredentials: overrides.blockCredentials ?? false,
      weekStartsOn: 1
    }
  }
}

const configSetCalls = (): unknown[][] =>
  mockRpc.mock.calls.filter(([method]) => method === Rpc.configSet)

describe('preference toggles write-through', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    mockConnection.connected = true
    useAppStore.setState({ paired: true })
    useDemoConfig.setState({ bypassPermissions: false, blockCredentials: false })
  })

  afterEach(() => {
    jest.useRealTimers()
    useAppStore.setState({ paired: false })
  })

  it('a flip lands locally and leaves as exactly one configSet patch', async () => {
    setConfigValue('bypassPermissions', true)
    expect(useDemoConfig.getState().bypassPermissions).toBe(true)
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { bypassPermissions: true } }]])
  })

  it('the week-start choice writes through like a switch, 0|1 on the wire', async () => {
    useDemoConfig.setState({ weekStartsOn: 1 })
    setConfigValue('weekStartsOn', 0)
    expect(useDemoConfig.getState().weekStartsOn).toBe(0)
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { weekStartsOn: 0 } }]])
  })

  it('a snapshot fetched across a flip keeps the flip; the next quiet one applies', async () => {
    // The refresh is already in the air when the user taps the switch.
    let resolveFetch!: (value: unknown) => void
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => (resolveFetch = resolve)))
    const raced = refreshConfigSnapshot()
    setConfigValue('bypassPermissions', true)
    resolveFetch(snapshotWith({ bypassPermissions: false }))
    await raced
    expect(useDemoConfig.getState().bypassPermissions).toBe(true)

    // The push settles; afterwards a quiet fetch is desktop truth and applies.
    await jest.advanceTimersByTimeAsync(0)
    mockRpc.mockResolvedValueOnce(snapshotWith({ bypassPermissions: false }))
    await refreshConfigSnapshot()
    expect(useDemoConfig.getState().bypassPermissions).toBe(false)
  })

  it('a refused write reverts the row to the snapshot the desktop answers with', async () => {
    mockRpc.mockImplementation(async (method: string) => {
      if (method === Rpc.configSet) throw new Error('not editable')
      return snapshotWith({ bypassPermissions: false })
    })
    setConfigValue('bypassPermissions', true)
    expect(useDemoConfig.getState().bypassPermissions).toBe(true)
    await jest.advanceTimersByTimeAsync(0)
    expect(useDemoConfig.getState().bypassPermissions).toBe(false)
    const methods = mockRpc.mock.calls.map(([method]) => method)
    expect(methods).toEqual([Rpc.configSet, Rpc.configSnapshot])
  })

  it('keys the desktop does not accept stay local and off the wire', async () => {
    setConfigValue('brainProvider', 'display-only')
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([])
    expect(useDemoConfig.getState().brainProvider).toBe('display-only')
  })

  it('saveDesktopSetting answers true only when the desktop accepted', async () => {
    await expect(saveDesktopSetting('blockCredentials', true)).resolves.toBe(true)
    expect(configSetCalls()).toEqual([[Rpc.configSet, { settings: { blockCredentials: true } }]])

    mockRpc.mockImplementation(async (method: string) => {
      if (method === Rpc.configSet) throw new Error('refused')
      return snapshotWith({ blockCredentials: true })
    })
    await expect(saveDesktopSetting('blockCredentials', false)).resolves.toBe(false)
    // Reverted to the snapshot's value, not left on the refused edit — the
    // optimistic false must not survive a desktop that says true.
    expect(useDemoConfig.getState().blockCredentials).toBe(true)
  })
})

/**
 * The rest of the editable surface — model routing, the channel rows, the
 * MCP map and the compaction schedule, whitelisted in the any-setting pass. Same contract as the preference toggles above (a
 * local move plus exactly one configSet patch), pinned once per SHAPE — a
 * switch, a select string, a number, a whole map, a whole array — because
 * every key of a shape shares one code path, and pinned by the exact
 * payload because the desktop's whitelist names these keys byte for byte.
 */
describe('the wider editable surface', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    mockConnection.connected = true
    useAppStore.setState({ paired: true })
    useDemoConfig.setState({
      chatMode: 'single',
      thinkingMode: 'high',
      brainModel: 'claude-opus-4-8',
      inappVerbose: false,
      mobileVerbose: false,
      compactionDailyHour: 23,
      mcpServers: { 'github-mcp': true, 'notion-mcp': false }
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    useAppStore.setState({ paired: false })
  })

  it('the composer’s model controls leave as configSet patches', async () => {
    setConfigValue('chatMode', 'workflow')
    setConfigValue('thinkingMode', 'max')
    setConfigValue('brainModel', 'claude-sonnet-4-5')
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([
      [Rpc.configSet, { settings: { chatMode: 'workflow' } }],
      [Rpc.configSet, { settings: { thinkingMode: 'max' } }],
      [Rpc.configSet, { settings: { brainModel: 'claude-sonnet-4-5' } }]
    ])
  })

  it('a channel row and the compaction schedule write through', async () => {
    setConfigValue('inappVerbose', true)
    setConfigValue('mobileVerbose', true)
    setConfigValue('compactionDailyHour', 5)
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([
      [Rpc.configSet, { settings: { inappVerbose: true } }],
      [Rpc.configSet, { settings: { mobileVerbose: true } }],
      [Rpc.configSet, { settings: { compactionDailyHour: 5 } }]
    ])
  })

  it('an MCP toggle sends the whole map, edited entry included', async () => {
    setConfigValue('mcpServers', {
      ...useDemoConfig.getState().mcpServers,
      'notion-mcp': true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([
      [Rpc.configSet, { settings: { mcpServers: { 'github-mcp': true, 'notion-mcp': true } } }]
    ])
    expect(useDemoConfig.getState().mcpServers['notion-mcp']).toBe(true)
  })

  // Web search is the organization's lane: the desktop refuses a phone write
  // to it, so the phone never sends one — the row is status, not a switch.
  it('the web-search lane stays off the wire', async () => {
    useDemoConfig.setState({ braveEnabled: true })
    setConfigValue('braveEnabled', false)
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([])
    await expect(saveDesktopSetting('braveEnabled', true)).resolves.toBe(false)
    expect(configSetCalls()).toEqual([])
  })
})

/**
 * This phone's own two channel settings — the pair the Channels screen's
 * "This phone" card carries, and the desktop's Mobile panel carries too.
 *
 * They were the first settings on this screen the phone could actually WRITE,
 * so the thing worth holding is that they leave as configSet patches
 * rather than sitting locally looking applied until the next refresh quietly
 * undoes them. The absent-section case is the older desktop: notifications
 * default ON, and a phone that read that as off would show a switch saying
 * the agent cannot reach it while the agent happily keeps notifying.
 */
describe('this phone as a channel', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    mockConnection.connected = true
    useAppStore.setState({ paired: true })
    useDemoConfig.setState({ mobileNotifications: true, mobileVerbose: false })
  })

  afterEach(() => {
    jest.useRealTimers()
    useAppStore.setState({ paired: false })
  })

  it('both switches write through to the desktop', async () => {
    setConfigValue('mobileNotifications', false)
    setConfigValue('mobileVerbose', true)
    await jest.advanceTimersByTimeAsync(0)
    expect(configSetCalls()).toEqual([
      [Rpc.configSet, { settings: { mobileNotifications: false } }],
      [Rpc.configSet, { settings: { mobileVerbose: true } }]
    ])
  })

  it('a snapshot carrying the section applies both values', async () => {
    mockRpc.mockResolvedValueOnce(snapshotWith({ mobile: { notifications: false, verbose: true } }))
    await refreshConfigSnapshot()
    expect(useDemoConfig.getState().mobileNotifications).toBe(false)
    expect(useDemoConfig.getState().mobileVerbose).toBe(true)
  })

  it('a desktop from before the section falls back to notifications on, feed clean', async () => {
    useDemoConfig.setState({ mobileNotifications: false, mobileVerbose: true })
    mockRpc.mockResolvedValueOnce(snapshotWith({}))
    await refreshConfigSnapshot()
    expect(useDemoConfig.getState().mobileNotifications).toBe(true)
    expect(useDemoConfig.getState().mobileVerbose).toBe(false)
  })
})
