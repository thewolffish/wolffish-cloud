import { fetchSnapshotFile } from '@/lib/cloud/api'
import { bridgeClient } from '@/lib/cloud/bridge'
import { cloudSession } from '@/lib/cloud/session'
import { Rpc, SNAPSHOT_PATH } from '@/lib/bridge/protocol'

/**
 * Where the phone's config snapshot comes from — one question, two answers.
 *
 * While the desktop is on the bridge it is asked directly (`configSnapshot`):
 * the freshest possible copy, with the live probes only that machine can
 * run. Otherwise the copy the desktop last wrote to the org
 * (`brain/mobile/snapshot.json`, synced like any workspace file) is read
 * from the API — so a phone whose desktop is asleep still opens Settings on
 * the settings as they last stood, instead of on a spinner.
 *
 * Its own module, importing nothing above the transport: both lib/sync and
 * the config store need it, and the store sits below sync in the import
 * graph.
 */
export async function fetchConfigSnapshot(): Promise<Record<string, unknown> | null> {
  const bridge = bridgeClient.active
  if (bridge && bridgeClient.connected) {
    try {
      const fresh = (await bridge.rpc(Rpc.configSnapshot)) as Record<string, unknown> | null
      if (fresh && typeof fresh === 'object' && Array.isArray(fresh.capabilities)) return fresh
    } catch {
      // The desktop left mid-call, or answered garbage — the org's copy is
      // seconds older at most and always readable.
    }
  }
  await cloudSession.load()
  if (!cloudSession.isSignedIn) return null
  return cloudSession.withAccessToken((token) => fetchSnapshotFile(token, SNAPSHOT_PATH))
}
