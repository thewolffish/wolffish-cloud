/**
 * The admin layer's client — the desktop half of apps/api/src/routes/admin.
 *
 * Two rules shape this file.
 *
 * NOTHING IS CACHED ON DISK. Every other cloud read in this app lands in the
 * workspace, because it is the signed-in employee's own work and the folder
 * is their cache of it. This is not that: it is other people's spend, other
 * people's devices and other people's conversations, read by someone acting
 * as an administrator. Writing any of it to ~/.wfc would put the company's
 * transcripts on whichever laptop happened to open the admin screen, and
 * leave them there after the person stopped being an admin. So every call
 * here returns its answer and keeps nothing — the renderer holds it in
 * memory for as long as the screen is open, and that is all.
 *
 * THE SERVER DECIDES. Role checks here are for the UI's benefit only (don't
 * render a button that will 403). Every endpoint re-verifies the caller's
 * role, an admin still cannot touch an owner, and reading a transcript is
 * audited server-side — none of which this file can affect.
 */
import { API_BASE, ApiError } from '@main/cloud/api'
import { cloudSession } from '@main/cloud/session'

// ── Wire shapes ──────────────────────────────────────────────────────────

export type AdminRole = 'owner' | 'admin' | 'support' | 'employee'
export type AdminStatus = 'invited' | 'active' | 'suspended' | 'removed'
export type TokenPlan = 'standard' | 'high' | 'unmetered'

export type PlanCeilings = { monthlyIn: number; monthlyOut: number }

/** One card in the people grid. Every figure comes from the server rollup. */
export type RosterPerson = {
  id: string
  email: string
  name: string
  role: AdminRole
  status: AdminStatus
  must_change_password: number
  created_at: string
  last_login_at: string | null
  token_plan: TokenPlan
  ceilings: PlanCeilings
  daily_token_cap: number | null
  daily_search_cap: number | null
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  searches: number
  days_active: number
  last_active_day: string | null
  month_tokens_in: number
  month_tokens_out: number
  month_cost_microusd: number
  month_searches: number
  devices: number
  phones: number
  conversations: number
}

export type Roster = {
  since: string
  days: number
  month_start: string
  plans: Record<TokenPlan, PlanCeilings>
  people: RosterPerson[]
}

export type LaneTotals = {
  kind: 'chat' | 'search'
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  month_requests: number
  month_tokens_in: number
  month_tokens_out: number
  month_cost_microusd: number
}

export type SurfaceTotals = {
  surface: string
  kind: 'chat' | 'search'
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  cost_microusd: number
}

export type DailyPoint = {
  day: string
  requests: number
  tokens_in: number
  tokens_out: number
  cost_microusd: number
  searches: number
}

export type AdminDevice = {
  id: string
  platform: string
  name: string
  app_version: string
  status: string
  pin_set: number
  pin_clear_requested: number
  created_at: string
  last_seen_at: string | null
}

export type AdminSession = {
  id: string
  device_id: string
  issued_at: string
  refreshed_at: string | null
  expires_at: string
  revoked_at: string | null
  revoked_by: string | null
}

export type UsageRow = {
  id: number
  device_id: string | null
  model: string
  kind: string
  surface: string
  upstream: string
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_microusd: number
  latency_ms: number
  decision: string
  error: string | null
  created_at: string
}

export type UserOverview = {
  user: {
    id: string
    email: string
    name: string
    role: AdminRole
    status: AdminStatus
    must_change_password: number
    phone: string
    position: string
    bio: string
    created_at: string
    updated_at: string
    last_login_at: string | null
    temp_password_expires_at: string | null
  }
  window: { since: string; days: number; month_start: string }
  policy: {
    token_plan: TokenPlan
    ceilings: PlanCeilings
    allowed_models?: string | null
    daily_token_cap?: number | null
    daily_search_cap?: number | null
    updated_at?: string
  }
  plans: Record<TokenPlan, PlanCeilings>
  standing: {
    tokens: {
      userDayUsed: number
      orgMonthUsed: number
      userMonthIn: number
      userMonthOut: number
    } | null
    searches: { userDayUsed: number; orgMonthUsed: number } | null
  }
  lanes: LaneTotals[]
  surfaces: SurfaceTotals[]
  daily: DailyPoint[]
  devices: AdminDevice[]
  sessions: AdminSession[]
  recent: UsageRow[]
  counts: { conversations: number; files: number; bytes: number }
}

/** A row in the admin's transcript list — provenance without opening it. */
export type AdminConversationRow = {
  id: string
  title: string
  device_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  model: string | null
  channel: string | null
  icon: string | null
  project_id: string | null
  sealed: number | null
  summary: string | null
  stats: Record<string, unknown> | null
  message_count: number
}

export type AdminRecord = {
  id: string
  seq: number
  kind: string
  content: unknown
  created_at: string
}

export type AdminRecordsPage = {
  records: AdminRecord[]
  next_after: number | null
  conversation: {
    id: string
    title: string
    created_at: string
    updated_at: string
    user_id: string
    user_name: string | null
    user_email: string | null
  }
}

export type AuditEntry = {
  id: number
  actor_user_id: string
  actor_name?: string | null
  actor_email?: string | null
  action: string
  target: string
  detail: string
  created_at: string
}

export type OrgSettings = {
  id: number
  name: string
  default_model: string
  default_allowed_models: string
  user_daily_token_cap: number
  org_monthly_token_cap: number
  search_enabled: number
  user_daily_search_cap: number
  org_monthly_search_cap: number
  created_at: string
  updated_at: string
}

/**
 * Adding a person hands back NO credential — the account's only key is the
 * 6-digit code mailed to the address. `email_sent` is what the UI acts on;
 * `activation_code` comes back only from an API with no mail configured
 * (a local worker), never from a deployment whose send failed.
 */
export type InviteResult = {
  user_id: string
  email: string
  role: AdminRole
  activation_expires_at: string
  email_sent: boolean
  email_error?: string
  email_error_detail?: string | null
  activation_code?: string
}

export type ActivationResult = {
  user_id: string
  email: string
  activation_expires_at: string
  email_sent: boolean
  email_error?: string
  email_error_detail?: string | null
  activation_code?: string
}

export type ResetResult = {
  user_id: string
  temp_password: string
  temp_password_expires_at: string
}

// ── Transport ────────────────────────────────────────────────────────────

/**
 * Longer than the 15 s the auth calls use: the roster and the overview each
 * fan out to a dozen aggregates, and a cold Worker isolate on a company's
 * first admin screen of the day is measurably slower than a warm one. Still
 * bounded — a hung admin screen must resolve, not spin.
 */
const TIMEOUT_MS = 30_000

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return cloudSession.withAccessToken(async (token) => {
    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new ApiError('network', 0)
    }
    let json: Record<string, unknown> | null = null
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      // non-JSON body — the status check below is the answer
    }
    if (!res.ok) {
      const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`
      let detail = typeof json?.detail === 'string' ? json.detail : undefined
      if (!detail && Array.isArray(json?.issues)) {
        detail = (json.issues as Array<{ path?: string; message?: string }>)
          .map((i) => [i.path, i.message].filter(Boolean).join(': '))
          .join('; ')
      }
      throw new ApiError(code, res.status, detail)
    }
    return json as T
  })
}

const q = (params: Record<string, string | number | undefined>): string => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return pairs.length === 0
    ? ''
    : `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
}

// ── People ───────────────────────────────────────────────────────────────

export const getRoster = (days = 30): Promise<Roster> => call('GET', `/admin/roster${q({ days })}`)

export const getUserOverview = (userId: string, days = 30): Promise<UserOverview> =>
  call('GET', `/admin/users/${encodeURIComponent(userId)}/overview${q({ days })}`)

export const inviteUser = (input: {
  email: string
  name: string
  role: AdminRole
}): Promise<InviteResult> => call('POST', '/admin/users', input)

export const updateUser = (
  userId: string,
  patch: { name?: string; role?: AdminRole; status?: 'active' | 'suspended' }
): Promise<{ ok: true }> => call('PATCH', `/admin/users/${encodeURIComponent(userId)}`, patch)

export const setPlan = (
  userId: string,
  plan: TokenPlan
): Promise<{ ok: true; token_plan: TokenPlan; ceilings: PlanCeilings }> =>
  call('PUT', `/admin/users/${encodeURIComponent(userId)}/plan`, { token_plan: plan })

export const setPolicy = (
  userId: string,
  policy: {
    allowed_models?: string[] | null
    daily_token_cap?: number | null
    daily_search_cap?: number | null
    token_plan?: TokenPlan | null
  }
): Promise<{ ok: true }> => call('PUT', `/admin/users/${encodeURIComponent(userId)}/policy`, policy)

export const resendActivation = (userId: string): Promise<ActivationResult> =>
  call('POST', `/admin/users/${encodeURIComponent(userId)}/activation`, {})

export const resetPassword = (userId: string): Promise<ResetResult> =>
  call('POST', `/admin/users/${encodeURIComponent(userId)}/reset-password`, {})

export const clearPin = (userId: string, deviceId?: string): Promise<{ ok: true }> =>
  call(
    'POST',
    `/admin/users/${encodeURIComponent(userId)}/clear-pin`,
    deviceId ? { device_id: deviceId } : {}
  )

export const revokeSessions = (userId: string): Promise<{ ok: true; revoked: number }> =>
  call('POST', `/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {})

// ── Their work ───────────────────────────────────────────────────────────

export const listConversations = (
  userId: string,
  opts: { before?: string; limit?: number } = {}
): Promise<{ conversations: AdminConversationRow[]; next: string | null }> =>
  call(
    'GET',
    `/admin/users/${encodeURIComponent(userId)}/conversations${q({ before: opts.before, limit: opts.limit ?? 30 })}`
  )

export const readRecords = (
  conversationId: string,
  opts: { after?: number; limit?: number } = {}
): Promise<AdminRecordsPage> =>
  call(
    'GET',
    `/admin/conversations/${encodeURIComponent(conversationId)}/records${q({ after: opts.after ?? 0, limit: opts.limit ?? 200 })}`
  )

/**
 * Every record of one conversation, paged to exhaustion. A transcript is
 * read whole — the admin is reading it, not streaming it — and the page
 * loop stops on the server's explicit terminator rather than on a short
 * page, which is the contract (see apps/api/src/lib/records.ts).
 *
 * MAX_PAGES is a safety valve, not a limit anyone should reach: 200 records
 * a page means 40,000 records before it trips, and the longest real
 * conversation is a small fraction of that.
 */
const MAX_PAGES = 200

export async function readTranscript(conversationId: string): Promise<{
  records: AdminRecord[]
  conversation: AdminRecordsPage['conversation']
  truncated: boolean
}> {
  const records: AdminRecord[] = []
  let after = 0
  let conversation: AdminRecordsPage['conversation'] | null = null
  let pages = 0
  for (;;) {
    const page = await readRecords(conversationId, { after })
    conversation ??= page.conversation
    records.push(...page.records)
    pages++
    if (page.next_after === null) return { records, conversation: conversation!, truncated: false }
    if (pages >= MAX_PAGES) return { records, conversation: conversation!, truncated: true }
    after = page.next_after
  }
}

// ── Org ──────────────────────────────────────────────────────────────────

export const getOrg = (): Promise<{ org: OrgSettings | null }> => call('GET', '/admin/org')

export const patchOrg = (patch: {
  name?: string
  default_model?: string
  default_allowed_models?: string[]
  user_daily_token_cap?: number
  org_monthly_token_cap?: number
  search_enabled?: boolean
  user_daily_search_cap?: number
  org_monthly_search_cap?: number
}): Promise<{ ok: true }> => call('PATCH', '/admin/org', patch)

export const getAudit = (limit = 100): Promise<{ entries: AuditEntry[] }> =>
  call('GET', `/admin/audit${q({ limit })}`)

export const getUserAudit = (userId: string, limit = 100): Promise<{ entries: AuditEntry[] }> =>
  call('GET', `/admin/users/${encodeURIComponent(userId)}/audit${q({ limit })}`)

export const getGates = (): Promise<Record<string, unknown>> => call('GET', '/admin/gates')
