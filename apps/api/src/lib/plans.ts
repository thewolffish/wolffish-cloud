/**
 * Token plans — the three ceilings an admin assigns per employee.
 *
 * These are the numbers on the pricing sheet, and they are the reason the
 * product can quote a fixed cost per seat: the ceiling is a HARD CAP the
 * router enforces, not a spend alert that arrives after the money is gone.
 * A plan is a monthly ceiling on input and output tokens SEPARATELY,
 * because the two differ by 2x in price and by an order of magnitude in
 * volume — one combined number would either strangle input (which is mostly
 * cached prefix, and nearly free) or leave output unbounded (which is not).
 *
 *   standard   100M in /  8M out — the default; every employee starts here
 *   high       300M in / 25M out — for people whose day is agent work
 *   unmetered  no ceiling         — alerting only; the org eats what it eats
 *
 * Ceilings live here rather than in D1 so changing one is a deploy, not a
 * backfill of every row: model_policies stores only the plan NAME.
 *
 * Enforcement is in ModelGate (durable counters, per user per UTC month);
 * `unmetered` passes caps of 0, which the gate reads as unlimited — the same
 * path an org that has switched every cap off already takes.
 */

export const TOKEN_PLANS = ['standard', 'high', 'unmetered'] as const
export type TokenPlan = (typeof TOKEN_PLANS)[number]

export const DEFAULT_TOKEN_PLAN: TokenPlan = 'standard'

export type PlanCeilings = {
  /** Input tokens per UTC month. 0 = unlimited. */
  monthlyIn: number
  /** Output tokens per UTC month. 0 = unlimited. */
  monthlyOut: number
}

export const PLAN_CEILINGS: Record<TokenPlan, PlanCeilings> = {
  standard: { monthlyIn: 100_000_000, monthlyOut: 8_000_000 },
  high: { monthlyIn: 300_000_000, monthlyOut: 25_000_000 },
  unmetered: { monthlyIn: 0, monthlyOut: 0 }
}

/** A stored value from any source (D1 column, cached policy, wire body). */
export function normalizePlan(value: unknown): TokenPlan {
  return TOKEN_PLANS.includes(value as TokenPlan) ? (value as TokenPlan) : DEFAULT_TOKEN_PLAN
}

export function ceilingsFor(plan: TokenPlan): PlanCeilings {
  return PLAN_CEILINGS[plan] ?? PLAN_CEILINGS[DEFAULT_TOKEN_PLAN]
}

/**
 * The surfaces a call can come from. The client names one in the
 * `x-wfc-surface` header; anything unrecognised (an older build, a script,
 * a hand-rolled request) records as '' rather than being rejected — the
 * router must never fail a call over an attribution label.
 */
export const SURFACES = ['inapp', 'mobile', 'extension', 'heartbeat', 'procedure', 'api'] as const
export type Surface = (typeof SURFACES)[number]

export function normalizeSurface(value: unknown): Surface | '' {
  return SURFACES.includes(value as Surface) ? (value as Surface) : ''
}
