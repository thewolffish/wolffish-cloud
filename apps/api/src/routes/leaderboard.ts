/**
 * The org leaderboard — one standing, readable by every signed-in user.
 *
 * Three figures per person: tokens spent on the model lane, conversations
 * held, and agentic tasks (the runs the agent started on its own — the
 * heartbeat and procedure channels). Nothing here is admin-tier: the board
 * IS the org looking at itself, so `requireAuth` is the whole gate. It
 * deliberately carries no money: cost is org-financial and stays behind
 * /admin/usage, where it already lives.
 *
 * Why the whole board is computed at once and cached rather than paged in
 * SQL: the figures are aggregates over every usage_daily row the org has
 * ever written (~1M for a 500-person org after a few years), so a scan per
 * page-turn, per search keystroke, per reader is the one thing this endpoint
 * must not do. Instead one aggregate fills a CONFIG_KV copy of the entire
 * board (~500 rows, ~60 KB), and paging, searching and rank all happen in
 * the isolate over that copy. The consequences are the good kind: a rank is
 * the rank in the WHOLE org even when the list is filtered to one name, and
 * page 2 can never disagree with page 1 because both came from one snapshot.
 *
 * Freshness: TTL_SECONDS + the edge read window. A leaderboard minutes
 * behind is a leaderboard; a leaderboard that costs a table scan to read is
 * not one anybody gets to keep.
 */
import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '@/middleware/auth'
import type { Env } from '@/index'

const leaderboard = new Hono<{ Bindings: Env; Variables: AuthVars }>()

leaderboard.use('*', requireAuth)

/** The two channels that mean "the agent ran this without being asked". */
const AGENTIC_CHANNELS = ['heartbeat', 'procedure']

/** Cached copy's lifetime, and the edge read window inside it. */
const TTL_SECONDS = 300
const EDGE_TTL_SECONDS = 60
/**
 * Bumped whenever a row's shape changes, so copies written by the previous
 * shape retire at once instead of needing a per-field compat branch.
 */
const CACHE_KEY = 'leaderboard:v1'

/**
 * Hard stop on the cached copy — the KV value ceiling (25 MB) reached long
 * before this, at roughly 120 bytes a row. Far above this deployment's scale
 * target of 500 employees; it exists so a fork with an implausible user table
 * gets a truncated board rather than a value KV refuses to store. Past it,
 * `standingOf` below still answers "where am I?" for someone who fell off the
 * end, so truncation costs visibility of the tail, never of yourself.
 */
const MAX_BOARD = 20_000

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

export type BoardEntry = {
  rank: number
  user_id: string
  name: string
  role: string
  tokens: number
  conversations: number
  agentic_tasks: number
}

type Board = {
  generated_at: string
  entries: BoardEntry[]
  /** True when MAX_BOARD cut the org off, so the tail is not listed here. */
  truncated: boolean
}

/**
 * The per-person figures, as one SELECT list over two grouped subqueries.
 * Written once and used by both the board and the single-person standing
 * below, so the two can never compute a person differently.
 */
const FIGURES_SQL = (agenticPlaceholders: string): string => `
  SELECT u.id AS user_id, u.name, u.role,
         COALESCE(ut.tokens, 0) AS tokens,
         COALESCE(ct.conversations, 0) AS conversations,
         COALESCE(ct.agentic_tasks, 0) AS agentic_tasks
    FROM users u
    LEFT JOIN (
      SELECT user_id, SUM(tokens_in + tokens_out) AS tokens
        FROM usage_daily GROUP BY user_id
    ) ut ON ut.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS conversations,
             SUM(CASE WHEN channel IN (${agenticPlaceholders}) THEN 1 ELSE 0 END) AS agentic_tasks
        FROM conversations WHERE deleted_at IS NULL GROUP BY user_id
    ) ct ON ct.user_id = u.id
   WHERE u.status != 'removed'`

/** The one ordering, shared by the board and by the rank count below. */
const ORDER_SQL = 'tokens DESC, conversations DESC, agentic_tasks DESC, name COLLATE NOCASE'

const toEntry = (r: Omit<BoardEntry, 'rank'>, rank: number): BoardEntry => ({
  rank,
  user_id: r.user_id,
  name: r.name,
  role: r.role,
  tokens: Number(r.tokens) || 0,
  conversations: Number(r.conversations) || 0,
  agentic_tasks: Number(r.agentic_tasks) || 0
})

/**
 * One aggregate for the whole org. Both sides are grouped subqueries rather
 * than correlated lookups, so this is two index-ordered passes joined onto
 * the user list — not a per-user query in a loop.
 */
async function computeBoard(env: Env): Promise<Board> {
  const placeholders = AGENTIC_CHANNELS.map((_, i) => `?${i + 1}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT * FROM (${FIGURES_SQL(placeholders)}) ORDER BY ${ORDER_SQL} LIMIT ${MAX_BOARD}`
  )
    .bind(...AGENTIC_CHANNELS)
    .all<Omit<BoardEntry, 'rank'>>()
  const entries = (rows.results ?? []).map((r, i) => toEntry(r, i + 1))
  return {
    generated_at: new Date().toISOString(),
    entries,
    truncated: entries.length >= MAX_BOARD
  }
}

/**
 * One person's standing, computed directly — the answer for a caller the
 * cached board does not hold (the truncated tail, or someone who joined
 * since the snapshot). Their rank is "everyone strictly ahead of me, plus
 * one" under exactly the board's ordering, so it agrees with the ranks on
 * the page rather than approximating them. It costs the same aggregate the
 * board does, which is why it runs only off the miss path and its answer is
 * cached per user for the same window.
 */
async function standingOf(env: Env, userId: string): Promise<BoardEntry | null> {
  const key = `${CACHE_KEY}:me:${userId}`
  try {
    const cached = (await env.CONFIG_KV.get(key, {
      type: 'json',
      cacheTtl: EDGE_TTL_SECONDS
    })) as BoardEntry | null
    if (cached && typeof cached.rank === 'number') return cached
  } catch {
    // A cache read that fails is a miss, never a 500.
  }
  const n = AGENTIC_CHANNELS.length
  const placeholders = AGENTIC_CHANNELS.map((_, i) => `?${i + 1}`).join(', ')
  const figures = FIGURES_SQL(placeholders)
  const row = await env.DB.prepare(
    `WITH figures AS (${figures}), me AS (SELECT * FROM figures WHERE user_id = ?${n + 1})
     SELECT me.*, (
       SELECT COUNT(*) + 1 FROM figures f, me
        WHERE f.tokens > me.tokens
           OR (f.tokens = me.tokens AND f.conversations > me.conversations)
           OR (f.tokens = me.tokens AND f.conversations = me.conversations
               AND f.agentic_tasks > me.agentic_tasks)
           OR (f.tokens = me.tokens AND f.conversations = me.conversations
               AND f.agentic_tasks = me.agentic_tasks
               AND f.name COLLATE NOCASE < me.name COLLATE NOCASE)
     ) AS rank
     FROM me`
  )
    .bind(...AGENTIC_CHANNELS, userId)
    .first<Omit<BoardEntry, 'rank'> & { rank: number }>()
  if (!row) return null
  const entry = toEntry(row, Number(row.rank) || 0)
  try {
    await env.CONFIG_KV.put(key, JSON.stringify(entry), { expirationTtl: TTL_SECONDS })
  } catch {
    // Lost the write race; the other isolate's copy is as good as ours.
  }
  return entry
}

async function getBoard(env: Env): Promise<Board> {
  try {
    const cached = await env.CONFIG_KV.get(CACHE_KEY, { type: 'json', cacheTtl: EDGE_TTL_SECONDS })
    const board = cached as Board | null
    if (board && Array.isArray(board.entries)) return board
  } catch {
    // A cache read that fails is a miss, never a 500.
  }
  const board = await computeBoard(env)
  try {
    await env.CONFIG_KV.put(CACHE_KEY, JSON.stringify(board), { expirationTtl: TTL_SECONDS })
  } catch {
    // Another isolate refilled the key within the same second (KV allows one
    // write per key per second); its copy is as good as ours.
  }
  return board
}

const intParam = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * GET /v1/leaderboard?limit=&offset=&q=
 *
 * Page 1 with the defaults is the top ten. `q` filters by name (substring,
 * case-insensitive) WITHOUT renumbering: a filtered row keeps the rank it
 * holds in the whole org, which is the only rank that means anything.
 * `me` is the caller's own row, always present whatever the page or filter
 * shows — and computed directly when a truncated board cut them off — so the
 * board never fails to answer "and where am I?".
 */
leaderboard.get('/leaderboard', async (c) => {
  const auth = c.get('auth')
  const limit = intParam(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = intParam(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const q = (c.req.query('q') ?? '').trim().toLowerCase()

  const board = await getBoard(c.env)
  const matched = q ? board.entries.filter((e) => e.name.toLowerCase().includes(q)) : board.entries

  // The caller is normally right there on the board. Two things can leave
  // them off it: MAX_BOARD cut the org off above them, or they joined after
  // the snapshot was taken — and either way "where do I stand?" is exactly
  // the question the page would otherwise be unable to answer. The direct
  // lookup costs what the board costs, but the set of people who need it is
  // bounded (a truncated tail, plus whoever joined in the last TTL window)
  // and each answer is itself cached for the same window.
  let me = board.entries.find((e) => e.user_id === auth.sub) ?? null
  if (!me) me = await standingOf(c.env, auth.sub)

  return c.json({
    generated_at: board.generated_at,
    total: matched.length,
    board_size: board.entries.length,
    truncated: board.truncated,
    limit,
    offset,
    rows: matched.slice(offset, offset + limit),
    me
  })
})

export default leaderboard
