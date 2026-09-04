/**
 * The admin layer, from the phone — the same endpoints the desktop's Admin
 * page calls (apps/api/src/routes/admin.ts), because there is one admin API
 * and two clients for it, not two admin layers.
 *
 * The phone holds a real org session with the person's real role, so nothing
 * here is a bridge call through the desktop: an admin's phone talks to the
 * org directly, and the org re-checks the role on every request. That also
 * means an admin can do this work with the laptop shut, which is most of the
 * point — somebody locked out on a Sunday is a phone problem.
 *
 * NOTHING READ HERE IS PERSISTED. Every other cloud read on this phone lands
 * in SQLite, because it is the signed-in person's own work and the local DB
 * is their cache of it. This is other people's spend and other people's
 * conversations: it lives in react-query's memory for as long as the screen
 * is open and no longer. The query client persists to AsyncStorage, so every
 * admin query below is deliberately excluded from that (see
 * lib/query/queryClient shouldPersistQuery) — a phone that is lost must not
 * carry the company's transcripts in plain storage.
 */
import { request } from '@/lib/cloud/api'

export type AdminRole = 'owner' | 'admin' | 'support' | 'employee'
export type AdminUserStatus = 'invited' | 'active' | 'suspended' | 'removed'
export type TokenPlan = 'standard' | 'high' | 'unmetered'
export type PlanCeilings = { monthlyIn: number; monthlyOut: number }

/** One person in the roster — every figure from the server-side rollup. */
export type RosterPerson = {
  id: string
  email: string
  name: string
  role: AdminRole
  status: AdminUserStatus
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

export type AdminRoster = {
  since: string
  days: number
  month_start: string
  plans: Record<TokenPlan, PlanCeilings>
  people: RosterPerson[]
}

export type AdminLaneTotals = {
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

export type AdminSurfaceTotals = {
  surface: string
  kind: 'chat' | 'search'
  requests: number
  denied: number
  tokens_in: number
  tokens_out: number
  cost_microusd: number
}

export type AdminDailyPoint = {
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

export type AdminUserOverview = {
  user: {
    id: string
    email: string
    name: string
    role: AdminRole
    status: AdminUserStatus
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
  }
  plans: Record<TokenPlan, PlanCeilings>
  /** Live gate counters — what the plan ceilings are enforced against. */
  standing: {
    tokens: {
      userDayUsed: number
      orgMonthUsed: number
      userMonthIn: number
      userMonthOut: number
    } | null
    searches: { userDayUsed: number; orgMonthUsed: number } | null
  }
  lanes: AdminLaneTotals[]
  surfaces: AdminSurfaceTotals[]
  daily: AdminDailyPoint[]
  devices: AdminDevice[]
  sessions: Array<{ id: string; device_id: string; issued_at: string; revoked_at: string | null }>
  recent: Array<Record<string, unknown>>
  counts: { conversations: number; files: number; bytes: number }
}

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

export type AdminAuditEntry = {
  id: number
  actor_user_id: string
  actor_name?: string | null
  actor_email?: string | null
  action: string
  target: string
  detail: string
  created_at: string
}

export type AdminOrgSettings = {
  id: number
  name: string
  default_model: string
  default_allowed_models: string
  user_daily_token_cap: number
  org_monthly_token_cap: number
  search_enabled: number
  user_daily_search_cap: number
  org_monthly_search_cap: number
  updated_at: string
}

export type AdminResetResult = {
  user_id: string
  temp_password: string
  temp_password_expires_at: string
}

/**
 * Longer than the default: the roster and the overview each fan out to a
 * dozen aggregates server-side, and a phone on cellular adds its own
 * latency on top. Still bounded — a stuck admin screen must resolve.
 */
const TIMEOUT_MS = 30_000

const q = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

const get = <T>(token: string, path: string): Promise<T> =>
  request<T>(path, { token, timeoutMs: TIMEOUT_MS })

const send = <T>(token: string, method: string, path: string, body?: unknown): Promise<T> =>
  request<T>(path, { token, method, body, timeoutMs: TIMEOUT_MS })

// ── Reads ────────────────────────────────────────────────────────────────

export const adminRoster = (token: string, days = 30): Promise<AdminRoster> =>
  get(token, `/admin/roster${q({ days })}`)

export const adminUserOverview = (
  token: string,
  userId: string,
  days = 30
): Promise<AdminUserOverview> =>
  get(token, `/admin/users/${encodeURIComponent(userId)}/overview${q({ days })}`)

export const adminConversations = (
  token: string,
  userId: string,
  opts: { before?: string; limit?: number } = {}
): Promise<{ conversations: AdminConversationRow[]; next: string | null }> =>
  get(
    token,
    `/admin/users/${encodeURIComponent(userId)}/conversations${q({ before: opts.before, limit: opts.limit ?? 25 })}`
  )

export const adminRecords = (
  token: string,
  conversationId: string,
  opts: { after?: number; limit?: number } = {}
): Promise<AdminRecordsPage> =>
  get(
    token,
    `/admin/conversations/${encodeURIComponent(conversationId)}/records${q({ after: opts.after ?? 0, limit: opts.limit ?? 200 })}`
  )

/**
 * Every record of one conversation. A transcript is read whole — the admin
 * is reading it, not streaming it — and the loop stops on the server's
 * explicit terminator rather than on a short page, which is the contract.
 * MAX_PAGES is a safety valve at 40,000 records, not a limit anyone reaches.
 */
const MAX_PAGES = 200

export async function adminTranscript(
  token: string,
  conversationId: string
): Promise<{
  records: AdminRecord[]
  conversation: AdminRecordsPage['conversation']
  truncated: boolean
}> {
  const records: AdminRecord[] = []
  let after = 0
  let conversation: AdminRecordsPage['conversation'] | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await adminRecords(token, conversationId, { after })
    conversation ??= res.conversation
    records.push(...res.records)
    if (res.next_after === null) {
      return { records, conversation: conversation, truncated: false }
    }
    after = res.next_after
  }
  return { records, conversation: conversation!, truncated: true }
}

export const adminAudit = (token: string, limit = 100): Promise<{ entries: AdminAuditEntry[] }> =>
  get(token, `/admin/audit${q({ limit })}`)

export const adminUserAudit = (
  token: string,
  userId: string,
  limit = 60
): Promise<{ entries: AdminAuditEntry[] }> =>
  get(token, `/admin/users/${encodeURIComponent(userId)}/audit${q({ limit })}`)

export const adminOrg = (token: string): Promise<{ org: AdminOrgSettings | null }> =>
  get(token, '/admin/org')

// ── Writes ───────────────────────────────────────────────────────────────

export const adminSetPlan = (
  token: string,
  userId: string,
  plan: TokenPlan
): Promise<{ ok: true; token_plan: TokenPlan; ceilings: PlanCeilings }> =>
  send(token, 'PUT', `/admin/users/${encodeURIComponent(userId)}/plan`, { token_plan: plan })

export const adminUpdateUser = (
  token: string,
  userId: string,
  patch: { name?: string; role?: AdminRole; status?: 'active' | 'suspended' }
): Promise<{ ok: true }> =>
  send(token, 'PATCH', `/admin/users/${encodeURIComponent(userId)}`, patch)

export const adminResetPassword = (token: string, userId: string): Promise<AdminResetResult> =>
  send(token, 'POST', `/admin/users/${encodeURIComponent(userId)}/reset-password`, {})

export const adminClearPin = (
  token: string,
  userId: string,
  deviceId?: string
): Promise<{ ok: true }> =>
  send(
    token,
    'POST',
    `/admin/users/${encodeURIComponent(userId)}/clear-pin`,
    deviceId ? { device_id: deviceId } : {}
  )

export const adminRevokeSessions = (
  token: string,
  userId: string
): Promise<{ ok: true; revoked: number }> =>
  send(token, 'POST', `/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {})

export const adminInvite = (
  token: string,
  input: { email: string; name: string; role: AdminRole }
): Promise<{
  user_id: string
  email: string
  role: AdminRole
  temp_password: string
  temp_password_expires_at: string
}> => send(token, 'POST', '/admin/users', input)

export const adminPatchOrg = (
  token: string,
  patch: {
    name?: string
    user_daily_token_cap?: number
    org_monthly_token_cap?: number
    search_enabled?: boolean
    user_daily_search_cap?: number
    org_monthly_search_cap?: number
  }
): Promise<{ ok: true }> => send(token, 'PATCH', '/admin/org', patch)
