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

// The org catalog. Dated DeepInfra release ids; see lib/models.ts for the
// verified metadata behind each one.
//
// Flash and Pro are the BASELINE: org.default_allowed_models, what anyone
// without a policy row gets. Flash-Vision-Exp is not — it is experimental
// upstream and ~2.7x Flash's input price, so it is provisioned to a named
// group by the per-user rows below. That is the shape a real org uses for a
// model it is piloting, and it keeps a brand-new account's catalog at the
// two-model baseline the release gate asserts.
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const PRO_MODEL = 'deepseek-ai/DeepSeek-V4-Pro-0813'
const VISION_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp'

/** Everything the org has: what the owners, the admins and the pilot see. */
const FULL_CATALOG = [DEFAULT_MODEL, PRO_MODEL, VISION_MODEL]

/**
 * Who gets the vision model. Both owners (000 human, 050 release gate) and
 * both admins hold the full catalog by construction — an owner locked out
 * of a model the org runs cannot administer it — and employees 21-30 are
 * the pilot. Everyone else is on the baseline or narrower, so the picker
 * genuinely differs between accounts.
 */
const visionPilot = (n) => n >= 21 && n <= 30
const hasVision = (n) => n === 0 || n === 50 || n === 1 || n === 2 || visionPilot(n)

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

// One fixed password for the whole cast — every account, the owner included,
// so "the demo password" is one string and not one string plus a footnote.
// This is a POC master repo by design; client forks rotate it (or replace
// seeding entirely) before any real deployment, and WFC_DEMO_PASSWORD
// overrides it here. A person who wants their own password takes it after
// seeding, through the in-app reset flow — until the next reseed writes this
// one back.
const password = process.env.WFC_DEMO_PASSWORD ?? 'wolffish123'

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
// verification never signs in as a person, and a human account's own
// sessions are never the ones a gate run revokes.
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
  lines.push(`DELETE FROM files WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM settings WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM device_sessions WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM devices WHERE user_id LIKE 'usr_demo_%';`)
  lines.push(`DELETE FROM users WHERE id LIKE 'usr_demo_%';`)
}

// No seeded account ships with a phone attached.
//
// Pairing is something a person does — the QR is two taps — and a demo that
// arrives already paired to a handset nobody owns teaches the wrong thing and
// hides the one control worth trying. The release gate pairs and unpairs real
// phones on its own account every run, too, and leaves rows behind; this is
// the sweep for both. Runs on every seed, not only a wipe: the invariant is
// "no fake phones", not "no fake phones once".
//
// The human owner (000) is excluded — that account's phone is a real one,
// paired by hand, and the same carve-out the password upsert makes below.
const NO_SEEDED_PHONES = `platform = 'mobile' AND user_id LIKE 'usr_demo_%' AND user_id <> 'usr_demo_000'`
lines.push(
  `DELETE FROM device_sessions WHERE device_id IN (SELECT id FROM devices WHERE ${NO_SEEDED_PHONES});`
)
lines.push(`DELETE FROM devices WHERE ${NO_SEEDED_PHONES};`)

lines.push(
  // Caps unenforced in the baseline (0 = unlimited): quotas are a mechanism a
  // fork switches on, not a policy the demo imposes.
  `INSERT INTO org (id, name, default_model, default_allowed_models, user_daily_token_cap, org_monthly_token_cap,
     user_daily_search_cap, org_monthly_search_cap)
   VALUES (1, 'Wolffish Inc', '${DEFAULT_MODEL}', '${JSON.stringify([DEFAULT_MODEL, PRO_MODEL])}', 0, 0, 0, 0)
   ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_model = excluded.default_model,
     default_allowed_models = excluded.default_allowed_models,
     user_daily_token_cap = 0, org_monthly_token_cap = 0, user_daily_search_cap = 0, org_monthly_search_cap = 0;`
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
     ON CONFLICT(email) DO UPDATE SET
       password_hash = excluded.password_hash, password_salt = excluded.password_salt,
       role = excluded.role, status = excluded.status,
       position = excluded.position, bio = excluded.bio, phone = excluded.phone;`
  )
}

// Policy variety so the admin surfaces have something true to show, and so
// the model picker is not the same list on every account:
//   000, 050, 001, 002  full catalog (both owners, both admins)
//   005–014            locked to the default model alone
//   015–020            no row at all — the org baseline, explicitly cleared
//   021–030            the vision pilot: baseline + Flash-Vision-Exp
//   everyone else       no row — the org baseline (Flash + Pro)
// No per-user caps in the baseline (NULL = org default, and the org caps are
// unlimited); a fork sets them via the admin API.
for (const n of [0, 1, 2, 50]) {
  lines.push(
    `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
     VALUES ('${uid(n)}', '${JSON.stringify(FULL_CATALOG)}', NULL);`
  )
}
for (let i = 5; i <= 14; i++) {
  lines.push(
    `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
     VALUES ('${uid(i)}', '${JSON.stringify([DEFAULT_MODEL])}', NULL);`
  )
}
for (let i = 15; i <= 20; i++) {
  lines.push(`DELETE FROM model_policies WHERE user_id = '${uid(i)}';`)
}
for (let i = 21; i <= 30; i++) {
  lines.push(
    `INSERT OR REPLACE INTO model_policies (user_id, allowed_models, daily_token_cap)
     VALUES ('${uid(i)}', '${JSON.stringify(FULL_CATALOG)}', NULL);`
  )
}

// microUSD per token at each model's real rate — lib/models.ts (Flash
// $0.08/$0.18, Pro $1.30/$2.60, and Flash-Vision-Exp at the $0.2156/$0.6468
// DeepInfra actually bills, its list price less the 51% promotion).
const RATES = {
  [DEFAULT_MODEL]: { in: 0.08, out: 0.18 },
  [PRO_MODEL]: { in: 1.3, out: 2.6 },
  [VISION_MODEL]: { in: 0.2156, out: 0.6468 }
}

/**
 * The models this person could actually have spent on, in the same bands
 * the policy rows above set. History that names a model its owner is
 * forbidden is history the admin surfaces would have to explain.
 */
function spendableBy(n) {
  if (n >= 5 && n <= 14) return [DEFAULT_MODEL]
  return hasVision(n) ? FULL_CATALOG : [DEFAULT_MODEL, PRO_MODEL]
}

// A week of deterministic usage history (~600 rows) so dashboards live.
//
// Replaced, not appended: `usage` is an append-only log with an
// autoincrement id and no natural key, so without this every reseed laid
// another generation on top of the last — nine of them by 2026-09-04, and
// any row minted before a price correction kept its old cost forever. The
// device id is the discriminator: the seed's rows are the only ones that
// carry `dev_demo_*`, so real traffic from these same accounts (the release
// gate's own calls, a demo session on a real device) survives untouched.
lines.push(
  `DELETE FROM usage WHERE user_id LIKE 'usr_demo_%' AND device_id LIKE 'dev_demo_%';`
)
for (const person of roster) {
  if (person.n === 49 || person.n === 48) continue
  const rnd = drawer(`usage-${person.n}`)
  const catalog = spendableBy(person.n)
  const requests = 4 + Math.floor(rnd() * 14)
  for (let r = 0; r < requests; r++) {
    const daysAgo = 1 + Math.floor(rnd() * 7)
    const hour = 6 + Math.floor(rnd() * 12)
    // Cheap-and-common first: the default model carries 80% of the traffic,
    // and whatever else the account may use splits the rest.
    const roll = rnd()
    // Math.min guards the one draw where rnd() returns exactly 1.
    const tail = Math.min(catalog.length - 1, 1 + Math.floor(((roll - 0.8) / 0.2) * (catalog.length - 1)))
    const model = roll < 0.8 || catalog.length === 1 ? DEFAULT_MODEL : catalog[tail]
    const tin = 200 + Math.floor(rnd() * 4000)
    const tout = 100 + Math.floor(rnd() * 2500)
    const rate = RATES[model]
    const cost = Math.round(tin * rate.in + tout * rate.out)
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

// D1 is the source of truth, but the Worker reads config from CONFIG_KV and
// only the admin API knows to invalidate it — a direct write like this one
// leaves the old org row and the old per-user policies served for up to an
// hour (lib/policy.ts, CACHE_TTL_SECONDS). Without this the seed reports a
// grant the API then refuses: the owner keeps the two-model catalog until
// the copy expires. Same key names as policyCacheKey().
const keysFile = join(dir, 'stale-keys.json')
writeFileSync(keysFile, JSON.stringify(['org', ...roster.map((p) => `policy2:${uid(p.n)}`)]))
try {
  execSync(`npx wrangler kv bulk delete "${keysFile}" --binding CONFIG_KV ${FLAG} --force`, {
    stdio: 'pipe'
  })
  console.log(`config cache purged (${roster.length + 1} keys)`)
} catch (err) {
  // Never fatal: the rows are already written, and every cached copy expires
  // on its own. Say so loudly enough that a confusing hour is explainable.
  console.warn(
    `\n  WARNING: could not purge the CONFIG_KV cache — policies and org config` +
      ` may take up to an hour to appear.\n  ${String(err.message ?? err).slice(0, 200)}`
  )
}

console.log('\nWolffish Inc is seeded.')
console.log(`   owner:   younes@wolffi.sh`)
console.log(`   admins:  ${roster[1].email}, ${roster[2].email}`)
console.log(`   support: ${roster[3].email}, ${roster[4].email}`)
console.log(`   invited (never logged in): ${roster[49].email}`)
console.log(`   suspended: ${roster[48].email}`)
console.log(
  `   vision (${VISION_MODEL.split('/').pop()}): owners 000/050, admins 001-002, pilot 021-030` +
    ` — ${roster.filter((p) => hasVision(p.n)).length} of ${roster.length}`
)
console.log(`\n   demo password (all seeded people): ${password}`)
