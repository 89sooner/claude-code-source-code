/**
 * ============================================================================
 * @module        command-invoke
 * @patterns      #F4 (/x and Skill('x') converge on ONE expansion path),
 *                #F1 Level-2 (full skill body materialized only on invoke),
 *                F5-lite ($ARGUMENTS / $1..$n substitution)
 * @intent        The single place a command is expanded, whether the USER typed
 *                `/x args` or the MODEL called the Skill tool `Skill('x', args)`.
 *                Both resolve the same Command and call `expandCommand`, so the
 *                two entry points can never diverge.
 * @source        Claude Code v2.1.88:
 *                  - "a slash command IS a skill; use the Skill tool to invoke":
 *                    tools/SkillTool/prompt.ts:176-194
 *                  - PromptCommand.getPromptForCommand (inline vs fork): command.ts:42-57
 *                  - $ARGUMENTS/$n substitution in markdown commands: argumentSubstitution.ts
 * @depends       ./command-types ./command-registry
 * @invariant     `runSlashCommand` (user) and `runSkillTool` (model) BOTH end in
 *                `expandCommand` — identical output for identical (command,args).
 *                The only difference is the invocation GATE (userInvocable vs
 *                disableModelInvocation), enforced before expansion.
 * @porting       For `context:'fork'`, hand `ExpandResult{kind:'fork'}` to your
 *                sub-agent spawner (see subagent.ts) with a fresh context window.
 * ============================================================================
 */

import type { Command, ExpandContext, PromptCommand } from './command-types'
import type { CommandRegistry } from './command-registry'

/**
 * Substitute command arguments. PROVENANCE: argumentSubstitution.ts:110-145.
 * ORDER matters: `$ARGUMENTS[n]` then `$n` (BOTH 0-indexed — `$0` = FIRST arg),
 * then the whole `$ARGUMENTS` LAST; if nothing matched and args were given and
 * `appendIfNoPlaceholder`, append them. Tokenizing is naive whitespace (source
 * uses shell-quote, so `"a b"` is a single arg there).
 */
export function substituteArgs(template: string, args: string, appendIfNoPlaceholder = false): string {
  const trimmed = args.trim()
  const parts = trimmed.length ? trimmed.split(/\s+/) : []
  const at = (n: string): string => parts[Number(n)] ?? '' // 0-indexed
  const out = template
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_, n: string) => at(n))
    .replace(/\$(\d+)(?!\w)/g, (_, n: string) => at(n))
    .replaceAll('$ARGUMENTS', trimmed)
  if (out === template && appendIfNoPlaceholder && trimmed.length) {
    return `${out}\n\nARGUMENTS: ${trimmed}`
  }
  return out
}

/** Build a markdown-backed prompt command (skill). Its body substitutes args. */
export function markdownSkill(opts: {
  name: string
  description: string
  template: string
  whenToUse?: string
  source?: PromptCommand['source']
  context?: 'inline' | 'fork'
  agent?: string
  paths?: string[]
  userInvocable?: boolean
  disableModelInvocation?: boolean
}): PromptCommand {
  return {
    type: 'prompt',
    name: opts.name,
    description: opts.description,
    whenToUse: opts.whenToUse,
    source: opts.source ?? 'skills',
    context: opts.context,
    agent: opts.agent,
    paths: opts.paths,
    userInvocable: opts.userInvocable ?? true,
    disableModelInvocation: opts.disableModelInvocation,
    loadedFrom: 'skills',
    getPromptForCommand: async (args: string) => substituteArgs(opts.template, args),
  }
}

export type ExpandResult =
  | { kind: 'inline'; content: string } //   expand into the current conversation
  | { kind: 'fork'; content: string; agent?: string } // run as a sub-agent
  | { kind: 'local'; output: string } //     headless local command output

/**
 * The ONE expansion path. LEVEL 2 of progressive disclosure: the full skill
 * body is materialized here, on invoke — not in the discovery catalog.
 */
export async function expandCommand(cmd: Command, args: string, ctx: ExpandContext): Promise<ExpandResult> {
  switch (cmd.type) {
    case 'prompt': {
      const content = await cmd.getPromptForCommand(args, ctx)
      return cmd.context === 'fork'
        ? { kind: 'fork', content, agent: cmd.agent }
        : { kind: 'inline', content }
    }
    case 'local':
      return { kind: 'local', output: await cmd.run(args, ctx) }
    case 'local-jsx':
      // interactive UI — out of scope for headless expansion
      return { kind: 'local', output: `[${cmd.name}] renders interactive UI` }
  }
}

/** USER entry point: `/name args`. Enforces userInvocable, then expands. */
export async function runSlashCommand(
  registry: CommandRegistry,
  cwd: string,
  input: string,
): Promise<ExpandResult> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim())
  if (!m) throw new Error(`Not a slash command: ${input}`)
  const [, name, args] = m
  const cmd = await registry.resolve(cwd, name!)
  if (!cmd) throw new Error(`Unknown command: /${name}`)
  if (cmd.userInvocable === false) throw new Error(`/${name} is not user-invocable`)
  return expandCommand(cmd, args ?? '', { cwd })
}

/** MODEL entry point: the Skill tool. Enforces model-invocability, then expands. */
export async function runSkillTool(
  registry: CommandRegistry,
  cwd: string,
  skill: string,
  args = '',
): Promise<ExpandResult> {
  const cmd = await registry.resolve(cwd, skill)
  if (!cmd) throw new Error(`Unknown skill: ${skill}`)
  if (cmd.type !== 'prompt') throw new Error(`${skill} is not a prompt skill`)
  if (cmd.disableModelInvocation) throw new Error(`${skill} is not model-invocable`)
  // SAME path as the slash command above (#F4 convergence).
  return expandCommand(cmd, args, { cwd })
}
