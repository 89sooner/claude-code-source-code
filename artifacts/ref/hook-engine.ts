/**
 * ============================================================================
 * @module        hook-engine
 * @patterns      #G1 (out-of-process lifecycle hook engine), #G2 (trust choke point)
 * @intent        Dispatch a lifecycle event to its configured hooks:
 *                (1) TRUST GATE (one choke point, RCE prevention),
 *                (2) two-stage cheap selection (matcher → `if`),
 *                (3) parallel fan-out over the 4 variants (command/prompt/agent/http),
 *                (4) fold results with deny>ask>allow precedence.
 * @source        Claude Code v2.1.88:
 *                  - shouldSkipHookDueToTrust: utils/hooks.ts:286-296
 *                  - matcher (literal|pipe|regex) + lazy `if` gate: events-gating recon
 *                  - command exit-code protocol (0/2/other): utils/hooks.ts
 *                  - deny>ask>allow merge switch: utils/hooks.ts:2820 (verbatim below)
 *                  - unbounded parallel fan-out: executeHooks `all(...)` (no cap)
 * @depends       ./hook-types ./permission-types ./bash-permission
 * @invariant     The trust gate is the FIRST thing runHooks does. Non-interactive
 *                (SDK) => implicit trust => always run; interactive => skip until
 *                the workspace trust dialog is accepted. Never register/spawn a
 *                hook before this gate.
 * @invariant     `permissionBehavior` folds by deny>ask>allow ORDER (passthrough
 *                is a no-op); `updatedInput` is forwarded ONLY from a hook whose
 *                behavior is allow/ask/undefined (a denying hook can't also rewrite).
 * @gotcha        The `if` gate is the permission-rule DSL and is only honored on
 *                TOOL events (a hook with `if` on a non-tool event is dropped).
 *                Source builds a PER-TOOL matcher; this ref extracts a per-tool
 *                target string (command/file_path/...) via `defaultIfTarget` —
 *                supply a custom `ifTarget` for tools whose match field differs.
 * @porting       Command hooks run out-of-process; inject a `runCommand` that
 *                spawns the child, writes the HookInput JSON to stdin, and returns
 *                {exitCode, stdout, stderr}. prompt/agent are LLM calls; http is a POST.
 * ============================================================================
 */

import {
  type AggregatedHookResult,
  type CommandHook,
  type HookCommand,
  type HookEvent,
  type HookInput,
  type HookResult,
  type HooksSettings,
  type SyncHookJSONOutput,
  type ToolHookInput,
  emptyAggregate,
  isToolHookEvent,
} from './hook-types'
import { parseRuleString } from './permission-types'
import { matchPattern } from './bash-permission'

/* -------------------------------------------------------------------------- */
/* Trust gate (#G2)                                                           */
/* -------------------------------------------------------------------------- */

export type TrustGate = { isNonInteractive: boolean; trustAccepted: boolean }

/** PROVENANCE: shouldSkipHookDueToTrust, utils/hooks.ts:286-296. */
export function shouldSkipHookDueToTrust(gate: TrustGate): boolean {
  if (gate.isNonInteractive) return false // SDK/headless: implicit trust, always run
  return !gate.trustAccepted // interactive: skip until the trust dialog is accepted
}

/* -------------------------------------------------------------------------- */
/* Two-stage selection: matcher (stage 1) then `if` (stage 2, tool events)    */
/* -------------------------------------------------------------------------- */

/** Stage 1. Literal/pipe-list when /^[A-Za-z0-9_|]+$/, else regex. undefined/'*' = all. */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(toolName)
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return false
  }
}

/**
 * Stage 2. The `if` condition IS the permission-rule DSL (e.g. "Bash(git *)",
 * "Read(src/**)"). Source builds a PER-TOOL matcher (tool.preparePermissionMatcher,
 * hooks.ts:1406-1419); this ref approximates it by matching `content` against a
 * per-tool TARGET string extracted from the tool input. Supply a custom
 * `IfMatchTarget` to mirror a specific tool's matcher exactly.
 */
export type IfMatchTarget = (toolInput: unknown) => string

/** Extract the string the `if` content matches against. Covers common tools so a
 *  non-Bash `if` guard (e.g. Read(secrets/**)) is NOT silently dropped. */
export const defaultIfTarget: IfMatchTarget = (toolInput) => {
  const o = toolInput as Record<string, unknown> | null | undefined
  for (const k of ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query']) {
    const v = o?.[k]
    if (typeof v === 'string') return v
  }
  return ''
}

export function ifMatches(
  ifCond: string,
  toolName: string,
  toolInput: unknown,
  target: IfMatchTarget = defaultIfTarget,
): boolean {
  const { toolName: t, content } = parseRuleString(ifCond)
  if (t !== toolName) return false
  if (content === undefined) return true
  return matchPattern(content, target(toolInput))
}

export function selectHooks(
  config: HooksSettings,
  event: HookEvent,
  toolName: string,
  toolInput: unknown,
  ifTarget: IfMatchTarget = defaultIfTarget,
): HookCommand[] {
  const out: HookCommand[] = []
  for (const m of config[event] ?? []) {
    if (!matcherMatches(m.matcher, toolName)) continue // stage 1
    for (const h of m.hooks) {
      if (h.if !== undefined) {
        // stage 2 — only meaningful on tool events; otherwise the hook is dropped.
        if (!isToolHookEvent(event) || !ifMatches(h.if, toolName, toolInput, ifTarget)) continue
      }
      out.push(h)
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Per-variant execution                                                     */
/* -------------------------------------------------------------------------- */

export type HookRunners = {
  /** Spawn the command hook: write HookInput JSON to stdin, capture stdout/stderr/exit. */
  runCommand: (hook: CommandHook, input: HookInput, signal: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** LLM prompt hook => {ok, reason}. ok=false blocks. */
  runPrompt?: (hook: Extract<HookCommand, { type: 'prompt' }>, input: HookInput) => Promise<{ ok: boolean; reason?: string }>
  /** Sub-agent hook => {ok, reason}. */
  runAgent?: (hook: Extract<HookCommand, { type: 'agent' }>, input: HookInput) => Promise<{ ok: boolean; reason?: string }>
  /** HTTP POST hook => JSON control. */
  runHttp?: (hook: Extract<HookCommand, { type: 'http' }>, input: HookInput) => Promise<SyncHookJSONOutput>
}

function tryParseJSON(s: string): SyncHookJSONOutput | null {
  const trimmed = s.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as SyncHookJSONOutput
  } catch {
    return null
  }
}

/** Map a SyncHookJSONOutput (advanced control) into a HookResult. */
function fromJSON(json: SyncHookJSONOutput, outcome: HookResult['outcome']): HookResult {
  const r: HookResult = { outcome }
  if (json.continue === false) {
    r.preventContinuation = true
    r.stopReason = json.stopReason
  }
  // legacy generic gate: 'approve' => allow, 'block' => deny + blocking.
  if (json.decision === 'approve') r.permissionBehavior = 'allow'
  if (json.decision === 'block') {
    r.outcome = 'blocking'
    r.permissionBehavior = 'deny'
    r.blockingError = json.reason ?? 'Hook blocked'
  }
  if (json.systemMessage) r.systemMessage = json.systemMessage
  if (json.suppressOutput) r.suppressOutput = true
  const hso = json.hookSpecificOutput
  if (hso) {
    if ('additionalContext' in hso && hso.additionalContext) r.additionalContext = hso.additionalContext
    if (hso.hookEventName === 'PreToolUse') {
      if (hso.permissionDecision) r.permissionBehavior = hso.permissionDecision
      if (hso.permissionDecisionReason) r.permissionDecisionReason = hso.permissionDecisionReason
      if (hso.updatedInput) r.updatedInput = hso.updatedInput
    }
    if (hso.hookEventName === 'PostToolUse' && hso.updatedMCPToolOutput !== undefined) {
      r.updatedMCPToolOutput = hso.updatedMCPToolOutput
    }
  }
  return r
}

async function executeHook(hook: HookCommand, input: HookInput, runners: HookRunners, signal: AbortSignal): Promise<HookResult> {
  try {
    switch (hook.type) {
      case 'command': {
        const { exitCode, stdout, stderr } = await runners.runCommand(hook, input, signal)
        // [#G1] JSON control is honored FIRST, regardless of exit code (source:
        // parseHookOutput before the exit-code branch). The exit code is the
        // PLAIN-TEXT fallback: 0=success, 2=BLOCK(+stderr fed to model), other=non-blocking.
        const json = tryParseJSON(stdout)
        if (json) return fromJSON(json, 'success')
        if (exitCode === 0) return { outcome: 'success' }
        if (exitCode === 2) return { outcome: 'blocking', blockingError: stderr.trim() || 'No stderr output (exit 2)' }
        return { outcome: 'non_blocking_error', systemMessage: stderr.trim() || `Hook exited ${exitCode}` }
      }
      case 'prompt': {
        const { ok, reason } = await runners.runPrompt!(hook, input)
        // prompt-hook non-met => preventContinuation + stopReason.
        return ok ? { outcome: 'success' } : { outcome: 'blocking', preventContinuation: true, stopReason: reason, blockingError: reason }
      }
      case 'agent': {
        const { ok, reason } = await runners.runAgent!(hook, input)
        // agent-hook non-met => blocking only (NO preventContinuation).
        return ok ? { outcome: 'success' } : { outcome: 'blocking', blockingError: reason }
      }
      case 'http': {
        const json = await runners.runHttp!(hook, input)
        return fromJSON(json, 'success')
      }
    }
  } catch {
    return { outcome: 'non_blocking_error' } // a failing hook must not crash the turn
  }
}

/* -------------------------------------------------------------------------- */
/* Fold results — deny>ask>allow                                             */
/* -------------------------------------------------------------------------- */

export function mergeResults(results: HookResult[]): AggregatedHookResult {
  const agg = emptyAggregate()
  let perm: 'allow' | 'deny' | 'ask' | undefined
  for (const r of results) {
    // PROVENANCE (verbatim), utils/hooks.ts:2820:
    // deny wins; ask only if not already deny; allow only if nothing set; passthrough no-op.
    switch (r.permissionBehavior) {
      case 'deny':
        perm = 'deny'
        break
      case 'ask':
        if (perm !== 'deny') perm = 'ask'
        break
      case 'allow':
        if (!perm) perm = 'allow'
        break
      default:
        break // 'passthrough' | undefined
    }
    if (r.blockingError) agg.blockingErrors.push(r.blockingError)
    if (r.additionalContext) agg.additionalContexts.push(r.additionalContext)
    if (r.systemMessage) agg.systemMessages.push(r.systemMessage)
    if (r.preventContinuation) {
      agg.preventContinuation = true
      agg.stopReason ??= r.stopReason
    }
    if (r.permissionDecisionReason && !agg.permissionDecisionReason) {
      agg.permissionDecisionReason = r.permissionDecisionReason
    }
    // updatedInput only from an allow/ask/undecided hook (a denier can't rewrite).
    if (r.updatedInput && (r.permissionBehavior === 'allow' || r.permissionBehavior === 'ask' || r.permissionBehavior === undefined)) {
      agg.updatedInput = r.updatedInput
    }
    if (r.updatedMCPToolOutput !== undefined) agg.updatedMCPToolOutput = r.updatedMCPToolOutput
  }
  agg.permissionBehavior = perm
  return agg
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                */
/* -------------------------------------------------------------------------- */

export async function runHooks(args: {
  event: HookEvent
  input: ToolHookInput | HookInput
  config: HooksSettings
  runners: HookRunners
  gate: TrustGate
  signal?: AbortSignal
  /** Per-tool `if`-target extractor (see ifMatches). Defaults to defaultIfTarget. */
  ifTarget?: IfMatchTarget
}): Promise<AggregatedHookResult> {
  // [#G2] TRUST CHOKE POINT — first, before any selection or spawn.
  if (shouldSkipHookDueToTrust(args.gate)) return emptyAggregate()

  const toolName = typeof (args.input as ToolHookInput).tool_name === 'string' ? (args.input as ToolHookInput).tool_name : ''
  const toolInput = (args.input as ToolHookInput).tool_input
  const hooks = selectHooks(args.config, args.event, toolName, toolInput, args.ifTarget)
  if (hooks.length === 0) return emptyAggregate()

  const signal = args.signal ?? new AbortController().signal
  // [#G1] UNBOUNDED parallel fan-out (source uses all(...) with no cap).
  const results = await Promise.all(hooks.map(h => executeHook(h, args.input, args.runners, signal)))
  return mergeResults(results)
}
