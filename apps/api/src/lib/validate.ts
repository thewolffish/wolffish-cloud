/**
 * Runtime validation at the body boundary. Handlers call parseJson() and
 * either receive data proven to match the schema or a ready-made 400 —
 * so handler logic never sees a malformed value, and the response shape
 * for every invalid payload is uniform:
 *
 *   400 { error: "invalid_request", issues: [{ path, message }] }
 */
import type { Context } from 'hono'
import { z } from 'zod'

export async function parseJson<S extends z.ZodType>(
  c: Context,
  schema: S
): Promise<z.infer<S> | Response> {
  const raw = await c.req.json().catch(() => undefined)
  return parseValue(c, schema, raw)
}

/** The same uniform 400 for a body the route already read (e.g. to cap its size). */
export function parseValue<S extends z.ZodType>(
  c: Context,
  schema: S,
  raw: unknown
): z.infer<S> | Response {
  const result = schema.safeParse(raw)
  if (!result.success) {
    return c.json(
      {
        error: 'invalid_request',
        issues: result.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join('.') || '(body)',
          message: i.message
        }))
      },
      400
    )
  }
  return result.data
}

/** Issues for one value against a schema — used for per-item batch checks. */
export function issuesOf(schema: z.ZodType, value: unknown): { path: string; message: string }[] | null {
  const r = schema.safeParse(value)
  if (r.success) return null
  return r.error.issues.slice(0, 3).map((i) => ({ path: i.path.join('.') || '(item)', message: i.message }))
}
