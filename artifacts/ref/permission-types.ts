/**
 * ============================================================================
 * @module        permission-types
 * @patterns      #8 (deny>ask>allow types), #14 (shell rule strings)
 * @intent        Faithful permission type model: behaviors, rules (source +
 *                behavior + value), the rich decision/result union with a
 *                machine-readable `decisionReason`, and the per-conversation
 *                permission context (modes + allow/deny/ask rule sets).
 * @source        Claude Code v2.1.88: src/types/permissions.ts
 *                  - PermissionBehavior / PermissionRule / sources: 44-79
 *                  - PermissionDecisionReason union (rule/mode/safetyCheck/
 *                    subcommandResults/...): 271-324
 *                  - PermissionResult = decision | passthrough: 251-266
 *                  - ToolPermissionContext (mode + alwaysAllow/Deny/AskRules +
 *                    isBypassPermissionsModeAvailable): 427-441
 * @depends       (none)
 * @invariant     `decisionReason` is structured (a tagged union), never a bare
 *                string — the engine and UI branch on it (e.g. safetyCheck and
 *                content-rule asks are bypass-IMMUNE; see permission-engine.ts).
 * @porting       Rule strings use the user-facing DSL `Tool` or `Tool(content)`
 *                (e.g. `"Edit"`, `"Bash(npm run test:*)"`) — the same shape as
 *                settings.json `permissions.allow/deny/ask`.
 * ============================================================================
 */

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** Where a rule came from (precedence is by your loader; deny>ask>allow is by ENGINE order). */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

// Source also has feature-gated internal modes 'auto'/'bubble' (types/permissions.ts:28); omitted here.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type PermissionRuleValue = { toolName: string; ruleContent?: string }
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

/** Why a decision was made. Structured so callers branch on intent. PROVENANCE: 271-324. */
export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'safetyCheck'; reason: string; classifierApprovable: boolean }
  | { type: 'subcommandResults'; reasons: Map<string, PermissionResult> }
  | { type: 'other'; reason: string }

export type AllowDecision = {
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  decisionReason?: PermissionDecisionReason
}
export type AskDecision = {
  behavior: 'ask'
  message: string
  decisionReason?: PermissionDecisionReason
  suggestions?: string[] // source: PermissionUpdate[] (types/permissions.ts:206); simplified to rule strings
}
export type DenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
}

/** A resolved decision. */
export type PermissionDecisionFull = AllowDecision | AskDecision | DenyDecision

/** Tool-level result; `passthrough` = "no opinion, fall through to mode/rules". PROVENANCE: 251-266. */
export type PermissionResult =
  | PermissionDecisionFull
  | { behavior: 'passthrough'; message: string; decisionReason?: PermissionDecisionReason }

export type RuleString = string // "Edit" | "Bash(npm run test:*)"
export type RulesBySource = Partial<Record<PermissionRuleSource, RuleString[]>>

export type ToolPermissionContext = {
  mode: PermissionMode
  alwaysAllowRules: RulesBySource
  alwaysDenyRules: RulesBySource
  alwaysAskRules: RulesBySource
  /** plan mode can bypass only if the user STARTED in bypass mode. */
  isBypassPermissionsModeAvailable: boolean
}

/** Parse a rule string of the DSL `Tool` or `Tool(content)`. */
export function parseRuleString(s: string): { toolName: string; content?: string } {
  const m = /^([^()]+)\((.*)\)$/.exec(s.trim())
  if (m) return { toolName: m[1]!.trim(), content: m[2] }
  return { toolName: s.trim() }
}

/** Iterate parsed rules across all sources. */
export function* iterRules(
  rules: RulesBySource,
): Generator<{ source: PermissionRuleSource; toolName: string; content?: string }> {
  for (const src of Object.keys(rules) as PermissionRuleSource[]) {
    for (const s of rules[src] ?? []) {
      yield { source: src, ...parseRuleString(s) }
    }
  }
}
