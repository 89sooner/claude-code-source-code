/**
 * ============================================================================
 * @module        context-usage
 * @patterns      #9 (usage-based context gauge + thresholds + circuit breaker)
 * @intent        Measure how full the context window is from the PROVIDER'S
 *                usage report (not cumulative estimation), and decide when
 *                reduction must fire — with a circuit breaker so a context that
 *                is irrecoverably over-limit doesn't retry forever.
 * @source        Claude Code v2.1.88:
 *                  - canonical gauge `tokenCountWithEstimation`: src/utils/tokens.ts:226
 *                  - reserved output 20k (p99.99 summary = 17,387 tok): autoCompact.ts:28-30
 *                  - buffer 13k + threshold = effectiveWindow - buffer: autoCompact.ts:62,72-91
 *                  - effectiveWindow = window - min(maxOutput, 20k): autoCompact.ts:33-49
 *                  - circuit breaker = 3 consecutive failures (BQ: 1,279 sessions
 *                    hit 50+ failures, ~250K wasted calls/day): autoCompact.ts:67-70
 * @depends       ./types
 * @invariant     Fullness is read from the LAST usage-bearing assistant message
 *                (the provider's own count of the prompt it saw) plus a rough
 *                estimate of messages added since — NEVER summed cumulatively
 *                (that double-counts as context grows).
 * @gotcha        Parallel tool calls split into multiple assistant records that
 *                share one `responseId` + one `usage`. Anchor to the FIRST such
 *                sibling so interleaved tool_results between siblings are counted.
 * @porting       Replace `roughTokenEstimate` (chars/4) with your tokenizer for
 *                accuracy. Feed `contextWindow`/`maxOutputTokens` from your
 *                model's limits.
 * ============================================================================
 */

import type { AssistantMessage, Message, Usage } from './types'

/** Reserve for the summary's own output. PROVENANCE: autoCompact.ts:30. */
export const RESERVED_OUTPUT_TOKENS = 20_000
/** Headroom below the effective window. PROVENANCE: autoCompact.ts:62. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
/** Stop retrying summarization after this many consecutive failures. autoCompact.ts:70. */
export const MAX_CONSECUTIVE_FAILURES = 3

/** Caller-owned circuit-breaker state. PROVENANCE: AutoCompactTrackingState, autoCompact.ts:51-60. */
export type CompactTracking = { consecutiveFailures: number }

/** window - min(maxOutput, RESERVED). PROVENANCE: getEffectiveContextWindowSize, autoCompact.ts:33-49. */
export function effectiveContextWindow(contextWindow: number, maxOutputTokens: number): number {
  return contextWindow - Math.min(maxOutputTokens, RESERVED_OUTPUT_TOKENS)
}

/** effectiveWindow - buffer. PROVENANCE: getAutoCompactThreshold, autoCompact.ts:72-91. */
export function autoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  return effectiveContextWindow(contextWindow, maxOutputTokens) - AUTOCOMPACT_BUFFER_TOKENS
}

/** Sum the provider's usage fields into a prompt-size estimate. */
export function tokenCountFromUsage(u: Usage): number {
  return (
    u.input_tokens +
    u.output_tokens +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  )
}

const isAssistant = (m: Message): m is AssistantMessage => m.type === 'assistant'

/** Provider-agnostic rough estimate (chars/4). Replace with a real tokenizer. */
export function roughTokenEstimate(messages: readonly Message[]): number {
  let chars = 0
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_result') chars += b.content.length
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length
      else if (b.type === 'thinking') chars += b.thinking.length
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Current context size in tokens. PROVENANCE: tokenCountWithEstimation
 * (tokens.ts:226). Find the last usage-bearing assistant message, anchor back
 * to the first sibling sharing its `responseId`, then add a rough estimate of
 * everything after the anchor.
 */
export function contextTokensFromUsage(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (isAssistant(m) && tokenCountFromUsage(m.usage) > 0) {
      const id = m.responseId ?? m.uuid
      let anchor = i
      for (let j = i - 1; j >= 0; j--) {
        const p = messages[j]!
        if (isAssistant(p)) {
          if ((p.responseId ?? p.uuid) === id) anchor = j // earlier split of same response
          else break // a different response — stop
        }
        // non-assistant (tool_result/user) between splits: keep walking.
      }
      return tokenCountFromUsage(m.usage) + roughTokenEstimate(messages.slice(anchor + 1))
    }
  }
  return roughTokenEstimate(messages)
}

/** Is the context over the auto-compact threshold? */
export function isOverThreshold(
  messages: readonly Message[],
  contextWindow: number,
  maxOutputTokens: number,
): boolean {
  return contextTokensFromUsage(messages) > autoCompactThreshold(contextWindow, maxOutputTokens)
}
