/**
 * Where the admin screen is, as a history — the pure part.
 *
 * The screen has one "Back", and it used to mean one thing: leave admin for
 * chat. That was right on the landing grid and wrong everywhere else: an
 * admin three levels deep in a transcript pressed the only Back in sight
 * and landed in chat, with the person and the conversation gone. So the
 * screen now keeps the pages it has been on, and Back pops one. Only the
 * root has nowhere further back, and only there does Back leave.
 *
 * The three sections (People, Organization, Log) are pages too, not just a
 * highlight: switching a tab pushes, so Back from Organization returns to
 * whichever section the admin came from — the "primary admin layer" — not
 * to chat. A repeat press of the tab already showing pushes nothing, so
 * the stack never fills with a page on top of itself.
 *
 * Kept free of React so it can be tested by running it.
 */

export type AdminView =
  | { kind: 'people' }
  | { kind: 'org' }
  | { kind: 'audit' }
  | { kind: 'user'; userId: string }
  | { kind: 'conversation'; userId: string; conversationId: string; title: string }

/** The tab strip's entries, in the order they are drawn. */
export const ADMIN_SECTIONS = ['people', 'org', 'audit'] as const
export type AdminSection = (typeof ADMIN_SECTIONS)[number]

export const ROOT_VIEW: AdminView = { kind: 'people' }

export function isSection(view: AdminView): view is { kind: AdminSection } {
  return view.kind === 'people' || view.kind === 'org' || view.kind === 'audit'
}

export function sameView(a: AdminView, b: AdminView): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'user':
      return a.userId === (b as typeof a).userId
    case 'conversation':
      return (
        a.userId === (b as typeof a).userId && a.conversationId === (b as typeof a).conversationId
      )
    default:
      return true
  }
}

/** The page on screen is the top of the stack; the stack is never empty. */
export function pushView(stack: readonly AdminView[], next: AdminView): AdminView[] {
  const top = stack[stack.length - 1]
  if (top && sameView(top, next)) return [...stack]
  return [...stack, next]
}

/**
 * One step back. Returns null at the root — the caller decides what leaving
 * means (for the screen, going to chat); this module only knows the stack.
 */
export function popView(stack: readonly AdminView[]): AdminView[] | null {
  if (stack.length <= 1) return null
  return stack.slice(0, -1)
}
