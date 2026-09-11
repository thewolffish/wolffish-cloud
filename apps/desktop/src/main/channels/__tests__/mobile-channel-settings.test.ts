/**
 * The two Mobile-channel settings that are edited from BOTH devices — the
 * notify_phone gate and the phone's feed verbosity.
 *
 * They are the panel's only stateful switches, and they are now also rows on
 * the phone's own Channels screen, which makes two things load-bearing that
 * were not before. First, they have to survive a restart: a switch that
 * silently reverted to its default on launch would have the phone and the
 * panel disagreeing about a setting neither of them touched — and `verbose`
 * did exactly that, held in memory and never written. Second, the snapshot
 * the phone renders has to CARRY them, with the desktop's own defaults for a
 * config that predates the section (notifications on, feed clean); a phone
 * that guessed the other way would show the agent as unable to reach it while
 * the agent kept notifying.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-channel-settings.test.ts
 */
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-settings-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0-test'
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
    }
  }
  return origLoad.apply(this, args)
}

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

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { buildConfigSnapshot } = await import('@main/channels/mobile/snapshot')
  const { getMobileChannelConfig, setMobileChannelConfig } =
    await import('@main/workspace/workspace')

  // ------------------------------------------------ persistence, both switches

  // The deps index.ts wires, verbatim in shape: config is the store, and the
  // channel is the only thing that reads or writes it.
  const channelDeps = {
    agent: {
      cerebellum: {
        registerInProcessCapability: () => undefined,
        unregisterInProcessCapability: () => undefined
      }
    },
    runner: { send: () => ({ turnId: 't', controller: new AbortController() }) },
    serializeCapabilities: async () => [],
    loadNotificationsEnabled: async () => (await getMobileChannelConfig()).notifications !== false,
    saveNotificationsEnabled: async (enabled: boolean) => {
      await setMobileChannelConfig({ notifications: enabled })
    },
    loadVerbose: async () => (await getMobileChannelConfig()).verbose === true,
    saveVerbose: async (verbose: boolean) => {
      await setMobileChannelConfig({ verbose })
    }
  }

  {
    const channel = new MobileChannel(channelDeps as never)
    await channel.start()
    const fresh = channel.getStatus()
    ok('a fresh workspace notifies by default', fresh.notificationsEnabled === true)
    ok('a fresh workspace keeps the feed clean', fresh.verbose === false)

    const afterVerbose = await channel.setVerbose(true)
    ok('setVerbose answers the updated status', afterVerbose.verbose === true)
    const afterNotifications = await channel.setNotificationsEnabled(false)
    ok(
      'setNotificationsEnabled answers the updated status',
      afterNotifications.notificationsEnabled === false
    )

    // Written where the panel, the snapshot and the next launch all read it —
    // not held in the instance that happened to make the change.
    const stored = await getMobileChannelConfig()
    ok('verbose reached config.json', stored.verbose === true)
    ok('notifications reached config.json', stored.notifications === false)
  }

  {
    // The restart. A second channel over the same workspace must come up on
    // the values the first one was left on.
    const restarted = new MobileChannel(channelDeps as never)
    await restarted.start()
    const status = restarted.getStatus()
    ok('verbose survives a restart', status.verbose === true)
    ok('notifications survives a restart', status.notificationsEnabled === false)

    // And one setter must never carry the other back to its default — they
    // share a config section, which is exactly where that goes wrong.
    await restarted.setVerbose(false)
    const both = await getMobileChannelConfig()
    ok('writing verbose leaves notifications alone', both.notifications === false)
    ok('verbose is back off', both.verbose === false)
  }

  // -------------------------------------------------- what the phone receives

  {
    const snapshot = (await buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => []
    } as never)) as {
      channels: {
        mobile?: { notifications?: boolean; verbose?: boolean }
        inapp?: { verbose?: boolean }
      }
    }
    ok(
      'the snapshot carries the phone channel',
      snapshot.channels.mobile !== undefined,
      JSON.stringify(snapshot.channels.mobile)
    )
    // Left at notifications:false / verbose:false by the block above.
    ok('snapshot mirrors the stored gate', snapshot.channels.mobile?.notifications === false)
    ok('snapshot mirrors the stored feed setting', snapshot.channels.mobile?.verbose === false)
  }

  {
    // The pre-section config: neither key present. The phone renders these
    // directly, so the fallbacks have to be the desktop's own, not `false`
    // twice because that is what an absent boolean coerces to.
    const { patchConfig } = await import('@main/workspace/workspace')
    await patchConfig((c) => ({ ...c, mobile: undefined }))
    const snapshot = (await buildConfigSnapshot({
      agent: {},
      serializeCapabilities: async () => []
    } as never)) as {
      channels: {
        mobile?: { notifications?: boolean; verbose?: boolean }
        inapp?: { verbose?: boolean }
      }
    }
    ok('absent section still notifies', snapshot.channels.mobile?.notifications === true)
    ok('absent section still means a clean feed', snapshot.channels.mobile?.verbose === false)
  }

  // ------------------------------------------------- the autostart probe

  /**
   * Whether this machine ACTUALLY starts on its own is a PROBE, not a config
   * mirror — a launchctl/systemctl query the snapshot builder is allowed to
   * fail at.
   *
   * The rule being pinned is that a failed probe OMITS its field. The phone
   * turns an absent field into `null` and prints "Unknown"; if the builder
   * emitted `false` instead, a laptop whose launchctl query timed out would
   * tell its owner autostart is off — a confident lie about a machine they
   * cannot see to check. Nothing here shells out: the probe is a stub,
   * exactly as the sandbox rule requires.
   */
  {
    type Prefs = { launchAtStartupActive?: boolean }
    const read = async (sources: Record<string, unknown>): Promise<Prefs> =>
      (
        (await buildConfigSnapshot({
          agent: {},
          serializeCapabilities: async () => [],
          ...sources
        } as never)) as { preferences?: Prefs }
      ).preferences ?? {}

    const answered = await read({ launchAtStartupActive: async () => true })
    ok('the autostart probe reaches the phone', answered.launchAtStartupActive === true)

    const refused = await read({
      launchAtStartupActive: async () => {
        throw new Error('launchctl failed')
      }
    })
    ok('a failed autostart probe omits the field', !('launchAtStartupActive' in refused))

    const unsupplied = await read({})
    ok('an unsupplied probe is simply absent', !('launchAtStartupActive' in unsupplied))
  }

  // ------------------------------------------------ the thinking-mode set
  {
    const { THINKING_MODES } = await import('@main/channels/mobile/snapshot')
    ok(
      'thinking modes are the four the phone renders',
      [...THINKING_MODES].join(',') === 'off,on,high,max'
    )
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
