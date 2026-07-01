/**
 * ============================================================================
 * @module        compaction
 * @patterns      #9 (tiered cheap->expensive reduction wired to the loop seam),
 *                #10 (compaction = narrative summary + structured live-state
 *                     reinjection)
 * @intent        Implement `agentLoop`'s `reduceContext` seam: measure usage,
 *                then escalate only as needed —
 *                  (cheap)     microcompact: clear old tool_result CONTENT
 *                  (expensive) summarize older messages + RE-INJECT structured
 *                              live-state (todos/plan/files/skills) from the
 *                              out-of-band store, not from the lossy summary.
 *                A circuit breaker stops retrying a context that can't shrink.
 * @source        Claude Code v2.1.88:
 *                  - reduction pipeline order (budget->snip->microcompact->
 *                    collapse->autocompact), each tier's freed tokens plumbed
 *                    to the next threshold: src/query.ts:379-465
 *                  - microcompact clears old tool results: microCompact.ts:253-293
 *                  - 9-section summary prompt + hidden <analysis> + verbatim
 *                    next-step quotes + no-tools preamble: compact/prompt.ts:19-129
 *                  - post-compact reinjection (files/plan/skills): compact.ts:1415,1470,1494
 * @depends       ./types ./context-usage ./live-state
 * @invariant     Reduction is monotone in safety: cheap tiers run first; the
 *                expensive summary is a LAST resort; clearing a tool_result only
 *                replaces its CONTENT (the tool_use/tool_result PAIR is kept, so
 *                the #5 invariant and API validity hold).
 * @invariant     Live-state is re-injected from the out-of-band store, NEVER
 *                trusted to survive inside the summary text.
 * @porting       `summarize` is YOUR model call (a forked/cheap turn). Default
 *                prompt below is faithful to the source's 9 sections. File
 *                re-reading uses your injected `readFile`. The microcompact here
 *                is the provider-agnostic LOCAL path; Claude Code prefers a
 *                cache-edit path that frees tokens without invalidating the
 *                prompt-cache prefix (apiMicrocompact.ts) — see @gotcha.
 * @gotcha        Local microcompact MUTATES message content => it changes the
 *                cached prefix => the next request is a cache MISS. Claude Code's
 *                time-based variant only clears when the server cache is already
 *                COLD (gap > TTL), so it never forces an avoidable miss
 *                (timeBasedMCConfig.ts). Gate your clear on cache-coldness too.
 * ============================================================================
 */

import { type Message, type UserMessage, metaUser } from './types'
import {
  type CompactTracking,
  MAX_CONSECUTIVE_FAILURES,
  autoCompactThreshold,
  contextTokensFromUsage,
  roughTokenEstimate,
} from './context-usage'
import { type LiveStateStore, type ReadFileEntry, renderTodos } from './live-state'

/* -------------------------------------------------------------------------- */
/* Cheap tier: microcompact (#9)                                              */
/* -------------------------------------------------------------------------- */

export const KEEP_RECENT_TURNS_DEFAULT = 8
const CLEARED_MARKER = '[tool result cleared to reclaim context]'

export type MicrocompactResult = { messages: Message[]; tokensFreed: number }

/**
 * Clear the CONTENT of tool_result blocks older than the recent tail, keeping
 * the blocks themselves (so tool_use/result pairing stays valid). Returns the
 * rewritten messages and an estimate of tokens freed (plumbed to the next
 * threshold check). PROVENANCE: microCompact.ts:253-293 (local clear path).
 *
 * SIMPLIFICATION: source clears only a COMPACTABLE_TOOLS allow-list
 * (Read/Bash/Grep/Glob/WebSearch/WebFetch/Edit/Write — microCompact.ts:41-50,
 * with special image handling). This ref clears ALL old tool_results (simpler;
 * still preserves the pair + #5 invariant). Add an allow-list if some results
 * must persist (e.g. small structured outputs the model still needs verbatim).
 */
export function microcompact(
  messages: Message[],
  keepRecent: number = KEEP_RECENT_TURNS_DEFAULT,
): MicrocompactResult {
  const boundary = Math.max(0, messages.length - keepRecent)
  let freedChars = 0
  const out = messages.map((m, idx) => {
    if (idx >= boundary || m.type !== 'user') return m
    let changed = false
    const content = m.content.map(b => {
      if (b.type === 'tool_result' && !b.content.startsWith(CLEARED_MARKER)) {
        freedChars += b.content.length
        changed = true
        return { ...b, content: `${CLEARED_MARKER} (id=${b.tool_use_id})` }
      }
      return b
    })
    return changed ? ({ ...m, content } as UserMessage) : m
  })
  return { messages: out, tokensFreed: Math.ceil(freedChars / 4) }
}

/* -------------------------------------------------------------------------- */
/* Expensive tier: summarize + reinject (#10)                                 */
/* -------------------------------------------------------------------------- */

/** Your model call: turn the older messages into a narrative summary string. */
export type Summarize = (olderMessages: Message[]) => Promise<string>

/** Re-read a file fresh at reinjection time. Return null if unreadable. */
export type ReadFile = (path: string) => Promise<string | null>

/**
 * The faithful 9-section summary instruction. PROVENANCE: compact/prompt.ts:61-129.
 * Feed this (plus the conversation) to your `summarize` model call. Section 9
 * REQUIRES verbatim quotes of the in-progress work to prevent task drift; the
 * hidden <analysis> scratchpad must be stripped before the summary is injected.
 */
export const COMPACT_PROMPT_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and fixes',
  'Problem Solving',
  'All user messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step (with VERBATIM quotes of where you left off)',
] as const

export function buildCompactPrompt(): string {
  return (
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
    'Create a detailed summary of the conversation so far, capturing technical ' +
    'details, code patterns, and decisions needed to continue without losing ' +
    'context. First draft your reasoning inside <analysis>...</analysis> (it will ' +
    'be stripped), then emit <summary>...</summary> with these numbered sections:\n' +
    COMPACT_PROMPT_SECTIONS.map((s, i) => `${i + 1}. ${s}`).join('\n')
  )
}

export const POST_COMPACT_MAX_FILES = 5
/** Illustrative defaults — source uses POST_COMPACT_TOKEN_BUDGET / _MAX_TOKENS_PER_FILE
 *  (exact values not verified in this pass). */
export const POST_COMPACT_TOKEN_BUDGET = 25_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 8_000

export type ReinjectOptions = {
  liveState?: LiveStateStore
  readFile?: ReadFile
  newUuid: () => string
  maxFiles?: number
}

/** Paths already visible as Read tool_results in the preserved tail (skip those). */
function preservedReadPaths(recent: Message[]): Set<string> {
  const paths = new Set<string>()
  for (const m of recent) {
    if (m.type !== 'user') continue
    for (const b of m.content) {
      // Heuristic: tool_result content tagged with a path marker. Adapt to your
      // own Read tool's result shape. PROVENANCE: collectReadToolFilePaths.
      if (b.type === 'tool_result') {
        const match = /^\[file:([^\]]+)\]/.exec(b.content)
        if (match) paths.add(match[1]!)
      }
    }
  }
  return paths
}

/**
 * Re-read recently accessed files (fresh content), newest-first, capped by file
 * count AND token budget, skipping files already in the preserved tail.
 * PROVENANCE: createPostCompactFileAttachments (compact.ts:1415-1464).
 */
async function reinjectFiles(
  files: Record<string, ReadFileEntry>,
  recent: Message[],
  opts: ReinjectOptions,
): Promise<UserMessage[]> {
  const skip = preservedReadPaths(recent)
  const ranked = Object.entries(files)
    .filter(([path]) => !skip.has(path))
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, opts.maxFiles ?? POST_COMPACT_MAX_FILES)

  const out: UserMessage[] = []
  let used = 0
  for (const [path, entry] of ranked) {
    const fresh = opts.readFile ? await opts.readFile(path) : entry.content
    if (fresh === null) continue
    const clipped = clampTokens(fresh, POST_COMPACT_MAX_TOKENS_PER_FILE)
    const cost = roughTokenEstimate([metaUser('x', clipped)])
    // skip the over-budget file but keep trying later (smaller) candidates —
    // mirrors source's filter (compact.ts:1452-1463), which does NOT break.
    if (used + cost > POST_COMPACT_TOKEN_BUDGET) continue
    used += cost
    out.push(metaUser(opts.newUuid(), `<file path="${path}">\n${clipped}\n</file>`))
  }
  return out
}

function clampTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…[truncated]'
}

/**
 * Summarize the older prefix and rebuild the context as:
 *   [summary(isMeta)] + [recent tail] + [reinjected live-state(isMeta)]
 * PROVENANCE: compact.ts (summary) + 1415/1470/1494 (reinjection).
 */
export async function summarizeAndReinject(
  messages: Message[],
  opts: ReinjectOptions & { summarize: Summarize; keepRecent?: number },
): Promise<Message[]> {
  const keep = opts.keepRecent ?? KEEP_RECENT_TURNS_DEFAULT
  const boundary = Math.max(0, messages.length - keep)
  const older = messages.slice(0, boundary)
  const recent = messages.slice(boundary)
  if (older.length === 0) return messages

  const summaryText = await opts.summarize(older)
  const summaryMsg = metaUser(opts.newUuid(), `<summary>\n${summaryText}\n</summary>`)

  const reinjections: UserMessage[] = []
  const ls = opts.liveState

  const plan = ls?.getPlan?.()
  if (plan) reinjections.push(metaUser(opts.newUuid(), `<plan>\n${plan}\n</plan>`))

  const todos = ls?.getTodos?.()
  if (todos && todos.length > 0) {
    reinjections.push(metaUser(opts.newUuid(), `<todos>\n${renderTodos(todos)}\n</todos>`))
  }

  const skills = ls?.getInvokedSkills?.() ?? []
  for (const s of [...skills].sort((a, b) => b.invokedAt - a.invokedAt)) {
    reinjections.push(
      metaUser(opts.newUuid(), `<skill name="${s.name}">\n${clampTokens(s.content, 2_000)}\n</skill>`),
    )
  }

  const files = ls?.getReadFiles?.()
  if (files) reinjections.push(...(await reinjectFiles(files, recent, opts)))

  return [summaryMsg, ...recent, ...reinjections]
}

/* -------------------------------------------------------------------------- */
/* The tiered reducer that plugs into agentLoop.reduceContext (#9)            */
/* -------------------------------------------------------------------------- */

export type ReduceContextOptions = {
  contextWindow: number
  maxOutputTokens: number
  summarize: Summarize
  liveState?: LiveStateStore
  readFile?: ReadFile
  keepRecentTurns?: number
  newUuid: () => string
  /** Caller-owned circuit-breaker state (shared across turns). */
  tracking?: CompactTracking
}

/**
 * Build the `reduceContext` function for `agentLoop`. Order mirrors query.ts:
 * measure -> (cheap) microcompact -> re-measure -> (expensive) summarize+reinject,
 * guarded by a 3-failure circuit breaker.
 */
export function makeReduceContext(
  opts: ReduceContextOptions,
): (messages: Message[]) => Promise<Message[]> {
  const tracking = opts.tracking ?? { consecutiveFailures: 0 }
  const threshold = autoCompactThreshold(opts.contextWindow, opts.maxOutputTokens)

  return async (messages: Message[]): Promise<Message[]> => {
    if (contextTokensFromUsage(messages) <= threshold) return messages // under budget

    // cheap tier (#9): microcompact, plumb freed tokens into the next check.
    const mc = microcompact(messages, opts.keepRecentTurns)
    const afterCheap = contextTokensFromUsage(mc.messages) - mc.tokensFreed
    if (afterCheap <= threshold) return mc.messages

    // circuit breaker (#9 / E2): give up if the context won't shrink.
    if (tracking.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return mc.messages

    // expensive tier (#10): summarize + reinject structured live-state.
    try {
      const reduced = await summarizeAndReinject(mc.messages, {
        summarize: opts.summarize,
        liveState: opts.liveState,
        readFile: opts.readFile,
        keepRecent: opts.keepRecentTurns,
        newUuid: opts.newUuid,
      })
      tracking.consecutiveFailures = 0
      return reduced
    } catch {
      tracking.consecutiveFailures += 1
      return mc.messages // ride this turn on the cheap reduction; upstream may stop
    }
  }
}
