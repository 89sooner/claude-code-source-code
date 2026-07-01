/**
 * ============================================================================
 * @module        hook-integration
 * @patterns      #G1 (PreToolUse / PostToolUse woven into the tool pipeline)
 * @intent        Show where hooks sit in a tool call: PreToolUse runs BEFORE the
 *                permission check and can block the tool, rewrite its input,
 *                pre-decide a permission, or inject context; PostToolUse runs
 *                AFTER and can replace the tool's output. Composes with the
 *                permission engine — critically, a hook `allow` does NOT escalate
 *                past deny rules (rule-based permission still runs).
 * @source        Claude Code v2.1.88: services/tools/toolHooks.ts (:332,:435) +
 *                the pipeline order validate → PreToolUse → permission → call →
 *                map → persist → PostToolUse (toolExecution.ts:599).
 * @depends       ./hook-types ./hook-engine ./permission-types ./tool
 * @invariant     Order: PreToolUse hooks → (if not blocked) permission engine →
 *                tool call → PostToolUse hooks. A hook `deny`/blockingError stops
 *                the tool BEFORE permission; a hook `allow` is advisory —
 *                rule-based deny still applies (no privilege escalation).
 * @porting       `injectedContext` entries become low-authority system-reminders
 *                (metaUser). Feed `hookPermission` into your permission engine as
 *                an additional signal, not as a bypass.
 * ============================================================================
 */

import type { HooksSettings, ToolHookInput } from './hook-types'
import { type HookRunners, type TrustGate, runHooks } from './hook-engine'
import type { CanUseTool } from './tool'

export type PreToolUseOutcome = {
  /** The tool must NOT run (a hook denied it or emitted a blocking error). */
  blocked: boolean
  denyMessage?: string
  /** Possibly hook-rewritten input to use for permission + the call. */
  input: Record<string, unknown>
  /** Hook's permission opinion. 'allow' is advisory (rules still run). */
  hookPermission?: 'allow' | 'deny' | 'ask'
  /** Extra context to inject as low-authority system-reminders. */
  injectedContext: string[]
}

export type HookDeps = { config: HooksSettings; runners: HookRunners; gate: TrustGate }

/** Run PreToolUse hooks and reduce them to a pipeline decision. */
export async function runPreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  deps: HookDeps,
  ctx: { cwd?: string; toolUseId?: string; signal?: AbortSignal },
): Promise<PreToolUseOutcome> {
  const hookInput: ToolHookInput = {
    hook_event_name: 'PreToolUse',
    cwd: ctx.cwd ?? '.',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: ctx.toolUseId,
  }
  const agg = await runHooks({ event: 'PreToolUse', input: hookInput, config: deps.config, runners: deps.runners, gate: deps.gate, signal: ctx.signal })

  const blocked = agg.permissionBehavior === 'deny' || agg.blockingErrors.length > 0
  return {
    blocked,
    denyMessage: blocked ? (agg.permissionDecisionReason ?? (agg.blockingErrors.join('; ') || `${toolName} blocked by hook`)) : undefined,
    input: agg.updatedInput ?? input,
    hookPermission: agg.permissionBehavior,
    injectedContext: agg.additionalContexts,
  }
}

/** Run PostToolUse hooks; may replace the tool output and inject context. */
export async function runPostToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  toolOutput: unknown,
  deps: HookDeps,
  ctx: { cwd?: string; toolUseId?: string; signal?: AbortSignal },
): Promise<{ output: unknown; injectedContext: string[] }> {
  const hookInput: ToolHookInput = {
    hook_event_name: 'PostToolUse',
    cwd: ctx.cwd ?? '.',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: ctx.toolUseId,
    tool_response: toolOutput,
  }
  const agg = await runHooks({ event: 'PostToolUse', input: hookInput, config: deps.config, runners: deps.runners, gate: deps.gate, signal: ctx.signal })
  return {
    output: agg.updatedMCPToolOutput !== undefined ? agg.updatedMCPToolOutput : toolOutput,
    injectedContext: agg.additionalContexts,
  }
}

/**
 * Wrap a base `CanUseTool` so PreToolUse hooks run first. Demonstrates the
 * non-escalation rule: a hook `deny`/`ask` is honored, but a hook `allow` falls
 * through to the base gate (rule-based deny still applies).
 */
export function withPreToolUseHooks(base: CanUseTool, deps: HookDeps): CanUseTool {
  return async (toolName, input, ctx) => {
    const pre = await runPreToolUseHooks(toolName, (input ?? {}) as Record<string, unknown>, deps, {
      toolUseId: ctx.agentId,
      signal: ctx.signal,
    })
    if (pre.blocked) return { behavior: 'deny', message: pre.denyMessage ?? `${toolName} blocked by hook` }
    if (pre.hookPermission === 'deny') return { behavior: 'deny', message: pre.denyMessage ?? `${toolName} denied by hook` }
    // 'ask'/'allow' are advisory: defer to the base gate so rule-based deny still
    // applies (no escalation). Pass the (possibly rewritten) input through.
    return base(toolName, pre.input, ctx)
  }
}
