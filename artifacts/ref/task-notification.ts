/**
 * ============================================================================
 * @module        task-notification
 * @patterns      D3 (dual result channel: inline return vs <task-notification>
 *                injection), K1 (the priority message/steering queue)
 * @intent        Two ways a (sub)agent's result reaches the parent:
 *                  (a) INLINE  — finalizeAgentResult() => the agent's final text,
 *                                returned synchronously to the caller/tool_result.
 *                  (b) ASYNC   — enqueueAgentNotification() => an XML
 *                                <task-notification> pushed into the parent's
 *                                message queue as a synthetic user turn.
 * @source        Claude Code v2.1.88:
 *                  - inline finalize (last assistant text, fallback scan):
 *                    src/tools/AgentTool/agentToolUtils.ts:276-317 (finalizeAgentTool)
 *                  - async notification + atomic `notified` dedup + XML build:
 *                    src/tasks/LocalAgentTask/LocalAgentTask.tsx:197-262
 *                  - enqueue into the singleton priority queue (steering):
 *                    src/utils/messageQueueManager.ts (enqueuePendingNotification)
 * @depends       ./types
 * @invariant     A given task notifies AT MOST once — the `notified` flag is
 *                checked-and-set atomically before enqueue (e.g. TaskStop may
 *                have already notified).
 * @porting       The queue is a module-level singleton in Claude Code so the
 *                non-React agent loop and the React UI observe the same state
 *                without a render race (useSyncExternalStore bridge). Model it
 *                as any priority queue your loop drains between turns.
 * ============================================================================
 */

import { type AssistantMessage, type Message, isText } from './types'

/* -------------------------------------------------------------------------- */
/* (a) INLINE channel                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Extract the agent's final answer text for synchronous return.
 * PROVENANCE: finalizeAgentTool (agentToolUtils.ts:297-317). If the final
 * assistant message is a pure tool_use (loop exited mid-turn), fall back to
 * the most recent assistant message that actually has text.
 */
export function finalizeAgentResult(messages: Message[]): string {
  const assistants = messages.filter((m): m is AssistantMessage => m.type === 'assistant')
  const last = assistants[assistants.length - 1]
  // Source THROWS 'No assistant messages found' here (agentToolUtils.ts:298-300);
  // this ref returns '' for the degenerate case (more lenient).
  if (!last) return ''

  let textBlocks = last.content.filter(isText)
  if (textBlocks.length === 0) {
    for (let i = assistants.length - 1; i >= 0; i--) {
      const t = assistants[i]!.content.filter(isText)
      if (t.length > 0) {
        textBlocks = t
        break
      }
    }
  }
  return textBlocks.map(b => b.text).join('\n').trim()
}

/* -------------------------------------------------------------------------- */
/* (b) ASYNC channel                                                          */
/* -------------------------------------------------------------------------- */

/** Minimal slice of task state the dedup needs. Your store owns the rest. */
export type TaskNotificationState = { notified: boolean }

export type NotificationStatus = 'completed' | 'failed' | 'killed'

/** The priority queue the agent loop drains between turns (K1 steering backbone). */
export interface MessageQueue {
  enqueue(item: { value: string; mode: 'task-notification' | 'user' | 'system' }): void
}

export type NotificationArgs = {
  taskId: string
  description: string
  status: NotificationStatus
  outputPath: string
  toolUseId?: string
  error?: string
  finalMessage?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

/**
 * Build the `<task-notification>` XML. PROVENANCE: LocalAgentTask.tsx:246-257.
 * Shape is intentionally model-readable: a fenced, tagged block the parent
 * agent parses as "an async task finished" rather than a human message.
 */
export function buildTaskNotification(a: NotificationArgs): string {
  const summary =
    a.status === 'completed'
      ? `Agent "${a.description}" completed`
      : a.status === 'failed'
        ? `Agent "${a.description}" failed: ${a.error ?? 'Unknown error'}`
        : `Agent "${a.description}" was stopped`

  const toolUseIdLine = a.toolUseId ? `\n<tool-use-id>${a.toolUseId}</tool-use-id>` : ''
  const resultSection = a.finalMessage ? `\n<result>${a.finalMessage}</result>` : ''
  const usageSection = a.usage
    ? `\n<usage><total_tokens>${a.usage.totalTokens}</total_tokens>` +
      `<tool_uses>${a.usage.toolUses}</tool_uses>` +
      `<duration_ms>${a.usage.durationMs}</duration_ms></usage>`
    : ''

  return (
    `<task-notification>\n` +
    `<task-id>${a.taskId}</task-id>${toolUseIdLine}\n` +
    `<output-file>${a.outputPath}</output-file>\n` +
    `<status>${a.status}</status>\n` +
    `<summary>${summary}</summary>${resultSection}${usageSection}\n` +
    `</task-notification>`
  )
}

/**
 * Enqueue an agent's completion as a `<task-notification>` — exactly once.
 * PROVENANCE: enqueueAgentNotification (LocalAgentTask.tsx:197-262).
 * @returns true if a notification was enqueued, false if it was deduped.
 */
export function enqueueAgentNotification(
  queue: MessageQueue,
  state: TaskNotificationState,
  args: NotificationArgs,
): boolean {
  // [D3] atomic check-and-set: a prior path (e.g. TaskStop) may have notified.
  if (state.notified) return false
  state.notified = true

  queue.enqueue({ value: buildTaskNotification(args), mode: 'task-notification' })
  return true
}
