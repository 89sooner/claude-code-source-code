/**
 * ============================================================================
 * @module        live-state
 * @patterns      #10 (the out-of-band live-state that SURVIVES compaction)
 * @intent        Define the store of structured task state that lives OUTSIDE
 *                the message array — so that when old messages are summarized
 *                away, the precise live state (todos, plan, recently-read files,
 *                invoked skills) can be re-injected verbatim rather than relying
 *                on the lossy narrative summary.
 * @source        Claude Code v2.1.88: the post-compaction reinjection sources —
 *                  - recently-read files: compact.ts:1415 (createPostCompactFileAttachments)
 *                  - plan file: compact.ts:1470 (createPlanAttachmentIfNeeded)
 *                  - invoked skills: compact.ts:1494 (createSkillAttachmentIfNeeded)
 *                  - todos (transcript-derived, app-state): TodoWriteTool.ts:65; attachments.ts:254-257
 * @depends       (none)
 * @invariant     This state is owned by the HOST app-state, not the transcript.
 *                That is precisely why it survives a transcript rewrite/compact
 *                (todos/plan/file cache are not in `messages`).
 * @porting       Back each getter with your own app-state store. Keep them
 *                cheap/synchronous (called on every compaction). File CONTENT
 *                should be re-read fresh at reinjection time (see compaction.ts).
 * ============================================================================
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type Todo = { content: string; status: TodoStatus }

export type ReadFileEntry = { content: string; timestamp: number }

export type InvokedSkill = { name: string; content: string; invokedAt: number }

/**
 * Out-of-band live state to re-inject after compaction. Every getter is
 * optional — supply only what your agent tracks.
 */
export interface LiveStateStore {
  /** Current todo list (transcript-derived in Claude Code; app-state here). */
  getTodos?(): Todo[]
  /** Active plan text, or null. */
  getPlan?(): string | null
  /**
   * path -> {content, timestamp}. Recency drives which files get re-read.
   * EXCLUDE plan/memory files here — they are reinjected separately, so leaving
   * them in would double-inject. Mirrors shouldExcludeFromPostCompactRestore
   * (compact.ts:1426).
   */
  getReadFiles?(): Record<string, ReadFileEntry>
  /** Skills the agent invoked this session (re-injected most-recent-first). */
  getInvokedSkills?(): InvokedSkill[]
}

/** Render todos compactly for reinjection. */
export function renderTodos(todos: Todo[]): string {
  const mark = (s: TodoStatus): string =>
    s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]'
  return todos.map(t => `${mark(t.status)} ${t.content}`).join('\n')
}
