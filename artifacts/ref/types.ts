/**
 * ============================================================================
 * @module        types
 * @patterns      #1 (Terminal/Continue tagged unions), shared message model
 * @intent        Provider-agnostic message + content-block model and the two
 *                tagged unions that drive agent-loop control flow.
 * @source        Claude Code v2.1.88:
 *                  - State / Terminal / Continue: src/query.ts:104,204-217
 *                  - Terminal/Continue members: src/query/transitions.ts
 *                    (not in extracted tarball; members recovered from the
 *                     queryLoop return-type + continue-site analysis)
 *                  - one-assistant-message-per-content-block: claude.ts:2192-2211
 * @depends       (none)
 * @invariant     An AssistantMessage carries the content blocks of ONE
 *                streamed block group; `stopReason`/`usage` are authoritative
 *                only after the stream ends (see model-client.ts).
 * @porting       Claude Code nests blocks under `msg.message.content`; this ref
 *                flattens to `msg.content` for clarity. If you keep the SDK
 *                shape, `mutate don't replace` the last message when patching
 *                stopReason/usage (claude.ts:2242-2248) so lazy transcript
 *                writers keep their live reference.
 * ============================================================================
 */

/** A unit of model output / tool exchange. Anthropic-compatible subset. */
export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  /** Stringified tool output OR error text when is_error. */
  content: string
  /** true => the model is told this tool_use failed. Pairing is mandatory (#5). */
  is_error?: boolean
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

/**
 * Authoritative end-of-turn signal. Arrives only at stream end (message_delta).
 * @gotcha NEVER drive loop control off this — use tool_use observation (#2).
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  /**
   * Shared API-response id. Anthropic emits one assistant record PER content
   * block (claude.ts:2192); all blocks of one streamed response share this id
   * (distinct from the per-record `uuid`). Used to anchor token estimation
   * across parallel tool calls (context-usage.ts). Defaults to `uuid` if unset.
   */
  responseId?: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
}

export type UserMessage = {
  type: 'user'
  uuid: string
  content: ContentBlock[]
  /**
   * Low-authority, system-injected message (todos/memory/compaction/hook
   * context/queued input). PROVENANCE: the `<system-reminder>` isMeta channel,
   * messages.ts:3097. Rendered/treated as background context, not a user turn.
   */
  isMeta?: boolean
}

export type Message = AssistantMessage | UserMessage

/* -------------------------------------------------------------------------- */
/* Loop-control tagged unions (#1)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Why the loop STOPPED. The single value `agentLoop` returns. Every exit is a
 * distinct, machine-readable reason so callers branch on intent, not strings
 * scraped from messages. PROVENANCE: queryLoop return type, src/query.ts:250.
 */
export type TerminalReason =
  | 'completed'           // model produced no tool_use → natural end
  | 'max_turns'           // turn cap hit
  | 'max_budget'          // token/cost budget exhausted
  | 'prompt_too_long'     // context overflow that recovery could not resolve
  | 'model_error'         // non-retryable model/API error
  | 'aborted_streaming'   // user/parent abort before/while streaming
  | 'aborted_tools'       // abort after streaming, before/within tool exec
  | 'hook_stopped'        // a Stop hook vetoed continuation
  | 'stop_hook_prevented' // Stop hook forced an extra iteration then gave up

export type Terminal = { reason: TerminalReason; detail?: string }

/**
 * Why the previous iteration CONTINUED. Undefined on the first iteration.
 * Stored on loop state so tests/observers can assert which recovery path fired
 * without parsing message contents. PROVENANCE: src/query.ts:214-216.
 */
export type ContinueReason =
  | 'next_turn'                 // normal: tools ran, feed results back
  | 'reactive_compact_retry'    // hit context limit mid-turn → compacted → retry
  | 'max_output_tokens_recovery'// max_tokens error → raised budget → retry
  | 'stop_hook_blocking'        // Stop hook requested another iteration
  | 'token_budget_continuation' // budget auto-continue nudge

export type Continue = { reason: ContinueReason }

/** Convenience guards. */
export const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use'
export const isText = (b: ContentBlock): b is TextBlock => b.type === 'text'

/**
 * Build a low-authority, system-injected user message (the `<system-reminder>`
 * isMeta channel). PROVENANCE: messages.ts:3097. Used to inject todos, memory,
 * compaction summaries, and reinjected live-state WITHOUT polluting the system
 * prompt or impersonating a real user turn. The model is told isMeta content is
 * system-injected and low-authority.
 */
export function metaUser(uuid: string, text: string): UserMessage {
  return { type: 'user', uuid, content: [{ type: 'text', text }], isMeta: true }
}
