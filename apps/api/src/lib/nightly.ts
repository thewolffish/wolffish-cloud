/**
 * The nightly maintenance run — the cron's body, also runnable on demand
 * from the admin layer (POST /admin/maintenance/run) so an operator can
 * drain a backlog now and so the whole path is provable in a simulation.
 *
 * Every job is bounded by its own deadline; together they stay well inside
 * the cron's 15-minute wall-clock allowance, and a backlog drains over
 * successive nights rather than ever overrunning.
 */
import { archiveIdleConversations, retireUsageRows } from '@/lib/archive'
import type { Env } from '@/index'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

export type NightlyReport = Record<string, unknown>

export async function runNightly(env: Env, now: number): Promise<NightlyReport> {
  const report: NightlyReport = {}
  const cutoff = new Date(now - 30 * DAY_MS).toISOString()
  await step(report, 'sessions', async () => {
    const r = await env.DB.prepare('DELETE FROM device_sessions WHERE expires_at < ?1').bind(cutoff).run()
    return { deleted: r.meta.changes ?? 0 }
  })
  await step(report, 'reset_codes', async () => {
    const r = await env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ?1')
      .bind(new Date(now).toISOString())
      .run()
    return { deleted: r.meta.changes ?? 0 }
  })
  await step(report, 'pairings', async () => {
    // Claimed and expired offers alike: an offer is a three-minute door, and
    // a day-old row says nothing the devices table does not.
    const r = await env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?1')
      .bind(new Date(now - DAY_MS).toISOString())
      .run()
    return { deleted: r.meta.changes ?? 0 }
  })
  await step(report, 'gc_blobs', () => collectOrphanBlobs(env, now))
  await step(report, 'purge_deleted', () =>
    purgeDeletedConversationRecords(env, now, Date.now() + 2 * MINUTE_MS)
  )
  await step(report, 'archive_idle', () => archiveIdleConversations(env, now, Date.now() + 7 * MINUTE_MS))
  await step(report, 'retire_usage', () => retireUsageRows(env, now, Date.now() + 2 * MINUTE_MS))
  return report
}

async function step(report: NightlyReport, name: string, job: () => Promise<unknown>): Promise<void> {
  const started = Date.now()
  try {
    const result = await job()
    report[name] = { ok: true, ms: Date.now() - started, ...(result as object) }
    console.log('nightly', { job: name, ms: Date.now() - started, result })
  } catch (err) {
    report[name] = { ok: false, ms: Date.now() - started, error: (err as Error).message }
    console.error('nightly job failed', { job: name, message: (err as Error).message })
  }
}

/**
 * A deleted conversation keeps its tombstone row forever (a stale device
 * replaying the conversation must still be refused), but its transcript
 * records — the bulk — go 30 days after the delete, and so does its
 * archive blob. "Wipe my data" is a real wipe a month later, and the
 * records table stops growing with what nobody can read any more. Loops
 * under a deadline; the backlog drains nightly.
 */
export async function purgeDeletedConversationRecords(
  env: Env,
  now: number,
  deadline: number
): Promise<{ purged: number }> {
  const stale = new Date(now - 30 * DAY_MS).toISOString()
  let purged = 0
  while (Date.now() < deadline) {
    const doomed = await env.DB.prepare(
      `SELECT c.id, c.archive_key FROM conversations c
       WHERE c.deleted_at IS NOT NULL AND c.deleted_at < ?1
         AND (c.archive_key IS NOT NULL
              OR EXISTS (SELECT 1 FROM conversation_records r WHERE r.conversation_id = c.id))
       LIMIT 200`
    )
      .bind(stale)
      .all<{ id: string; archive_key: string | null }>()
    const rows = doomed.results ?? []
    if (rows.length === 0) break
    const ids = rows.map((r) => r.id)
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90)
      await env.DB.prepare(
        `DELETE FROM conversation_records
         WHERE conversation_id IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
      )
        .bind(...chunk)
        .run()
    }
    const blobs = rows.map((r) => r.archive_key).filter((k): k is string => Boolean(k))
    if (blobs.length) await env.BLOBS.delete(blobs)
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90)
      await env.DB.prepare(
        `UPDATE conversations SET archive_key = NULL
         WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
      )
        .bind(...chunk)
        .run()
    }
    purged += rows.length
    if (rows.length < 200) break
  }
  return { purged }
}

/**
 * Blob garbage collection. A file row is tombstoned when its path is
 * deleted, wiped, or superseded by newer content, but the content-addressed
 * blob stays until NO live row (any user) and no avatar references it — and
 * even then it waits a day, so a sweep that deduped against the object
 * minutes ago can't lose it. Rows of a collected blob go with it (the
 * tombstone has done its job: a re-upload simply inserts), and tombstones
 * whose blob lives on elsewhere are dropped after 30 days. Bounded per run;
 * the backlog drains over successive nights.
 */
export async function collectOrphanBlobs(env: Env, now: number): Promise<{ collected: number }> {
  const grace = new Date(now - DAY_MS).toISOString()
  const orphans = await env.DB.prepare(
    `SELECT sha256 FROM files GROUP BY sha256
     HAVING SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) = 0 AND MAX(deleted_at) < ?1
     LIMIT 500`
  )
    .bind(grace)
    .all<{ sha256: string }>()
  const avatars = new Set(
    ((await env.DB.prepare('SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL').all<{
      avatar_key: string
    }>()).results ?? []).map((r) => r.avatar_key)
  )
  const doomed = (orphans.results ?? []).map((r) => r.sha256).filter((s) => !avatars.has(s))
  if (doomed.length) {
    await env.BLOBS.delete(doomed.map((s) => `files/${s}`))
    for (let i = 0; i < doomed.length; i += 90) {
      const chunk = doomed.slice(i, i + 90)
      await env.DB.prepare(
        `DELETE FROM files WHERE deleted_at IS NOT NULL
         AND sha256 IN (${chunk.map((_, k) => `?${k + 1}`).join(', ')})`
      )
        .bind(...chunk)
        .run()
    }
  }
  const stale = new Date(now - 30 * DAY_MS).toISOString()
  await env.DB.prepare('DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?1')
    .bind(stale)
    .run()
  return { collected: doomed.length }
}
