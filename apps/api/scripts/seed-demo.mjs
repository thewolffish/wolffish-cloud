#!/usr/bin/env node
/**
 * Seed "Wolffish Inc" — the 50-employee demo org. Same posture as the
 * mobile app's demo data: real-shaped, deterministically minted, fake.
 *
 *   node scripts/seed-demo.mjs [--remote] [--wipe]
 *
 * Deterministic: user ids, emails, names, roles, salts, policies and the
 * 7-day usage history are pure functions of the roster — reseeding
 * produces identical rows.
 *
 * The people are named. A written-down cast of fifty Saudi names, each at
 * `first.last@wolffi.sh`, because an org whose staff read as fixtures makes
 * every surface built on top of them read as one too. What marks a row as
 * seeded is its id (`usr_demo_NNN`) — the thing --wipe and the sweeps below
 * already match on, and the only place that job belongs.
 *
 * The password is one fixed string for the whole cast (WFC_DEMO_PASSWORD
 * overrides it) — a deliberate POC-master choice, see USERS.md. A fork
 * rotates it, or deletes this file and its rows (--wipe).
 *
 * Cast: 2 owners (000 human, 050 the release gate) + 2 admins + 2 support
 * + 45 employees = 51.
 * 049 stays 'invited' forever — the live demo of the invite flow.
 * 048 is suspended — the live demo of suspension.
 */
import { execSync } from 'node:child_process'
import { pbkdf2Sync, randomBytes, createHash } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REMOTE = process.argv.includes('--remote')
const WIPE = process.argv.includes('--wipe')
const FLAG = REMOTE ? '--remote' : '--local'

// The org catalog. DeepInfra ids; see lib/models.ts for the verified
// metadata behind each one.
//
// Flash and Pro are the BASELINE: org.default_allowed_models, what anyone
// without a policy row gets — the two-model catalog the release gate
// asserts for a brand-new account. Since 2026-09-11 Flash is V4.1, which
// sees, so image input needs no per-user grant any more: the vision pilot
// (021–030 on the experimental Flash-Vision-Exp) is gone with the model.
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'
const PRO_MODEL = 'deepseek-ai/DeepSeek-V4-Pro-0813'

/**
 * Everything the org has. Both owners (000 human, 050 release gate) and
 * both admins hold it by an explicit row — an owner locked out of a model
 * the org runs cannot administer it — which is also the same list as the
 * baseline today; the row is the shape, kept for the day the catalog grows.
 */
const FULL_CATALOG = [DEFAULT_MODEL, PRO_MODEL]

/**
 * The cast, written down rather than drawn from two pools. Fifty Saudi
 * names, every `first last` pair distinct — which is what lets the address
 * below be `first.last@wolffi.sh` with no index glued on to keep it unique.
 * Surnames repeat the way they do in a real Riyadh office (three Alharbis,
 * two Alotaibis) but never twice under the same first name.
 *
 * Order is the roster order: 01-02 administer, 03-04 support, 05-49 are
 * staff, and 50 is the release gate's service owner — a person's name like
 * everyone else, with the job it actually does named in `position`.
 */
const CAST = [
  ['Shahad', 'Alotaibi'],
  ['Abdulaziz', 'Alqahtani'],
  ['Saad', 'Alharbi'],
  ['Alia', 'Alghamdi'],
  ['Hamad', 'Alshehri'],
  ['Amal', 'Alzahrani'],
  ['Sara', 'Almutairi'],
  ['Faisal', 'Aldossari'],
  ['Lina', 'Alsubaie'],
  ['Khalid', 'Aljuhani'],
  ['Bandar', 'Alanazi'],
  ['Yousef', 'Alshammari'],
  ['Lubna', 'Alrashidi'],
  ['Waleed', 'Albalawi'],
  ['Noura', 'Alamri'],
  ['Turki', 'Almalki'],
  ['Reem', 'Alyami'],
  ['Saad', 'Alharthi'],
  ['Sultan', 'Alqurashi'],
  ['Ziyad', 'Alhazmi'],
  ['Maha', 'Alruwaili'],
  ['Anas', 'Alenezi'],
  ['Dana', 'Alturki'],
  ['Meshal', 'Altamimi'],
  ['Shahad', 'Alharbi'],
  ['Salman', 'Alrajhi'],
  ['Osama', 'Alqahtani'],
  ['Nawaf', 'Alotaibi'],
  ['Jana', 'Alnasser'],
  ['Norah', 'Alghamdi'],
  ['Rakan', 'Alrasheed'],
  ['Joud', 'Aldakhil'],
  ['Ghada', 'Alzamil'],
  ['Abdullah', 'Alolayan'],
  ['Layla', 'Alsuwailem'],
  ['Fahad', 'Almutairi'],
  ['Wafa', 'Alhamdan'],
  ['Majed', 'Alsudairi'],
  ['Rania', 'Albishi'],
  ['Yazeed', 'Aloraini'],
  ['Farah', 'Alhussain'],
  ['Tariq', 'Alsahli'],
  ['Hana', 'Alfaraj'],
  ['Badr', 'Aldawood'],
  ['Latifa', 'Alshaya'],
  ['Mohammed', 'Alharbi'],
  ['Abrar', 'Almogbel'],
  ['Talal', 'Alkhathlan'],
  ['Ruba', 'Alsanea'],
  ['Nasser', 'Alowais']
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
CAST.forEach(([first, last], idx) => {
  const n = idx + 1
  const role = n <= 2 ? 'admin' : n <= 4 ? 'support' : n === 50 ? 'owner' : 'employee'
  roster.push({
    n,
    // The address a real employer would mint: given name, family name, the
    // company's own domain. Nothing in it says "seed" — the demo rows are
    // told apart by their `usr_demo_*` ids, which is where that belongs.
    email: `${first}.${last}@wolffi.sh`.toLowerCase(),
    name: `${first} ${last}`,
    role
  })
})

// `users.email` is UNIQUE: a duplicated pair in CAST would not be a slightly
// wrong roster, it would be a seed that dies halfway through with the org
// row written and half the people missing. Catch it here, by name, before a
// single statement is sent.
const dupes = roster.map((p) => p.email).filter((e, i, all) => all.indexOf(e) !== i)
if (dupes.length > 0) {
  console.error(`duplicate seeded address: ${[...new Set(dupes)].join(', ')}`)
  process.exit(1)
}
if (roster.length !== 51) {
  console.error(`roster is ${roster.length}, expected 51 (1 human owner + 50 cast)`)
  process.exit(1)
}

/** The release gate's own account — every script that signs in as the
 *  service owner reads this address out of USERS.md, so print it below. */
const GATE = roster[50]

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

// No seeded account ships with a phone attached, and no account keeps a
// phone it is not actually holding.
//
// Pairing is something a person does — the QR is two taps — and a demo that
// arrives already paired to a handset nobody owns teaches the wrong thing and
// hides the one control worth trying. The release gate pairs and unpairs real
// phones on its own account every run, too, and leaves rows behind; this is
// the sweep for both. Runs on every seed, not only a wipe: the invariant is
// "no fake phones", not "no fake phones once".
//
// The condition is "holds no live session" rather than "is not the human
// owner". The old carve-out exempted 000 whole, to protect the one real
// phone on the roster — and so that account quietly collected the others:
// a device row still marked active whose sessions had all expired months
// ago sits in the admin's device list as a SECOND handset, on the one
// account where a second handset looks plausible. Only one phone may be
// paired at a time (the desktop's Mobile panel withdraws the pairing
// control the moment one is listed, `SINGLE_PHONE`), so a row nobody is
// signed in on is not a phone — it is a ghost of one, and it goes. The
// phone someone is genuinely using has a live session and survives this
// on every account, 000's included.
const LIVE_SESSION = `SELECT device_id FROM device_sessions
     WHERE revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
const NO_SEEDED_PHONES = `platform = 'mobile' AND user_id LIKE 'usr_demo_%'
   AND id NOT IN (${LIVE_SESSION})`
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

// The id is the key an upsert has to aim at, not the email. Ids are fixed
// (`usr_demo_NNN`) while an address can be rewritten — the move to
// `first.last@wolffi.sh` rewrote all fifty — and an ON CONFLICT(email) that
// misses lands on the primary key instead, where nothing handles it: the
// seed would die on its first person with the org row already written.
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
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email, name = excluded.name,
       password_hash = excluded.password_hash, password_salt = excluded.password_salt,
       role = excluded.role, status = excluded.status,
       position = excluded.position, bio = excluded.bio, phone = excluded.phone;`
  )
}

// Policy variety so the admin surfaces have something true to show, and so
// the model picker is not the same list on every account:
//   000, 050, 001, 002  full catalog (both owners, both admins)
//   005–014            locked to the default model alone
//   015–030            no row at all — the org baseline, explicitly cleared
//                      (021–030 were the vision pilot until 2026-09-11)
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
for (let i = 15; i <= 30; i++) {
  lines.push(`DELETE FROM model_policies WHERE user_id = '${uid(i)}';`)
}

// microUSD per token at each model's real rate — lib/models.ts (V4.1 Flash
// $0.20/$0.60, Pro $1.30/$2.60, both what DeepInfra actually bills).
const RATES = {
  [DEFAULT_MODEL]: { in: 0.2, out: 0.6 },
  [PRO_MODEL]: { in: 1.3, out: 2.6 }
}

/**
 * The models this person could actually have spent on, in the same bands
 * the policy rows above set. History that names a model its owner is
 * forbidden is history the admin surfaces would have to explain.
 */
function spendableBy(n) {
  if (n >= 5 && n <= 14) return [DEFAULT_MODEL]
  return FULL_CATALOG
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
console.log(`   release gate (service owner, 050): ${GATE.email}`)
console.log(`   catalog: ${FULL_CATALOG.map((m) => m.split('/').pop()).join(' + ')} (Flash sees; no vision grant needed)`)
console.log(`\n   demo password (all seeded people): ${password}`)
