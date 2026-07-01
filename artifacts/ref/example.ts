/**
 * ============================================================================
 * @module        example
 * @intent        Executable WIRING reference: constructs a mock ModelClient and
 *                two tools, runs the loop to completion, then spawns an ISOLATED
 *                sub-agent and delivers its result over BOTH channels (inline +
 *                <task-notification>). Doubles as the end-to-end type/compile
 *                check for the whole pack.
 * @depends       (all modules)
 * @porting       Replace `mockClient` with a real provider implementation of
 *                ModelClient. Everything else is provider-agnostic.
 * @run           cd artifacts/ref && tsc --noEmit   # type-checks the whole pack
 * ============================================================================
 */

import type { AssistantMessage, Message } from './types'
import { agentLoop } from './agent-loop'
import { type CanUseTool, type Tool, type ToolSchema, buildTool } from './tool'
import type { ModelClient, StreamParams, StreamResult } from './model-client'
import {
  type MessageQueue,
  type TaskNotificationState,
  enqueueAgentNotification,
} from './task-notification'
import { type ParentContext, spawnSubagent } from './subagent'
import { makeReduceContext } from './compaction'
import type { LiveStateStore } from './live-state'
import { makeCanUseTool } from './permission-engine'
import { checkBashPermission } from './bash-permission'
import type { ToolPermissionContext } from './permission-types'
import { makeCommandRegistry } from './command-registry'
import { markdownSkill, runSlashCommand, runSkillTool } from './command-invoke'
import { formatCommandsWithinBudget } from './skill-catalog'
import type { HookRunners, TrustGate } from './hook-engine'
import { runPreToolUseHooks, withPreToolUseHooks } from './hook-integration'
import type { HooksSettings } from './hook-types'

let __c = 0
const newUuid = (): string => `id-${(__c += 1)}`

/* ---- tools ---------------------------------------------------------------- */

const echoTool: Tool = buildTool<{ text: string }>({
  name: 'echo',
  prompt: 'Echo back the given text. Read-only.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  validate: input =>
    input && typeof (input as { text?: unknown }).text === 'string'
      ? { ok: true, value: input as { text: string } }
      : { ok: false, error: 'text must be a string' },
  isReadOnly: () => true,
  isConcurrencySafe: () => true, // safe → eligible for the parallel batch (#4)
  call: async ({ text }) => `echo: ${text}`,
})

const writeTool: Tool = buildTool<{ path: string; content: string }>({
  name: 'write',
  prompt: 'Write content to a path. Mutating — runs serially.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  // no isReadOnly/isConcurrencySafe override → defaults to false (serial). (#7)
  call: async ({ path }) => `wrote ${path}`,
})

const tools = new Map<string, Tool>([
  [echoTool.name, echoTool],
  [writeTool.name, writeTool],
])
const toolSchemas: ToolSchema[] = [echoTool, writeTool].map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}))

/* ---- a scripted mock model client ---------------------------------------- */

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return { type: 'assistant', uuid: newUuid(), content, stopReason: null, usage: { input_tokens: 0, output_tokens: 0 } }
}

/**
 * Turn 1: request two read-only echoes (parallel batch) + one write (serial).
 * Turn 2: no tool_use → loop completes. The mock ignores prior results for brevity.
 */
function makeMockClient(): ModelClient {
  let turn = 0
  return {
    async *stream(_params: StreamParams): AsyncGenerator<AssistantMessage, StreamResult> {
      turn += 1
      if (turn === 1) {
        // one block per yield, mirroring content_block_stop (A2)
        yield assistant([{ type: 'text', text: 'Working on it.' }])
        yield assistant([{ type: 'tool_use', id: newUuid(), name: 'echo', input: { text: 'a' } }])
        yield assistant([{ type: 'tool_use', id: newUuid(), name: 'echo', input: { text: 'b' } }])
        yield assistant([{ type: 'tool_use', id: newUuid(), name: 'write', input: { path: '/tmp/x', content: 'hi' } }])
        return { stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }
      }
      yield assistant([{ type: 'text', text: 'All done.' }])
      return { stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }
    },
  }
}

/* ---- #9/#10 context-survival reducer wired into the loop seam ------------- */
function buildContextSurvivalReducer(): (m: Message[]) => Promise<Message[]> {
  const liveState: LiveStateStore = {
    getTodos: () => [{ content: 'wire compaction into the loop', status: 'in_progress' }],
    getPlan: () => 'Phase 1: reduce context. Phase 2: reinject live-state.',
    getReadFiles: () => ({ 'src/agent-loop.ts': { content: '// ...file body...', timestamp: 1 } }),
    getInvokedSkills: () => [],
  }
  const fakeSummarize = async (older: Message[]): Promise<string> =>
    `Summarized ${older.length} older messages (9-section narrative would go here).`
  return makeReduceContext({
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    summarize: fakeSummarize,
    liveState,
    keepRecentTurns: 6,
    newUuid,
  })
}

/* ---- run ------------------------------------------------------------------ */

/* ---- #8/#14 permission engine wired into the CanUseTool seam -------------- */
function demoPermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: { session: ['echo', 'write', 'Bash(ls:*)', 'Bash(git status)'] },
    alwaysDenyRules: { userSettings: ['Bash(rm:*)', 'Bash(curl:*)'] },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

function buildPermissionGate(): CanUseTool {
  return makeCanUseTool({
    ctx: demoPermissionContext(),
    checkers: new Map([['Bash', checkBashPermission]]),
    prompt: async () => true, // demo: approve any residual ask
  })
}

/** Show #8 ordering + #14 anti-bypass on a few commands (compile + usage demo). */
export async function permissionDemo(): Promise<Record<string, string>> {
  const ctx = demoPermissionContext()
  // no `prompt` => any `ask` resolves to DENY (headless fail-closed, #8).
  const gate = makeCanUseTool({ ctx, checkers: new Map([['Bash', checkBashPermission]]) })
  const tctx = { signal: new AbortController().signal, newUuid }
  const probe = async (cmd: string): Promise<string> => (await gate('Bash', { command: cmd }, tctx)).behavior
  return {
    'ls -la': await probe('ls -la'), //                 allow  (Bash(ls:*))
    'rm -rf /': await probe('rm -rf /'), //             deny   (Bash(rm:*))
    'ls && rm -rf /': await probe('ls && rm -rf /'), // deny   (#14 compound guard)
    'PATH=/evil rm x': await probe('PATH=/evil rm x'), // deny (#14 aggressive deny-normalize)
    'echo hi': await probe('echo hi'), //               deny   (no allow rule => ask => deny)
  }
}

/* ---- F1/F4 unified command model + skill catalog ------------------------- */
export async function commandSystemDemo(): Promise<{
  catalog: string
  slashOut: string
  skillOut: string
  converge: boolean
}> {
  const greet = markdownSkill({ name: 'greet', description: 'Greet someone', template: 'Say hello to $ARGUMENTS warmly.', source: 'skills' })
  const pdf = markdownSkill({ name: 'pdf', description: 'Work with PDF files: extract text, split, merge, fill forms', whenToUse: 'when the user references a PDF', template: 'Follow the PDF workflow for: $ARGUMENTS', source: 'bundled' })
  const deploy = markdownSkill({ name: 'deploy', description: 'Deploy the app', template: 'Deploy to $ARGUMENTS', source: 'skills', disableModelInvocation: true })

  // Precedence: bundled + skillDir, then builtins. The `greet` SKILL shadows the
  // built-in `greet` (first-wins dedupe) — the F4 layered registry.
  const registry = makeCommandRegistry({
    bundledSkills: () => [pdf],
    skillDirCommands: () => [greet, deploy],
    builtins: () => [
      { type: 'local', name: 'greet', description: 'built-in greet (shadowed by skill)', supportsNonInteractive: true, run: async () => 'builtin' },
    ],
  })

  const cwd = '/repo'
  const cmds = await registry.getCommands(cwd)
  const catalog = formatCommandsWithinBudget(cmds, 200_000)

  // /greet World (user) and Skill('greet','World') (model) => SAME expansion.
  const slash = await runSlashCommand(registry, cwd, '/greet World')
  const skill = await runSkillTool(registry, cwd, 'greet', 'World')
  const slashOut = slash.kind === 'inline' ? slash.content : ''
  const skillOut = skill.kind === 'inline' ? skill.content : ''
  return { catalog, slashOut, skillOut, converge: slashOut === skillOut }
}

/* ---- G1 lifecycle hooks woven into the tool pipeline --------------------- */
export async function hookSystemDemo(): Promise<{
  trustSkipped: string
  blocked: string
  rewritten: boolean
  injected: string[]
  composed: string
}> {
  const config: HooksSettings = {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit-guard' }] }],
  }
  const runners: HookRunners = {
    runCommand: async (_hook, input) => {
      const cmd = ((input as { tool_input?: { command?: string } }).tool_input?.command) ?? ''
      if (cmd.includes('rm ')) return { exitCode: 2, stdout: '', stderr: 'rm is blocked by policy' } // exit 2 => BLOCK
      // advanced JSON control: inject context + rewrite input.
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'audited', updatedInput: { command: cmd, audited: true } },
        }),
        stderr: '',
      }
    },
  }
  const trusted: TrustGate = { isNonInteractive: false, trustAccepted: true }
  const untrusted: TrustGate = { isNonInteractive: false, trustAccepted: false }

  // trust gate: an untrusted interactive workspace never runs hooks.
  const skipped = await runPreToolUseHooks('Bash', { command: 'rm -rf /' }, { config, runners, gate: untrusted }, {})
  const rm = await runPreToolUseHooks('Bash', { command: 'rm -rf /' }, { config, runners, gate: trusted }, {})
  const ls = await runPreToolUseHooks('Bash', { command: 'ls -la' }, { config, runners, gate: trusted }, {})

  // compose with the permission engine — hook deny blocks BEFORE rules.
  const base = makeCanUseTool({
    ctx: { mode: 'default', alwaysAllowRules: { session: ['Bash(ls:*)'] }, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false },
    checkers: new Map([['Bash', checkBashPermission]]),
  })
  const hooked = withPreToolUseHooks(base, { config, runners, gate: trusted })
  const composed = (await hooked('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, newUuid })).behavior

  return {
    trustSkipped: skipped.blocked ? 'ran' : 'skipped',
    blocked: rm.blocked ? 'blocked' : 'allowed',
    rewritten: (ls.input as { audited?: boolean }).audited === true,
    injected: ls.injectedContext,
    composed,
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController()
  const client = makeMockClient()

  // (1) main loop to completion
  const seed: Message[] = [{ type: 'user', uuid: newUuid(), content: [{ type: 'text', text: 'do the thing' }] }]
  const loop = agentLoop({
    messages: seed,
    system: 'You are a demo agent.',
    tools,
    toolSchemas,
    client,
    canUseTool: buildPermissionGate(), // #8/#14 plug into the seam
    signal: controller.signal,
    newUuid,
    reduceContext: buildContextSurvivalReducer(), // #9/#10 plug into the seam
  })

  let step = await loop.next()
  while (!step.done) {
    // a consumer renders/persists each yielded message here
    step = await loop.next()
  }
  const terminal = step.value // tagged Terminal reason (#1)
  // terminal.reason === 'completed'
  void terminal

  // (2) spawn an ISOLATED sub-agent (#12) and deliver via BOTH channels (D3)
  const parent: ParentContext = {
    signal: controller.signal,
    fileCache: new Map(),
    callbacks: {
      setAppState: () => {}, // child default-deny will no-op this anyway
      showPermissionPrompt: async () => true,
      onAgentMessage: () => {},
    },
    permissionMode: 'default',
    alwaysAllowRules: { cliArg: [], session: ['echo', 'write'] }, // session NOT inherited
  }

  const sub = await spawnSubagent({
    parent,
    opts: { isAsync: true, allowedTools: ['echo'] }, // child may ONLY use echo
    agentId: 'sub-1',
    system: 'You are a sub-agent.',
    promptMessages: [{ type: 'user', uuid: newUuid(), content: [{ type: 'text', text: 'summarize' }] }],
    tools,
    toolSchemas,
    client: makeMockClient(),
    newUuid,
  })

  // INLINE channel: synchronous final text
  const inline = sub.finalText

  // ASYNC channel: push a <task-notification> into the parent queue (deduped)
  const queue: MessageQueue = { enqueue: () => {} }
  const taskState: TaskNotificationState = { notified: false }
  enqueueAgentNotification(queue, taskState, {
    taskId: 'sub-1',
    description: 'summarize',
    status: sub.terminal.reason === 'completed' ? 'completed' : 'failed',
    outputPath: '/tmp/sub-1.out',
    finalMessage: inline,
    usage: { totalTokens: 25, toolUses: 0, durationMs: 12 },
  })

  void inline
}
