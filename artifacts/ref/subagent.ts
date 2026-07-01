/**
 * ============================================================================
 * @module        subagent
 * @patterns      #12 (default-deny context isolation for sub-agents),
 *                D5 (sync shares parent signal / async gets unlinked controller)
 * @intent        Spawn a sub-agent that runs the SAME agent-loop with a context
 *                that is isolated by default: cloned mutable caches, no-op'd UI
 *                and mutation callbacks, narrow opt-ins, and tool permissions
 *                that do NOT inherit the parent's session approvals.
 * @source        Claude Code v2.1.88:
 *                  - createSubagentContext CORE (clone mutable caches +
 *                    default-deny/no-op mutation & UI callbacks + always-on
 *                    `setAppStateForTasks` cleanup channel at 416-417):
 *                    src/utils/forkedAgent.ts:345-462
 *                  - worker tool pool uses the WORKER's own permission mode,
 *                    independent of parent restrictions: runAgent.ts:292-300,500-502
 *                  - allowedTools replaces session allow rules, cliArg preserved
 *                    (parent approvals don't leak): runAgent.ts:465-479
 *                  - async => new unlinked AbortController; sync => parent's:
 *                    runAgent.ts:520-528
 * @depends       ./types ./tool ./agent-loop ./model-client ./task-notification
 * @invariant     Without an explicit opt-in, a sub-agent cannot mutate parent
 *                app-state or drive parent UI. Cleanup runs on a separate
 *                always-on channel (source: `setAppStateForTasks`,
 *                forkedAgent.ts:416-417 — registration/kill must reach the root
 *                store even when setAppState is a no-op).
 * @gotcha        This ref clears the child's SESSION tool-approvals by default
 *                (default-deny). The source only REPLACES alwaysAllowRules when
 *                allowedTools !== undefined (runAgent.ts:469); with it undefined
 *                the worker INHERITS the parent's approvals. Pick stricter (this
 *                ref) or source-faithful per your threat model.
 * @porting       Map `AppCallbacks` to your host (React setState, a TUI, a web
 *                socket...). The key is the DEFAULT: every cross-boundary
 *                callback is a no-op until explicitly shared.
 * ============================================================================
 */

import type { Message, Terminal } from './types'
import type { CanUseTool, PermissionDecision, Tool, ToolSchema } from './tool'
import { agentLoop } from './agent-loop'
import type { ModelClient } from './model-client'
import { finalizeAgentResult } from './task-notification'

/** Parent-side mutation / UI surface. All are no-op'd for children by default. */
export type AppCallbacks = {
  setAppState: (mutate: (prev: unknown) => unknown) => void
  showPermissionPrompt: (toolName: string, input: unknown) => Promise<boolean>
  /** Always-on side channel for progress/cleanup (NOT gated by isolation). */
  onAgentMessage: (m: Message) => void
}

export type AllowRules = {
  /** From SDK/CLI (--allowedTools). Explicit; preserved across the boundary. */
  cliArg: string[]
  /** Session-level grants accumulated in the parent. NOT inherited by children. */
  session: string[]
}

export type ParentContext = {
  signal: AbortSignal
  /** Mutable file/state cache; cloned (not shared) for the child. */
  fileCache: Map<string, string>
  callbacks: AppCallbacks
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  alwaysAllowRules: AllowRules
}

export type SubagentSpawnOptions = {
  /** Background agent? async => unlinked controller + prompts suppressed. */
  isAsync: boolean
  /**
   * Replaces the child's session allow-rules entirely (cliArg preserved).
   * Parent session approvals never leak in. PROVENANCE: runAgent.ts:469-479.
   */
  allowedTools?: string[]
  /** Narrow opt-in: let the child drive parent app-state. Default off. */
  shareSetAppState?: boolean
  /** Narrow opt-in: let the child show interactive permission prompts. */
  shareShowPermissionPrompt?: boolean
}

export type SubagentContext = {
  signal: AbortSignal
  abortController?: AbortController
  fileCache: Map<string, string>
  callbacks: AppCallbacks
  canUseTool: CanUseTool
  alwaysAllowRules: AllowRules
}

const noopAsync = async (): Promise<boolean> => false
const noop = (): void => {}

/** Derive a child permission gate from its OWN allow-rules (no parent leak). */
function childCanUseTool(rules: AllowRules): CanUseTool {
  const allow = new Set([...rules.cliArg, ...rules.session])
  return async (toolName: string): Promise<PermissionDecision> => {
    if (allow.has('*') || allow.has(toolName)) return { behavior: 'allow' }
    return {
      behavior: 'deny',
      message: `Tool "${toolName}" is not in this sub-agent's allow-list (parent approvals do not leak).`,
    }
  }
}

/**
 * Build an ISOLATED context for a sub-agent. PROVENANCE: createSubagentContext
 * (src/utils/forkedAgent.ts:345-462). Everything that could mutate the parent
 * is no-op'd unless an explicit, narrow opt-in is set.
 */
export function createSubagentContext(
  parent: ParentContext,
  opts: SubagentSpawnOptions,
): SubagentContext {
  // (1) clone mutable caches — child mutations never touch parent state.
  const fileCache = new Map(parent.fileCache)

  // (2) async agents get a NEW unlinked controller (parent ESC won't kill them);
  //     sync agents share the parent's signal. PROVENANCE: runAgent.ts:520-528.
  const abortController = opts.isAsync ? new AbortController() : undefined
  const signal = abortController ? abortController.signal : parent.signal

  // (3) default-deny callbacks; narrow opt-ins re-enable specific surfaces.
  const callbacks: AppCallbacks = {
    setAppState: opts.shareSetAppState ? parent.callbacks.setAppState : noop,
    showPermissionPrompt:
      opts.shareShowPermissionPrompt && !opts.isAsync
        ? parent.callbacks.showPermissionPrompt
        : noopAsync,
    // Always-on: progress/cleanup must work even under full isolation.
    onAgentMessage: parent.callbacks.onAgentMessage,
  }

  // (4) scope permissions to the child's own rules; cliArg preserved.
  //     NB: stricter than source — Claude Code only replaces session rules when
  //     allowedTools is provided (runAgent.ts:469); undefined => inherit
  //     parent.session. This ref defaults to deny (session: []) for isolation.
  const alwaysAllowRules: AllowRules =
    opts.allowedTools !== undefined
      ? { cliArg: parent.alwaysAllowRules.cliArg, session: [...opts.allowedTools] }
      : { cliArg: parent.alwaysAllowRules.cliArg, session: [] }

  return {
    signal,
    abortController,
    fileCache,
    callbacks,
    canUseTool: childCanUseTool(alwaysAllowRules),
    alwaysAllowRules,
  }
}

export type SpawnResult = {
  terminal: Terminal
  /** Inline channel: the agent's final text, for synchronous return (D3). */
  finalText: string
  messages: Message[]
}

/**
 * Spawn and run a sub-agent to completion in the ISOLATED context.
 * Returns the inline result (finalText). For async agents, the caller pairs
 * this with an out-of-band `<task-notification>` (see task-notification.ts).
 */
export async function spawnSubagent(args: {
  parent: ParentContext
  opts: SubagentSpawnOptions
  agentId: string
  system: string
  promptMessages: Message[]
  tools: Map<string, Tool>
  toolSchemas: ToolSchema[]
  client: ModelClient
  newUuid: () => string
  maxTurns?: number
}): Promise<SpawnResult> {
  const ctx = createSubagentContext(args.parent, args.opts)
  const collected: Message[] = [...args.promptMessages]

  const gen = agentLoop({
    messages: args.promptMessages,
    system: args.system,
    tools: args.tools,
    toolSchemas: args.toolSchemas,
    client: args.client,
    canUseTool: ctx.canUseTool, // child's own gate — no parent leak (#12)
    signal: ctx.signal,
    newUuid: args.newUuid,
    maxTurns: args.maxTurns,
    agentId: args.agentId,
  })

  let terminal: Terminal
  while (true) {
    const res = await gen.next()
    if (res.done) {
      terminal = res.value
      break
    }
    collected.push(res.value)
    ctx.callbacks.onAgentMessage(res.value) // always-on side channel
  }

  return { terminal, finalText: finalizeAgentResult(collected), messages: collected }
}
