<!--
AGENT-READABLE INDEX. This pack is optimized for AI agents to read, verify, and
port — not for human prose. Parse `manifest.json` for the machine-readable map;
read this file for reading order, the tag vocabulary, and the porting checklist.
-->

# claude-code-pattern-refs

Self-contained, **compilable** TypeScript reference implementations of the
highest-value Claude Code v2.1.88 agent patterns, distilled for porting into a
**TS/Node general orchestration agent**.

- **Source provenance:** `@anthropic-ai/claude-code` v2.1.88 (extracted `src/`).
- **Nature:** idealized distillation, *not* a copy. Faithful in structure and
  invariants; every mechanism cites `file:line` in the original.
- **Dependencies:** none (provider-agnostic; no Anthropic SDK).
- **Verified:** `tsc --noEmit` (strict) → 0 errors; behavioral smoke test →
  #4 parallel batch, #5 N-in/N-out pairing (throw/unknown/abort), #12 isolation
  + permission non-inheritance, #1/#2 loop returns `Terminal{completed}`,
  M1 reduceContext persists, #9 microcompact frees tokens + usage gauge
  over-threshold + circuit breaker stops after 3, #10 summarize + live-state
  (plan/todos) reinjection, #8 deny beats bypass + ask fail-closed to deny,
  #14 compound guard (incl. `&` split) + env-var deny-normalize +
  dangerous-prefix stripping + nested-exec (`$(…)`/backtick) bypass-immune ask +
  Bash content-ask beats bypass; F1 catalog budget (bundled full, rest
  truncated/names-only, 250-char cap), F4 registry precedence (skill shadows
  built-in) + gates re-run + `/greet`==`Skill('greet')` identical expansion;
  G1 trust gate (untrusted interactive skips, non-interactive runs), command
  exit-code 0/2/other, deny>ask>allow merge, PreToolUse block/rewrite/inject,
  hook `allow` defers to rules (no escalation).

## How to read this pack (tag vocabulary)

Every file opens with a structured header block. Tags:

| Tag | Meaning |
|-----|---------|
| `@module` | stable id used in cross-references |
| `@patterns` | borrow-list pattern ids implemented here (`#1`, `#5`, `#12`, `D3`, …) |
| `@intent` | one-line purpose |
| `@source` | Claude Code `file:line` this mirrors (verify against the repo) |
| `@depends` | intra-pack dependencies |
| `@invariant` | guarantees the code upholds — **preserve these when porting** |
| `@porting` | how to adapt outside Claude Code (provider swap, framework, strictness) |
| `@gotcha` | failure modes to avoid |

Inline, mechanisms are tagged `// [#N]` at the exact implementing line and
`PROVENANCE: <file:line>` where they mirror the source.

## Reading order

```
types.ts            shared message model + Terminal/Continue unions     (#1)
  └─ tool.ts        fail-closed Tool contract + buildTool + permission   (#7)
      └─ model-client.ts   provider-agnostic streaming contract          (#2)
          └─ tool-runner.ts   concurrency batching + result pairing      (#4,#5)
              └─ agent-loop.ts   the turn loop                           (#1,#2)
                  └─ subagent.ts   default-deny isolation + spawn        (#12)
                      └─ task-notification.ts   dual result channel      (D3)
                          ├─ context-usage.ts     usage gauge + thresholds  (#9)
                          ├─ live-state.ts        out-of-band survive store(#10)
                          ├─ compaction.ts        tiered reduce + reinject (#9,#10)
                          ├─ permission-types.ts  permission model          (#8)
                          ├─ permission-engine.ts deny>ask>allow + seam      (#8)
                          ├─ bash-permission.ts   shell anti-bypass         (#14)
                          ├─ command-types.ts     unified command union     (#F4)
                          ├─ skill-catalog.ts     budgeted L1 catalog       (#F1)
                          ├─ command-registry.ts  layered cwd-memoized reg   (#F4)
                          ├─ command-invoke.ts    /x == Skill('x') path     (#F1,#F4)
                          ├─ hook-types.ts        27 events + result types  (#G1)
                          ├─ hook-engine.ts       trust + select + merge    (#G1)
                          ├─ hook-integration.ts  Pre/PostToolUse wiring     (#G1)
                          └─ example.ts           end-to-end wiring (compiles)
```

## Pattern → file → source map

| # | Pattern | Implemented in | Mirrors (Claude Code) |
|---|---------|----------------|-----------------------|
| **#1** | async-generator turn loop + `Terminal`/`Continue` union | `agent-loop.ts`, `types.ts` | `query.ts:241-307, 204-217, 1357, 1715-1727` |
| **#2** | `tool_use` observation is the continue signal (never `stop_reason`) | `agent-loop.ts`, `model-client.ts` | `query.ts:558,834`; `claude.ts:2242-2248` |
| **#5** | every `tool_use` → exactly one `tool_result` (incl. abort) | `tool-runner.ts` | `query.ts:123-149` (`yieldMissingToolResultBlocks`) |
| **#4** | read-only vs mutating concurrency batching (cap 10) | `tool-runner.ts`, `tool.ts` | `toolOrchestration.ts:10,91-116` |
| **#7** | fail-closed `Tool` contract + `buildTool` defaults | `tool.ts` | `Tool.ts:362-695,757-792` |
| **#12** | default-deny sub-agent context isolation | `subagent.ts` | `forkedAgent.ts:345-462`; `runAgent.ts:465-479,520-528` |
| **D3** | dual result channel: inline vs `<task-notification>` | `task-notification.ts`, `subagent.ts` | `agentToolUtils.ts:276-317`; `LocalAgentTask.tsx:197-262` |
| **#9** | tiered context reduction + usage gauge + circuit breaker | `compaction.ts`, `context-usage.ts` | `query.ts:379-465`; `autoCompact.ts:28-91`; `tokens.ts:226` |
| **#10** | compaction = narrative summary + structured live-state reinjection | `compaction.ts`, `live-state.ts` | `compact/prompt.ts:19-129`; `compact.ts:1415,1470,1494` |
| **#8** | deny>ask>allow by evaluation ORDER; bypass is leaky (deny + safety asks beat bypass) | `permission-engine.ts`, `permission-types.ts` | `permissions.ts:1158-1310`; `types/permissions.ts:251-324` |
| **#14** | bash anti-bypass: rule DSL + compound guard + asymmetric normalization + dangerous-prefix stripping | `bash-permission.ts` | `shellRuleMatching.ts:43-184`; `dangerousPatterns.ts:18-80` |
| **#F1** | 2-stage progressive disclosure: budgeted 1-line skill catalog (L1) + load-on-invoke (L2) | `skill-catalog.ts`, `command-invoke.ts` | `SkillTool/prompt.ts:20-171,188-194` |
| **#F4** | unified command model (skill = slash = plugin); layered cwd-memoized registry; `/x`==`Skill('x')` | `command-types.ts`, `command-registry.ts`, `command-invoke.ts` | `types/command.ts:169-216`; `commands.ts:258-346,449-509` |
| **#G1** | out-of-process lifecycle hooks: trust gate + matcher/`if` selection + exit-code protocol + deny>ask>allow merge + Pre/PostToolUse wiring | `hook-types.ts`, `hook-engine.ts`, `hook-integration.ts` | `utils/hooks.ts:286-296,2820`; `toolHooks.ts:332-435` |

## How they compose

```
            user/seed messages
                  │
                  ▼
        ┌──────────────────────┐   stream one block at a time (#2)
        │     agentLoop (#1)    │◀───────────────  ModelClient
        │  while(true):        │
        │   reduceContext seam │   (compaction plugs in here)
        │   stream → observe   │
        │   tool_use? (#2)     │
        └───────┬──────────────┘
       needsFollowUp │ yes
                  ▼
        ┌──────────────────────┐
        │   runTools (#4,#5)   │  batch safe calls ‖ serial mutating
        │  guarantee 1 result  │  per tool_use, even on abort
        └───────┬──────────────┘
                  │ tool_result messages → next turn input
                  ▼
              return Terminal{reason}   (#1)

   spawnSubagent (#12) ── runs the SAME agentLoop in an isolated context ──┐
        finalText (inline)  ───────────────────────────────────────────────┤ D3
        enqueueAgentNotification → <task-notification> into parent queue ──┘
```

## Verify

```bash
cd artifacts/ref
tsc --noEmit -p tsconfig.json        # strict type-check (0 errors)
# behavioral test: emit to JS and run the smoke test (see repo notes), or
# adapt example.ts main() with a real ModelClient.
```

## Porting checklist (into your orchestration agent)

1. **Provider swap** — implement `ModelClient.stream()` for your LLM. Keep the
   contract: YIELD one assistant message per content block; RETURN the
   authoritative `{stopReason, usage}` only at the end. Do **not** branch loop
   control on `stopReason` (#2).
2. **Cancellation** — async generators are **not** auto-cancelled by an
   `AbortSignal`. Check `signal.aborted` at every phase boundary (the loop does;
   `query.ts` checks ~6×). On abort, still pair every `tool_use` (#5).
3. **Concurrency safety defaults** — keep `isReadOnly`/`isConcurrencySafe`
   defaulting to `false` (`buildTool`). A mutating tool that forgets the override
   must serialize, never silently parallelize (#4/#7).
4. **Permission order** (#8/#14, IN this pack) — `makeCanUseTool`
   (`permission-engine.ts`) implements `deny > ask > allow` by evaluation ORDER,
   with explicit denials + safety asks evaluated BEFORE bypass mode, and `ask`
   fail-closed to deny when headless. For shells, register `checkBashPermission`
   (`bash-permission.ts`) via `checkers: new Map([['Bash', checkBashPermission]])`
   for the compound-command guard + asymmetric env-var normalization.
5. **Sub-agent isolation** — default every cross-boundary callback to a no-op;
   require narrow opt-ins; never inherit the parent's session approvals; give
   async children an unlinked controller (#12).
6. **Result delivery** — sync sub-agents return `finalText` inline; async ones
   push a deduped `<task-notification>` into the parent's priority queue, which
   the loop drains between turns (D3 + the steering queue, K1).
7. **Context survival** (#9/#10, IN this pack) — `makeReduceContext`
   (`compaction.ts`) plugs into `agentLoop`'s `reduceContext` seam: measure
   usage (`context-usage.ts`) → cheap microcompact → expensive summarize +
   re-inject structured live-state (todos/plan/files/skills) from the
   out-of-band `LiveStateStore` (`live-state.ts`). Keep that store in app-state
   so it survives the transcript rewrite. Gate local microcompact on
   cache-coldness (it mutates the cached prefix; see `compaction.ts` @gotcha).

## Caveats

- Claude Code nests blocks under `msg.message.content`; this pack flattens to
  `msg.content` for clarity. If you keep the SDK shape, **mutate, don't replace**
  the last streamed message when back-patching `stopReason`/`usage`
  (`claude.ts:2242-2248`) so lazy transcript writers keep their live reference.
- Permission/sandbox here is a *seam* (`CanUseTool`), not the full engine
  (`bashPermissions.ts` / `filesystem.ts` anti-bypass guards — patterns #8/#14).
- `source` line numbers are from the extracted v2.1.88 tree; verify before
  relying on an exact line.
