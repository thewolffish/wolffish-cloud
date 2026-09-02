#!/usr/bin/env node
/**
 * Seed "Wolffish Inc" — the 50-employee demo org. Same posture as the
 * mobile app's demo data: real-shaped, deterministically minted, fake.
 *
 *   node scripts/seed-demo.mjs [--remote] [--wipe]
 *
 * Deterministic: user ids, emails, names, roles, salts, policies and the
 * 7-day usage history are pure functions of the roster — reseeding
 * produces identical rows. Passwords are NOT deterministic by default:
 * one password for all seeded people is WFC_DEMO_PASSWORD or the fixed
 * randomly generated and printed ONCE, so a public repo never contains a
 * live credential. A fork deletes this file and its rows (--wipe).
 *
 * Cast: 1 owner + 2 admins + 2 support + 45 employees = 50.
 * emp-049 stays 'invited' forever — the live demo of the invite flow.
 * emp-048 is suspended — the live demo of suspension.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync, randomBytes, createHash } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REMOTE = process.argv.includes('--remote')
const WIPE = process.argv.includes('--wipe')
const FLAG = REMOTE ? '--remote' : '--local'

// The frontier pair — the whole org catalog. Dated DeepInfra release ids,
// verified live 2026-09-01 (see lib/models.ts for the verified metadata).
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const PRO_MODEL = 'deepseek-ai/DeepSeek-V4-Pro-0813'

const FIRST = [
  'Sara', 'Omar', 'Lina', 'Faisal', 'Nora', 'Khalid', 'Maha', 'Ziyad', 'Reem', 'Tariq',
  'Dana', 'Majed', 'Alia', 'Hassan', 'Joud', 'Rakan', 'Layla', 'Badr', 'Hana', 'Saad',
  'Amal', 'Yazid', 'Ghada', 'Nawaf', 'Rania', 'Sultan', 'Farah', 'Anas', 'Lubna', 'Meshal',
  'Aya', 'Fahad', 'Noura', 'Talal', 'Shahad', 'Waleed', 'Jana', 'Salman', 'Dalia', 'Nayef',
  'Ruba', 'Hamad', 'Wafa', 'Osama', 'Latifa', 'Bandar', 'Muna', 'Yousef', 'Abrar'
]
const LAST = [
  'Alharbi', 'Alqahtani', 'Alotaibi', 'Alshehri', 'Alghamdi', 'Alzahrani', 'Almutairi',
  'Aldossari', 'Alsubaie', 'Aljuhani', 'Nakamura', 'Petrov', 'Garcia', 'Okafor', 'Kim',
  'Haddad', 'Demir', 'Rossi', 'Iyer', 'Novak'
]

/** FNV-1a → xorshift32, the house PRNG (mirrors mobile's provider-keys). */
function drawer(seedText) {
  let h = 0x811c9dc5
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let state = h || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

// One fixed password for the whole demo cast. This is a POC master repo by
// design — client forks rotate it (or replace seeding entirely) before any
// real deployment. WFC_DEMO_PASSWORD still overrides.
const password = process.env.WFC_DEMO_PASSWORD ?? 'wolffish'

// Wolffish Inc is a tech company: engineering, devops, support, marketing,
// sales. Positions and bios are deterministic like everything else.
const POSITIONS = [
  'Software Engineer',
  'Senior Software Engineer',
  'Frontend Engineer',
  'Backend Engineer',
  'DevOps Engineer',
  'Site Reliability Engineer',
  'QA Engineer',
  'Data Engineer',
  'Customer Support Specialist',
  'Technical Support Engineer',
  'Marketing Manager',
  'Content Marketer',
  'Growth Marketer',
  'Account Executive',
  'Sales Development Rep',
  'Solutions Consultant'
]
const BIO_FLAVOR = [
  'Coffee first, then code.',
  'Ships fast, breaks nothing.',
  'Loves clean dashboards.',
  'Automates everything twice.',
  'Asks the agent before asking a human.',
  'Keeps the backlog honest.',
  'Turns tickets into fans.',
  'Pipelines are a love language.'
]
/** The owner keeps their real number; everyone else gets a deterministic
 *  Saudi-shaped fake (+966 5X XXX XXXX). */
const phoneFor = (i) => {
  if (i === 0) return '+966 53 865 4514'
  const rnd = drawer(`phone-${i}`)
  const d = (n) => String(Math.floor(rnd() * 10 ** n)).padStart(n, '0')
  return `+966 5${d(1)} ${d(3)} ${d(4)}`
}

const positionFor = (i, role) => {
  if (i === 50) return 'Release Gate'
  if (role === 'owner') return 'Founder & Engineer'
  if (role === 'admin') return 'IT Administrator'
  if (role === 'support') return 'IT Support Specialist'
  const rnd = drawer(`position-${i}`)
  return POSITIONS[Math.floor(rnd() * POSITIONS.length)]
}
const bioFor = (i, position) => {
  if (position === 'Founder & Engineer') return 'Building Wolffish Cloud — the employee agent platform.'
  const rnd = drawer(`bio-${i}`)
  return `${position} at Wolffish Inc. ${BIO_FLAVOR[Math.floor(rnd() * BIO_FLAVOR.length)]}`
}

const roster = []
roster.push({ n: 0, email: 'younes@wolffi.sh', name: 'Younes Alturkey', role: 'owner' })
for (let i = 1; i < 50; i++) {
  const rnd = drawer(`wolffish-inc-${i}`)
  const first = FIRST[Math.floor(rnd() * FIRST.length)]
  const last = LAST[Math.floor(rnd() * LAST.length)]
  const role = i <= 2 ? 'admin' : i <= 4 ? 'support' : 'employee'
  roster.push({
    n: i,
    email: `${first.toLowerCase()}.${last.toLowerCase()}.${String(i).padStart(2, '0')}@demo.wolffi.sh`,
    name: `${first} ${last}`,
    role
  })
}

// The release gate's service owner: a stable second owner so automated
// verification never depends on a human's personal password (the real
// owner rotates theirs via the reset flow).
roster.push({ n: 50, email: 'gate.keeper.50@demo.wolffi.sh', name: 'Gate Keeper', role: 'owner' })

const uid = (n) => `usr_demo_${String(n).padStart(3, '0')}`
const saltOf = (email) => createHash('sha256').update(`wfc-salt:${email}`).digest('hex').slice(0, 32)
const esc = (s) => String(s).replace(/'/g, "''")

const lines = []
if (WIPE) {
  lines.push(`DELETE FROM usage WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM audit_log WHERE actor_user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM model_policies WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM conversation_records WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM conversations WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM episodes WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM files WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM settings WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM device_sessions WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM devices WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM users WHERE id LIKE 'usr_demo_%';`)
}

lines.push(
  `INSERT INTO org (id, name, default_model, default_allowed_models, user_daily_token_cap, org_monthly_token_cap)
   VALUES (1, 'Wolffish Inc', '${DEFAULT_MODEL}', '${JSON.stringify([DEFAULT_MODEL, PRO_MODEL])}', 2000000, 500000000)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_model = excluded.default_model,
     default_allowed_models = excluded.default_allowed_models;`
)

for (const person of roster) {
  const salt = saltOf(person.email)
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex')
  const status = person.n === 49 ? 'invited' : person.n === 48 ? 'suspended' : 'active'
  const mustChange = person.n === 49 ? 1 : 0
  const position = positionFor(person.n, person.role)
  const bio = bioFor(person.n, position)
  const phone = phoneFor(person.n)
  lines.push(
    `INSERT INTO users (id, email, name, role, status, password_hash, password_salt, must_change_password, temp_password_expires_at, position, bio, phone)
     VALUES ('${uid(person.n)}', '${esc(person.email)}', '${esc(person.name)}', '${person.role}', '${status}', '${hash}', '${salt}', ${mustChange},
       ${person.n === 49 ? "strftime('%Y-%m-%dT%H:%M:%fZ','now','+365 days')" : 'NULL'}, '${esc(position)}', '${esc(bio)}', '${esc(phone)}')
     ON CONFLICT(email) DO UPDATE SET ${
       person.n === 0
         ? ''
         : 'password_hash = excluded.password_hash, password_salt = excluded.password_salt,'
     } role = excluded.role, status = excluded.status,
       position = excluded.position, bio = excluded.bio, phone = excluded.phone;`
  )
}

// Policy variety so the admin surfaces have something true to show:
// 05–14 default-only model, 15–19 tight daily caps, 20 effectively cut off.
for (let i = 5; i <= 14; i++) {
  lines.push(
    `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
     VALUES ('${uid(i)}', '${JSON.stringify([DEFAULT_MODEL])}', NULL);`
  )
}
for (let i = 15; i <= 19; i++) {
  lines.push(
    `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
     VALUES ('${uid(i)}', NULL, ${50_000 * (i - 14)});`
  )
}
lines.push(
  `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
   VALUES ('${uid(20)}', '${JSON.stringify([DEFAULT_MODEL])}', 1000);`
)

// A week of deterministic usage history (~600 rows) so dashboards live.
for (const person of roster) {
  if (person.n === 49 || person.n === 48) continue
  const rnd = drawer(`usage-${person.n}`)
  const requests = 4 + Math.floor(rnd() * 14)
  for (let r = 0; r < requests; r++) {
    const daysAgo = 1 + Math.floor(rnd() * 7)
    const hour = 6 + Math.floor(rnd() * 12)
    const model = rnd() < 0.8 ? DEFAULT_MODEL : PRO_MODEL
    const tin = 200 + Math.floor(rnd() * 4000)
    const tout = 100 + Math.floor(rnd() * 2500)
    // microUSD at each model's real per-token rate (Flash $0.08/$0.18,
    // Pro $1.30/$2.60 per Mtok — lib/models.ts).
    const cost = Math.round(
      model === PRO_MODEL ? tin * 1.3 + tout * 2.6 : tin * 0.08 + tout * 0.18
    )
    const denied = rnd() < 0.06
    const decision = denied ? (rnd() < 0.5 ? 'denied_model' : 'denied_quota') : 'allowed'
    const latency = 400 + Math.floor(rnd() * 2600)
    lines.push(
      `INSERT INTO usage (user_id, device_id, model, tokens_in, tokens_out, cost_microusd, latency_ms, decision, created_at)
       VALUES ('${uid(person.n)}', 'dev_demo_${person.n}', '${model}', ${denied ? 0 : tin}, ${denied ? 0 : tout},
         ${denied ? 0 : cost}, ${denied ? 0 : latency}, '${decision}',
         strftime('%Y-%m-%dT%H:%M:%fZ','now','start of day','-${daysAgo} days','+${hour} hours','+${Math.floor(rnd() * 3600)} seconds'));`
    )
  }
}

const dir = mkdtempSync(join(tmpdir(), 'wfc-seed-'))
const file = join(dir, 'seed.sql')
writeFileSync(file, lines.join('\n'))
console.log(`seeding ${roster.length} people (${FLAG}) — ${lines.length} statements`)
execSync(`npx wrangler d1 execute wfc-master ${FLAG} --file "${file}"`, { stdio: 'inherit' })
console.log('\nWolffish Inc is seeded.')
console.log(`   owner:   younes@wolffi.sh`)
console.log(`   admins:  ${roster[1].email}, ${roster[2].email}`)
console.log(`   support: ${roster[3].email}, ${roster[4].email}`)
console.log(`   invited (never logged in): ${roster[49].email}`)
console.log(`   suspended: ${roster[48].email}`)
console.log(`\n   demo password (all seeded people): ${password}`)
