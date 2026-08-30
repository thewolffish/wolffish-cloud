import type { ApprovalDescription } from '@main/runtime/cerebellum'
import type { Corpus } from '@main/runtime/corpus'
import type { ToolCall } from '@main/runtime/wernicke'

/**
 * Amygdala is the safety gate. It can stop any action before it executes.
 *
 * Maps to: the amygdala — two almond-shaped clusters in the temporal
 * lobes that handle threat detection and the fear response. The amygdala
 * fires before conscious thought catches up: you flinch from the snake,
 * then you realize it's a stick. It can override anything the cortex was
 * about to do.
 *
 * In Wolffish, Amygdala classifies every tool call before the motor
 * cortex runs it. Safe operations pass through. Confirm-level calls
 * bounce through an approval bridge (IPC to the renderer). Block-level
 * calls halt the pipeline outright. The pattern table is empty until
 * capabilities register their own — the core knows nothing about
 * specific tools.
 */

export type DangerLevel = 'safe' | 'warn' | 'confirm' | 'destructive' | 'block'

export type DangerPattern = {
  match: RegExp
  level: DangerLevel
  reason: string
}

export type ApprovalRequest = {
  toolCall: ToolCall
  level: DangerLevel
  reason: string
  description?: ApprovalDescription
}

export type ApprovalDecision = 'approved' | 'denied'

export type ApprovalBridge = (
  request: ApprovalRequest & { id: string }
) => Promise<ApprovalDecision>

export type AmygdalaOptions = {
  corpus?: Corpus
  approvalBridge?: ApprovalBridge
}

const APPROVAL_DENIED: ApprovalDecision = 'denied'

export class Amygdala {
  private patterns: DangerPattern[] = []
  private approvalBridge: ApprovalBridge | null
  private bypassPermissions = false

  constructor(private options: AmygdalaOptions = {}) {
    this.approvalBridge = options.approvalBridge ?? null
  }

  /**
   * Wire the approval bridge after construction. Used by main, where the
   * Electron IPC channels aren't available when the Agent is built.
   */
  setApprovalBridge(bridge: ApprovalBridge | null): void {
    this.approvalBridge = bridge
  }

  /**
   * Toggle auto-approval mode. When true, every `confirm`/`destructive`
   * call resolves to approved without prompting the user. `block`-class
   * calls remain hard-blocked — bypass mode is for skipping the dialog,
   * not for overriding hard safety stops.
   */
  setBypassPermissions(value: boolean): void {
    this.bypassPermissions = value
  }

  isBypassingPermissions(): boolean {
    return this.bypassPermissions
  }

  /**
   * Register danger patterns contributed by a capability. Capabilities
   * call this when they load so amygdala can refuse the operations they
   * own (shell knows what `rm -rf` is; the core does not). With zero
   * capabilities, no patterns are registered and every tool call
   * classifies as `safe`.
   */
  registerPatterns(patterns: DangerPattern[]): void {
    this.patterns.push(...patterns)
  }

  /**
   * Classify a tool call by matching its serialized arguments against
   * every registered pattern. The first match wins; with no registered
   * patterns the call is `safe`.
   */
  classify(call: ToolCall): DangerLevel {
    let haystack: string
    try {
      haystack = JSON.stringify(call.args)
    } catch {
      return 'safe'
    }
    for (const pattern of this.patterns) {
      if (pattern.match.test(haystack)) return pattern.level
    }
    return 'safe'
  }

  /**
   * Find the first matching pattern (or null if none). Useful when callers
   * need both the level and the reason in a single pass.
   */
  match(call: ToolCall): DangerPattern | null {
    let argsString: string
    try {
      argsString = JSON.stringify(call.args)
    } catch {
      argsString = ''
    }
    // Match against the tool name AND the stringified args, so a pattern
    // can target either side. Without the name, a danger pattern that names
    // a specific tool (e.g. `test_dangerous_action`) would never fire.
    const haystack = `${call.name} ${argsString}`
    for (const pattern of this.patterns) {
      if (pattern.match.test(haystack)) return pattern
    }
    return null
  }

  /**
   * Bounce a request to the renderer for the user's approval and resolve
   * with their decision. Without a bridge wired, fails closed (denied) so
   * a misconfigured runtime never executes a confirm-level call. When
   * bypass mode is on the user dialog is skipped and approval is granted
   * automatically — `safety.autoApproved` is logged so the audit trail
   * is intact.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = generateApprovalId()
    if (this.bypassPermissions) {
      this.options.corpus?.emit('safety.autoApproved', {
        id,
        tool: req.toolCall.name,
        args: req.toolCall.args,
        level: req.level,
        reason: req.reason
      })
      return 'approved'
    }
    this.options.corpus?.emit('safety.confirmNeeded', {
      id,
      tool: req.toolCall.name,
      args: req.toolCall.args,
      reason: req.reason
    })
    if (!this.approvalBridge) {
      this.options.corpus?.emit('safety.denied', { id })
      return APPROVAL_DENIED
    }
    let decision: ApprovalDecision
    try {
      decision = await this.approvalBridge({ ...req, id })
    } catch {
      decision = APPROVAL_DENIED
    }
    if (decision === 'approved') {
      this.options.corpus?.emit('safety.approved', { id })
    } else {
      this.options.corpus?.emit('safety.denied', { id })
    }
    return decision
  }

  /**
   * Convenience boolean — anything that isn't `safe` deserves a second look.
   */
  isDangerous(call: ToolCall): boolean {
    return this.classify(call) !== 'safe'
  }

  /**
   * Hard-stop: emit a safety.blocked event and surface a recoverable error
   * so the agent loop can hand the reason back to the LLM and continue
   * the conversation.
   */
  block(call: ToolCall, reason: string): never {
    this.options.corpus?.emit('safety.blocked', {
      tool: call.name,
      args: call.args,
      reason
    })
    throw new SafetyBlockedError(call.name, reason)
  }
}

export class SafetyBlockedError extends Error {
  readonly toolName: string
  readonly reason: string
  constructor(toolName: string, reason: string) {
    super(`safety.blocked: ${toolName} — ${reason}`)
    this.name = 'SafetyBlockedError'
    this.toolName = toolName
    this.reason = reason
  }
}

function generateApprovalId(): string {
  return `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
