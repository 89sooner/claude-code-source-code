/**
 * ============================================================================
 * @module        bash-permission
 * @patterns      #14 (shell rule DSL + anti-bypass: asymmetric normalization,
 *                compound-command guard, dangerous allow-prefix stripping)
 * @intent        A `ToolPermissionChecker` for a shell tool. The single most
 *                reusable insight: ALLOW and DENY normalize the command
 *                ASYMMETRICALLY — allow conservatively (only safe env vars
 *                stripped, no wrappers), deny aggressively (every env-var
 *                assignment + wrapper stripped to a fixed point). Plus a
 *                compound-command guard so `safe && rm -rf /` cannot slip
 *                through an allow on `safe`.
 * @source        Claude Code v2.1.88:
 *                  - rule DSL exact/prefix(:*)/wildcard + matchWildcardPattern
 *                    (escape, \* / \\, trailing ' *' optional, dotAll):
 *                    src/utils/permissions/shellRuleMatching.ts:43-184
 *                  - dangerous allow-prefixes (interpreters/shells/eval) that an
 *                    allow rule must NOT grant: dangerousPatterns.ts:18-80
 *                  - per-sub-command results (compound guard): the
 *                    `{type:'subcommandResults', reasons: Map}` decisionReason,
 *                    types/permissions.ts:280-283
 * @depends       ./permission-types ./permission-engine
 * @invariant     DENY is evaluated per sub-command on the AGGRESSIVELY-normalized
 *                form; if ANY sub matches a deny rule the whole command is denied.
 * @invariant     ALLOW requires EVERY sub-command to match a SAFE allow rule
 *                (allow rules whose prefix is a dangerous interpreter/shell are
 *                ignored), on the CONSERVATIVELY-normalized form.
 * @gotcha        Execution-affecting env vars (PATH, LD_PRELOAD, LD_LIBRARY_PATH,
 *                PYTHONPATH, NODE_OPTIONS, ...) must NEVER be in SAFE_ENV_VARS,
 *                or `PATH=/evil safe-cmd` normalizes to `safe-cmd` and matches an
 *                allow rule while running an attacker binary.
 * @porting       Splits compound commands on `&& || ; | & \n`. Command/process
 *                substitution (`$(…)`, backticks, `<( )`, `>( )`) can't be split
 *                by operators, so any command containing them is forced to a
 *                BYPASS-IMMUNE ask (never auto-allowed) — mirroring source's
 *                isBashSecurityCheckForMisparsing. This is NOT a full shell
 *                parser: Claude Code uses a tree-sitter AST (per-SimpleCommand)
 *                that also handles quotes/heredocs/redirect targets. Port the AST
 *                if you accept untrusted commands. SAFE_ENV_VARS / wrapper /
 *                dangerous lists here are illustrative subsets of the canonical
 *                source lists.
 * ============================================================================
 */

import {
  type PermissionResult,
  type PermissionRule,
  type PermissionRuleSource,
  type RulesBySource,
  iterRules,
} from './permission-types'
import type { ToolPermissionChecker } from './permission-engine'

/* -------------------------------------------------------------------------- */
/* Constants (illustrative subsets of the source's canonical lists)           */
/* -------------------------------------------------------------------------- */

/** Only display/locale vars are safe to strip for ALLOW matching. */
export const SAFE_ENV_VARS = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'COLUMNS', 'LINES'])

/** Leading wrappers stripped for DENY matching (so deny sees the real command). */
const WRAPPER_COMMANDS = new Set(['env', 'sudo', 'nohup', 'time', 'command', 'builtin', 'nice', 'stdbuf'])

/** Dangerous allow-prefixes: an allow rule on these grants arbitrary code, so it
 *  is ignored when evaluating ALLOW. PROVENANCE: dangerousPatterns.ts:18-80. */
const DANGEROUS_PREFIXES = new Set([
  'python', 'python3', 'python2', 'node', 'deno', 'tsx', 'ruby', 'perl', 'php', 'lua',
  'npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run',
  'bash', 'sh', 'zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo', 'ssh',
])

/** Command/process substitution the operator-splitter can't decompose. */
const NESTED_EXEC_RE = /\$\(|`|<\(|>\(/

/* -------------------------------------------------------------------------- */
/* Rule DSL matching (exact / prefix / wildcard)                              */
/* -------------------------------------------------------------------------- */

/** PROVENANCE: hasWildcards, shellRuleMatching.ts:54-78. */
function hasWildcard(p: string): boolean {
  if (p.endsWith(':*')) return false
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') {
      let bs = 0
      let j = i - 1
      while (j >= 0 && p[j] === '\\') {
        bs++
        j--
      }
      if (bs % 2 === 0) return true
    }
  }
  return false
}

/** PROVENANCE: parsePermissionRule + matchWildcardPattern, shellRuleMatching.ts:90-184. */
export function matchPattern(pattern: string, command: string): boolean {
  const pat = pattern.trim()

  // legacy prefix syntax "git:*" => matches "git" and "git ..."
  const pm = /^(.+):\*$/.exec(pat)
  if (pm) {
    const pre = pm[1]!
    return command === pre || command.startsWith(pre + ' ')
  }

  if (!hasWildcard(pat)) return command === pat // exact

  // wildcard: escape regex specials except *, handle \* and \\, * -> .*
  const STAR = '\x00S\x00'
  const BS = '\x00B\x00'
  let processed = ''
  for (let i = 0; i < pat.length; ) {
    const c = pat[i]!
    if (c === '\\' && i + 1 < pat.length) {
      const n = pat[i + 1]
      if (n === '*') {
        processed += STAR
        i += 2
        continue
      }
      if (n === '\\') {
        processed += BS
        i += 2
        continue
      }
    }
    processed += c
    i++
  }
  let rgx = processed
    .replace(/[.+?^${}()|[\]\\'"]/g, '\\$&')
    .replace(/\*/g, '.*')
    .split(STAR)
    .join('\\*')
    .split(BS)
    .join('\\\\')
  // trailing ' *' optional when it's the only wildcard (so 'git *' matches bare 'git')
  const starCount = (processed.match(/\*/g) || []).length
  if (rgx.endsWith(' .*') && starCount === 1) rgx = rgx.slice(0, -3) + '( .*)?'
  return new RegExp(`^${rgx}$`, 's').test(command)
}

/* -------------------------------------------------------------------------- */
/* Compound split + asymmetric normalization                                  */
/* -------------------------------------------------------------------------- */

/** Split on shell operators. NOT a full parser (see @porting). */
export function splitCompound(command: string): string[] {
  return command
    // `&&`/`||` precede `&`/`|` in the alternation so the 2-char ops win.
    .split(/\s*(?:&&|\|\||;|\||&|\n)\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)\s+/

/** Strip leading `VAR=val` assignments. For ALLOW (keepUnsafe), stop at the first
 *  non-SAFE var so the unsafe prefix remains and the allow rule won't match. */
function stripLeadingAssignments(cmd: string, keepUnsafe: boolean): string {
  let s = cmd.trimStart()
  for (;;) {
    const m = ASSIGN_RE.exec(s)
    if (!m) break
    if (keepUnsafe && !SAFE_ENV_VARS.has(m[1]!)) break
    s = s.slice(m[0].length).trimStart()
  }
  return s
}

function stripWrappers(cmd: string): string {
  let s = cmd
  for (;;) {
    const m = /^(\S+)\s+(.*)$/.exec(s)
    if (!m || !WRAPPER_COMMANDS.has(m[1]!)) break
    s = m[2]!.trimStart()
  }
  return s
}

/** Aggressive: strip ALL assignments + wrappers to a fixed point. */
export function normalizeForDeny(cmd: string): string {
  let prev = ''
  let s = cmd.trim()
  while (s !== prev) {
    prev = s
    s = stripWrappers(stripLeadingAssignments(s, false))
  }
  return s
}

/** Conservative: strip only SAFE env vars; keep wrappers + unsafe vars. */
export function normalizeForAllow(cmd: string): string {
  return stripLeadingAssignments(cmd.trim(), true)
}

/* -------------------------------------------------------------------------- */
/* The checker                                                                */
/* -------------------------------------------------------------------------- */

function bashContentRules(rules: RulesBySource): { content: string; source: PermissionRuleSource }[] {
  const out: { content: string; source: PermissionRuleSource }[] = []
  for (const r of iterRules(rules)) {
    if (r.toolName.toLowerCase() === 'bash' && r.content !== undefined) {
      out.push({ content: r.content, source: r.source })
    }
  }
  return out
}

/** Is this allow-rule pattern a dangerous interpreter/shell prefix? Then ignore it. */
function isDangerousAllowPrefix(content: string): boolean {
  const prefix = content.replace(/:\*$/, '').trim()
  const words = prefix.split(/\s+/)
  return DANGEROUS_PREFIXES.has(words[0] ?? '') || DANGEROUS_PREFIXES.has(words.slice(0, 2).join(' '))
}

function toRule(content: string, source: PermissionRuleSource, behavior: PermissionRule['ruleBehavior']): PermissionRule {
  return { source, ruleBehavior: behavior, ruleValue: { toolName: 'Bash', ruleContent: content } }
}

/**
 * Decide a Bash command's permission. Wire this into the engine via
 * `makeCanUseTool({ checkers: new Map([['Bash', checkBashPermission]]) })`.
 */
export const checkBashPermission: ToolPermissionChecker = (input, ctx): PermissionResult => {
  const command = typeof input.command === 'string' ? input.command : ''
  if (!command) return { behavior: 'passthrough', message: 'Allow Bash?' }

  const subs = splitCompound(command)

  // DENY first, per sub-command, on the aggressively-normalized form (#14).
  const denyRules = bashContentRules(ctx.alwaysDenyRules)
  for (const sub of subs) {
    const norm = normalizeForDeny(sub)
    const hit = denyRules.find(r => matchPattern(r.content, norm))
    if (hit) {
      // compound: real code records a {type:'subcommandResults', reasons:Map};
      // here we name the offending sub and cite the matched rule.
      return {
        behavior: 'deny',
        message: `Command "${sub}" matches deny rule Bash(${hit.content}).`,
        decisionReason: { type: 'rule', rule: toRule(hit.content, hit.source, 'deny') },
      }
    }
  }

  // ASK rules (content-specific) are bypass-immune (engine step 1f). Match per
  // sub on the aggressively-normalized form so env-var prefixes can't dodge ask.
  const askRules = bashContentRules(ctx.alwaysAskRules)
  for (const sub of subs) {
    const hit = askRules.find(r => matchPattern(r.content, normalizeForDeny(sub)))
    if (hit) {
      return {
        behavior: 'ask',
        message: `Command "${sub}" requires confirmation (Bash(${hit.content})).`,
        decisionReason: { type: 'rule', rule: toRule(hit.content, hit.source, 'ask') },
      }
    }
  }

  // Command/process substitution can hide a command this operator-splitter can't
  // decompose. Force a bypass-immune ASK — never auto-allow. PROVENANCE:
  // isBashSecurityCheckForMisparsing (types/permissions.ts:209-215).
  if (NESTED_EXEC_RE.test(command)) {
    return {
      behavior: 'ask',
      message: `Command contains nested execution; confirm: ${command}`,
      decisionReason: {
        type: 'safetyCheck',
        reason: 'command/process substitution is not statically decomposable',
        classifierApprovable: false,
      },
    }
  }

  // ALLOW requires EVERY sub to match a SAFE allow rule (dangerous-prefix allows
  // excluded), on the conservatively-normalized form (#14).
  const allowRules = bashContentRules(ctx.alwaysAllowRules).filter(r => !isDangerousAllowPrefix(r.content))
  const allAllowed =
    subs.length > 0 && subs.every(sub => allowRules.some(r => matchPattern(r.content, normalizeForAllow(sub))))
  if (allAllowed) return { behavior: 'allow' }

  // No opinion → engine converts passthrough to ask.
  return { behavior: 'passthrough', message: `Allow command: ${command}` }
}
