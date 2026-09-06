/**
 * Authorization, as one table you can read.
 *
 * It used to be three mechanisms scattered through routes/admin.ts: a
 * route-group `requireRole`, a method-level `requireAdmin`, six ad-hoc
 * `if (auth.role === 'support')` lines, and an `ownerGuard` helper called at
 * nine sites. Correct at four roles — and there was no way to answer "what
 * may support actually do?" other than reading a thousand-line file, and no
 * way to add a fifth role without visiting every handler.
 *
 * Every rule now lives in ACTIONS. A handler asks `can(...)` and the answer
 * comes from one place, which means the policy can be reviewed, tested, and
 * — when a fork needs "a team lead sees their own team" — extended in a
 * table instead of in twenty conditionals.
 *
 * Two axes, because the real rules have two:
 *
 *   tier      the minimum standing to attempt the action at all.
 *   ownerSafe whether it may be aimed at an OWNER by someone who is not one.
 *             False for everything that reads or changes a person, so
 *             "only an owner may act on an owner" is stated once rather
 *             than remembered nine times.
 */

export type Role = 'owner' | 'admin' | 'support' | 'employee'

/** Standing, ordered. Everything above a tier also satisfies it. */
const RANK: Record<Role, number> = { employee: 0, support: 1, admin: 2, owner: 3 }

export type Action =
  // People
  | 'user.list'
  | 'user.read'
  | 'user.invite'
  | 'user.update'
  | 'user.reset_password'
  | 'user.read_reset_code'
  | 'user.revoke_sessions'
  | 'user.clear_pin'
  // Governance
  | 'policy.write'
  | 'org.read'
  | 'org.write'
  | 'maintenance.run'
  // The sensitive reads: an employee's settings blob carries their
  // integration credentials, and their conversations are the company's
  // actual words. Support is the view-only tier for OPERATIONS, not a
  // licence to read either.
  | 'config.read'
  | 'config.write'
  | 'conversation.read'
  // Reporting
  | 'usage.read'
  | 'audit.read'
  | 'gates.read'
  // Capabilities
  | 'capability.read'
  | 'capability.write'

type Rule = {
  tier: Role
  /** May a non-owner aim this at an owner? Defaults to false when the
   *  action takes a target at all. */
  ownerSafe?: boolean
}

export const ACTIONS: Record<Action, Rule> = {
  'user.list': { tier: 'support', ownerSafe: true },
  'user.read': { tier: 'support', ownerSafe: true },
  'user.invite': { tier: 'admin' },
  'user.update': { tier: 'admin' },
  'user.reset_password': { tier: 'admin' },
  'user.read_reset_code': { tier: 'admin' },
  'user.revoke_sessions': { tier: 'admin' },
  'user.clear_pin': { tier: 'admin' },

  'policy.write': { tier: 'admin' },
  'org.read': { tier: 'support', ownerSafe: true },
  'org.write': { tier: 'admin', ownerSafe: true },
  'maintenance.run': { tier: 'admin', ownerSafe: true },

  'config.read': { tier: 'admin' },
  'config.write': { tier: 'admin' },
  'conversation.read': { tier: 'admin' },

  'usage.read': { tier: 'support', ownerSafe: true },
  'audit.read': { tier: 'support', ownerSafe: true },
  'gates.read': { tier: 'support', ownerSafe: true },

  'capability.read': { tier: 'support', ownerSafe: true },
  'capability.write': { tier: 'admin', ownerSafe: true }
}

export type Actor = { id: string; role: Role }
/** The person being acted on, when there is one. */
export type Target = { id: string; role: Role } | null

export type Denial = { ok: false; reason: 'forbidden'; detail: string }
export type Decision = { ok: true } | Denial

/**
 * The whole rule set, applied. Callers hand the target's ROLE rather than
 * just an id, so this stays synchronous and testable; routes/admin.ts loads
 * the target row once and passes it in.
 */
export function can(actor: Actor, action: Action, target: Target = null): Decision {
  const rule = ACTIONS[action]
  if (!rule) return { ok: false, reason: 'forbidden', detail: 'unknown action' }
  if (RANK[actor.role] < RANK[rule.tier]) {
    return {
      ok: false,
      reason: 'forbidden',
      detail:
        rule.tier === 'admin' && actor.role === 'support'
          ? `support cannot ${action.replace('.', ' ')}`
          : 'insufficient role'
    }
  }
  if (target && rule.ownerSafe !== true && target.role === 'owner' && actor.role !== 'owner') {
    return { ok: false, reason: 'forbidden', detail: 'only an owner can act on an owner' }
  }
  return { ok: true }
}

/**
 * Minting or promoting to a role is bounded by the actor's own: only an
 * owner makes an owner. Separate from `can` because the constraint is on
 * the role being ASSIGNED, not on the person being changed.
 */
export function canAssignRole(actor: Actor, role: Role): boolean {
  return role !== 'owner' || actor.role === 'owner'
}

/**
 * Changing your own role or status is refused for everyone, owner included
 * — the last owner demoting themselves leaves an org nobody can administer.
 */
export function isSelfPrivilegeChange(
  actor: Actor,
  targetId: string,
  patch: { role?: unknown; status?: unknown }
): boolean {
  return actor.id === targetId && (patch.role !== undefined || patch.status !== undefined)
}
