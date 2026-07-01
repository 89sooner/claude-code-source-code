# Claude Code v2.1.88 심층 분석 — 범용 오케스트레이션 에이전트 적용 관점

> 추출된 Claude Code v2.1.88 TypeScript 소스를 15개 서브시스템으로 병렬 분석 → 종합 → 적대적 비평 → 최종화한 결과. 모든 주장은 `file:line`으로 근거화되어 있으며, 말미의 "주의/한계"에 검증 상태를 명시한다.

# 개요

이 저장소는 **Claude Code v2.1.88의 추출/역컴파일된 TypeScript 소스**다. Anthropic 공식 CLI 에이전트로, 터미널 REPL(Ink/React)과 headless SDK 양쪽에서 동작한다. 규모는 `src/` 아래 수백 개 파일이며, 핵심 단일 파일 몇 개가 거대하다(예: `src/utils/hooks.ts` ~5000줄, `src/utils/sessionStorage.ts` 수천 줄, `src/constants/prompts.ts` 시스템 프롬프트 빌더 전체). 40여 개의 빌트인 도구(`src/tools/`), 30여 개 MCP 서비스 파일(`src/services/mcp/`), 85여 개 React UI 훅(`src/hooks/`)으로 구성된다.

전체 아키텍처는 **하나의 async-generator 에이전트 루프**를 중심으로 동심원처럼 층이 쌓인 구조다. 모든 출력(텍스트/툴 결과/시스템 노트)이 단일 정렬 채널로 yield되어 위로 흐르고, REPL/SDK는 이를 `for await`로 pull하면서 backpressure·취소·증분 렌더를 공짜로 얻는다.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ENTRYPOINTS                                                               │
│  REPL(Ink/React) src/screens/REPL.tsx │ headless SDK ask() QueryEngine.ts  │
│  Remote bridge(claude.ai) src/bridge/*                                     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  submitMessage() = generator (시스템프롬프트/슬래시확장/usage/budget)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  QueryEngine  src/QueryEngine.ts   (per-conversation owner)                │
│   - transcript 영속화 / usage 누적 / budget 강제 / SDK result 변환          │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  yield*  query()
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  AGENT LOOP  src/query.ts  queryLoop() = while(true) async generator       │
│   매 턴: [컨텍스트축소 pipeline] → callModel(stream) → tool_use 감지 →       │
│          tool 실행 → toolResults를 다음 턴 입력으로 → return Terminal       │
│   ├─ context 축소: snip→microcompact→collapse→autocompact                  │
│   ├─ 모델 스트리밍 src/services/api/claude.ts (SSE→블록별 메시지)           │
│   ├─ retry/backoff src/services/api/withRetry.ts (529→fallback 모델)        │
│   └─ 도구 실행 toolOrchestration.ts / StreamingToolExecutor.ts             │
└───────┬───────────────────────────────┬──────────────────────────────────┘
        ▼                               ▼
┌───────────────────────┐   ┌──────────────────────────────────────────────┐
│ TOOLS  src/Tool.ts     │   │ PERMISSIONS / SANDBOX                         │
│ 단일 Tool 계약 +       │   │ permissions.ts (deny>ask>allow 순서 파이프라인)│
│ buildTool fail-closed  │──▶│ bashPermissions.ts / filesystem.ts           │
│ 레지스트리 src/tools.ts │   │ sandbox-adapter.ts (bubblewrap/Seatbelt)     │
└───────────────────────┘   └──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  CONTEXT / STATE                                                          │
│  compact/* (요약·microcompact)  claudemd.ts(메모리)  tokens.ts(usage계측)  │
│  sessionStorage.ts(append-only JSONL DAG)  fileHistory.ts(체크포인트)      │
└──────────────────────────────────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  EXTENSIBILITY / SERVICES                                                 │
│  skills/* commands.ts plugins/*  hooks.ts(라이프사이클 훅)                  │
│  services/mcp/*(MCP+IDE채널)  services/remoteManagedSettings/* killswitch  │
└──────────────────────────────────────────────────────────────────────────┘
```

전 계층을 관통하는 두 가지 규율: **prompt-cache 바이트 안정성**(캐시되는 바이트를 절대 churn하지 않음)과 **`<system-reminder>` 메타 메시지 채널**(낮은 권위의 out-of-band 조종 주입).

---

# 핵심 아키텍처

## 1) Entry → Session owner

- **REPL** `src/screens/REPL.tsx:2793`은 `for await (const event of query({...}))`로 제너레이터를 소비한다. **headless**는 `QueryEngine.ask()`(`src/QueryEngine.ts:1186`)가 호출당 `QueryEngine` 하나를 만든다.
- `QueryEngine.submitMessage()`(`src/QueryEngine.ts:209`)는 그 자체가 generator다. 시스템 프롬프트 조립(`fetchSystemPromptParts` 288), `processUserInput`로 슬래시 커맨드/첨부 확장(416-431), `system_init` yield(540) 후 `query()` 소비(675). 메시지별로 transcript 기록(assistant는 fire-and-forget, 나머지는 await — 717-732), usage 추적(`stream_event` message_start에서 reset, message_delta에서 갱신 — 789-816), 최종 `{type:'result'}` 방출(1058-1155).

## 2) Agent loop — `src/query.ts`

- `queryLoop()`(241)은 de-recursed `while(true)`(307) async generator로, 하나의 가변 `State`(204-217)를 매 iteration마다 통째로 재할당한다. **유일한 탈출은 tagged `Terminal` reason의 `return`**(`'completed'|'max_turns'|'aborted_tools'|'prompt_too_long'|...`).
- **continue 신호는 stop_reason이 아니라 tool_use 블록 관측 여부**다(`needsFollowUp`, 558·834). 코드 주석이 명시적으로 `stop_reason==='tool_use'`는 신뢰 불가라고 경고한다(553-556).
- 매 모델 호출 전 컨텍스트 축소 파이프라인: `applyToolResultBudget`(379) → HISTORY_SNIP(401) → microcompact(414) → CONTEXT_COLLAPSE(440) → autocompact(454).

## 3) 모델 스트리밍 — `src/services/api/claude.ts`

- raw SSE 스트림(BetaMessageStream 아님 — O(n²) partial-JSON 파싱 회피, 1822-1836)을 `for await`로 순회(1940). **content_block_stop마다 그 블록 하나에 대한 완전한 AssistantMessage를 만들어 yield**(2192-2211). `message_delta`는 그 뒤에 와서 진짜 stop_reason/usage를 마지막 메시지에 **직접 mutate**로 back-patch(2242-2248) — lazy transcript write-queue가 live 참조를 들고 있어 object 교체 금지.

## 4) 도구 실행 + 권한

- 두 실행기. (A) post-stream `runTools`(`toolOrchestration.ts:19`): `partitionToolCalls`(91)가 연속된 concurrency-safe 호출을 한 병렬 배치로 묶고(cap 10, `toolOrchestration.ts:10`) 비안전 호출은 직렬. (B) `StreamingToolExecutor`(`StreamingToolExecutor.ts:76`): 모델이 아직 스트리밍 중일 때 도구 시작.
- 실행 파이프라인 `checkPermissionsAndCallTool`(`toolExecution.ts:599`): zod safeParse → validateInput → backfill(클론에만) → PreToolUse 훅 → 권한 결정 → call → map(1회) → 영속화 → PostToolUse 훅.
- 권한은 **실제 보안 경계**다. `permissions.ts:1158`의 고정 순번 파이프라인(deny→ask→tool-check→bypass→allow→passthrough). 핵심: deny/explicit-ask/safetyCheck는 bypassPermissions(2a)보다 **앞서** 평가되어 bypass가 의도적으로 leaky.

## 5) Context / State

- 컨텍스트 충만도는 **프로바이더 usage 리포트로** 계측(`tokens.ts:226`). autocompact 임계값 = `contextWindow − reservedOutput(~20k) − buffer(13k)`, 연속 실패 3회 circuit breaker(`autoCompact.ts`).
- transcript는 **append-only JSONL + parentUuid DAG**(`sessionStorage.ts`). resume는 leaf에서 backward walk + `recoverOrphanedParallelToolResults`(2118).
- 파일 체크포인트(`fileHistory.ts`): edit 전 copy-on-write 백업 `sha256(path)[:16]@vN`(725-731), 턴별 스냅샷을 transcript에도 기록.

## 6) Services / Remote

- **MCP**(`services/mcp/client.ts`): stdio/SSE/HTTP/ws/sdk 트랜스포트, OAuth, XAA(Cross-App Access/SEP-990), elicitation, resources/prompts. config scope 7종(`types.ts:9`: local/user/project/dynamic/enterprise/claudeai/managed).
- **IDE 통합은 MCP 채널로** 구현된다(`sse-ide`/ws-ide 트랜스포트, `useDiffInIDE.ts:22-28`의 `callIdeRpc`).
- **Remote bridge**(`src/bridge/*`)는 claude.ai가 로컬 세션을 구동, set_model/set_permission_mode를 런타임에 push.

---

# 주요 기능 카탈로그

## A. Agent Loop / Query Engine

### A1. tagged Terminal/Continue union을 반환하는 async-generator 턴 루프
- **무엇**: de-recursed `while(true)` 제너레이터가 단일 가변 State를 운반, 모든 종료/재시도 이유를 discriminated value로 표현.
- **어떻게**: 매 iteration이 stream→tool_use 감지→tool 실행→`[messagesForQuery,...assistant,...toolResults]`로 State 재구성. 탈출은 `return {reason}`뿐.
- **핵심파일**: `src/query.ts:241,307,1357,1715-1727`; `src/query/deps.ts`.
- **왜 중요**: 모든 exit/continue가 machine-readable·testable. 복구 코드가 `transition.reason`을 검사해 무한루프 방지.

### A2. 블록당 1메시지 SSE 스트리밍 + message_delta back-patch
- **핵심파일**: `src/services/api/claude.ts:1940,2192-2211,2242-2248`.
- **왜 중요**: SSE를 개별 렌더 가능한 블록으로 yield하면서 끝에만 도착하는 권위 있는 stop_reason/usage를 회수. "교체 말고 mutate" 규칙이 미묘한 재사용 인사이트.

### A3. 지수 backoff retry + 529 fallback 모델 escalation
- **무엇**: backoff `500ms·2^n`(cap 32s)+25% jitter, server retry-after 존중, 401/403시 client refresh, 반복 529 → `FallbackTriggeredError`.
- **핵심파일**: `src/services/api/withRetry.ts:170,316-360,530-548`. (단, 실제 모델 swap·thinking-signature 스트리핑·턴 replay는 `withRetry`가 아니라 `src/query.ts:893-953`에서 일어남.)
- **왜 중요**: retry를 generator로 만들어 'retrying in Ns' 상태를 렌더링과 분리해 yield.

### A4. 완전한 정지 조건 매트릭스
- **무엇**: natural completion / max_turns / maxBudgetUsd / user abort / Stop-hook veto / structured-output 재시도 cap / token-budget early-stop을 각각 별개 result subtype으로.
- **핵심파일**: `src/query.ts:1262-1357,1704-1712`; `src/QueryEngine.ts:842-873,972-1048`; `query/stopHooks.ts`; `query/tokenBudget.ts`.

### A5. 루프 내 컨텍스트-한계 복구(withhold-then-recover)
- **무엇**: mid-stream 413/max-output 에러를 SDK 소비자에게 withhold하고, collapse-drain → reactiveCompact → max_tokens escalation(8k→64k) → "mid-thought 재개" 메시지 주입 순으로 같은 턴 재발행. 실패 시에만 표면화.
- **핵심파일**: `src/query.ts:788-825,1062-1183,1188-1256`. `hasAttemptedReactiveCompact` one-shot 가드.

## B. Tools

### B1. 단일 Tool 계약 + fail-closed `buildTool()`
- **무엇**: 모든 capability가 ~40메서드 Tool 계약을 만족하는 데이터 객체. `TOOL_DEFAULTS`는 비관적(isReadOnly→false, isConcurrencySafe→false, isDestructive→false)이지만 노출/허용은 낙관적(isEnabled→true, checkPermissions→allow).
- **핵심파일**: `src/Tool.ts:757-792,362-695`.
- **왜 중요**: 새 도구는 ~6개만 선언하면 됨. 누락된 override가 mutating 도구를 조용히 병렬화하지 못함.

### B2. cache-stable Zod→API 스키마 직렬화
- **무엇**: WeakMap 캐시 native `toJSONSchema`, base를 세션 캐시(tool명 키), per-request 필드(defer_loading/cache_control)는 fresh copy에 overlay. beta kill-switch가 이 한 곳에서 필드 strip.
- **핵심파일**: `src/utils/api.ts:119-266`; `src/utils/zodToJsonSchema.ts:12-23`.
- **왜 중요**: 도구 직렬화는 턴당 ~60-250회 hot path. 바이트 churn이 서버측 prompt cache 무효화.

### B3. read-only vs mutating 동시성 배칭
- **핵심파일**: `toolOrchestration.ts:91-116,152-177`; `BashTool.tsx:434`(isConcurrencySafe = isReadOnly).
- **왜 중요**: 모델 인지 없이 Read/Grep 버스트를 병렬화, write는 직렬. 병렬 서브에이전트가 이로부터 공짜로 파생.

### B4. deferred 도구 스키마 + ToolSearch
- **무엇**: `shouldDefer`+`searchHint`만 모델에 보내고(defer_loading), 모델이 ToolSearch로 `tool_reference`를 pull. 미로딩 도구 호출 시 'ToolSearch select:X first' self-healing 힌트.
- **핵심파일**: `ToolSearchTool.ts:186-302,444-470`; `claude.ts:1154-1167`.

### B5. 대용량 tool-result 디스크 영속화
- **무엇**: tool당 `maxResultSizeChars`, 초과분은 `tool_use_id` 키로 멱등 기록(wx), `<persisted-output>` preview+경로로 대체. Read는 Infinity로 opt-out.
- **핵심파일**: `toolResultStorage.ts:137-199`; `Tool.ts:457-466`.

### B6. 5계층 도구 레지스트리 게이팅
- **핵심파일**: `src/tools.ts:193-251,262-327,345-367`; `constants/tools.ts`.
- **왜 중요**: build-time `feature()` 매크로(DCE), `USER_TYPE==='ant'`, env, runtime flag, permission deny-rule을 하나의 source-of-truth 배열로 collapse.

## C. Permissions / Sandbox

### C1. deny>ask>allow 순서 파이프라인(bypass-immune asks)
- **핵심파일**: `permissions.ts:1158-1300`; `types/permissions.ts`.
- **왜 중요**: 우선순위가 scoring이 아니라 평가 순서로 강제. bypass는 explicit deny/sensitive-file ask를 못 넘음 — safe-by-construction.

### C2. 권한 모드 + AI auto-classifier + headless auto-deny
- **무엇**: outer wrapper가 'ask'를 변환. ant `auto` 모드는 acceptEdits fast-path(클론 컨텍스트로 재검사)와 안전도구 allowlist로 pre-screen 후 LLM classifier 호출, denial-limit·fail-closed/open circuit breaker.
- **핵심파일**: `permissions.ts:473,600,689,845,932`; `getNextPermissionMode.ts`.

### C3. Bash 권한 매칭 anti-bypass 가드
- **무엇**: `Tool(content)` DSL(escaped paren, exact/prefix:*/wildcard), **비대칭 정규화**(ALLOW는 SAFE_ENV_VARS만, DENY/ASK는 모든 env var를 fixed-point까지 strip), compound-command 가드, tree-sitter AST 인젝션 게이트 + per-SimpleCommand deny 재검사.
- **핵심파일**: `bashPermissions.ts:378,524,733,948,1050,1431,1663`.
- **왜 중요**: allow-vs-deny 정규화 비대칭이 단일 최고 재사용 인사이트. 각 가드에 실제 CVE/HackerOne 주석.

### C4. 경로 기반 write 봉쇄 + auto-edit safety
- **무엇**: literal+symlink-resolved 경로 양쪽 검사, case-fold, `../` 거부, dangerous 파일/디렉터리 목록(.bashrc/.git/.claude/Windows NTFS-ADS·8.3·long-path)을 unbypassable safetyCheck로 라우팅. `classifierApprovable` 플래그가 민감파일 ask와 hard bypass 시도 구분.
- **핵심파일**: `filesystem.ts:435,537,620,709,1205-1366`.

### C5. OS 샌드박스 = 프롬프트 auto-skip 두 번째 층
- **무엇**: sandboxable 명령이면 ask 건너뛰되 explicit deny/ask는 여전히 강제. 같은 Edit/Read/WebFetch 룰 문자열을 sandbox-runtime(bubblewrap/Seatbelt) 설정으로 변환(단일 source of truth). `excludedCommands`는 명시적으로 보안 경계 아님.
- **핵심파일**: `shouldUseSandbox.ts:130`; `sandbox-adapter.ts:172,532,704`; `permissions.ts:1189`.

## D. Sub-agents / Task orchestration

### D1. default-deny 컨텍스트 격리 spawn
- **무엇**: 워커 tool pool을 부모와 독립적으로 자기 permissionMode로 계산, `createSubagentContext`가 가변 캐시는 clone하고 모든 mutation/UI 콜백은 기본 no-op, 좁은 opt-in(shareSetAppState/shareAbortController)과 별도 cleanup 사이드채널(setAppStateForTasks).
- **핵심파일**: `runAgent.ts:248,500`; `forkedAgent.ts:345,410`; `AgentTool.tsx:573`.

### D2. sync/async 디스패치 + mid-flight backgrounding
- **무엇**: 백그라운드 에이전트는 unlinked AbortController(메인 ESC로 안 죽음). sync 에이전트를 `Promise.race(iterator.next(), backgroundSignal)`로 실행하다 같은 task id로 isAsync 재개.
- **핵심파일**: `AgentTool.tsx:567,686,886`; `LocalAgentTask.tsx`; `Task.ts`.

### D3. dual 결과 채널: inline return vs `<task-notification>` 주입
- **무엇**: 완료된 백그라운드 에이전트가 status를 terminal로 먼저 전환(reader unblock) 후 XML `<task-notification>`을 부모 대화에 synthetic user turn으로 enqueue, atomic `notified` 플래그로 dedup.
- **핵심파일**: `agentToolUtils.ts:276`; `LocalAgentTask.tsx:197,252`.

### D4. prompt-cache-identical fork 서브에이전트
- **무엇**: FORK_AGENT가 부모의 이미 렌더된 시스템프롬프트 바이트·정확한 tool 배열·thinkingConfig 재사용, `buildForkedMessages`가 동일한 placeholder tool_result로 마지막 텍스트만 다르게.
- **핵심파일**: `forkSubagent.ts:60,107`; `forkedAgent.ts:399`.

### D5. worktree/remote 격리 + 멀티에이전트 메시 
- **핵심파일**: `worktree.ts:902`; `AgentTool.tsx:430,643`; `coordinator/coordinatorMode.ts`; `InProcessTeammateTask/types.ts`. 변경 있는 worktree는 보존(병합용), 무변경은 teardown.

## E. Context / Compaction / Memory

### E1. 프로바이더 usage 리포트 기반 계측
- **핵심파일**: `tokens.ts:226,46,7`. 병렬 tool-call 형제 id로 anchoring해 interleaved tool_result undercount 회피.

### E2. autocompact 임계값 + circuit breaker
- **무엇**: `effectiveWindow − reservedOutput(20k, p99.99 요약=17,387토큰 근거) − buffer(13k)`, 연속 3회 실패 차단(1,279 세션이 50+회 실패로 ~250K calls/day 낭비한 텔레메트리 근거).
- **핵심파일**: `autoCompact.ts:33,72,160,241`.

### E3. 요약 compaction + 구조화 상태 재주입
- **무엇**: forked agent가 hidden `<analysis>` 후 9-섹션 `<summary>` 방출(진행중 작업은 verbatim quote 강제). 이후 read 파일(재읽기·토큰버짓), plan, invoked skills, 백그라운드 에이전트, deferred tool 스키마, todos를 out-of-band 저장소에서 재주입.
- **핵심파일**: `compact.ts:387,330,1415,1494,1568`; `compact/prompt.ts:61`.

### E4. microcompaction(재요약 없는 tool-result clearing)
- **무엇**: time-based(서버 1h 캐시 TTL에 맞춤 — 캐시가 확실히 cold일 때만 clear) + cached(API `cache_edits`로 old result 삭제하되 로컬 미수정·캐시 prefix 유지, boundary는 `cache_deleted_input_tokens` 보고까지 deferral).
- **핵심파일**: `microCompact.ts:253,305,446`; `apiMicrocompact.ts`.

### E5. 계층적 CLAUDE.md/memory 로딩
- **핵심파일**: `claudemd.ts:790,1153`; `context.ts:155`; `attachments.ts:1710,2279`. root→cwd walk, per-file cap, nested 메모리는 non-evicting Set로 dedup(readFileState가 100-entry LRU라서).

## F. Skills / Commands / Plugins (Extensibility)

### F1. 2단계 progressive disclosure
- **무엇**: Level 1 = 예산 제한 1줄 카탈로그(**context window의 1%**, `SKILL_BUDGET_CONTEXT_PERCENT=0.01`, per-entry **250자** cap, bundled skill은 절대 truncate 안 함), per-agent delta-only `<system-reminder>`. Level 2 = invoke 시에만 SKILL.md 본문 materialize + `${SKILL_DIR}/$ARGUMENTS` 치환.
- **핵심파일**: `tools/SkillTool/prompt.ts:20-29,70`(검증됨); `loadSkillsDir.ts:344`; `attachments.ts:2661`.

### F2. Skill 도구: forward-safe allowlist + inline vs forked
- **무엇**: descriptor가 `SAFE_SKILL_PROPERTIES`만 포함할 때만 auto-approve(새 필드는 기본 confirm). inline 확장(인간 슬래시 경로 재사용) 또는 forked 서브에이전트.
- **핵심파일**: `SkillTool.ts:354,432,875,622`.

### F3. 디렉터리/경로-조건부 skill 활성화
- **무엇**: file 도구가 트리거. nested `.claude/skills` walk-up(deepest-first, gitignore 검사) + `paths:` glob 매칭 시에만 promote.
- **핵심파일**: `loadSkillsDir.ts:861,997`; `FileReadTool.ts:579`.

### F4. 통합 Command 모델(skill=slash command=plugin)
- **무엇**: 단일 discriminated union(prompt/local/local-jsx). cwd-키 메모이즈 레지스트리가 layer별 precedence로 concat하되 auth/feature-flag 게이트는 매 `getCommands()` 호출마다 재실행. `/x`와 `Skill('x')`가 동일 확장 경로 수렴.
- **핵심파일**: `commands.ts:258,449,476`; `types/command.ts:205`; `processSlashCommand.tsx`.

### F5. 마크다운 커맨드 + 게이트된 inline shell
- **무엇**: YAML frontmatter(파싱 실패 시 glob 값 auto-quote), 디렉터리→colon namespace, `$ARGUMENTS/$n/named` 치환, inline `!`cmd`` 블록은 확장 시 개별 권한 검사·MCP 출처는 하드 비활성화.
- **핵심파일**: `argumentSubstitution.ts:94`; `loadPluginCommands.ts:60,326`; `frontmatterParser.ts`.

### F6. 플러그인 manifest + marketplace
- **핵심파일**: `plugins/schemas.ts`; `builtinPlugins.ts:28`; `createMovedToPluginCommand.ts`. commands/agents/skills/hooks/mcpServers/lspServers/outputStyles 선언, github/git/npm/url/file/directory 소스.

## G. Hooks (라이프사이클 훅)

### G1. out-of-process 설정 훅 + dual 제어 채널
- **무엇**: PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop 등 25+ 이벤트에서 command/prompt/agent/http 변형 실행. JSON-over-stdin + (exit code 0=ok, **2=block+stderr를 모델에 피드백**, 그외=non-blocking) / JSON 제어. 훅이 tool block·input rewrite·permission 결정·context 주입 가능, PostToolUse는 MCP tool 출력도 사후 교체.
- **핵심파일**: `utils/hooks.ts:747,1117,1952,2617`; `types/hooks.ts`; `toolHooks.ts:435`.

### G2. config snapshot + trust gate + 권한 precedence
- **무엇**: trust 다이얼로그 전 immutable snapshot, 단일 `shouldSkipHookDueToTrust` 초크포인트(untrusted repo RCE 방지), matcher+`if` 2단계 cheap-gate, 병렬 fan-out을 deny>ask>allow로 병합, 훅 'allow'도 `checkRuleBasedPermissions` 재실행(escalation 불가).
- **핵심파일**: `hooks/hooksConfigSnapshot.ts`; `AsyncHookRegistry.ts`; `toolHooks.ts:332`.
- **주의**: `src/hooks/`는 거의 React UI 훅(85개)이고, 설정 훅 엔진은 `src/utils/hooks.ts`에 있다.

## H. System Prompt / Prompt Engineering

### H1. 블록 배열 시스템 프롬프트 + 2-tier 캐시 scope
- **무엇**: `getSystemPrompt`이 개별 캐시 가능한 `string[]` 반환, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel이 static(cacheScope 'global', **org 간 공유**)과 volatile 분리. volatile은 `DANGEROUS_uncachedSystemPromptSection`에 서면 이유를 적어야 매턴 recompute.
- **핵심파일**: `constants/prompts.ts:444,114`; `systemPromptSections.ts:20,32`; `utils/api.ts:321`; `system.ts:14`.
- **왜 중요**: boundary 앞에 런타임 비트를 두면 prefix-hash variant가 2^N배 — 실제 버그 클래스(참조 PR 명시).

### H2. 권위 레벨별 3계층 컨텍스트 주입
- **무엇**: durable 규칙→캐시 시스템 프롬프트, git status→trailing system 블록, CLAUDE.md/date→별도 low-authority isMeta user 메시지(`<system-reminder>` + "highly relevant 아니면 응답 말라" 면책). 단 CLAUDE.md 자체 헤더는 "OVERRIDE" — 권위는 wording이 결정.
- **핵심파일**: `context.ts:36,96`; `claudemd.ts:89,1153`; `utils/api.ts:449,463`.

### H3. 도구 가이드/refusal/few-shot/output style
- **핵심파일**: `prompts.ts:269`(병렬·dedicated tool 가이드, 이름 보간); `cyberRiskInstruction.ts:24`; `TodoWriteTool/prompt.ts`(`<example>/<reasoning>`); `outputStyles.ts:41`.

## I. MCP / IDE 통합 (critique 반영 보강)

### I1. MCP 서버 라이프사이클 + 다중 트랜스포트 + OAuth/XAA
- **무엇**: `@modelcontextprotocol/sdk` 기반. 트랜스포트 6종(`stdio`/`sse`/`sse-ide`/`http`/`ws`/`sdk`, `types.ts:23`), config scope 7종(local/user/project/dynamic/enterprise/claudeai/managed). OAuth 자동 갱신, **XAA(Cross-App Access/SEP-990)** 서버별 플래그(공유 IdP), `ElicitRequestSchema` 기반 사용자 elicitation, resources(`ListResources`)/prompts(`ListPrompts`) 노출.
- **핵심파일**: `services/mcp/client.ts:1-60`; `services/mcp/types.ts:9-50`; `MCPConnectionManager.tsx`(reconnect/toggle context); `auth.ts`/`oauthPort.ts`/`xaaIdpLogin.ts`/`elicitationHandler.ts`.
- **전용 도구 5종**: `MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `McpAuthTool` + `assembleToolPool`이 MCP 도구를 cache-stable contiguous prefix로 병합.

### I2. IDE 통합은 MCP 채널로 구현
- **무엇**: VS Code/JetBrains 컴패니언이 `sse-ide`/ws-ide MCP 서버로 연결. 에디터에 diff 표시(`useDiffInIDE`가 edits→patch 변환 후 `callIdeRpc`), @-mention 셀렉션(`useIdeAtMentioned`), 셀렉션 공유(`useIdeSelection`), Windows→WSL 경로 변환(`idePathConversion.ts`).
- **핵심파일**: `hooks/useIDEIntegration.tsx`; `hooks/useDiffInIDE.ts:22-28`; `hooks/useIdeSelection.ts`; `services/mcp/vscodeSdkMcp.ts`.

### I3. WebFetch / WebSearch 도구
- **무엇**: WebFetch는 URL fetch→HTML→markdown→**작은 fast 모델로 요약**. HTTP→HTTPS 자동 업그레이드, **15분 self-cleaning 캐시**, **다른 host로 redirect 시 새 요청 요구(SSRF성 보호)**, preapproved 도메인은 충실 응답 vs 비preapproved는 strict 125자 인용·가사 금지(저작권 가드).
- **핵심파일**: `WebFetchTool/prompt.ts:23-46`; `WebFetchTool/preapproved.ts`; `WebSearchTool/`.

### I4. Plan mode (EnterPlanMode/ExitPlanModeV2)
- **무엇**: 계획 수립 모드 진입/이탈 전용 도구. ExitPlanModeV2는 **semantic 권한 프롬프트**(`allowedPrompts`: Bash에 대해 "run tests"/"install dependencies" 같은 의미 기술)로 계획 승인 시 권한을 함께 요청, plan 파일 영속화, teammate plan-approval 연동. `PLAN_MODE_ATTACHMENT_CONFIG`(5턴마다 재주입).
- **핵심파일**: `ExitPlanModeTool/ExitPlanModeV2Tool.ts:60-70`; `EnterPlanModeTool/`; `utils/plans.ts`; `attachments.ts:259`.

### I5. 기타 도구
- NotebookEdit(Jupyter), PowerShell(Windows), LSP(언어서버 진단), Sleep(autonomous pacing), ScheduleCron/RemoteTrigger, AskUserQuestion, Brief, Config, SyntheticOutput, Task*/Team* 도구군. `src/tools/` 참조.

## J. State / Sessions / Persistence

### J1. append-only JSONL + 배칭 write queue
- **핵심파일**: `sessionStorage.ts:606,645,841,976`. per-file debounce(100ms, remote ingress시 10ms), 100MB chunk cap, lazy session-file materialization, 단일 `shouldSkipPersistence` 가드, in-flight barrier로 shutdown flush 보장.

### J2. parentUuid 메시지 DAG + resume 재구성
- **핵심파일**: `sessionStorage.ts:993,1040,2069,2118`. compact boundary는 parentUuid=null(logicalParentUuid에 진짜 부모), leaf에서 backward walk(cycle guard) 후 병렬 tool_result orphan 복구.

### J3. tombstone 삭제 + tail-window 메타데이터 복구
- **핵심파일**: `sessionStorage.ts:871,721`. 64KB tail에 ftruncate(>50MB는 full-rewrite 거부), title/tag를 EOF에 재append(외부 SDK 편집 흡수 — CRDT-lite LWW).

### J4. 파일 체크포인트 + /rewind
- **핵심파일**: `fileHistory.ts:725-731`(`sha256(path)[:16]@vN`, 검증됨), `:198,347`; `MessageSelector.tsx`. MAX_SNAPSHOTS ring + transcript에 스냅샷 기록(재시작 생존).

### J5. transcript-파생 ephemeral todos
- **핵심파일**: `TodoWriteTool.ts:65`; `attachments.ts:254-257`(`TURNS_SINCE_WRITE:10, TURNS_BETWEEN_REMINDERS:10`, 검증됨); `sessionRestore.ts:77`. 별도 영속화 없이 transcript 역주사로 rehydrate, 전부 완료 시 `[]`로 auto-clear.

### J6. 버전 게이트 마이그레이션
- **핵심파일**: `main.tsx:325`(CURRENT_MIGRATION_VERSION); `migrations/migrateSonnet45ToSonnet46.ts`. 정수 게이트 config 마이그레이션(멱등·self-guard) + transcript는 read-time tolerance(절대 rewrite 안 함).

## K. Interaction model

### K1. 통합 command queue(steering backbone)
- **핵심파일**: `messageQueueManager.ts:40,128,525`; `query.ts:1547-1590`; `attachments.ts:1046`. React 밖 module singleton, `useSyncExternalStore` 브리지 + generator 직접 read. queued 입력을 현재 턴에 `queued_command` attachment로 주입(agentId-scoped, slash는 턴 후로 deferral).

### K2. 2-tier interruption(intent in `AbortSignal.reason`)
- **핵심파일**: `useCancelRequest.ts:87`; `REPL.tsx:2106`; `handlePromptSubmit.ts:313`; `StreamingToolExecutor.ts:153`. 'user-cancel'(partial 텍스트 commit 후 abort+marker) vs 'interrupt'(marker 억제) vs 'sibling_error'. 모든 abort 경로가 synthetic is_error tool_result로 tool_use/result pairing 보장.

### K3. jitter-free 스트리밍 렌더 dispatcher
- **핵심파일**: `messages.ts:2930-3095`; `REPL.tsx:1458-1473,1318`. partial→committed atomic clear-then-append, 마지막 newline까지만 렌더, signature_delta는 토큰 카운터 제외, `useDeferredValue`로 입력 응답성.

### K4. QueryGuard generation-counter + abort tree
- **핵심파일**: `QueryGuard.ts:29-121`; `abortController.ts:16-99`. monotonic generation으로 cancel-then-resubmit race 무효화, WeakRef parent↔child 전파.

## L. Remote / Killswitches

### L1. remote bridge(claude.ai → 로컬 세션)
- **핵심파일**: `remoteBridgeCore.ts:140,317,530`; `codeSessionApi.ts`; `bridgeMessaging.ts:132,328`; `jwtUtils.ts:21`. epoch-versioned worker JWT, sequence-resumed transport rebuild, set_model/set_permission_mode push(verdict로 거부 가능).

### L2. managed settings / killswitch / trusted device
- **핵심파일**: `remoteManagedSettings/index.ts:105,433`; `securityCheck.tsx:67`(reject→`gracefulShutdownSync(1)`); `trustedDevice.ts`; `inboundAttachments.ts`. 시간당 폴, byte-exact SHA-256 ETag, fail-open-to-stale-cache, accept-or-die. killswitch는 기본값에 안전 방향 인코딩.

### L3. telemetry / OTel (보강)
- **핵심파일**: `utils/telemetry/`(`bigqueryExporter.ts`, `perfettoTracing.ts`, `sessionTracing.ts`, `pluginTelemetry.ts`, `instrumentation.ts`). 세션 트레이싱·메트릭 export·플러그인 텔레메트리.

---

# 두드러진 엔지니어링 패턴

## 횡단 패턴
1. **End-to-end async-generator 파이프라인** — 모델 호출·턴 루프·도구 진행·retry·서브에이전트·훅이 모두 generator. 단일 정렬 채널, 자동 backpressure, 구조적 취소. (`query.ts`, `claude.ts`, `withRetry.ts`, `toolExecution.ts`)
2. **`<system-reminder>` isMeta 주입 채널** — 모든 out-of-band steering(todo/메모리/compaction/skill listing/훅 context/queued command)을 isMeta user 메시지로 고정 루프 지점에 주입. 시스템 프롬프트 미오염. (`messages.ts:3097`)
3. **prompt-cache 바이트 안정성 강박** — tool base 세션 캐시 후 per-request overlay, persona prefix를 Set 멤버십으로 식별, static/dynamic boundary sentinel, mutate-don't-replace, fork prefix 바이트 동일, cache_edits로 무효화 없이 축소.
4. **`isConcurrencySafe(input)` read-only 동시성** — 연속 안전 호출 한 배치(cap 10), 비안전은 단독 ordering barrier. 병렬 서브에이전트가 공짜 파생.
5. **대형 카탈로그 2단계 progressive disclosure** — tiny always-on index + on-demand payload(deferred tool/skill).
6. **fail-closed 기본값 + layered-precedence override** — 비관적 도구 기본, headless auto-deny, untrusted repo 훅 skip, killswitch 안전 기본. deny>ask>allow + 소스 precedence.
7. **build/feature-flag 게이팅 + DCE** — positive-ternary `flag ? checks : false`로 번들러가 게이트 문자열 strip.
8. **제어 흐름용 tagged discriminated union** — Terminal/Continue, AbortSignal.reason, PermissionDecisionReason, TaskType/Status, 훅 결과, command mode.
9. **module-singleton + `useSyncExternalStore` 브리지** — React UI와 비-React 루프가 동일 상태를 race 없이 관측(steering queue, skill sent-tracking, write queue).
10. **withhold-then-recover + synthetic-result pairing** — transient 에러 숨기고 복구 시도, 모든 abort 경로에서 tool_use/result 짝 보장.

## standout 결정 (구체 메커니즘 + 참조)
- **mutate-don't-replace** 마지막 스트림 메시지: stop_reason/usage가 content_block_stop 뒤 message_delta에서만 도착, lazy transcript queue가 live ref 보유 — 교체 금지. `claude.ts:2236-2248`.
- **global cross-org prompt-cache scope**: static prefix를 `cacheScope:'global'`로 태그해 조직 간 캐시 공유. boundary 앞 런타임 비트는 prefix-hash 2^N배. `api.ts:74-83,304-357`.
- **cached microcompaction**: 로컬 미수정·prefix 무효화 없이 `cache_edits`로 old tool result 삭제, `cache_deleted_input_tokens` 보고까지 boundary deferral. `microCompact.ts:369-394`.
- **time-based microcompact가 서버 1h 캐시 TTL에 키잉**: 캐시가 확실히 cold일 때만 clear → 안 일어날 miss를 강제하지 않음. `timeBasedMCConfig.ts:21-24`.
- **Bash 권한 비대칭 env-var 스트리핑**: ALLOW는 safe만, DENY/ASK는 전부 fixed-point까지. `bashPermissions.ts:733/826`.
- **Windows 경로 canonicalization 방어를 모든 플랫폼에서**: NTFS가 Linux/macOS에 마운트 가능하므로. classifier-approvable=false로 auto/bypass도 우회 불가. `filesystem.ts:537`.
- **autocompact circuit breaker**: 1,279 세션 50+회 실패(~250K calls/day) 텔레메트리 근거, reserved 20k는 p99.99 요약=17,387토큰 근거. `autoCompact.ts:28-91`.
- **Bash 에러는 sibling subprocess cascade-cancel, Read/WebFetch는 안 함**: shell은 암묵 의존 체인, read는 독립. `StreamingToolExecutor.ts:354-363`.
- **tombstone 삭제**: append-only 로그를 64KB tail ftruncate로 in-place 변경, full `"uuid":"..."` 키 검색(child의 parentUuid 매칭 회피), >50MB는 거부. `sessionStorage.ts:871-933`.
- **parentUuid는 list가 아니라 DAG**: 병렬 tool_use N개가 한 message.id 공유 → 별도 orphan-recovery 패스 필수. `sessionStorage.ts:2118`.
- **generation-counter 취소**가 2곳 재사용: `QueryGuard.forceEnd()`와 JWT refresh 스케줄러. AbortController 스레딩 대안.
- **steering queue가 React 밖 singleton**: Ink/React 배칭이 알림을 drop해서 의도적으로 분리. `messageQueueManager.ts`.
- **Esc 시 partial 텍스트를 abort 전에 실 메시지로 commit**: transcript가 `[user, partial-assistant, '[Request interrupted]']`로 끝나 사용자가 읽은 것 보존. `REPL.tsx:2121-2129`.

---

# 에이전트 개발자가 빌려갈 만한 패턴 (우선순위)

value-to-effort 순. 각 항목: **패턴 / 무엇을 / 이식 주의점 / 난이도**.

**1. async-generator 턴 루프 + tagged Terminal/Continue union** — *무엇*: 턴을 단일 generator로, 모든 종료/재시도 이유를 discriminated value로 return/저장. *주의*: generator는 AbortSignal로 자동 취소 안 됨 — 각 phase 경계에서 `signal.aborted` 직접 체크(query.ts는 ~6회). *난이도*: 중간. **(최고 ROI — 전체 설계의 척추)**

**2. tool_use 관측을 continue 신호로(stop_reason 신뢰 금지)** — *무엇*: 스트리밍 중 tool_use 블록이 하나라도 나왔는지 boolean으로 루프. *주의*: end_turn/max_tokens는 message_delta에서 읽되 per-block 메시지(null)에서 읽지 말 것. *난이도*: 낮음. **(거의 공짜, 실 버그 예방)**

**3. `<system-reminder>` 메타 메시지로 out-of-band 주입** — *무엇*: 모든 reminder/상태를 isMeta user 메시지로 시스템 프롬프트 밖에 주입, 모델에 "system-injected·저권위"라고 학습/지시. *주의*: 어떤 이벤트가 raw stdout을 모델에 노출할지 제한(SessionStart/UserPromptSubmit만), 빈 content는 렌더 안 함. *난이도*: 낮음.

**4. read-only vs mutating 동시성 배칭** — *무엇*: tool당 `isConcurrencySafe(input)` 술어, 연속 안전 호출 bounded-parallel(cap 10), 비안전은 단독 직렬. *주의*: 술어는 파싱된 input에 평가, throw 시 unsafe 기본. concurrency-safe 도구의 contextModifier는 무시. *난이도*: 중간.

**5. 모든 tool_use에 tool_result 보장(abort 포함)** — *무엇*: 모든 취소/에러 경로에서 orphan tool_use에 synthetic is_error 결과 생성. *주의*: user-reject는 'User rejected'로(모델이 의도 학습), 일반 interrupt와 구분. *난이도*: 낮음. **(API 유효성·resumability 필수)**

**6. retry generator가 status 메시지 yield** — *무엇*: 'retrying in Nms'를 yield해 UI 분리, exp backoff+jitter+retry-after, 529→cheaper fallback을 typed error로. *주의*: fallback 모델로 history replay 전 model-bound thinking signature strip. *난이도*: 중간.

**7. fail-closed Tool 계약 + buildTool 기본값** — *무엇*: 단일 계약 + 안전 기본 주입 팩토리, `prompt()`(전체 설명)와 `description()`(권한 다이얼로그) 분리. *주의*: isReadOnly/isConcurrencySafe를 SAFE(false)로 기본. true 기본이면 mutating 도구를 조용히 병렬화. *난이도*: 낮음.

**8. deny>ask>allow 평가 순서(보안 ask는 bypass보다 먼저)** — *무엇*: 고정 순번 단축평가, explicit deny/ask/민감자원 safetyCheck를 bypass-all 모드 앞에. structured decisionReason 태깅. *주의*: 순번을 코드에 주석으로 명시(순서가 곧 스펙). 새 bypass 모드 추가 시 어떤 체크가 immune인지 명시 결정. *난이도*: 중간.

**9. tiered 컨텍스트 축소(cheap→expensive) + usage 기반 계측** — *무엇*: microcompact(tool-result clearing)를 full 요약 전에, freed-token delta를 임계값 검사에 forward. 윈도우 충만도는 프로바이더 usage로. *주의*: cache-edit microcompact는 프로바이더 기능 의존, 없으면 로컬 mutate(cold cache) fallback. *난이도*: 중간.

**10. compaction = narrative 요약 + 구조화 live-state 재주입** — *무엇*: 요약만 믿지 말고 out-of-band 저장소에서 파일/plan/skill/background-task/todos 재주입, transcript 경로로 정밀 복구. *주의*: todos/plans를 app state에 둬야 transcript rewrite 생존. 메모리/plan 파일은 file-restore에서 제외. *난이도*: 높음.

**11. module-singleton queue + external-store 브리지(steering)** — *무엇*: 입력/조종 queue를 우선순위(user>system) singleton에, UI는 `useSyncExternalStore`, 루프는 직접 read. *주의*: React 18+ 전용 프리미티브 — 타 프레임워크는 등가물로. dequeue를 agentId·slash-vs-prompt로 scope. *난이도*: 중간.

**12. default-deny 컨텍스트 격리(서브에이전트)** — *무엇*: 가변 캐시 clone + 모든 mutation/UI 콜백 no-op 기본, 좁은 boolean opt-in, cleanup용 별도 always-on 사이드채널. *주의*: 격리 하에서도 동작해야 하는 리소스 등록/cleanup 채널 분리. *난이도*: 중간.

**13. prompt-cache 바이트 안정성 + byte-identical fork** — *무엇*: Zod→JSON identity 캐시, tool base 세션 캐시 후 per-request overlay, fork는 부모의 렌더된 prompt/tool/thinking 재사용. *주의*: 프로바이더가 tool 바이트로 캐시하지 않으면 효과 제한(정렬 안정성은 여전히 이득). lazySchema로 참조 안정성 필요. *난이도*: 높음. **(Anthropic API 특화 — 타 프로바이더면 우선순위 낮춤)**

**14. 비대칭 정규화(allowlist vs denylist) + compound-command 가드** — *무엇*: allow는 보수적(safe set만), deny는 공격적(전부 strip, fixed-point), wildcard는 exact 모드 미매치·prefix는 compound 미매치. *주의*: 실행 영향 env var(PATH/LD_*/PYTHONPATH/NODE_OPTIONS) 절대 safe set 미포함, wrapper 스트리핑 regex 값 클래스를 char allowlist로 bound. *난이도*: 높음. **(shell 권한 시스템에 필수 — 안 하면 우회됨)**

---

# 주의 / 한계

- **역컴파일 소스**: 일부 파일은 source-map이 보존된 React-Compiler 출력(`MCPConnectionManager.tsx`는 `_c(6)` 캐시 슬롯과 base64 sourcemap 포함). 변수명이 minify된 경우 존재 — 예: `isConcurrencySafe`가 일부 컴파일 파일에서 `ln`으로 축약(naive grep이 놓침). 줄 번호는 일치하나 미세 차이 가능.
- **feature-gated / 빌트인 전용**: 상당수 기능이 `USER_TYPE==='ant'`(undercover 모드, 내부 명령군, auto/bubble 권한 모드, ant model override) 또는 `feature()` build 매크로(SleepTool, cron, MonitorTool, agent swarms, coordinator, fork-subagent, TRANSCRIPT_CLASSIFIER) 뒤에 있어 공개 빌드에선 DCE로 제거된다. 외부 빌드 동작 ≠ 소스의 모든 분기.
- **`src/hooks/`의 함정**: 85개 React UI 훅이며 라이프사이클 훅 엔진이 아니다. RCE 민감 엔진은 `src/utils/hooks.ts`.
- **검증 상태**:
  - **검증됨(소스 직접 확인)**: skills budget(1%·250자·bundled never-truncate, `SkillTool/prompt.ts:20-29`), fileHistory `sha256[:16]@vN`(`fileHistory.ts:725-731`), todo cadence 10/10(`attachments.ts:254-257`), MCP 트랜스포트/scope/XAA(`mcp/types.ts`, `client.ts`), IDE=MCP 채널(`useDiffInIDE.ts:22-28`), WebFetch redirect-host·15분 캐시·copyright 가드(`WebFetchTool/prompt.ts`), ExitPlanModeV2 semantic 권한(`ExitPlanModeV2Tool.ts:64-70`). 그 외 critique가 강검증한 상수들(retry 500ms/32s/jitter/529=3, autocompact 3/20k/13k, TOOL_DEFAULTS, deny>ask>allow 순서, tombstone 50MB/64KB, global cache scope, 동시성 cap 10)도 verbatim 일치.
  - **부분 검증/주의 필요**: "FORK_AGENT가 maxOutputTokens를 설정하면 안 됨(thinking budget_tokens clamp→캐시 키 깨짐)"은 소스 코멘트에 근거가 있다고 보고되나 이번 패스에서 직접 재확인 못 함 — 채택 시 `forkSubagent.ts`/`forkedAgent.ts`로 확인 권장. retry의 "fallback 모델 swap·signature strip·turn replay"는 `withRetry.ts`가 아니라 `query.ts:893-953`에서 일어남(원 findings의 파일 귀속이 느슨했음).
- **이번 분석이 얕게 다룬 영역**: vim 편집 모드(`src/vim/`), keybindings 시스템(`src/keybindings/`), voice(`services/voice*`), cost/model-selection UX(`cost-tracker`/`useMainLoopModel`), NotebookEdit·PowerShell·LSP 도구의 내부, AskUserQuestion/Brief/SyntheticOutput 세부는 카탈로그에 항목만 두고 깊이 파지 않았다. 필요 시 해당 디렉터리 직접 참조.
- **MCP/IDE 보강은 헤더·타입·핵심 훅 레벨**까지만 검증했고(트랜스포트 목록, scope, OAuth/XAA 존재, IDE RPC 경로), 각 트랜스포트의 재연결/백오프 세부와 elicitation 전체 플로우는 추가 조사 여지가 있다.