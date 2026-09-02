/**
 * Google status derivation — pins the per-device truth table.
 *
 * Google credentials live in gogcli's own store, OUTSIDE the synced
 * workspace, so the synced config can only ever mean "this user set Google
 * up on some device". The derivation must therefore:
 *   - trust the DEVICE (gogcli accounts) over the synced flags in both
 *     directions — a restored config saying 'active' on a machine with no
 *     credentials yields needsReconnect (never a lying 'active'), and
 *     drifted flags on a machine WITH accounts yield 'active';
 *   - never require rewriting the synced row (the flag is per-device, so
 *     it is computed, not stored).
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/__tests__/google-status.test.ts
 */

import Module from 'node:module'
import os from 'node:os'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
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
  const { deriveGoogleStatus } = await import('@main/google')

  // The purge-restore / second-machine case: synced config says active,
  // device holds nothing → reconnect prompt, never a lying 'active'.
  const restored = deriveGoogleStatus({
    accountsOnDevice: 0,
    cloudConfigured: true,
    lastError: null
  })
  ok('cloud-configured + empty device → needsReconnect', restored.status === 'needsReconnect')
  ok('reconnect keeps the cloud hint', restored.cloudConfigured && restored.accountsOnDevice === 0)

  // Never configured anywhere.
  ok(
    'unconfigured + empty device → inactive',
    deriveGoogleStatus({ accountsOnDevice: 0, cloudConfigured: false, lastError: null }).status ===
      'inactive'
  )

  // Reality beats drifted flags in the OTHER direction too: accounts on
  // this device count as connected even when the synced flags say nothing.
  const drifted = deriveGoogleStatus({
    accountsOnDevice: 2,
    cloudConfigured: false,
    lastError: null
  })
  ok('accounts on device + drifted flags → active', drifted.status === 'active')
  ok('account count reported', drifted.accountsOnDevice === 2)

  // A standing probe failure only matters when there ARE accounts to fail.
  const erring = deriveGoogleStatus({
    accountsOnDevice: 1,
    cloudConfigured: true,
    lastError: { kind: 'network', message: 'refresh failed' }
  })
  ok(
    'accounts + standing error → error',
    erring.status === 'error' && erring.errorKind === 'network'
  )
  ok(
    'error does not leak into the empty-device states',
    deriveGoogleStatus({
      accountsOnDevice: 0,
      cloudConfigured: true,
      lastError: { kind: 'network', message: 'stale' }
    }).status === 'needsReconnect'
  )

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run()
