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
import { TOKEN_PLANS } from '@/lib/plans'

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

export const ResetRequestSchema = z.object({
  email: z.string().email().max(320)
})

export const ResetConfirmSchema = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^[0-9]{6}$/, '6-digit code'),
  new_password: z.string().min(10, 'min 10 characters').max(128)
})

export const PasswordChangeSchema = z.object({
  new_password: z.string().min(10, 'min 10 characters').max(128),
  // Required when the caller holds a normal session (voluntary change);
  // the forced first-login flow's change token carries no password to prove.
  current_password: z.string().min(1).max(256).optional()
})

export const RefreshSchema = z.object({
  refresh_token: z.string().min(10).max(256)
})

// ── pairing (the phone's claim) ──────────────────────────────────────────

export const PairClaimSchema = z
  .object({
    /** The typed code, any spelling the phone accepts. */
    code: z.string().min(8).max(16).optional(),
    /** The QR's token, base64url. */
    token: z.string().min(32).max(64).optional(),
    device: z
      .object({
        id: idStr.optional(),
        name: z.string().max(200).optional(),
        app_version: z.string().max(64).optional(),
        /** What the phone is, for the desktop's Mobile panel. Descriptive
         *  only — nothing is authorized by it. */
        model: z.string().max(120).optional(),
        os: z.enum(['ios', 'android']).optional(),
        os_version: z.string().max(60).optional()
      })
      .optional()
  })
  .refine((b) => Boolean(b.code || b.token), { message: 'code or token required' })

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
    status: z.enum(['active', 'suspended']).optional(),
    /** The group this person's spend and activity roll up under. '' clears
     *  it — free text, because an org's own names are the only ones that
     *  will ever be right. */
    team: z.string().max(80).optional()
  })
  .refine(
    (b) =>
      b.name !== undefined || b.role !== undefined || b.status !== undefined || b.team !== undefined,
    { message: 'at least one of name, role, status, team required' }
  )

/**
 * Who an org capability reaches. An empty list opens it to the whole org —
 * the state every capability is in until an admin narrows it.
 */
export const CapabilityGrantsPutSchema = z.object({
  grants: z
    .array(
      z.object({
        kind: z.enum(['role', 'team', 'user']),
        subject: z.string().min(1).max(128)
      })
    )
    .max(200)
})

export const ClearPinSchema = z.object({ device_id: idStr.optional() }).nullable().optional()

export const PolicyPutSchema = z.object({
  allowed_models: modelList.nullable().optional(),
  daily_token_cap: cap.nullable().optional(),
  // Searches per day; null/absent = org default, 0 = unlimited.
  daily_search_cap: cap.nullable().optional(),
  // The employee's token plan. null clears it back to the default; absent
  // leaves whatever is set, so a caller editing only the search cap cannot
  // silently reset someone's plan.
  token_plan: z.enum(TOKEN_PLANS).nullable().optional()
})

/** The plan on its own — the one control the admin UI reaches for most. */
export const PlanPutSchema = z.object({
  token_plan: z.enum(TOKEN_PLANS)
})

/**
 * The org's config overlay: dot-path → value. Every path present is
 * org-owned — forced on read and on write (see lib/org-config.ts). An empty
 * object hands every path back to the employees.
 */
export const OrgConfigPutSchema = z.object({
  overlay: z
    .custom<Record<string, unknown>>(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
      'must be a plain object of dot-path -> value'
    )
    .refine((v) => Object.keys(v).length <= 200, 'at most 200 paths')
    .refine((v) => JSON.stringify(v).length <= 65_536, 'must serialize to <= 65536 bytes')
})

export const OrgPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    default_model: modelId.optional(),
    default_allowed_models: modelList.optional(),
    user_daily_token_cap: cap.optional(),
    org_monthly_token_cap: cap.optional(),
    search_enabled: z.boolean().optional(),
    user_daily_search_cap: cap.optional(),
    org_monthly_search_cap: cap.optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// ── search ───────────────────────────────────────────────────────────────

/**
 * One web search. `count` is results per query (Brave's ceiling is 20);
 * the locale knobs are pass-through and validated to Brave's shapes so a
 * malformed value fails here, not as an opaque upstream 4xx.
 */
export const SearchSchema = z.object({
  query: z.string().trim().min(1, 'query required').max(400),
  count: z.number().int().min(1).max(20).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code').optional(),
  search_lang: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'language code such as en or pt-br')
    .optional(),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional()
})

export const ProfilePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    position: z.string().max(120).optional(),
    phone: z
      .string()
      .max(32)
      .regex(/^[+0-9 ()-]*$/, 'digits, spaces, + ( ) - only')
      .optional(),
    bio: z.string().max(500).optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// ── sync ─────────────────────────────────────────────────────────────────

export const ConfigPutSchema = z.object({
  // The whole per-user config blob. 512 KB ceiling: the blob carries every
  // integration credential plus per-server MCP OAuth state, so the old 64 KB
  // cap was reachable in real configs — and a client that hits the ceiling
  // stops syncing config entirely. Bounded still, so one bug can't bloat
  // the row without limit.
  config: plainObject.refine(
    (v) => JSON.stringify(v).length <= 524_288,
    'must serialize to <= 524288 bytes'
  )
})

/**
 * Tombstone request for path-named file rows — the delete half of the blob
 * sweep. Names are workspace-relative paths, same field the manifest serves.
 */
export const FilesDeleteSchema = z.object({
  names: z.array(z.string().min(1).max(500)).min(1).max(500)
})

export const BatchItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation'),
    id: idStr,
    title: z.string().max(500).optional(),
    created_at: isoDate,
    updated_at: isoDate,
    device_id: idStr.optional(),
    // Provenance: which surface started this conversation ('electron',
    // 'mobile', 'heartbeat', 'procedure'). Open rather than an enum — a
    // client that grows a channel must not have its whole batch refused by
    // an older API — and the leaderboard's agentic count simply matches the
    // two autonomous names. Absent on pre-0014 clients; '' means unknown.
    channel: z.string().max(32).optional()
  }),
  z.object({
    type: z.literal('record'),
    id: idStr,
    conversation_id: idStr,
    seq: z.number().int().min(0),
    kind: z.string().max(64).optional(),
    /**
     * The message this record is a version OF, and which version it is.
     * The id has always encoded both as `<base_id>.<version_hash>`; sending
     * them explicitly is what lets the server — and every reader — stop
     * parsing that string. Absent on older clients: derived server-side
     * from the id (see splitRecordId in routes/sync.ts).
     */
    base_id: idStr.optional(),
    version_hash: z.string().max(64).optional(),
    // 400 KB: comfortably above the client's 300 KB slim threshold, so a
    // message it chose to send whole is never rejected for size.
    content: boundedJson(409_600),
    created_at: isoDate
  })
])

export const BatchSchema = z.object({
  items: z.array(z.unknown()).min(1, '1..500 items required').max(500, '1..500 items required')
})
