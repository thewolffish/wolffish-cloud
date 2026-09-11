#!/usr/bin/env node
/**
 * Leaderboard smoke test against `wrangler dev` (:8787). Proves the board is
 * the org looking at itself:
 *
 *   any employee may read it → agentic tasks come from the conversation's
 *   channel → the default page is the top ten → offset pages → search by
 *   name keeps the ORG rank → `me` is there whatever the page shows.
 *
 * Two employees are seeded with usage rollups and conversations written
 * straight into D1, so the ordering under test is a known one rather than
 * whatever the shared local database happens to hold.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const PW = 'board-user-pass-1'
const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')

// Two names sharing a prefix, so the `q` filter has something to discriminate.
const PEOPLE = [
  { tag: 'boardhi', name: `Zeta Boardhi ${stamp}`, tokens: 900_000, convs: 4, agentic: 3 },
  { tag: 'boardlo', name: `Zeta Boardlo ${stamp}`, tokens: 12_000, convs: 2, agentic: 0 }
]

const day = new Date().toISOString().slice(0, 10)
const now = new Date().toISOString()
const sql = [
  `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models)
   VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4.1-Flash', '[]');`
]
for (const p of PEOPLE) {
  const id = `usr_${p.tag}_${stamp}`
  sql.push(
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password)
     VALUES ('${id}', '${p.tag}-${stamp}@wolffi.sh', '${p.name}', 'employee', 'active', '${hash}', '${salt}', 0);`,
    `INSERT INTO usage_daily (user_id, day, kind, requests, denied, tokens_in, tokens_out, tokens_cached, cost_microusd)
     VALUES ('${id}', '${day}', 'chat', 1, 0, ${Math.floor(p.tokens / 2)}, ${Math.ceil(p.tokens / 2)}, 0, 100);`
  )
  for (let i = 0; i < p.convs; i++) {
    // The first `agentic` conversations of each person are autonomous runs.
    const channel = i < p.agentic ? (i % 2 === 0 ? 'heartbeat' : 'procedure') : 'electron'
    sql.push(
      `INSERT INTO conversations (id, user_id, device_id, title, channel, created_at, updated_at)
       VALUES ('cnv_${p.tag}_${stamp}_${i}', '${id}', 'dev_x', 'c${i}', '${channel}', '${now}', '${now}');`
    )
  }
}
execSync(`npx wrangler d1 execute wfc-master --local --command "${sql.join(' ').replace(/"/g, '\\"')}"`, {
  stdio: 'pipe'
})

let failures = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
/**
 * One retry on a TRANSPORT failure. This suite interleaves slow `wrangler`
 * CLI calls with its requests, and a pooled keep-alive socket that the dev
 * server closed during one of those gaps surfaces as ECONNRESET on the next
 * request rather than as a response. Nothing about the API is retried here —
 * a response, of any status, is returned exactly as it came.
 */
const api = async (path, opts = {}) => {
  try {
    return await request(path, opts)
  } catch {
    return request(path, opts)
  }
}
const request = async (path, { token, body, method } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const login = async (tag) =>
  (
    await api('/auth/login', {
      body: { email: `${tag}-${stamp}@wolffi.sh`, password: PW, device: { platform: 'sim' } }
    })
  ).json

const hi = await login('boardhi')
const lo = await login('boardlo')
check('two employees logged in', hi?.access_token && lo?.access_token)

check('unauthenticated read refused', (await api('/v1/leaderboard')).status === 401)

// The ingest seam the agentic count rests on: a client names the channel on
// the conversation item, and the row keeps it. Read back from D1 rather than
// from the board, which is cached for minutes — this is about the write.
const readChannel = (id) =>
  JSON.parse(
    execSync(
      `npx wrangler d1 execute wfc-master --local --json --command "SELECT channel FROM conversations WHERE id = '${id}'"`,
      { encoding: 'utf8' }
    )
  )[0]?.results?.[0]?.channel
const ingestId = `cnv_${stamp}_ingest`
const t0 = new Date().toISOString()
const pushed = await api('/v1/sync/batch', {
  token: hi.access_token,
  body: {
    items: [
      { type: 'conversation', id: ingestId, title: 'run', channel: 'procedure', created_at: t0, updated_at: t0 }
    ]
  }
})
check('a conversation item may carry its channel', pushed.json?.accepted === 1, JSON.stringify(pushed.json))
check('the channel lands on the row', readChannel(ingestId) === 'procedure', String(readChannel(ingestId)))
// An older client sends no channel at all; that must not erase the one the
// row already holds (provenance is write-once).
const t1 = new Date(Date.now() + 2000).toISOString()
await api('/v1/sync/batch', {
  token: hi.access_token,
  body: { items: [{ type: 'conversation', id: ingestId, title: 'renamed', created_at: t0, updated_at: t1 }] }
})
check('a channel-less update keeps the recorded channel', readChannel(ingestId) === 'procedure', String(readChannel(ingestId)))

// The board is a cached snapshot of the whole org (minutes of TTL), and the
// rows above were written after any copy an earlier suite left behind. Retire
// that copy rather than polling and hoping — the suite already reaches into
// D1 to seed, and reaching into the same local KV keeps the endpoint itself
// free of any test-only door.
const bustCache = () => {
  for (const key of ['leaderboard:v1', `leaderboard:v1:me:usr_boardlo_${stamp}`]) {
    try {
      execSync(`npx wrangler kv key delete --binding CONFIG_KV --local "${key}"`, { stdio: 'pipe' })
    } catch {
      // Nothing cached yet: the next read computes the board from scratch,
      // which is exactly what deleting it was for.
    }
  }
}
bustCache()

// Found by NAME, not by position: this database also holds whatever the load
// simulation left behind, so neither of these two is at a predictable rank.
// Searching is the board's own way of finding one person, and it preserves
// the org rank — which is what the checks below are about.
const rowOf = async (tag) =>
  (await api(`/v1/leaderboard?q=Zeta%20Board${tag}%20${stamp}`, { token: lo.access_token })).json
    ?.rows?.[0] ?? null
const board = (await api('/v1/leaderboard?limit=100', { token: lo.access_token })).json
const rowHi = await rowOf('hi')
const rowLo = await rowOf('lo')
check('an employee (not an admin) can read the board', Boolean(rowHi && rowLo), JSON.stringify(board)?.slice(0, 300))
check('token spend is reported', rowHi?.tokens === 900_000 && rowLo?.tokens === 12_000, JSON.stringify([rowHi, rowLo]))
// boardhi holds the four conversations seeded above PLUS the one pushed
// through /v1/sync/batch — so these two checks also prove the ingested
// channel reaches the board, end to end, and not only the D1 row.
check(
  'conversations are counted',
  rowHi?.conversations === PEOPLE[0].convs + 1 && rowLo?.conversations === PEOPLE[1].convs,
  JSON.stringify([rowHi?.conversations, rowLo?.conversations])
)
check(
  'agentic tasks come from the autonomous channels only',
  rowHi?.agentic_tasks === PEOPLE[0].agentic + 1 && rowLo?.agentic_tasks === 0,
  JSON.stringify([rowHi?.agentic_tasks, rowLo?.agentic_tasks])
)
check('the heavier spender outranks the lighter one', rowHi?.rank < rowLo?.rank)
check('no cost is disclosed', rowHi && !('cost_microusd' in rowHi), JSON.stringify(rowHi))

const page1 = (await api('/v1/leaderboard', { token: lo.access_token })).json
check('page 1 is the top ten', page1?.rows?.length === Math.min(10, page1?.board_size ?? 0) && page1?.limit === 10)
check('page 1 starts at rank 1', page1?.rows?.[0]?.rank === 1)
// Whatever page is showing — and however far down the caller sits, even off
// the end of a truncated board — `me` answers "where do I stand?".
check(
  'the caller is on every page, wherever they rank',
  page1?.me?.user_id === `usr_boardlo_${stamp}` && page1.me.tokens === 12_000,
  JSON.stringify(page1?.me)
)

const page2 = (await api('/v1/leaderboard?offset=10', { token: lo.access_token })).json
check(
  'offset pages continue the ranking',
  (page2?.rows?.length ?? 0) === 0 || page2.rows[0].rank === 11,
  JSON.stringify(page2?.rows?.[0])
)

const found = (await api(`/v1/leaderboard?q=Boardhi%20${stamp}`, { token: lo.access_token })).json
check('search by name matches', found?.total === 1 && found.rows[0].user_id === `usr_boardhi_${stamp}`, JSON.stringify(found)?.slice(0, 200))
check('a searched row keeps its ORG rank, not its position in the result', found?.rows?.[0]?.rank === rowHi?.rank)
check('search still reports the whole board size', found?.board_size === board?.board_size)
check('me survives a search that excludes me', found?.me?.user_id === `usr_boardlo_${stamp}`)

const none = (await api('/v1/leaderboard?q=zzz-no-such-person', { token: lo.access_token })).json
check('an empty search is an empty page, not an error', none?.total === 0 && none.rows.length === 0)

const capped = (await api('/v1/leaderboard?limit=99999&offset=-5', { token: lo.access_token })).json
check('limit and offset are clamped', capped?.limit === 100 && capped?.offset === 0)

// Someone who joined AFTER the cached snapshot was taken is on no page of
// it — the case that used to answer "you are nowhere". The board is warm by
// now (every read above filled it), so this user exercises the direct
// standing lookup rather than the board.
const lateId = `usr_boardnew_${stamp}`
execSync(
  `npx wrangler d1 execute wfc-master --local --command "` +
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password) ` +
    `VALUES ('${lateId}', 'boardnew-${stamp}@wolffi.sh', 'Zeta Boardnew ${stamp}', 'employee', 'active', '${hash}', '${salt}', 0);"`,
  { stdio: 'pipe' }
)
const late = await login('boardnew')
const lateBoard = (await api('/v1/leaderboard', { token: late.access_token })).json
check(
  'someone who joined since the snapshot still gets their own standing',
  lateBoard?.me?.user_id === lateId && lateBoard.me.rank > 0 && lateBoard.me.tokens === 0,
  JSON.stringify(lateBoard?.me)
)
check(
  'and they are NOT invented onto the page they are missing from',
  !(lateBoard?.rows ?? []).some((r) => r.user_id === lateId)
)

console.log(failures === 0 ? '\nLEADERBOARD SMOKE PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
