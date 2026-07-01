/**
 * ============================================================================
 * @module        permission-engine
 * @patterns      #8 (deny>ask>allow by EVALUATION ORDER; bypass is leaky)
 * @intent        Turn a tool call into a permission decision via a FIXED-ORDER
 *                pipeline where explicit denials and bypass-immune asks are
 *                evaluated BEFORE bypassPermissions — so "bypass everything"
 *                still cannot run an explicitly-denied or safety-flagged action.
 *                Plus `makeCanUseTool`, the adapter that resolves the rich
 *                decision into the simple allow/deny gate `tool-runner` consumes.
 * @source        Claude Code v2.1.88: hasPermissionsToUseToolInner,
 *                src/utils/permissions/permissions.ts:1158-1310. Step labels
 *                below (1a..3) match the source comments exactly.
 * @depends       ./permission-types ./tool
 * @invariant     ORDER IS THE SPEC. Deny(1a,1d) and the bypass-immune asks
 *                (1e requiresUserInteraction, 1f content-rule ask, 1g
 *                safetyCheck) are returned BEFORE the bypass check (2a). Reorder
 *                and you create a privilege-escalation hole.
 * @invariant     `ask` with no interactive prompt resolves to DENY (fail-closed)
 *                — headless/async agents never silently auto-approve.
 * @porting       The engine produces allow/ask/deny; `tool-runner` only knows
 *                allow/deny. `makeCanUseTool` bridges them: it runs the engine,
 *                then resolves `ask` via your injected `prompt` (or denies).
 * ============================================================================
 */

import {
  type AskDecision,
  type PermissionDecisionFull,
  type PermissionResult,
  type PermissionRule,
  type RulesBySource,
  type ToolPermissionContext,
  iterRules,
} from './permission-types'
import type { CanUseTool, PermissionDecision, ToolContext } from './tool'

/** A tool's own permission opinion (e.g. Bash command matching). */
export type ToolPermissionChecker = (
  input: Record<string, unknown>,
  ctx: ToolPermissionContext,
) => PermissionResult | Promise<PermissionResult>

export type PermissionEngineTool = {
  name: string
  /** Content-specific checker (#14 for Bash). Absent => passthrough. */
  checkPermissions?: ToolPermissionChecker
  /** If true, an `ask` from the tool is bypass-immune (1e). */
  requiresUserInteraction?: boolean
}

/** Match an ENTIRE-tool rule (no content) for a tool name. PROVENANCE: getDenyRuleForTool etc. */
function entireToolRule(
  rules: RulesBySource,
  toolName: string,
  behavior: PermissionRule['ruleBehavior'],
): PermissionRule | null {
  for (const r of iterRules(rules)) {
    if (r.toolName === toolName && r.content === undefined) {
      return { source: r.source, ruleBehavior: behavior, ruleValue: { toolName } }
    }
  }
  return null
}

/**
 * The ordered decision pipeline. Returns a resolved allow/ask/deny.
 * PROVENANCE: permissions.ts:1158-1310.
 */
export async function evaluatePermission(
  tool: PermissionEngineTool,
  input: Record<string, unknown>,
  ctx: ToolPermissionContext,
): Promise<PermissionDecisionFull> {
  // 1a. entire tool denied
  const denyRule = entireToolRule(ctx.alwaysDenyRules, tool.name, 'deny')
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `Permission to use ${tool.name} has been denied.`,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 1b. entire tool always-ask. (Source additionally lets sandboxed Bash skip
  // this via canSandboxAutoAllow, permissions.ts:1186-1206; omitted = stricter.)
  const askRule = entireToolRule(ctx.alwaysAskRules, tool.name, 'ask')
  if (askRule) {
    return {
      behavior: 'ask',
      message: `${tool.name} requires confirmation.`,
      decisionReason: { type: 'rule', rule: askRule },
    }
  }

  // 1c. ask the tool implementation (default: passthrough = "no opinion")
  let toolResult: PermissionResult = { behavior: 'passthrough', message: `Allow ${tool.name}?` }
  if (tool.checkPermissions) {
    try {
      toolResult = await tool.checkPermissions(input, ctx)
    } catch {
      // fail-closed: a thrown checker leaves passthrough (-> ask at step 3)
    }
  }

  // 1d. tool denied
  if (toolResult.behavior === 'deny') return toolResult

  // 1e. tool requires user interaction even in bypass mode
  if (tool.requiresUserInteraction && toolResult.behavior === 'ask') return toolResult

  // 1f. content-specific ASK rule from the tool takes precedence over bypass
  if (
    toolResult.behavior === 'ask' &&
    toolResult.decisionReason?.type === 'rule' &&
    toolResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolResult
  }

  // 1g. safety checks (.git/.claude/shell configs) are bypass-immune
  if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type === 'safetyCheck') {
    return toolResult
  }

  // 2a. bypass mode (or plan mode when bypass was available)
  const shouldBypass =
    ctx.mode === 'bypassPermissions' ||
    (ctx.mode === 'plan' && ctx.isBypassPermissionsModeAvailable)
  if (shouldBypass) {
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'mode', mode: ctx.mode } }
  }

  // 2b. entire tool allowed
  const allowRule = entireToolRule(ctx.alwaysAllowRules, tool.name, 'allow')
  if (allowRule) {
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'rule', rule: allowRule } }
  }

  // 3. passthrough -> ask
  if (toolResult.behavior === 'passthrough') {
    return { behavior: 'ask', message: toolResult.message, decisionReason: toolResult.decisionReason }
  }
  // tool returned allow or ask
  return toolResult
}

/** Resolve an `ask` into allow(true)/deny(false). Default (none) => deny. */
export type PermissionPrompt = (
  decision: AskDecision,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>

export type CanUseToolConfig = {
  ctx: ToolPermissionContext
  /** Tool-specific checkers (e.g. {'bash': (input,ctx) => checkBashPermission(...)}). */
  checkers?: Map<string, ToolPermissionChecker>
  /** Tool names whose `ask` is bypass-immune (1e). */
  requiresUserInteraction?: Set<string>
  /** Resolves `ask`. Omit for headless => `ask` becomes DENY (fail-closed). */
  prompt?: PermissionPrompt
}

/**
 * Adapter: rich engine -> the simple `CanUseTool` gate `tool-runner` calls.
 * `ask` is resolved via `prompt` (or denied). PROVENANCE: the canUseTool wrapper
 * around hasPermissionsToUseTool + headless auto-deny.
 */
export function makeCanUseTool(config: CanUseToolConfig): CanUseTool {
  return async (toolName: string, input: unknown, _toolCtx: ToolContext): Promise<PermissionDecision> => {
    const tool: PermissionEngineTool = {
      name: toolName,
      checkPermissions: config.checkers?.get(toolName),
      requiresUserInteraction: config.requiresUserInteraction?.has(toolName),
    }
    const decision = await evaluatePermission(tool, (input ?? {}) as Record<string, unknown>, config.ctx)

    // NOTE: drops decision.updatedInput — this pack's simple CanUseTool gate has
    // no input-rewrite channel. Thread it through if your checker sanitizes input.
    if (decision.behavior === 'allow') return { behavior: 'allow' }
    if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message }

    // ask: resolve via prompt; fail-closed to deny when headless.
    const approved = config.prompt
      ? await config.prompt(decision, toolName, (input ?? {}) as Record<string, unknown>)
      : false
    return approved ? { behavior: 'allow' } : { behavior: 'deny', message: decision.message }
  }
}
