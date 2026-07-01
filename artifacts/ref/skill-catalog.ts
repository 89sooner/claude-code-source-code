/**
 * ============================================================================
 * @module        skill-catalog
 * @patterns      #F1 (2-stage progressive disclosure: budgeted 1-line catalog)
 * @intent        LEVEL 1 of skill disclosure: a compact, budget-bounded catalog
 *                of `- name: description` lines injected as a low-authority
 *                `<system-reminder>` so the model can DISCOVER skills without
 *                paying for their full bodies. LEVEL 2 (loading the full skill)
 *                happens only on invoke (command-invoke.ts).
 * @source        Claude Code v2.1.88: src/tools/SkillTool/prompt.ts
 *                  - 1% of context window in chars: 20-23 (SKILL_BUDGET_CONTEXT_PERCENT)
 *                  - per-entry 250-char cap: 25-29 (MAX_LISTING_DESC_CHARS)
 *                  - getCharBudget: 31-41; formatCommandsWithinBudget: 70-171
 *                  - bundled skills NEVER truncated; extreme case => names-only: 92-142
 *                  - the "already loaded => don't re-invoke" marker: 188-194
 * @depends       ./command-types ./types
 * @invariant     Bundled skills keep FULL descriptions even under budget
 *                pressure; only non-bundled descriptions are trimmed, and only
 *                to names-only as a last resort.
 * @gotcha        The catalog is DISCOVERY only. Verbose whenToUse in the catalog
 *                wastes turn-1 cache_creation tokens without improving match
 *                rate — the 250-char cap exists for exactly this reason.
 * @porting       `stringWidth` here is `String.length`; use a grapheme/CJK-aware
 *                width if your catalog contains wide characters (source does).
 * ============================================================================
 */

import type { Command } from './command-types'
import { type UserMessage, metaUser } from './types'

export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // 1% of 200k × 4
export const MAX_LISTING_DESC_CHARS = 250
const MIN_DESC_LENGTH = 20

const stringWidth = (s: string): number => s.length

/** PROVENANCE: getCharBudget, prompt.ts:31-41. (Source also honors env
 *  SLASH_COMMAND_TOOL_CHAR_BUDGET before everything else; omitted here.) */
export function getCharBudget(contextWindowTokens?: number): number {
  if (contextWindowTokens) {
    return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT)
  }
  return DEFAULT_CHAR_BUDGET
}

function isBundled(cmd: Command): boolean {
  return cmd.type === 'prompt' && cmd.source === 'bundled'
}

/** `description [- whenToUse]`, capped at 250 chars. PROVENANCE: prompt.ts:43-50. */
function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse ? `${cmd.description} - ${cmd.whenToUse}` : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '…' : desc
}

function formatCommandDescription(cmd: Command): string {
  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * Build the Level-1 catalog string within the character budget.
 * PROVENANCE: formatCommandsWithinBudget, prompt.ts:70-171.
 */
export function formatCommandsWithinBudget(commands: Command[], contextWindowTokens?: number): string {
  if (commands.length === 0) return ''
  const budget = getCharBudget(contextWindowTokens)

  const fullEntries = commands.map(cmd => ({ cmd, full: formatCommandDescription(cmd) }))
  const fullTotal = fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) + (fullEntries.length - 1)
  if (fullTotal <= budget) return fullEntries.map(e => e.full).join('\n')

  // Partition bundled (never truncated) vs rest.
  const bundledIdx = new Set<number>()
  const rest: Command[] = []
  commands.forEach((cmd, i) => (isBundled(cmd) ? bundledIdx.add(i) : rest.push(cmd)))

  const bundledChars = fullEntries.reduce(
    (sum, e, i) => (bundledIdx.has(i) ? sum + stringWidth(e.full) + 1 : sum),
    0,
  )
  if (rest.length === 0) return fullEntries.map(e => e.full).join('\n')

  const restNameOverhead =
    rest.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) + (rest.length - 1)
  const maxDescLen = Math.floor((budget - bundledChars - restNameOverhead) / rest.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme: non-bundled go names-only; bundled keep full descriptions.
    return commands.map((cmd, i) => (bundledIdx.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`)).join('\n')
  }

  return commands
    .map((cmd, i) => (bundledIdx.has(i) ? fullEntries[i]!.full : `- ${cmd.name}: ${truncate(getCommandDescription(cmd), maxDescLen)}`))
    .join('\n')
}

/**
 * Wrap the Level-1 catalog as a low-authority system-reminder user message
 * (the isMeta channel). PROVENANCE: skills are surfaced in system-reminder
 * messages (prompt.ts:188-189); the Skill tool loads the full body on invoke.
 */
export function skillCatalogReminder(
  commands: Command[],
  uuid: string,
  contextWindowTokens?: number,
): UserMessage | null {
  const listing = formatCommandsWithinBudget(commands, contextWindowTokens)
  if (!listing) return null
  return metaUser(uuid, `<available-skills>\n${listing}\n</available-skills>`)
}
