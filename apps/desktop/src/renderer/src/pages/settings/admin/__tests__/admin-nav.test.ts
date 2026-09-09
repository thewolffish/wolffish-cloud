/**
 * The admin screen's Back, as a stack.
 *
 *   npx tsx --tsconfig tsconfig.node.json \
 *     src/renderer/src/pages/settings/admin/__tests__/admin-nav.test.ts
 *
 * The bug this guards: Back from a person or a transcript used to leave
 * admin for chat. Now it pops one page, and only the root leaves.
 */
import { ROOT_VIEW, popView, pushView, type AdminView } from '../adminNav'

let failures = 0
const check = (name: string, cond: unknown, extra = ''): void => {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}
const top = (s: readonly AdminView[]): AdminView => s[s.length - 1]!

// Grid → person → conversation, then Back three times.
let s: AdminView[] = [ROOT_VIEW]
s = pushView(s, { kind: 'user', userId: 'u1' })
s = pushView(s, { kind: 'conversation', userId: 'u1', conversationId: 'c1', title: 'T' })
check('drill is three deep', s.length === 3)

let back = popView(s)
const person = back === null ? null : top(back)
check('Back from conversation lands on the person', person?.kind === 'user')
check('and on the SAME person', person?.kind === 'user' && person.userId === 'u1')

back = popView(back!)
check('Back from person lands on the people grid', back !== null && top(back).kind === 'people')

check('Back at the root is the exit, not a pop', popView(back!) === null)

// Tabs: Organization is a page, so Back from it returns to People — not chat.
s = pushView([ROOT_VIEW], { kind: 'org' })
check('a tab switch is a push', s.length === 2 && top(s).kind === 'org')
back = popView(s)
check('Back from Organization returns to People', back !== null && top(back).kind === 'people')

// Log → Organization → Back → Log: the previous PAGE, not always People.
s = pushView(pushView([ROOT_VIEW], { kind: 'audit' }), { kind: 'org' })
back = popView(s)
check(
  'Back returns to the section the admin came from',
  back !== null && top(back).kind === 'audit'
)

// Pressing the tab already showing must not stack a page on itself.
s = pushView(pushView([ROOT_VIEW], { kind: 'org' }), { kind: 'org' })
check('re-pressing the current tab pushes nothing', s.length === 2)
s = pushView([ROOT_VIEW], { kind: 'people' })
check('re-pressing People at the root pushes nothing', s.length === 1)

// Same person twice in a row is one entry; a different person is another.
s = pushView(pushView([ROOT_VIEW], { kind: 'user', userId: 'u1' }), { kind: 'user', userId: 'u1' })
check('the same person twice is one page', s.length === 2)
s = pushView(s, { kind: 'user', userId: 'u2' })
check('a different person is another page', s.length === 3)

// The stack is never mutated in place.
const before: AdminView[] = [ROOT_VIEW]
pushView(before, { kind: 'org' })
check('push leaves the old stack alone', before.length === 1)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
