# claude-code-pattern-refs

> Self-contained, **compilable** TypeScript reference implementations of the
> highest-value Claude Code v2.1.88 agent-harness patterns — distilled for
> porting into a **TS/Node general orchestration agent**, and annotated so
> **other AI agents** can read, verify, and reuse them.

- **Provenance:** distilled from the extracted, unbundled source of
  `@anthropic-ai/claude-code` v2.1.88 (`../../src/`). Every mechanism cites the
  real `file:line`.
- **Nature:** an *idealized distillation*, **not a copy** — faithful in
  structure and invariants, provider-agnostic (no Anthropic SDK dependency),
  and standalone-compilable.
- **Status:** 21 modules · 14 patterns · 6 subsystems. `tsc --noEmit` strict → 0
  errors; behavioral smoke test passes; **all 5 authoring batches passed an
  independent adversarial faithfulness review** (findings fixed — see below).
- **Disclaimer:** the underlying source is the intellectual property of
  Anthropic; this pack is for technical research and study only.

---

## Quick start

```bash
cd artifacts/ref
tsc --noEmit -p tsconfig.json      # strict type-check → 0 errors
```

Then, in reading order:

1. **`manifest.json`** — the machine-readable map (patterns → files → source,
   per-module exports/deps, verification status). Parse this first if you are an agent.
2. **`INDEX.md`** — the tag vocabulary (`@module/@patterns/@source/@invariant/@porting/@gotcha`),
   the reading-order tree, the pattern→file→source table, the "how they compose"
   diagram, and the **porting checklist**.
3. **`example.ts`** — one file that wires *everything* together end-to-end (it
   also serves as the compile-time integration test). Exports `main`,
   `permissionDemo`, `commandSystemDemo`, `hookSystemDemo`.
4. The modules themselves, each opening with a structured header block.

> There is no runtime dependency and no build step. The pack type-checks as-is;
> to run behavior, implement the small injected seams (a `ModelClient`, a
> `runCommand`, etc.) — `example.ts` shows mock versions.

---

## The patterns

14 patterns across 6 subsystems. `ROI/Orch` marks the highest value-to-effort
and orchestration-relevant ones. Source column is the primary anchor (full list
in `manifest.json`).

### 1. Agent loop core — the spine
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#1** ⭐ | async-generator turn loop + tagged `Terminal`/`Continue` union | `agent-loop.ts`, `types.ts` | mid | `query.ts:241-307,204-217,1715-1727` |
| **#2** ⭐ | `tool_use` observation is the continue signal (never `stop_reason`) | `agent-loop.ts`, `model-client.ts` | low | `query.ts:558,834`; `claude.ts:2242-2248` |
| **#5** ⭐ | every `tool_use` → exactly one `tool_result` (incl. abort) | `tool-runner.ts` | low | `query.ts:123-149` |
| **#4** | read-only vs mutating concurrency batching (cap 10) | `tool-runner.ts`, `tool.ts` | mid | `toolOrchestration.ts:10,91-116` |
| **#7** | fail-closed `Tool` contract + `buildTool` defaults | `tool.ts` | low | `Tool.ts:362-695,757-792` |

### 2. Sub-agent orchestration
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#12** ⭐ | default-deny sub-agent context isolation | `subagent.ts` | mid | `forkedAgent.ts:345-462`; `runAgent.ts:465-479,520-528` |
| **D3** ⭐ | dual result channel: inline return vs `<task-notification>` | `task-notification.ts`, `subagent.ts` | mid | `agentToolUtils.ts:276-317`; `LocalAgentTask.tsx:197-262` |

### 3. Context survival
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#9** ⭐ | tiered cheap→expensive reduction + usage gauge + circuit breaker | `context-usage.ts`, `compaction.ts` | mid | `query.ts:379-465`; `autoCompact.ts:28-91`; `tokens.ts:226` |
| **#10** ⭐ | compaction = narrative summary + structured live-state reinjection | `compaction.ts`, `live-state.ts` | high | `compact/prompt.ts:19-129`; `compact.ts:1415,1470,1494` |

### 4. Permission engine (security)
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#8** | deny>ask>allow by evaluation ORDER; bypass is leaky | `permission-engine.ts`, `permission-types.ts` | mid | `permissions.ts:1158-1310` |
| **#14** | bash anti-bypass: rule DSL + compound guard + asymmetric normalization + dangerous-prefix stripping | `bash-permission.ts` | high | `shellRuleMatching.ts:43-184`; `dangerousPatterns.ts:18-80` |

### 5. Extensibility
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#F1** ⭐ | 2-stage progressive disclosure: budgeted skill catalog (L1) + load-on-invoke (L2) | `skill-catalog.ts`, `command-invoke.ts` | mid | `SkillTool/prompt.ts:20-171,188-194` |
| **#F4** ⭐ | unified command model (skill = slash = plugin); cwd-memoized registry; `/x`==`Skill('x')` | `command-types.ts`, `command-registry.ts`, `command-invoke.ts` | mid | `types/command.ts:169-216`; `commands.ts:258-346,449-509` |

### 6. Lifecycle hooks
| # | Pattern | Files | Diff | Source |
|---|---------|-------|------|--------|
| **#G1** ⭐ (+#G2) | out-of-process hooks: trust gate + matcher/`if` selection + exit-code protocol + deny>ask>allow merge + Pre/PostToolUse wiring | `hook-types.ts`, `hook-engine.ts`, `hook-integration.ts` | high | `utils/hooks.ts:286-296,2820`; `toolHooks.ts:332-435` |

---

## How they compose

The pack is a minimal agent runtime. A single tool-using turn threads through
**six seams**, each fillable by one subsystem:

```
 seed messages
      │
      ▼
 ┌──────────────────────────── agentLoop (#1) ───────────────────────────────┐
 │  reduceContext seam ─────────────► context survival (#9 #10)               │
 │  client.stream() ───────────────► ModelClient (#2: tool_use = continue)    │
 │  tool_use?                                                                 │
 │     │ yes                                                                  │
 │     ▼                                                                      │
 │  canUseTool seam:                                                          │
 │     withPreToolUseHooks (#G1) ──► block / rewrite input / inject context   │
 │       └─► makeCanUseTool (#8) ──► checkBashPermission (#14)                 │
 │              (hook 'allow' defers to rules — no escalation)                │
 │     ▼                                                                      │
 │  runTools (#4 batch, #5 pair) ──► exec ──► runPostToolUseHooks (#G1)       │
 │     │  tool_result → next turn                                             │
 │     ▼                                                                      │
 │  return Terminal{reason} (#1)                                             │
 └───────────────────────────────────────────────────────────────────────────┘

 spawnSubagent (#12 isolation) ─► same agentLoop ─► finalize (D3 inline)
                                                 └─► <task-notification> (D3 async)
 runSlashCommand /x ─┐
 runSkillTool Skill('x') ─┴─► expandCommand (#F4)   catalog via #F1
```

**Cross-module reuse** (the pack composes like the real system):

- The hook `if`-gate (`#G1`) **reuses the permission rule DSL** `matchPattern`
  from `#14`.
- `withPreToolUseHooks` (`#G1`) **wraps** the `makeCanUseTool` gate (`#8`).
- The skill catalog (`#F1`) and compaction (`#10`) both inject via `metaUser`
  (the `<system-reminder>` isMeta channel from `types.ts`).
- `spawnSubagent` (`#12`) runs the **same** `agentLoop` (`#1`) as the main loop.

---

## Porting guide

1. **Read `INDEX.md`** for the tag vocabulary and the porting checklist.
2. **Provider swap:** implement `ModelClient.stream()` for your LLM. Keep the
   contract: yield one assistant message per content block; return the
   authoritative `{stopReason, usage}` only at the end. Never branch loop control
   on `stopReason` (`#2`).
3. **Fill the seams:** `canUseTool` (permission engine + hooks), `reduceContext`
   (compaction), tool `checkers` (bash guard), `HookRunners` (spawn/LLM/HTTP),
   `LiveStateStore`, `CommandSources`. `example.ts` shows a mock for each.
4. **Honor the invariants** (each module's `@invariant`): tool-result pairing,
   deny>ask>allow order, trust-gate-first, default-deny isolation, cache-cold
   microcompact, `/x`==`Skill('x')` convergence.
5. **Heed the `@gotcha`s** — they are the load-bearing subtleties (e.g. generators
   aren't auto-cancelled by AbortSignal; execution-affecting env vars must never
   be "safe"; local microcompact mutates the cached prefix).

---

## Verification & review status

Every batch was authored, then **verified** (strict `tsc` + a behavioral smoke
test), then **independently reviewed** by an adversarial faithfulness pass that
cross-checked each `@source` citation against the real tree. All findings were
fixed.

| Batch | Patterns | Review verdict | Key fixes applied |
|-------|----------|----------------|-------------------|
| 1 | #1 #2 #5 #4 #7 #12 D3 | faithful & safe | M1 accumulate reduced list at continue-site; M2 `createSubagentContext` is in `forkedAgent.ts` |
| 2 | #9 #10 | faithful (constants exact) | manifest export gap; `reinjectFiles` `break`→`continue`; disclosure notes |
| 3 | #8 #14 | faithful; gates not weaker than source | `&` background split + nested-exec bypass-immune ask; Bash content-ask beats bypass |
| 4 | #F1 #F4 | faithful; gates/precedence correct | `availability:[]` hides (not everywhere); `$n` 0-indexed per source |
| 5 | #G1 (#G2) | faithful; **no RCE / escalation gap** | `if`-gate per-tool target (no non-Bash fail-open); legacy `decision` mapping; JSON-first |

Re-run verification any time:

```bash
cd artifacts/ref && tsc --noEmit -p tsconfig.json   # → 0 errors
```

---

## Caveats & fidelity

- **Decompiled source:** the upstream tree is extracted/decompiled; a few line
  numbers may drift and some variable names were minified. Verify a citation
  before relying on an exact line.
- **Illustrative constants:** where the source list is large or feature-gated,
  the pack uses a documented subset (e.g. `SAFE_ENV_VARS`, `DANGEROUS_PREFIXES`,
  `POST_COMPACT_*` budgets). These are marked in the relevant `@gotcha`/comment.
- **Distillation, not a parser:** `#14` splits compound shell commands on
  operators (source uses a tree-sitter AST); `#G1`'s `if`-gate approximates the
  per-tool matcher via field extraction. Both are documented and fail *safe*, not
  open — but port the real matcher before accepting untrusted input.
- **Seams are yours to fill:** anything provider- or host-specific (model client,
  process spawning, app-state store, UI) is an injected interface, deliberately.

---

## Navigation

- `manifest.json` — machine-readable map (agents: start here).
- `INDEX.md` — tag vocabulary, reading order, pattern→file→source table, wiring diagram, porting checklist.
- `example.ts` — end-to-end wiring of all 6 seams (compiles; doubles as the integration test).
- `tsconfig.json` — strict config the pack type-checks under.
- Parent analysis (the *why* behind these patterns): `../claude-code-analysis-report.md` and `../claude-code-analysis.html` (interactive), which rank all discovered patterns by value-to-effort.
