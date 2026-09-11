/**
 * Reasoning capability registry.
 *
 * Sibling to `vision.ts`: a pure, dependency-free module of model
 * predicates that BOTH the main process (the cloud provider's request
 * builder) and the renderer (the brain button) import. It declares, per
 * model of the one lane, the ordered set of reasoning modes the org router
 * actually honours, and translates the single canonical scale into the
 * request parameter.
 *
 * Canonical scale (ordered, the brain button cycles in this order):
 *   ['off', 'high', 'max']  effort models   (off / high effort / max effort)
 *   ['off', 'high']         coarse effort   (off / on, no distinct max)
 *   ['off', 'on']           binary toggle   (off / on, no effort levels)
 *   ['on', 'high']          always-on effort (cannot be disabled; low/high knob)
 *   ['on']                  always-on       (cannot be disabled; UI shows it locked)
 *   []                      unsupported     (no reasoning at all)
 *
 * Keep this file free of node/electron imports — it is bundled into the
 * renderer through the `@main` alias.
 */

export type ReasoningMode = 'off' | 'on' | 'high' | 'max'

/**
 * The ordered reasoning modes a given provider+model honours. `provider` is
 * always 'cloud' in this build; the parameter stays so a second lane is a new
 * case, not a new signature.
 */
export function reasoningModesFor(provider: string, model: string): ReasoningMode[] {
  const m = model.toLowerCase()
  switch (provider) {
    // ── Wolffish Cloud (org API → DeepInfra) ───────────────────────────
    // The one real lane in this build. Catalog is the frontier DeepSeek V4
    // pair (V4.1-Flash / Pro-0813). Verified live 2026-09-01 (and V4.1 Flash
    // on 2026-09-11) through api.wolffi.sh: top-level `reasoning_effort` is honoured with a
    // genuinely validated enum (none|minimal|low|medium|high|xhigh|max —
    // 'banana' 400s), 'none' produces zero reasoning, higher rungs stream
    // `reasoning_content` deltas, effort coexists with tool calls, and
    // WITHOUT the param these models do not reason at all — so the
    // provider must send it in both directions. Effort is a ceiling:
    // high and max converge on easy turns and separate on hard ones
    // (Pro at max rode a 4k cap that high stopped short of, n=2).
    // Anything outside the v4 line answers [] until verified.
    case 'cloud':
      if (m.includes('deepseek-v4')) return ['off', 'high', 'max']
      return []

    default:
      return []
  }
}

// ── Canonical-token helpers used by the provider request builders ────────
// These are tolerant of legacy persisted tokens (none/basic/extended/fast/
// budget) so an un-migrated config still produces correct requests.

const OFF_TOKENS = new Set(['off', 'none'])

/** Whether reasoning should be on. Undefined defaults to ON (prior behaviour). */
export function thinkingEnabled(mode: string | undefined): boolean {
  if (mode == null) return true
  return !OFF_TOKENS.has(mode)
}

/** Collapse any token to the coarse effort level a provider consumes. */
export function effortFromMode(mode: string | undefined): 'off' | 'high' | 'max' {
  if (mode == null) return 'high'
  if (OFF_TOKENS.has(mode)) return 'off'
  if (mode === 'max') return 'max'
  return 'high'
}

// ── Persisted-value normalisation (legacy migration + clamp) ─────────────

const LEGACY_INTENT: Record<string, ReasoningMode> = {
  none: 'off',
  off: 'off',
  basic: 'on', // old UI used 'basic' as the default "thinking on" value
  on: 'on',
  high: 'high',
  extended: 'high',
  fast: 'on',
  budget: 'on',
  max: 'max'
}

function firstOn(modes: ReasoningMode[]): ReasoningMode {
  return modes.find((x) => x !== 'off') ?? modes[0]
}

/**
 * Coerce a persisted/raw mode into a value valid for THIS model's modes.
 * Handles legacy tokens and clamps to the nearest available canonical mode.
 * The default when nothing is persisted is "thinking on" (matching prior
 * behaviour): undefined → on/high.
 */
export function normalizeReasoningMode(
  raw: string | undefined,
  modes: ReasoningMode[]
): ReasoningMode {
  if (modes.length === 0) return 'off'
  const want: ReasoningMode = (raw != null && LEGACY_INTENT[raw]) || 'on'
  if (modes.includes(want)) return want
  if (want === 'off') return firstOn(modes) // always-on model: no off
  // on ↔ high are equivalent "default thinking"; max degrades to high then on.
  if (want === 'on') return modes.includes('high') ? 'high' : firstOn(modes)
  if (want === 'high') return modes.includes('on') ? 'on' : firstOn(modes)
  // want === 'max'
  return modes.includes('high') ? 'high' : modes.includes('on') ? 'on' : firstOn(modes)
}
