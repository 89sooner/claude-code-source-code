/**
 * ============================================================================
 * @module        command-types
 * @patterns      #F4 (unified command model: skill = slash command = plugin)
 * @intent        ONE discriminated union for everything invocable — built-in
 *                commands, markdown skills, plugin commands. A "skill" is just a
 *                `prompt` command that expands into model-visible content; the
 *                same object is reachable via `/name` (user) AND the Skill tool
 *                (model). Two gating axes: `availability` (static auth) vs
 *                `isEnabled()` (dynamic on/off); `userInvocable` vs
 *                `disableModelInvocation` (who may invoke it).
 * @source        Claude Code v2.1.88: src/types/command.ts
 *                  - Command = CommandBase & (PromptCommand|LocalCommand|LocalJSXCommand): 205-206
 *                  - PromptCommand.getPromptForCommand + context 'inline'|'fork': 25-57
 *                  - CommandBase (availability/isEnabled/userInvocable/
 *                    disableModelInvocation/loadedFrom): 175-203
 *                  - getCommandName / isCommandEnabled: 209-216
 * @depends       (none)
 * @invariant     A skill and a slash command are the SAME object, expanded by
 *                the SAME path (see command-invoke.ts). The only difference is
 *                which surface is allowed to invoke it (the two boolean axes).
 * @porting       `getPromptForCommand` is where a markdown skill substitutes
 *                `$ARGUMENTS` and returns its body (see command-invoke.ts).
 * ============================================================================
 */

export type CommandSource = 'builtin' | 'bundled' | 'plugin' | 'skills' | 'mcp' | 'workflow' | 'user'

/** Static auth requirement (who CAN use). Absent => available everywhere. */
export type CommandAvailability = 'claude-ai' | 'console'

export type CommandBase = {
  name: string
  description: string
  aliases?: string[]
  /** Detailed "when to use" scenarios (shown in the discovery catalog). */
  whenToUse?: string
  argumentHint?: string
  /** Static auth gate. PROVENANCE: command.ts:169-176. */
  availability?: CommandAvailability[]
  /** Dynamic on/off (feature flags, env). Defaults true. PROVENANCE: command.ts:180. */
  isEnabled?: () => boolean
  isHidden?: boolean
  /** Model cannot invoke via the Skill tool. PROVENANCE: command.ts:189. */
  disableModelInvocation?: boolean
  /** User can type `/name`. Defaults true. PROVENANCE: command.ts:190. */
  userInvocable?: boolean
  loadedFrom?: CommandSource
  /** Displayed name when it differs from `name` (e.g. plugin-prefix stripping). PROVENANCE: command.ts:201-202. */
  userFacingName?: () => string
}

/** Expansion context (idealized; source passes full ToolUseContext). `skillRoot`: command.ts:41. */
export type ExpandContext = { cwd: string; skillRoot?: string }

/** A skill / prompt command — expands into model-visible content. */
type PromptVariant = {
  type: 'prompt'
  source: CommandSource
  /** 'inline' = expand into the current conversation; 'fork' = run as a sub-agent. */
  context?: 'inline' | 'fork'
  /** Agent type when context==='fork'. */
  agent?: string
  /** Directory/path-conditional visibility (F3). Empty => always visible. */
  paths?: string[]
  getPromptForCommand: (args: string, ctx: ExpandContext) => Promise<string>
}

/** A headless code command. PROVENANCE: command.ts:74-78. */
type LocalVariant = {
  type: 'local'
  supportsNonInteractive: boolean
  run: (args: string, ctx: ExpandContext) => Promise<string>
}

/** An interactive (Ink/UI) command. PROVENANCE: command.ts:144-152. */
type LocalJSXVariant = {
  type: 'local-jsx'
  render: (args: string, ctx: ExpandContext) => Promise<unknown>
}

/** PROVENANCE: command.ts:205-206. */
export type Command = CommandBase & (PromptVariant | LocalVariant | LocalJSXVariant)
export type PromptCommand = CommandBase & PromptVariant

export const getCommandName = (c: CommandBase): string => c.userFacingName?.() ?? c.name
export const isCommandEnabled = (c: CommandBase): boolean => c.isEnabled?.() ?? true

/** Static auth gate. PROVENANCE: meetsAvailabilityRequirement, commands.ts:417-443. */
export function meetsAvailability(c: CommandBase, userAuth: CommandAvailability | null): boolean {
  if (!c.availability) return true // absent => available everywhere
  // NB: an EMPTY array matches nothing => hidden. Matches source, where
  // `availability` is truthy so the loop iterates zero times and returns false.
  return userAuth !== null && c.availability.includes(userAuth)
}
