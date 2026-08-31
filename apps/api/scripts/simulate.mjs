#!/usr/bin/env node
/**
 * The Wolffish Inc traffic simulator — 50 employees using the real API.
 *
 *   WFC_DEMO_PASSWORD=... node scripts/simulate.mjs [--rounds 3] [--stream 0.3]
 *
 * No test-mode bypass anywhere: every simulated employee authenticates
 * through /auth/login, reads their own /v1/models, chats through the
 * governed router, and drains a sync batch — exactly the calls the
 * desktop will make. Roster comes from /admin/users via the owner
 * account, so the simulator follows whatever the seed (or an admin)
 * did to the org. Denials for capped users are EXPECTED and reported
 * as governance-working, not errors.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const PASSWORD = process.env.WFC_DEMO_PASSWORD
if (!PASSWORD) {
  console.error('WFC_DEMO_PASSWORD required (the seed printed it)')
  process.exit(1)
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : dflt
}
const ROUNDS = arg('rounds', 3)
const STREAM_FRACTION = arg('stream', 0.3)

const api = async (path, { token, body, method } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json }
}

// Owner signs in and pulls the roster.
const owner = await api('/auth/login', {
  body: { email: 'younes@wolffi.sh', password: PASSWORD, device: { platform: 'sim', name: 'simulator' } }
})
if (owner.status !== 200) {
  console.error('owner login failed — is the org seeded and the password right?', owner.json)
  process.exit(1)
}
const rosterRes = await api('/admin/users', { token: owner.json.access_token })
const cast = (rosterRes.json?.users ?? []).filter(
  (u) => u.status === 'active' && !u.must_change_password
)
console.log(`cast: ${cast.length} active employees (of ${(rosterRes.json?.users ?? []).length} seeded)`)

// Phase 1 — everyone logs in at once. This IS the concurrency check.
const t0 = Date.now()
const sessions = await Promise.all(
  cast.map(async (u) => {
    const r = await api('/auth/login', {
      body: { email: u.email, password: PASSWORD, device: { platform: 'sim', name: `sim-${u.id}` } }
    })
    return r.status === 200 ? { user: u, token: r.json.access_token } : { user: u, error: r }
  })
)
const live = sessions.filter((s) => s.token)
const loginFailures = sessions.filter((s) => !s.token)
console.log(
  `phase 1 — concurrent login: ${live.length}/${sessions.length} in ${Date.now() - t0}ms` +
    (loginFailures.length ? ` — FAILURES: ${loginFailures.map((f) => f.user.email).join(', ')}` : '')
)

// Phase 2 — rounds of real work.
const stats = { chat_ok: 0, chat_denied_model: 0, chat_denied_quota: 0, chat_error: 0, sync_ok: 0, sync_error: 0, latencies: [] }
const stamp = Date.now().toString(36)

for (let round = 0; round < ROUNDS; round++) {
  await Promise.all(
    live.map(async ({ user, token }, i) => {
      const models = await api('/v1/models', { token })
      const model = models.json?.models?.[0]?.id
      if (!model) return

      const stream = Math.random() < STREAM_FRACTION
      const started = Date.now()
      if (stream) {
        const res = await fetch(`${BASE}/ai/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model,
            stream: true,
            max_tokens: 40,
            messages: [{ role: 'user', content: `One short fact, round ${round}.` }]
          })
        })
        await res.text()
        stats.latencies.push(Date.now() - started)
        if (res.status === 200) stats.chat_ok++
        else if (res.status === 403) stats.chat_denied_model++
        else if (res.status === 429) stats.chat_denied_quota++
        else stats.chat_error++
      } else {
        const res = await api('/ai/v1/chat/completions', {
          token,
          body: {
            model,
            max_tokens: 40,
            messages: [{ role: 'user', content: `One short fact, round ${round}.` }]
          }
        })
        stats.latencies.push(Date.now() - started)
        if (res.status === 200) stats.chat_ok++
        else if (res.status === 403) stats.chat_denied_model++
        else if (res.status === 429) stats.chat_denied_quota++
        else stats.chat_error++
      }

      // A slice of the cast also drains an outbox batch each round.
      if (i % 3 === round % 3) {
        const convId = `cnv_sim_${user.id}_${stamp}`
        const now = new Date().toISOString()
        const batch = await api('/v1/sync/batch', {
          token,
          body: {
            items: [
              { type: 'conversation', id: convId, title: `Sim ${round}`, created_at: now, updated_at: now },
              {
                type: 'record',
                id: `rec_sim_${user.id}_${stamp}_${round}`,
                conversation_id: convId,
                seq: round,
                content: { role: 'user', text: `round ${round}` },
                created_at: now
              }
            ]
          }
        })
        batch.status === 200 ? stats.sync_ok++ : stats.sync_error++
      }
    })
  )
  console.log(`round ${round + 1}/${ROUNDS} done`)
}

stats.latencies.sort((a, b) => a - b)
const pct = (p) => stats.latencies[Math.floor((stats.latencies.length - 1) * p)] ?? 0
console.log('\n── simulator report ──')
console.log(`  logins:        ${live.length}/${sessions.length}`)
console.log(`  chat ok:       ${stats.chat_ok}`)
console.log(`  denied model:  ${stats.chat_denied_model}  (governance working)`)
console.log(`  denied quota:  ${stats.chat_denied_quota}  (governance working)`)
console.log(`  chat errors:   ${stats.chat_error}`)
console.log(`  sync batches:  ${stats.sync_ok} ok / ${stats.sync_error} failed`)
console.log(`  chat latency:  p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms`)

const hardFailure = loginFailures.length > 0 || stats.chat_error > 0 || stats.sync_error > 0
process.exit(hardFailure ? 1 : 0)
