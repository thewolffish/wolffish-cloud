/**
 * The wire contract, as runtime schemas — one per mutating body. These are
 * the single source of truth for what the API accepts; when packages/types
 * is extracted for the desktop client, these schemas move there and both
 * sides validate against the same objects.
 *
 * Conventions: ids and tokens are bounded strings; timestamps are ISO
 * strings that must parse; caps are non-negative integers where 0 means
 * "unlimited"; free-text fields carry explicit length ceilings.
 */
import { z } from 'zod'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const emailField = z.string().max(254).regex(EMAIL_RE, 'must be an email address')
const idStr = z.string().min(1).max(128)
const isoDate = z
  .string()
  .max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date-time string')
const cap = z.number().int('must be an integer').min(0, 'must be >= 0 (0 means unlimited)')
const modelId = z.string().min(1).max(200)
const modelList = z.array(modelId).max(50)
const plainObject = z.custom<Record<string, unknown>>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  'must be a plain object'
)
/** JSON payloads owned by the client — bounded so one bug can't bloat a row. */
const boundedJson = (maxBytes: number) =>
  z.unknown().refine((v) => JSON.stringify(v ?? null).length <= maxBytes, `must serialize to <= ${maxBytes} bytes`)

export const ROLES = ['owner', 'admin', 'support', 'employee'] as const

// ── auth ─────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(256),
  device: z
    .object({
      id: idStr.optional(),
      platform: z.enum(['desktop', 'mobile', 'sim']).optional(),
      name: z.string().max(200).optional(),
      app_version: z.string().max(64).optional()
    })
    .optional()
})

export const PasswordChangeSchema = z.object({
  new_password: z.string().min(10, 'min 10 characters').max(128)
})

export const RefreshSchema = z.object({
  refresh_token: z.string().min(10).max(256)
})

// ── session surface ──────────────────────────────────────────────────────

export const DevicePinSchema = z.object({ pin_set: z.boolean() })

// ── admin ────────────────────────────────────────────────────────────────

export const InviteSchema = z.object({
  email: emailField,
  name: z.string().min(1).max(200),
  role: z.enum(ROLES).default('employee')
})

export const UserPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(['active', 'suspended']).optional()
  })
  .refine((b) => b.name !== undefined || b.role !== undefined || b.status !== undefined, {
    message: 'at least one of name, role, status required'
  })

export const ClearPinSchema = z.object({ device_id: idStr.optional() }).nullable().optional()

export const PolicyPutSchema = z.object({
  allowed_models: modelList.nullable().optional(),
  daily_token_cap: cap.nullable().optional()
})

export const OrgPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    default_model: modelId.optional(),
    default_allowed_models: modelList.optional(),
    user_daily_token_cap: cap.optional(),
    org_monthly_token_cap: cap.optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// ── sync ─────────────────────────────────────────────────────────────────

export const ConfigPutSchema = z.object({
  // The whole per-user config blob; 64 KB ceiling on the serialized form.
  config: plainObject.refine((v) => JSON.stringify(v).length <= 65_536, 'must serialize to <= 65536 bytes')
})

export const BatchItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation'),
    id: idStr,
    title: z.string().max(500).optional(),
    created_at: isoDate,
    updated_at: isoDate,
    device_id: idStr.optional()
  }),
  z.object({
    type: z.literal('record'),
    id: idStr,
    conversation_id: idStr,
    seq: z.number().int().min(0),
    kind: z.string().max(64).optional(),
    content: boundedJson(131_072),
    created_at: isoDate
  }),
  z.object({
    type: z.literal('episode'),
    id: idStr,
    content: boundedJson(131_072),
    occurred_at: isoDate
  })
])

export const BatchSchema = z.object({
  items: z.array(z.unknown()).min(1, '1..500 items required').max(500, '1..500 items required')
})
