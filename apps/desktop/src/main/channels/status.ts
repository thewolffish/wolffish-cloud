import type { MobileStatus } from '@main/channels/mobile/channel'

/**
 * A point-in-time view of one messaging channel's connectivity, shaped for
 * the agent rather than the settings UI. This is the single source of truth
 * behind both `wolffish_status` (a compact one-liner) and the dedicated
 * `channel_status` tool (the full view with reconnect steps). The agent uses
 * it to decide whether it can reach the user on a channel and, when it can't,
 * to tell them exactly how to reconnect — instead of guessing or trying to
 * GUI-automate a desktop app that isn't there.
 */
export type ChannelStatusSnapshot = {
  /** Stable channel id used in tool output and logs. */
  id: 'mobile' | 'cli' | 'electron'
  /** Human label shown to the user (e.g. "Mobile"). */
  label: string
  /** True when the channel is connected and able to send right now. */
  connected: boolean
  /** Raw lifecycle state (connected, listening, unpaired, …). */
  state: string
  /** One-line specifics — linked phone, attached terminals, or why it's down. */
  detail: string
  /** When NOT connected, concrete steps to (re)connect. Empty when connected. */
  reconnect: string
}

/**
 * Live status getters for the channels that have a connection lifecycle. The
 * in-app (Electron) channel has no getter — it's reported as always available
 * while the desktop app is open.
 */
export type ChannelStatusDeps = {
  mobile: () => MobileStatus
  /** Terminals attached to the control socket right now. */
  cli?: () => { clients: number; listening: boolean }
  /** True when this process has no window and never will. */
  headless?: () => boolean
}

const MOBILE_PAIR =
  'Open Settings → Channels → Mobile and start a pairing — scan the QR with the Wolffish app on your phone, or use the typed code.'
const MOBILE_WAKE =
  'Open the Wolffish app on your phone — it reconnects to the desktop by itself once it is on screen.'

/**
 * Snapshot every channel's connectivity. Always returns all channels (in a
 * stable order) so the agent can see which are down, not just which are up.
 */
export function collectChannelStatus(deps: ChannelStatusDeps): ChannelStatusSnapshot[] {
  return [
    mobileSnapshot(deps.mobile()),
    cliSnapshot(deps.cli?.() ?? null),
    electronSnapshot(deps.headless?.() ?? false)
  ]
}

/**
 * The terminal, as a channel like any other.
 *
 * It was missing from this list entirely, which on a headless box meant the
 * status the agent reads — and prints — named every way of reaching the user
 * EXCEPT the only one that worked.
 */
function cliSnapshot(cli: { clients: number; listening: boolean } | null): ChannelStatusSnapshot {
  const listening = cli?.listening === true
  const clients = cli?.clients ?? 0
  return {
    id: 'cli',
    label: 'Terminal',
    // Reachable means someone is attached. The socket being up only means a
    // terminal COULD attach, which is not somewhere a message can be sent.
    connected: listening && clients > 0,
    state: listening ? (clients > 0 ? 'attached' : 'listening') : 'off',
    detail: !listening
      ? 'the control socket is not listening'
      : clients > 0
        ? `${clients} terminal${clients === 1 ? '' : 's'} attached`
        : 'no terminal attached — run: wolffish',
    reconnect: listening ? '' : 'Restart Wolffish — the control socket failed to start.'
  }
}

/**
 * The paired phone.
 *
 * It was missing from this list entirely, which meant a phone could be paired
 * and reachable while every surface that reads this — `wolffish status`, the
 * agent's `channel_status` and `wolffish_status` — reported no mobile. The
 * agent could not know it had a way to reach the user.
 *
 * PAIRED IS NOT CONNECTED, and the difference is the whole reason this row is
 * worth having. A pairing is durable; the bridge only carries traffic while
 * the app is actually on screen. `connected` therefore tracks the TUNNEL —
 * anything else would tell the agent it can reach a phone that is in someone's
 * pocket — while the detail line still says the phone is paired, so "down"
 * never reads as "gone".
 */
function mobileSnapshot(s: MobileStatus): ChannelStatusSnapshot {
  if (!s.paired) {
    return {
      id: 'mobile',
      label: 'Mobile',
      connected: false,
      state: 'unpaired',
      detail: 'no phone paired',
      reconnect: MOBILE_PAIR
    }
  }
  const live = s.phones.filter((p) => p.connected)
  const name = (p: MobileStatus['phones'][number]): string => p.name || p.model || 'phone'
  const bridge = s.bridge
  const connected = live.length > 0
  const detail = connected
    ? `${live.map(name).join(', ')} connected`
    : bridge?.status === 'connected'
      ? `${s.phones.map(name).join(', ')} paired — the app is not open`
      : bridge?.status === 'connecting' || bridge?.status === 'reconnecting'
        ? `${s.phones.map(name).join(', ')} paired — this desktop is reconnecting to the org`
        : bridge?.status === 'error'
          ? `${s.phones.map(name).join(', ')} paired — ${bridge.lastError ?? 'bridge error'}`
          : `${s.phones.map(name).join(', ')} paired — this desktop is not on the org bridge`
  return {
    id: 'mobile',
    label: 'Mobile',
    connected,
    state: connected ? 'connected' : (bridge?.status ?? 'idle'),
    detail,
    reconnect: connected ? '' : MOBILE_WAKE
  }
}

/**
 * In-app chat is available only where there is an app to be in.
 *
 * Reported as unconditionally connected, it told a headless server that a
 * window was there to answer in — which is both false and the worst kind of
 * false, because it is what the agent reads when deciding how to reach
 * someone.
 */
function electronSnapshot(headless: boolean): ChannelStatusSnapshot {
  if (headless) {
    return {
      id: 'electron',
      label: 'In-app chat',
      connected: false,
      state: 'unavailable',
      detail: 'no window on this machine — it runs headless',
      reconnect: ''
    }
  }
  return {
    id: 'electron',
    label: 'In-app chat',
    connected: true,
    state: 'available',
    detail: 'always available while the desktop app is open',
    reconnect: ''
  }
}
