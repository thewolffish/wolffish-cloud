/**
 * The audit writer — one insert, shared by every surface that mutates the
 * org.
 *
 * It lived inside routes/admin.ts while admins were the only writers. The
 * publish lane (routes/publish.ts) writes the same rows for capability
 * pushes that arrive from CI rather than from a person, so the function
 * moved here instead of being copied: one place decides what an audit row
 * looks like, and `actor_user_id` stays free-form text — a user id for a
 * person, a machine label like `ci:publish` for a pipeline.
 */
import type { Env } from '@/index'

export async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {}
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor_user_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)'
  )
    .bind(actor, action, target, JSON.stringify(detail))
    .run()
}
