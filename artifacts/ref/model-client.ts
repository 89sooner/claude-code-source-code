/**
 * ============================================================================
 * @module        model-client
 * @patterns      #2 (stopReason arrives last), A2 (one message per block)
 * @intent        Provider-agnostic streaming model contract. The loop depends
 *                only on this interface, so swapping Anthropic ↔ any provider is
 *                a single implementation, not a loop change.
 * @source        Claude Code v2.1.88: src/services/api/claude.ts
 *                  - raw SSE, one AssistantMessage per content_block_stop: 1940,2192-2211
 *                  - authoritative stopReason/usage at message_delta (back-patch): 2242-2248
 *                  - retry/backoff/fallback wrapper: services/api/withRetry.ts:170,316-360
 * @depends       ./types ./tool
 * @invariant     `stream()` YIELDS one AssistantMessage per content block and
 *                RETURNS the authoritative {stopReason, usage} only at the end.
 *                Callers must not infer end-of-turn from any single yielded msg.
 * @porting       Wrap your provider SDK here. Keep the generator's RETURN value
 *                as the place stopReason/usage live so the loop's #2 contract
 *                holds. Add retry as an OUTER generator that yields 'retrying'
 *                status messages (withRetry.ts) rather than blocking silently.
 * ============================================================================
 */

import type { AssistantMessage, Message, StopReason, Usage } from './types'
import type { ToolSchema } from './tool'

export type StreamResult = { stopReason: StopReason; usage: Usage }

export type StreamParams = {
  system: string
  messages: Message[]
  tools: ToolSchema[]
  signal: AbortSignal
}

export interface ModelClient {
  /**
   * Stream a single assistant turn.
   * - YIELD: one AssistantMessage per content block (text | thinking | tool_use).
   * - RETURN: the authoritative StopReason + Usage, known only at stream end.
   */
  stream(params: StreamParams): AsyncGenerator<AssistantMessage, StreamResult>
}
