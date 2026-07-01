/**
 * ============================================================================
 * @module        tool-runner
 * @patterns      #4 (read-only vs mutating concurrency batching),
 *                #5 (every tool_use gets exactly one tool_result, incl. abort)
 * @intent        Execute the tool_use blocks of one turn and emit exactly one
 *                tool_result per tool_use — the invariant that keeps the API
 *                transcript valid and the session resumable.
 * @source        Claude Code v2.1.88:
 *                  - partition concurrency-safe vs serial: services/tools/toolOrchestration.ts:91-116
 *                  - CONCURRENCY_CAP = 10: toolOrchestration.ts:10
 *                  - guaranteed pairing (synthetic is_error per tool_use):
 *                    src/query.ts:123-149 (yieldMissingToolResultBlocks)
 *                  - sibling cascade-cancel only for shell, not reads:
 *                    StreamingToolExecutor.ts:354-363
 * @depends       ./types ./tool
 * @invariant     For N input tool_use blocks, runTools produces exactly N
 *                tool_result blocks, in original order, on EVERY path
 *                (allow/deny/invalid/throw/abort). Never throws.
 * @gotcha        isConcurrencySafe is evaluated on the VALIDATED input; if the
 *                predicate throws, the call is treated as UNSAFE (serialized).
 *                Default (buildTool) is already false, so omission is safe.
 * @porting       Safe calls run via chunked Promise.all (chunk size = cap). The
 *                source uses a ROLLING max-in-flight window (toolOrchestration.ts:
 *                158-176, env CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY) which avoids
 *                head-of-line blocking between chunks. Both honor "<= cap
 *                concurrent, read-only batched, mutating serial."
 * ============================================================================
 */

import type { ToolResultBlock, ToolUseBlock, UserMessage } from './types'
import { type CanUseTool, type PermissionDecision, type Tool, type ToolContext, toolResult } from './tool'

/**
 * PROVENANCE: toolOrchestration.ts:10. Max concurrent tool calls. Default 10;
 * the source is env-overridable via CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY.
 */
export const CONCURRENCY_CAP = 10

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** [#5] Pair every tool_use with a synthetic is_error result. */
export function syntheticErrorResults(
  toolUses: ToolUseBlock[],
  message: string,
): ToolResultBlock[] {
  return toolUses.map(tu => toolResult(tu.id, message, true))
}

/** Wrap an ordered set of tool_result blocks into one user message. */
export function toolResultsMessage(results: ToolResultBlock[], uuid: string): UserMessage {
  return { type: 'user', uuid, content: results }
}

/** Is this call eligible for the parallel batch? Validated-input predicate (#4). */
function isSafe(tool: Tool | undefined, rawInput: unknown): boolean {
  if (!tool) return false
  const v = tool.validate(rawInput)
  if (!v.ok) return false
  try {
    return tool.isConcurrencySafe(v.value)
  } catch {
    return false // [#4 gotcha] predicate threw → treat as unsafe
  }
}

/** Run ONE tool_use to a guaranteed ToolResultBlock. Never throws (#5). */
async function execOne(
  tu: ToolUseBlock,
  tool: Tool | undefined,
  canUseTool: CanUseTool,
  ctx: ToolContext,
): Promise<ToolResultBlock> {
  if (!tool) return toolResult(tu.id, `Tool "${tu.name}" not found`, true)

  const v = tool.validate(tu.input)
  if (!v.ok) return toolResult(tu.id, `Invalid input for ${tu.name}: ${v.error}`, true)

  let decision: PermissionDecision
  try {
    decision = await canUseTool(tu.name, v.value, ctx)
  } catch (e) {
    return toolResult(tu.id, `Permission check failed: ${errText(e)}`, true)
  }
  if (decision.behavior === 'deny') {
    // [#5] denial still pairs — and the wording teaches the model the boundary.
    return toolResult(tu.id, decision.message, true)
  }

  try {
    const out = await tool.call(v.value, ctx)
    return toolResult(tu.id, out, false)
  } catch (e) {
    if (ctx.signal.aborted) return toolResult(tu.id, '[Tool execution interrupted]', true)
    return toolResult(tu.id, `Tool ${tu.name} threw: ${errText(e)}`, true)
  }
}

/**
 * Execute all tool_use blocks of one turn, yielding a single user message that
 * carries every tool_result in original order.
 *
 * [#4] Consecutive concurrency-safe calls run in bounded-parallel chunks
 *      (chunk size = CONCURRENCY_CAP); an unsafe call is a serial barrier
 *      (runs alone, in order). NB: source uses a rolling window — see @porting.
 * [#5] If the signal aborts mid-run, every remaining tool_use is paired with a
 *      synthetic is_error result so the transcript never has an orphan tool_use.
 */
export async function* runTools(
  toolUses: ToolUseBlock[],
  tools: Map<string, Tool>,
  canUseTool: CanUseTool,
  ctx: ToolContext,
): AsyncGenerator<UserMessage, void> {
  const results: (ToolResultBlock | undefined)[] = new Array(toolUses.length)

  let i = 0
  while (i < toolUses.length) {
    if (ctx.signal.aborted) {
      for (let k = i; k < toolUses.length; k++) {
        results[k] = toolResult(toolUses[k]!.id, '[Aborted before execution]', true)
      }
      break
    }

    const head = toolUses[i]!
    const headTool = tools.get(head.name)

    if (!isSafe(headTool, head.input)) {
      // serial barrier: a single mutating/unknown call runs alone, in order.
      results[i] = await execOne(head, headTool, canUseTool, ctx)
      i += 1
      continue
    }

    // gather a chunk of consecutive safe calls, bounded by CONCURRENCY_CAP (#4).
    const batch: number[] = []
    while (i < toolUses.length && batch.length < CONCURRENCY_CAP) {
      const t = toolUses[i]!
      if (!isSafe(tools.get(t.name), t.input)) break
      batch.push(i)
      i += 1
    }
    const settled = await Promise.all(
      batch.map(idx => execOne(toolUses[idx]!, tools.get(toolUses[idx]!.name), canUseTool, ctx)),
    )
    batch.forEach((idx, j) => {
      results[idx] = settled[j]
    })
  }

  // Defensive: fill any gap so the N-in/N-out invariant always holds (#5).
  for (let k = 0; k < toolUses.length; k++) {
    if (!results[k]) results[k] = toolResult(toolUses[k]!.id, '[No result produced]', true)
  }

  yield toolResultsMessage(results as ToolResultBlock[], ctx.newUuid())
}
