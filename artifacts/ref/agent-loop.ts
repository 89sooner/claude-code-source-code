/**
 * ============================================================================
 * @module        agent-loop
 * @patterns      #1 (async-generator turn loop + Terminal/Continue union),
 *                #2 (tool_use observation as the continue signal),
 *                #5 (guaranteed tool_result pairing on abort, via tool-runner)
 * @intent        The minimal agentic turn loop: stream model → observe tool_use
 *                → run tools → feed results back as the next input → repeat,
 *                exiting ONLY by returning a tagged Terminal reason.
 * @source        Claude Code v2.1.88: src/query.ts
 *                  - queryLoop while(true): 241-307
 *                  - mutable State, reassigned whole at each continue: 204-217,268-279
 *                  - needsFollowUp = saw a tool_use block: 558,834
 *                  - return {reason:'completed'}: 1357
 *                  - continue: state = {messages:[...prev,...assistant,...results]}: 1715-1727
 * @depends       ./types ./model-client ./tool ./tool-runner
 * @invariant     The ONLY way out is `return <Terminal>`. Continuation is
 *                decided by `needsFollowUp` (saw a tool_use), NEVER by stopReason.
 * @invariant     Every tool_use emitted is paired with a tool_result before the
 *                loop continues or returns (delegated to tool-runner, #5).
 * @porting       Async generators are NOT auto-cancelled by AbortSignal — this
 *                loop checks `signal.aborted` at each phase boundary (query.ts
 *                checks ~6×). Context compaction (snip→microcompact→summarize)
 *                belongs at the marked seam before each model call.
 * ============================================================================
 */

import {
  type AssistantMessage,
  type Continue,
  type Message,
  type Terminal,
  type ToolUseBlock,
  type UserMessage,
  isToolUse,
} from './types'
import type { ModelClient } from './model-client'
import type { CanUseTool, Tool, ToolSchema } from './tool'
import { runTools, syntheticErrorResults, toolResultsMessage } from './tool-runner'

export type AgentLoopParams = {
  messages: Message[]
  system: string
  /** Executable tools, keyed by name. */
  tools: Map<string, Tool>
  /** Schemas the model sees (subset/serialization of `tools`). */
  toolSchemas: ToolSchema[]
  client: ModelClient
  canUseTool: CanUseTool
  signal: AbortSignal
  newUuid: () => string
  maxTurns?: number
  agentId?: string
  /**
   * Optional seam: reduce `messages` before each model call
   * (snip → microcompact → summarize). PROVENANCE: query.ts:379-454.
   * Return the (possibly) shrunk message list. Identity by default.
   */
  reduceContext?: (messages: Message[]) => Promise<Message[]> | Message[]
}

/** Mutable cross-iteration state. PROVENANCE: query.ts:204-217. */
type LoopState = {
  messages: Message[]
  turnCount: number
  /** Why the previous iteration continued (observability/tests). */
  transition: Continue | undefined
}

const collectToolUses = (msgs: AssistantMessage[]): ToolUseBlock[] =>
  msgs.flatMap(m => m.content.filter(isToolUse))

/**
 * Run the agent to a terminal state.
 * YIELDS every Message (assistant blocks + tool-result user messages) so a
 * consumer can render/persist incrementally. RETURNS a tagged Terminal reason.
 */
export async function* agentLoop(
  params: AgentLoopParams,
): AsyncGenerator<Message, Terminal> {
  const maxTurns = params.maxTurns ?? 100
  const reduce = params.reduceContext ?? ((m: Message[]) => m)

  let state: LoopState = {
    messages: params.messages,
    turnCount: 1,
    transition: undefined,
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // [#1] phase-boundary cancellation check (generators don't auto-cancel).
    if (params.signal.aborted) return { reason: 'aborted_streaming' }
    if (state.turnCount > maxTurns) return { reason: 'max_turns' }

    // --- context reduction seam (compaction lives here) ---
    const messagesForModel = await reduce(state.messages)

    // --- stream ONE assistant turn ---------------------------------------
    const assistantMessages: AssistantMessage[] = []
    let needsFollowUp = false // [#2] the SOLE continue signal

    const stream = params.client.stream({
      system: params.system,
      messages: messagesForModel,
      tools: params.toolSchemas,
      signal: params.signal,
    })

    while (true) {
      const next = await stream.next()
      if (next.done) {
        // next.value is the authoritative StreamResult {stopReason, usage}.
        // [#2] We intentionally do NOT branch on stopReason — see @invariant.
        break
      }
      const am = next.value
      assistantMessages.push(am)
      // [#2] PROVENANCE: query.ts:558,834 — observe tool_use, NOT stopReason.
      if (am.content.some(isToolUse)) needsFollowUp = true
      yield am
    }

    const toolUses = collectToolUses(assistantMessages)

    // [#5] abort AFTER streaming but before/without tools: still pair every
    // tool_use so the transcript has no orphan tool_use block.
    if (params.signal.aborted) {
      if (toolUses.length > 0) {
        const um = toolResultsMessage(
          syntheticErrorResults(toolUses, '[Request interrupted]'),
          params.newUuid(),
        )
        yield um
      }
      return { reason: 'aborted_tools' }
    }

    // [#2] No tool_use => the model is done. PROVENANCE: query.ts:1357.
    if (!needsFollowUp) {
      return { reason: 'completed' }
    }

    // --- execute tools, feeding results back (#4/#5) ---------------------
    const toolResultMessages: UserMessage[] = []
    for await (const um of runTools(toolUses, params.tools, params.canUseTool, {
      signal: params.signal,
      newUuid: params.newUuid,
      agentId: params.agentId,
    })) {
      toolResultMessages.push(um)
      yield um
    }

    // [#1] continue: rebuild State as a fresh object. Accumulate onto the
    // REDUCED list (messagesForModel), NOT the full history — otherwise context
    // reduction in `reduceContext` is recomputed from a regrowing history every
    // turn and never persists. PROVENANCE: query.ts:1715-1727 builds
    // `[...messagesForQuery, ...]` where messagesForQuery is post-reduction.
    state = {
      messages: [...messagesForModel, ...assistantMessages, ...toolResultMessages],
      turnCount: state.turnCount + 1,
      transition: { reason: 'next_turn' },
    }
  }
}
