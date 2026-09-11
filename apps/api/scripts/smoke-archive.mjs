#!/usr/bin/env node
/**
 * Archive smoke test against `wrangler dev` (:8787) — proves the D1 hot
 * window: an idle conversation's records move to one R2 blob and the
 * records read still serves every record, in order, under the client's
 * unchanged cursor loop; new records after archiving merge in; a second
 * archive pass merges the blob; raw usage rows past retention are exported
 * and deleted; a conversation deleted a month ago loses records and blob.
 *
 * The snapshot record is the one row archiving LEAVES in D1: it is the
 * conversation's envelope, and the phone's conversation index reads
 * model/icon/project/stats straight off it. So the contract after a pass is
 * "every message moved, the envelope stayed", not "D1 emptied" — and because
 * live rows sit after the blob in cursor space (N + rowid), the envelope is
 * read back at the END of the record stream rather than at its original
 * position. Order is therefore contractual for the MESSAGE run only; the set
 * as a whole must still come back complete and exactly once.
 *
 *   sync 451 records (idle 20 days) → read all (paged) → maintenance run →
 *   messages archived + envelope live + archive_key set → read all again:
 *   every id once, messages in order, one snapshot → push 3 records + newer
 *   snapshot → read: 454, ONE snapshot (the newest) → re-idle + maintenance →
 *   merged blob, messages archived again, read still 454 → 5 usage rows aged
 *   200 days retire → deleted 40 days ago → purged (records 0, archive_key
 *   NULL).
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const stamp = Date.now().toString(36)
const PW = 'archive-pass-1'
const salt = '00112233445566778899aabbccddeeff'
const hash = pbkdf2Sync(PW, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
const ownerEmail = `archowner-${stamp}@wolffi.sh`
const userEmail = `archuser-${stamp}@wolffi.sh`
const ownerId = `usr_archowner_${stamp}`
const userId = `usr_archuser_${stamp}`
const d1 = (sql) =>
  execSync(`npx wrangler d1 execute wfc-master --local --json --command "${sql.replace(/"/g, '\\"')}"`, {
    stdio: 'pipe'
  }).toString()
const d1rows = (sql) => JSON.parse(d1(sql))[0].results

d1(
  [
    `INSERT OR IGNORE INTO org (id, name, default_model, default_allowed_models) VALUES (1, 'Wolffish', 'deepseek-ai/DeepSeek-V4.1-Flash', '[]');`,
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password) VALUES ('${ownerId}', '${ownerEmail}', 'Owner', 'owner', 'active', '${hash}', '${salt}', 0);`,
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password) VALUES ('${userId}', '${userEmail}', 'User', 'employee', 'active', '${hash}', '${salt}', 0);`
  ].join(' ')
)

let failures = 0
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
const api = async (path, { token, body, method } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

const O = (await api('/auth/login', { body: { email: ownerEmail, password: PW } })).json.access_token
const U = (await api('/auth/login', { body: { email: userEmail, password: PW } })).json.access_token
check('logins', Boolean(O && U))

// The client's exact paging loop (pullRecords in apps/desktop cloud/sync.ts).
async function pullAll(convId, limit = 200) {
  const all = []
  const cursors = []
  let after = 0
  for (;;) {
    const res = (await api(`/v1/conversations/${convId}/records?after=${after}&limit=${limit}`, { token: U })).json
    all.push(...res.records)
    cursors.push(res.next_after)
    const next = res.next_after
    if (typeof next !== 'number' || res.records.length === 0 || !(next > after)) break
    after = next
  }
  return { all, cursors }
}

/** The message run, in read order — the part of the order that is a promise. */
const msgIds = (recs) => recs.filter((r) => r.kind !== 'snapshot').map((r) => r.id)
/** Every id, order-independent — proves the set is complete and duplicate-free. */
const allIds = (recs) => recs.map((r) => r.id).sort()

const convId = `cnv_arch_${stamp}`
const DAY = 86_400_000
const idleAt = new Date(Date.now() - 20 * DAY).toISOString()
const olderAt = new Date(Date.now() - 21 * DAY).toISOString()
const N = 450
const items = [
  { type: 'conversation', id: convId, title: 'Archive me', created_at: olderAt, updated_at: idleAt },
  {
    type: 'record',
    id: `snap.${convId}`,
    conversation_id: convId,
    seq: 1000,
    kind: 'snapshot',
    content: { title: 'Archive me', v: 1 },
    created_at: idleAt
  },
  ...Array.from({ length: N }, (_, i) => ({
    type: 'record',
    id: `m_${i}.${(i * 2654435761 >>> 0).toString(16).padStart(8, '0').slice(0, 8)}`,
    conversation_id: convId,
    seq: i,
    kind: 'message',
    content: { role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'x'.repeat(200) },
    created_at: olderAt
  }))
]
for (let i = 0; i < items.length; i += 400) {
  const r = await api('/v1/sync/batch', { token: U, body: { items: items.slice(i, i + 400) } })
  check(`batch ${i / 400 + 1} accepted`, r.status === 200 && r.json.rejected === 0, JSON.stringify(r.json))
}

const before = await pullAll(convId)
check(`read before archive: ${N + 1} records`, before.all.length === N + 1, `${before.all.length}`)
const msgIdsBefore = msgIds(before.all)
const allIdsBefore = allIds(before.all)

// ── The archive pass ─────────────────────────────────────────────────────
// Each nightly pass is bounded (400 conversations, oldest first), and a
// local D1 may hold thousands of idle conversations from earlier
// simulations, so run passes until THIS conversation has been reached —
// exactly how a backlog drains over successive nights.
async function archiveUntilReached() {
  let runs = 0
  let last = null
  for (; runs < 40; runs++) {
    last = await api('/admin/maintenance/run', { token: O, body: {} })
    if (last.status !== 200 || last.json?.report?.archive_idle?.ok !== true) break
    const key = d1rows(`SELECT archive_key FROM conversations WHERE id = '${convId}'`)[0]?.archive_key
    if (key) break
    if ((last.json?.report?.archive_idle?.archived ?? 0) === 0) break
  }
  return { runs: runs + 1, last }
}
const pass1 = await archiveUntilReached()
check(`maintenance passes ok (${pass1.runs} run(s) to reach this conversation)`, pass1.last?.status === 200 && pass1.last?.json?.report?.archive_idle?.ok === true, JSON.stringify(pass1.last?.json?.report))
const conv1 = d1rows(`SELECT archived_at, archive_key FROM conversations WHERE id = '${convId}'`)[0]
// Exactly one row survives, and it is the envelope: archiveIdleConversations
// moves everything whose kind is not 'snapshot' and leaves that one behind.
const kinds1 = d1rows(`SELECT kind FROM conversation_records WHERE conversation_id = '${convId}'`).map((r) => r.kind)
check(
  'messages archived, snapshot envelope left live, archive_key set',
  kinds1.length === 1 && kinds1[0] === 'snapshot' && conv1?.archive_key === `archive/${userId}/${convId}.json.gz`,
  `rows ${JSON.stringify(kinds1)}, key ${conv1?.archive_key}`
)

const after1 = await pullAll(convId)
check(`read after archive: ${N + 1} records`, after1.all.length === N + 1, `${after1.all.length}`)
check('…messages in the same order', JSON.stringify(msgIds(after1.all)) === JSON.stringify(msgIdsBefore))
check('…every id back exactly once', JSON.stringify(allIds(after1.all)) === JSON.stringify(allIdsBefore))
check('…exactly one snapshot', after1.all.filter((r) => r.kind === 'snapshot').length === 1)
check('…cursors strictly increase and terminate with null', after1.cursors.slice(0, -1).every((c, i) => typeof c === 'number' && (i === 0 || c > after1.cursors[i - 1])) && after1.cursors[after1.cursors.length - 1] === null, JSON.stringify(after1.cursors))
check('…content round-trips', after1.all.find((r) => r.id.startsWith('m_7.'))?.content?.text?.startsWith('message 7 '))
const small = await pullAll(convId, 7)
check(
  '…any page size pages the same set',
  small.all.length === N + 1 &&
    JSON.stringify(msgIds(small.all)) === JSON.stringify(msgIdsBefore) &&
    JSON.stringify(allIds(small.all)) === JSON.stringify(allIdsBefore),
  `${small.all.length}`
)

// ── New records after archiving merge in ─────────────────────────────────
const now = new Date().toISOString()
const more = [
  { type: 'conversation', id: convId, title: 'Archive me (revived)', created_at: olderAt, updated_at: now },
  { type: 'record', id: `snap.${convId}`, conversation_id: convId, seq: 2000, kind: 'snapshot', content: { title: 'revived', v: 2 }, created_at: now },
  ...[0, 1, 2].map((i) => ({
    type: 'record',
    id: `m_new${i}.deadbeef`,
    conversation_id: convId,
    seq: 5000 + i,
    kind: 'message',
    content: { role: 'user', text: `new ${i}` },
    created_at: now
  }))
]
const r2 = await api('/v1/sync/batch', { token: U, body: { items: more } })
check('revival batch accepted', r2.status === 200 && r2.json.rejected === 0, JSON.stringify(r2.json))
const merged = await pullAll(convId)
const snaps = merged.all.filter((r) => r.kind === 'snapshot')
check(`read after revival: ${N + 4} records`, merged.all.length === N + 4, `${merged.all.length}`)
check('…ONE snapshot, the newest', snaps.length === 1 && snaps[0].seq === 2000 && snaps[0].content.v === 2, JSON.stringify(snaps.map((s) => s.seq)))
check('…ids unique', new Set(merged.all.map((r) => r.id)).size === merged.all.length)
check('…new records present', ['m_new0.deadbeef', 'm_new1.deadbeef', 'm_new2.deadbeef'].every((id) => merged.all.some((r) => r.id === id)))

// ── A second idle pass merges the blob ───────────────────────────────────
d1(`UPDATE conversations SET updated_at = '${idleAt}' WHERE id = '${convId}'`)
// Reached again means: the revived MESSAGES are gone and only the envelope
// is left (the reach test is archive_key, already set — so loop on the
// surviving kinds instead).
let kinds2 = []
for (let i = 0; i < 40; i++) {
  const r = await api('/admin/maintenance/run', { token: O, body: {} })
  kinds2 = d1rows(`SELECT kind FROM conversation_records WHERE conversation_id = '${convId}'`).map((k) => k.kind)
  if (!kinds2.some((k) => k !== 'snapshot') || (r.json?.report?.archive_idle?.archived ?? 0) === 0) break
}
const drained2 = kinds2.length === 1 && kinds2[0] === 'snapshot'
check('maintenance run 2 archived the revived messages, envelope still live', drained2, `rows ${JSON.stringify(kinds2)}`)
const merged2 = await pullAll(convId)
check(
  'after merge: read still complete, each id once, one snapshot',
  drained2 &&
    merged2.all.length === N + 4 &&
    new Set(merged2.all.map((r) => r.id)).size === N + 4 &&
    merged2.all.filter((r) => r.kind === 'snapshot').length === 1,
  `rows ${JSON.stringify(kinds2)}, read ${merged2.all.length}`
)
check('…newest snapshot survived the merge', merged2.all.find((r) => r.kind === 'snapshot')?.seq === 2000)

// ── Usage retention ──────────────────────────────────────────────────────
const old = new Date(Date.now() - 200 * DAY).toISOString()
d1(
  Array.from({ length: 5 }, (_, i) =>
    `INSERT INTO usage (user_id, device_id, model, tokens_in, tokens_out, cost_microusd, latency_ms, decision, created_at) VALUES ('${userId}', 'dev', 'm', 10, 5, 1, 1, 'allowed', '${old}');`
  ).join(' ')
)
const oldCount = d1rows(`SELECT COUNT(*) AS n FROM usage WHERE user_id = '${userId}' AND created_at = '${old}'`)[0].n
check('5 aged usage rows seeded', oldCount === 5, `${oldCount}`)
const run3 = await api('/admin/maintenance/run', { token: O, body: {} })
check('retirement exported the aged rows', (run3.json?.report?.retire_usage?.exported ?? 0) >= 5, JSON.stringify(run3.json?.report?.retire_usage))
const leftover = d1rows(`SELECT COUNT(*) AS n FROM usage WHERE user_id = '${userId}' AND created_at = '${old}'`)[0].n
check('…and deleted them from D1', leftover === 0, `${leftover}`)

// ── Purge of a conversation deleted a month ago ──────────────────────────
const del = await api(`/v1/conversations/${convId}`, { token: U, method: 'DELETE' })
check('conversation tombstoned', del.status === 200 && del.json?.deleted === true)
d1(`UPDATE conversations SET deleted_at = '${new Date(Date.now() - 40 * DAY).toISOString()}' WHERE id = '${convId}'`)
const run4 = await api('/admin/maintenance/run', { token: O, body: {} })
check('purge run ok', run4.json?.report?.purge_deleted?.ok === true && (run4.json?.report?.purge_deleted?.purged ?? 0) >= 1, JSON.stringify(run4.json?.report?.purge_deleted))
const conv4 = d1rows(`SELECT archive_key, deleted_at FROM conversations WHERE id = '${convId}'`)[0]
check('…tombstone kept, archive_key cleared', conv4 && conv4.deleted_at && conv4.archive_key === null, JSON.stringify(conv4))
const audit = (await api('/admin/audit?limit=5', { token: O })).json?.entries ?? []
check('maintenance runs audited', audit.some((e) => e.action === 'maintenance.run'))

console.log(failures === 0 ? '\nARCHIVE SMOKE: ALL PASS' : `\nARCHIVE SMOKE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
