/**
 * ============================================================================
 * @module        hook-types
 * @patterns      #G1 (lifecycle hook engine types), #G2 (trust gate types)
 * @intent        The type backbone for out-of-process lifecycle hooks: the 27
 *                event union, the 4 persistable hook config variants
 *                (command/prompt/agent/http), the stdin HookInput, the stdout
 *                JSON control (SyncHookJSONOutput), and the per-hook HookResult
 *                that the engine folds into one AggregatedHookResult.
 * @source        Claude Code v2.1.88:
 *                  - HOOK_EVENTS (27): entrypoints/sdk/coreSchemas.ts:355-383
 *                  - config variants (discriminatedUnion 'type'): schemas/hooks.ts:31-222
 *                  - SyncHookJSONOutput (continue/decision/hookSpecificOutput):
 *                    coreSchemas.ts:907-935; types/hooks.ts:50-200
 *                  - HookResult / AggregatedHookResult: types/hooks.ts:260,277
 * @depends       (none)
 * @invariant     `hook_event_name` is the discriminator everywhere. The `if`
 *                gate is only meaningful for TOOL events; on any other event a
 *                hook that declares `if` is silently DROPPED.
 * @porting       Field names are snake_case on stdin (hook INPUT) and camelCase
 *                on stdout (hook OUTPUT) — mirror both if you want drop-in hooks.
 * ============================================================================
 */

/** The 27 lifecycle events, in source order. PROVENANCE: coreSchemas.ts:355-383. */
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'PermissionRequest', 'PermissionDenied', 'Setup',
  'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** The `if` gate is only meaningful for these. PROVENANCE: events-gating recon. */
export const TOOL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']
export const isToolHookEvent = (e: HookEvent): boolean => TOOL_HOOK_EVENTS.includes(e)

/* -------------------------------------------------------------------------- */
/* Config variants — discriminated union on `type`. PROVENANCE: schemas/hooks.ts */
/* -------------------------------------------------------------------------- */

/** Shared fields. `if` = permission-rule DSL gate (e.g. "Bash(git *)"); timeout in SECONDS. */
type HookCommon = { if?: string; timeout?: number; statusMessage?: string; once?: boolean }

export type CommandHook = HookCommon & {
  type: 'command'
  command: string
  shell?: 'bash' | 'powershell'
  /** background, non-blocking. `asyncRewake` additionally wakes the model on exit 2. */
  async?: boolean
  asyncRewake?: boolean
}
export type PromptHook = HookCommon & { type: 'prompt'; prompt: string; model?: string }
export type AgentHook = HookCommon & { type: 'agent'; prompt: string; model?: string }
export type HttpHook = HookCommon & { type: 'http'; url: string; headers?: Record<string, string>; allowedEnvVars?: string[] }
export type HookCommand = CommandHook | PromptHook | AgentHook | HttpHook

export type HookMatcher = { matcher?: string; hooks: HookCommand[] }
/** The shape under the top-level `hooks` key in settings.json. */
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>

/* -------------------------------------------------------------------------- */
/* HookInput (stdin, snake_case). PROVENANCE: coreSchemas.ts:387-797           */
/* -------------------------------------------------------------------------- */

export type BaseHookInput = {
  session_id?: string
  cwd: string
  hook_event_name: HookEvent
  permission_mode?: string
}
/** Tool events carry the tool identity/args (and, post-call, its response). */
export type ToolHookInput = BaseHookInput & {
  tool_name: string
  tool_input: unknown
  tool_use_id?: string
  tool_response?: unknown
}
export type HookInput = BaseHookInput & Record<string, unknown>

/* -------------------------------------------------------------------------- */
/* Hook stdout control (SyncHookJSONOutput). PROVENANCE: coreSchemas.ts:907-935 */
/* -------------------------------------------------------------------------- */

export type HookPermissionDecision = 'allow' | 'deny' | 'ask'

/** Discriminated on hookEventName. Only the load-bearing members are modeled. */
export type HookSpecificOutput =
  | {
      hookEventName: 'PreToolUse'
      permissionDecision?: HookPermissionDecision
      permissionDecisionReason?: string
      updatedInput?: Record<string, unknown>
      additionalContext?: string
    }
  | { hookEventName: 'PostToolUse'; additionalContext?: string; updatedMCPToolOutput?: unknown }
  | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
  | { hookEventName: 'SessionStart' | 'Setup' | 'SubagentStart' | 'Notification'; additionalContext?: string }

export type SyncHookJSONOutput = {
  /** default true; false HALTS the agent. */
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  /** LEGACY generic gate — distinct from PreToolUse permissionDecision. */
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: HookSpecificOutput
}
export type AsyncHookJSONOutput = { async: true; asyncTimeout?: number }
export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput
export const isAsyncHookJSONOutput = (o: HookJSONOutput): o is AsyncHookJSONOutput =>
  'async' in o && o.async === true

/* -------------------------------------------------------------------------- */
/* Engine-internal result types. PROVENANCE: types/hooks.ts:260,277            */
/* -------------------------------------------------------------------------- */

export type HookOutcome = 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
export type HookPermissionBehavior = 'allow' | 'deny' | 'ask' | 'passthrough'

/** One hook's contribution. */
export type HookResult = {
  outcome: HookOutcome
  systemMessage?: string
  blockingError?: string
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: HookPermissionBehavior
  permissionDecisionReason?: string
  additionalContext?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  suppressOutput?: boolean
}

/** Many hook results folded into one. `permissionBehavior` is the deny>ask>allow winner. */
export type AggregatedHookResult = {
  blockingErrors: string[]
  systemMessages: string[]
  additionalContexts: string[]
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'allow' | 'deny' | 'ask' // passthrough collapses to undefined
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
}

export function emptyAggregate(): AggregatedHookResult {
  return { blockingErrors: [], systemMessages: [], additionalContexts: [] }
}
