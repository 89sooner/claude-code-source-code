/**
 * ============================================================================
 * @module        command-registry
 * @patterns      #F4 (layered, cwd-memoized registry; load once, gate fresh)
 * @intent        Assemble commands from many sources into ONE precedence-ordered
 *                list. Loading (disk I/O + dynamic import) is memoized by cwd,
 *                but availability/isEnabled gates RE-RUN on every getCommands()
 *                so auth/flag changes (e.g. /login) take effect immediately.
 * @source        Claude Code v2.1.88: src/commands.ts
 *                  - COMMANDS = memoize(() => [...builtins]): 258-346
 *                  - loadAllCommands = memoize(async (cwd) => precedence concat): 449-469
 *                  - getCommands: load memoized, gate fresh, merge dynamic skills: 476-509
 * @depends       ./command-types
 * @invariant     Precedence = earliest source wins on a name clash (first-match
 *                at resolution). Source order (highest first): bundled →
 *                builtin-plugin → skillDir → workflow → plugin → pluginSkills →
 *                builtins. (Source keeps duplicates and relies on find-first;
 *                this pack pre-dedupes for a cleaner list — same resolution.)
 * @invariant     `getCommands` filters by meetsAvailability && isCommandEnabled
 *                on EVERY call (never memoized) — the gates are dynamic.
 * @porting       `memoize1` caches the load Promise per cwd (also dedupes
 *                concurrent loads). Clear the cache when a plugin is (un)installed.
 * ============================================================================
 */

import {
  type Command,
  type CommandAvailability,
  getCommandName,
  isCommandEnabled,
  meetsAvailability,
} from './command-types'

/** Memoize a 0-arg function. */
function memoize0<T>(fn: () => T): () => T {
  let cache: { v: T } | null = null
  return () => (cache ??= { v: fn() }).v
}

/** Memoize a 1-arg async function by its (primitive) argument. */
function memoize1<A, T>(fn: (a: A) => Promise<T>): (a: A) => Promise<T> {
  const cache = new Map<A, Promise<T>>()
  return (a: A) => {
    let p = cache.get(a)
    if (!p) {
      p = fn(a)
      cache.set(a, p)
    }
    return p
  }
}

/** Command sources, highest precedence first in the concat below. */
export type CommandSources = {
  bundledSkills?: () => Command[]
  builtinPluginSkills?: () => Command[]
  skillDirCommands?: (cwd: string) => Command[] | Promise<Command[]>
  workflowCommands?: (cwd: string) => Command[] | Promise<Command[]>
  pluginCommands?: () => Command[] | Promise<Command[]>
  pluginSkills?: () => Command[] | Promise<Command[]>
  builtins?: () => Command[]
  /** Discovered during file operations (directory-conditional skills, F3). */
  dynamicSkills?: () => Command[]
}

/** Keep the FIRST command per name (precedence). */
function dedupeByName(commands: Command[]): Command[] {
  const seen = new Set<string>()
  const out: Command[] = []
  for (const c of commands) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }
  return out
}

export type CommandRegistry = {
  getCommands: (cwd: string) => Promise<Command[]>
  resolve: (cwd: string, nameOrAlias: string) => Promise<Command | null>
  /** Commands a USER can invoke by typing `/name`. */
  userCommands: (cwd: string) => Promise<Command[]>
  /** Skills the MODEL can invoke via the Skill tool. */
  modelSkills: (cwd: string) => Promise<Command[]>
}

export function makeCommandRegistry(
  sources: CommandSources,
  userAuth: CommandAvailability | null = null,
): CommandRegistry {
  const builtins = memoize0(() => sources.builtins?.() ?? [])

  // Expensive load, memoized by cwd. Precedence concat: earliest wins.
  const loadAll = memoize1(async (cwd: string): Promise<Command[]> => {
    const [bundled, builtinPlugin, skillDir, workflow, plugin, pluginSkills] = await Promise.all([
      Promise.resolve(sources.bundledSkills?.() ?? []),
      Promise.resolve(sources.builtinPluginSkills?.() ?? []),
      Promise.resolve(sources.skillDirCommands?.(cwd) ?? []),
      Promise.resolve(sources.workflowCommands?.(cwd) ?? []),
      Promise.resolve(sources.pluginCommands?.() ?? []),
      Promise.resolve(sources.pluginSkills?.() ?? []),
    ])
    return [
      ...bundled,
      ...builtinPlugin,
      ...skillDir,
      ...workflow,
      ...plugin,
      ...pluginSkills,
      ...builtins(),
    ]
  })

  // Gates run fresh every call (dynamic). PROVENANCE: commands.ts:476-485.
  async function getCommands(cwd: string): Promise<Command[]> {
    const all = await loadAll(cwd)
    const base = all.filter(c => meetsAvailability(c, userAuth) && isCommandEnabled(c))
    const dynamic = (sources.dynamicSkills?.() ?? []).filter(
      c => meetsAvailability(c, userAuth) && isCommandEnabled(c),
    )
    return dedupeByName([...base, ...dynamic])
  }

  async function resolve(cwd: string, nameOrAlias: string): Promise<Command | null> {
    const cmds = await getCommands(cwd)
    return (
      cmds.find(
        c =>
          c.name === nameOrAlias ||
          getCommandName(c) === nameOrAlias ||
          c.aliases?.includes(nameOrAlias),
      ) ?? null
    )
  }

  async function userCommands(cwd: string): Promise<Command[]> {
    return (await getCommands(cwd)).filter(c => c.userInvocable !== false && !c.isHidden)
  }

  // Models the runtime Skill-tool INVOCATION gate (SkillTool.validateInput,
  // SkillTool.ts:411-427), which is broader than the discovery-catalog listing
  // filter (source's getSkillToolCommands also requires source!=='builtin' etc).
  async function modelSkills(cwd: string): Promise<Command[]> {
    return (await getCommands(cwd)).filter(c => c.type === 'prompt' && !c.disableModelInvocation)
  }

  return { getCommands, resolve, userCommands, modelSkills }
}
