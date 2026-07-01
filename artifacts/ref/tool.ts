/**
 * ============================================================================
 * @module        tool
 * @patterns      #7 (fail-closed Tool contract + buildTool defaults),
 *                supports #4 (concurrency predicate) and the permission seam
 * @intent        One uniform Tool contract every capability implements, plus a
 *                factory that injects PESSIMISTIC safety defaults so a tool
 *                author opts IN to parallelism/read-only, never by omission.
 * @source        Claude Code v2.1.88:
 *                  - Tool contract + TOOL_DEFAULTS: src/Tool.ts:362-695,757-792
 *                  - isConcurrencySafe(input) batching key: toolOrchestration.ts
 *                  - prompt() vs description() split: src/Tool.ts
 * @depends       ./types
 * @invariant     buildTool defaults isReadOnly=false and isConcurrencySafe=false.
 *                A tool that mutates state but forgets the override is treated
 *                as UNSAFE → serialized, never silently parallelized.
 * @porting       Replace `inputSchema: object` with your validation lib's JSON
 *                Schema (Claude Code serializes a Zod schema, cached by tool
 *                name for prompt-cache byte stability — utils/api.ts:119-266).
 * ============================================================================
 */

import type { ToolResultBlock } from './types'

/** What the model sees in the API `tools` array. */
export type ToolSchema = {
  name: string
  description: string
  input_schema: object
}

/** Per-call execution context threaded to tools and the permission check. */
export type ToolContext = {
  signal: AbortSignal
  /** UUID factory (injected so the loop is deterministic/testable). */
  newUuid: () => string
  /** Set when running inside a sub-agent; isolates telemetry/permissions. */
  agentId?: string
}

export type Validated<I> = { ok: true; value: I } | { ok: false; error: string }

/**
 * The resolved, fail-closed tool. All capability flags are concrete predicates.
 */
export interface Tool<I = unknown> {
  readonly name: string
  /** Full instructions for the MODEL (large). PROVENANCE: Tool.prompt(). */
  readonly prompt: string
  /** One-line label for permission dialogs (small). PROVENANCE: Tool.description(). */
  readonly description: string
  readonly inputSchema: object
  validate(input: unknown): Validated<I>
  /** No side effects? Default false. */
  isReadOnly(input: I): boolean
  /** Safe to run concurrently with sibling tool calls? Default false (#4). */
  isConcurrencySafe(input: I): boolean
  call(input: I, ctx: ToolContext): Promise<string>
}

/** Author-facing definition: only `name`, `prompt`, `inputSchema`, `call` required. */
export type ToolDef<I> = {
  name: string
  prompt: string
  description?: string
  inputSchema: object
  validate?: (input: unknown) => Validated<I>
  isReadOnly?: (input: I) => boolean
  isConcurrencySafe?: (input: I) => boolean
  call: (input: I, ctx: ToolContext) => Promise<string>
}

/**
 * Factory that injects SAFE-by-default behavior. PROVENANCE: Tool.ts buildTool +
 * TOOL_DEFAULTS (Tool.ts:757-792). Exposure is optimistic (a tool is enabled
 * unless gated) but safety is pessimistic (read-only/concurrency default false).
 */
export function buildTool<I>(def: ToolDef<I>): Tool<I> {
  return {
    name: def.name,
    prompt: def.prompt,
    description: def.description ?? def.name,
    inputSchema: def.inputSchema,
    validate: def.validate ?? ((input: unknown) => ({ ok: true, value: input as I })),
    isReadOnly: def.isReadOnly ?? (() => false),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    call: def.call,
  }
}

/* -------------------------------------------------------------------------- */
/* Permission seam (deny > ask > allow lives behind this fn — pattern #8)     */
/* -------------------------------------------------------------------------- */

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }

/**
 * The single gate between a validated tool call and execution. Implementations
 * must enforce deny > ask > allow ORDER (not scoring), with explicit denials
 * evaluated BEFORE any bypass mode. PROVENANCE: permissions.ts:1158-1300.
 * `input` is already-validated (post-`validate`) so path/argv checks are exact.
 */
export type CanUseTool = (
  toolName: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<PermissionDecision>

/** Build a tool_result block. Centralized so every exit path pairs a tool_use (#5). */
export function toolResult(toolUseId: string, content: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }
}
