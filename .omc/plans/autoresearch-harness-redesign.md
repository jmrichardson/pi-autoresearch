# Pi-Autoresearch — Harness-Driven Redesign

**Status:** Draft (direct mode)
**Date:** 2026-04-23
**Goal:** Replace the LLM-driven in-session loop with a deterministic harness that spawns fresh-context iteration agents per experiment, while preserving the existing user interface and downstream tooling (widget, dashboard, `autoresearch-finalize`).

---

## 1. Requirements Summary

### Problem
The current design has the LLM itself drive the loop inside a single pi session. Two failure modes with weaker models:
1. **Lost iterations** — if the LLM forgets to call `log_experiment`, the run never lands in `autoresearch.jsonl` (the jsonl write is *inside* `log_experiment`, `extensions/pi-autoresearch/index.ts` — see the log_experiment tool handler).
2. **Silent stalls** — the auto-resume mechanism at `index.ts:1464` requires `experimentsThisSession > 0`; if the model never successfully logs one, resume never fires. Even when it does fire, a weak model may reply in prose instead of calling tools.

### Objective
Move the loop *outside* the LLM. Each iteration = a fresh-context agent invocation driven by a deterministic harness that:
- Owns the jsonl append (guaranteed per iteration, no LLM dependency).
- Owns keep/revert decisions (rule-based with optional LLM veto).
- Owns git hygiene (clean slate per iteration).
- Enforces a single-edit + single-hypothesis contract on the iteration agent.

### Non-Goals
- Redesigning the dashboard UI.
- Breaking compatibility with existing `autoresearch.jsonl` files, `autoresearch.md`, `autoresearch.sh`, `autoresearch.checks.sh`, or `autoresearch-finalize`.
- Removing the user's ability to manually call `run_experiment` / `log_experiment`.

---

## 2. Acceptance Criteria

All criteria must be testable and verifiable on a local pi install.

1. **Interface preservation**
   - `/autoresearch <goal>`, `/autoresearch off`, `/autoresearch clear`, `/autoresearch export` continue to work with identical behavior from the user's perspective.
   - `autoresearch-finalize` runs successfully against a jsonl produced by the new harness, producing the same branch structure as today.
   - Widget and dashboard (`Ctrl+Shift+T`, `Ctrl+Shift+F`) continue to auto-update from `autoresearch.jsonl`.
   - Existing `autoresearch.jsonl` files from pre-migration sessions load without error (schema is additive).

2. **Durability guarantee**
   - For every started iteration, exactly one jsonl line is appended, regardless of whether the iteration agent completed, stalled, crashed, or produced no edits. Verified by a test that injects a stalled agent and confirms a `crash`-status line lands in jsonl.
   - No code path exists in the harness where the benchmark runs but the jsonl write is skipped.

3. **Fresh context per iteration**
   - Each iteration uses `createAgentSession({ sessionManager: SessionManager.inMemory(), ... })` — verified by inspecting harness code (single call site, no shared session).
   - Between iterations, git working tree is either clean or reset to the last known-good commit before the next agent spawn.

4. **Configurability**
   - `autoresearch.config.json` supports a new `iterationModel`, `iterationProvider`, `iterationThinkingLevel`, `iterationTimeoutSeconds`, `iterationToolCallCap`, `noImprovementK`, `autoKeepThreshold`, and `harnessMode` field. Defaults documented.
   - With `harnessMode: "llm"`, the old in-session LLM-driven behavior is preserved verbatim (escape hatch).

5. **Abort and lifecycle**
   - `/autoresearch off` aborts a running harness within 5 seconds (current benchmark allowed to finish; no new iteration started).
   - Closing the pi session aborts the harness cleanly via `pi.on("session_shutdown")`.

6. **Observability**
   - Each iteration produces `.autoresearch/iterations/<segment>-<iter>.jsonl` containing the agent's tool calls, messages, and final status.
   - Widget shows live "iter N: <tool>" while an iteration runs; foreground pi session is not polluted with per-tool chatter.

7. **Performance**
   - Time from end of iteration N's benchmark to start of iteration N+1's agent prompt is under 10 seconds on a local dev machine (excludes actual benchmark runtime).

---

## 3. Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│ Foreground pi session (user)                           │
│                                                         │
│   /autoresearch <goal>                                 │
│         │                                               │
│         ▼                                               │
│   autoresearch-create skill                            │
│     • gather requirements                              │
│     • write autoresearch.md, .sh, .checks.sh           │
│     • init git branch                                  │
│     • invoke extension tool: start_loop                │
│         │                                               │
│         ▼                                               │
│   extension start_loop tool                            │
│     • validates state, kicks off harness async task    │
│     • returns immediately to the user                  │
│                                                         │
│   Widget + dashboard (unchanged): tail autoresearch.jsonl │
└────────────────────────────────────────────────────────┘
                         │ (in-process async task, same Node runtime)
                         ▼
┌────────────────────────────────────────────────────────┐
│ Harness loop (extension-owned)                         │
│                                                         │
│   for i in 1..maxIterations:                           │
│     1. ensureCleanGit()                                │
│     2. buildIterationPrompt()                          │
│     3. createAgentSession({                            │
│          sessionManager: SessionManager.inMemory(),    │
│          model, tools: [read, edit, write, bash,       │
│                         grep, announce_hypothesis],    │
│          cwd, resourceLoader (curated system prompt)   │
│        })                                              │
│     4. session.subscribe → .autoresearch/iter log      │
│                          → widget summary line         │
│     5. await session.prompt(userMessage)               │
│        (with timeout and tool-call cap)                │
│     6. run autoresearch.sh → parse METRIC lines        │
│     7. append jsonl line   ← GUARANTEED                │
│     8. rule-based keep/revert (git)                    │
│     9. update autoresearch.md "What's Been Tried"      │
│    10. stop-condition check                            │
└────────────────────────────────────────────────────────┘
```

---

## 4. File-by-File Changes

### New files

| Path | Purpose |
|------|---------|
| `extensions/pi-autoresearch/harness.ts` | Main loop, git hygiene, jsonl append, keep/revert decision. |
| `extensions/pi-autoresearch/iter-prompt.ts` | Builds curated system prompt + user message per iteration from `autoresearch.md` + last-N jsonl + hypothesis. |
| `extensions/pi-autoresearch/iter-log.ts` | Per-iteration event log to `.autoresearch/iterations/<segment>-<iter>.jsonl`. |
| `extensions/pi-autoresearch/announce-tool.ts` | Registers the mandatory `announce_hypothesis(description: string)` tool that the iteration agent must call to signal completion. |
| `extensions/pi-autoresearch/config.ts` | Typed loader for `autoresearch.config.json` with new fields. Replaces the inline `readMaxExperiments()` in `index.ts`. |
| `tests/harness.test.ts` | Unit tests for rule engine, jsonl writer, no-improvement detector. |
| `tests/harness.integration.test.ts` | Integration test against a mocked agent + fake `autoresearch.sh`. |

### Modified files

| Path | Change summary |
|------|----------------|
| `extensions/pi-autoresearch/index.ts` | Register `start_loop` tool; wire harness lifecycle to `session_start` / `session_shutdown`; gate the auto-resume code path behind `harnessMode === "llm"`; add `harness` slot to `AutoresearchRuntime`; add `announce_hypothesis` registration on agent session creation (via harness). |
| `skills/autoresearch-create/SKILL.md` | Tighten prose. Replace "LOOP FOREVER / NEVER STOP" section with "after writing files, call `start_loop` and stop — the harness takes over." Structural tool-contract language for weaker models. |
| `package.json` | Version bump (e.g., 1.0.1 → 1.1.0). Peer deps unchanged. |
| `README.md` | Short section documenting `harnessMode` and the new config keys. |

### Untouched

| Path | Why |
|------|-----|
| `skills/autoresearch-finalize/*` | Reads jsonl; schema is additive. Zero changes. |
| `autoresearch.sh`, `autoresearch.md`, `autoresearch.checks.sh` (user files) | Same purpose, same format. |
| Existing `run_experiment` / `log_experiment` tool handlers in `index.ts` | Kept for manual use. The harness calls internal functions, not these tools. |
| Widget / dashboard rendering (`index.ts` lines ~1276–1430) | Reads state reconstructed from jsonl. No change. |
| `reconstructState` (`index.ts:1150`) | Schema-additive; still works. |

---

## 5. Detailed Design

### 5.1 `start_loop` tool

Registered at extension load. Parameters: none (config comes from disk). Behavior:

```typescript
pi.registerTool({
  name: "start_loop",
  label: "Start Autoresearch Loop",
  description: "Start the autoresearch harness loop. Runs autonomously; returns immediately.",
  promptGuidelines: [
    "Call start_loop exactly once at the end of autoresearch-create, after writing autoresearch.md and autoresearch.sh.",
    "Do not call run_experiment manually afterwards — the harness owns the loop.",
  ],
  parameters: Type.Object({}),
  async execute(_id, _params, signal, _onUpdate, ctx) {
    const runtime = getRuntime(ctx);
    if (runtime.harness.running) {
      return { content: [{ type: "text", text: "⚠️ Autoresearch loop already running." }], details: {} };
    }
    const abort = new AbortController();
    runtime.harness.abort = abort;
    runtime.harness.running = true;
    // Fire-and-forget; harness holds its own lifecycle via ctx
    runHarnessLoop({ ctx, runtime, signal: abort.signal })
      .catch(err => ctx.ui.notify?.(`Harness error: ${err.message}`, "error"))
      .finally(() => { runtime.harness.running = false; });
    return { content: [{ type: "text", text: "✅ Autoresearch harness started." }], details: {} };
  }
});
```

**Concurrency invariant:** one harness per pi session. Second call returns a no-op message. `/autoresearch off` triggers `abort.abort()`.

### 5.2 Harness main loop (`harness.ts`)

```typescript
export async function runHarnessLoop({ ctx, runtime, signal }: HarnessDeps): Promise<void> {
  const config = loadConfig(ctx.cwd);
  const workDir = resolveWorkDir(ctx.cwd);
  const state = runtime.state;
  const maxIter = config.maxIterations ?? Infinity;
  const noImproveK = config.noImprovementK ?? 10;
  const startIter = state.results.filter(r => r.segment === state.currentSegment).length;

  for (let i = startIter; i < maxIter; i++) {
    if (signal.aborted) return;

    // 1. Git hygiene
    const hygieneOk = await ensureCleanGit(workDir);
    if (!hygieneOk) {
      appendJsonl(workDir, makeCrashLine(state, "dirty git tree; harness refusing to proceed"));
      break;
    }

    // 2. Build iteration prompt
    const { systemPrompt, userMessage } = buildIterationPrompt(workDir, state, i);

    // 3. Per-iteration log sink
    const iterLog = openIterationLog(workDir, state.currentSegment, i);

    // 4. Spawn fresh-context agent
    let hypothesis = "(agent did not announce hypothesis)";
    const announceTool = createAnnounceTool(h => { hypothesis = h; });
    const loader = new DefaultResourceLoader({ systemPromptOverride: () => systemPrompt });
    await loader.reload();

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      cwd: workDir,
      model: resolveIterationModel(config, ctx),
      thinkingLevel: config.iterationThinkingLevel ?? "minimal",
      tools: [
        createReadTool(workDir),
        createEditTool(workDir),
        createWriteTool(workDir),
        createBashTool(workDir),
        createGrepTool(workDir),
        announceTool,
      ],
      resourceLoader: loader,
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
    });

    let toolCallCount = 0;
    const unsubscribe = session.subscribe(ev => {
      iterLog.record(ev);
      if (ev.type === "tool_execution_start") {
        toolCallCount++;
        broadcastIterStatus(runtime, i, ev.toolName);
        if (toolCallCount > (config.iterationToolCallCap ?? 20)) {
          session.abort?.();
        }
      }
    });

    // 5. Run agent with timeout
    const timeoutMs = (config.iterationTimeoutSeconds ?? 600) * 1000;
    let agentError: Error | null = null;
    try {
      await withTimeoutAndAbort(session.prompt(userMessage), timeoutMs, signal);
    } catch (err) {
      agentError = err as Error;
    } finally {
      unsubscribe();
    }

    // 6. Run benchmark — ALWAYS, regardless of agent outcome
    let benchResult: BenchResult;
    if (agentError) {
      benchResult = { crashed: true, metric: 0, metrics: {}, tailOutput: agentError.message };
    } else {
      benchResult = await runBenchmarkInternal(workDir, config);
    }

    // 7. ALWAYS append jsonl line
    const status = decideStatus(benchResult, state, config);
    const line: ExperimentResult = {
      commit: "",
      metric: benchResult.metric,
      metrics: benchResult.metrics,
      status,
      description: hypothesis,
      timestamp: Date.now(),
      segment: state.currentSegment,
      confidence: null,
      iterationTokens: null,
      asi: { iter_log: iterLog.path, tool_calls: toolCallCount, agent_error: agentError?.message },
    };

    // 8. Rule-based keep/revert + git commit
    if (status === "keep") {
      const sha = await gitCommitAll(workDir, commitMessageFromIter(hypothesis, line));
      line.commit = sha;
    } else {
      await gitResetHardToLastGood(workDir);
    }
    appendJsonl(workDir, line);
    state.results.push(line);
    state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
    state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
    broadcastDashboardUpdate(workDir);
    updateWidgetFromState(ctx);

    // 9. Update autoresearch.md mechanically (append a bullet to "What's Been Tried")
    await appendTriedBullet(workDir, line);

    // 10. Stop conditions
    if (hasStalled(state, noImproveK)) {
      ctx.ui?.notify?.(`Autoresearch stopped: no improvement in ${noImproveK} iterations.`, "info");
      break;
    }
  }
}
```

### 5.3 The `announce_hypothesis` contract

The iteration agent is given a **mandatory** custom tool:

```typescript
{
  name: "announce_hypothesis",
  description: "Required final step. Call this once with a one-sentence description of what you tried. After calling this, stop — do not make further edits.",
  parameters: { description: string }
}
```

The system prompt explicitly says: "Your final tool call must be `announce_hypothesis`. Do not run tests, do not call bash except to inspect state. The harness runs the benchmark after you exit." If the agent never calls it, the hypothesis defaults to `"(agent did not announce hypothesis)"` and still gets logged — no data loss. This gives weak models a schema-shaped exit ramp instead of relying on prose compliance.

### 5.4 Keep/revert decision rule

```typescript
function decideStatus(b: BenchResult, state: ExperimentState, cfg: Config): Status {
  if (b.crashed) return "crash";
  if (b.checksFailed) return "checks_failed";
  if (state.bestMetric === null) return "keep"; // first run — baseline
  const thresholdPct = cfg.autoKeepThreshold ?? 0;
  const isBetter = state.bestDirection === "lower"
    ? b.metric < state.bestMetric * (1 - thresholdPct / 100)
    : b.metric > state.bestMetric * (1 + thresholdPct / 100);
  return isBetter ? "keep" : "discard";
}
```

**Optional LLM veto:** if `cfg.llmVeto === true` (default `false`), before committing a `keep`, the harness invokes a minimal 1-turn agent with the diff + metric delta and asks `should_keep: yes|no|why`. Off by default because it adds cost and latency. Can be enabled for signal-noisy domains.

### 5.5 Iteration prompt structure (`iter-prompt.ts`)

System prompt (under 800 tokens, cache-friendly — stable across iterations):

```
You are an autoresearch iteration agent. Make ONE optimization attempt. Rules:

1. Read autoresearch.md for objective, scope, and constraints.
2. Review the "Recent runs" below to avoid dead ends.
3. Pick ONE change from the hypothesis queue OR propose a new small change.
4. Make edits with the edit/write tools ONLY on files listed in "Files in Scope".
5. Do NOT run autoresearch.sh. Do NOT commit. Do NOT call run_experiment or log_experiment — they do not exist here.
6. When done, call `announce_hypothesis` with a one-sentence description and STOP.

Tool-call budget: 20. Timeout: 10 minutes.

## Objective and Scope
<contents of autoresearch.md>

## Recent runs (last 5)
- iter 12 (keep, −3.1%): switched vitest pool to forks
- iter 11 (discard):      bumped worker count to 8
- ...

## Hypothesis queue (top 3 from autoresearch.ideas.md or auto-generated)
1. Try sharding test files by size.
2. Memoize schema compiler output.
3. Lazy-import the slow fixture.

## Current metric
Best: total_s = 38.1 (lower is better). Baseline: 42.3.
```

User message: `"Begin iteration {i}. Pick one change, make the edits, call announce_hypothesis."`

### 5.6 Git hygiene (`ensureCleanGit`)

```typescript
async function ensureCleanGit(workDir: string): Promise<boolean> {
  const status = await pi.exec("git", ["status", "--porcelain"], { cwd: workDir });
  if (!status.stdout.trim()) return true;
  // Unexpected dirty state — stash with label and report to user
  await pi.exec("git", ["stash", "-u", "-m", "autoresearch-safety-stash"], { cwd: workDir });
  return true;
}
```

Stash pops are **not** automatic — they're surfaced in the final summary so the user decides.

### 5.7 Iteration log schema

`.autoresearch/iterations/<segment>-<iter>.jsonl`:

```
{"ts": 1745428800000, "type": "meta", "iter": 13, "model": "claude-sonnet-4-6", "started_at": ...}
{"ts": ..., "type": "tool_execution_start", "tool": "edit", "args": {...}}
{"ts": ..., "type": "tool_execution_end", "tool": "edit", "ok": true}
{"ts": ..., "type": "announce_hypothesis", "description": "sharded tests by size"}
{"ts": ..., "type": "meta_end", "tool_calls": 5, "finished_at": ..., "error": null}
```

### 5.8 Config extensions (`autoresearch.config.json`)

```jsonc
{
  "workingDir": "/path/to/project",       // existing
  "maxIterations": 50,                     // existing
  "harnessMode": "harness",                // NEW: "harness" (default) | "llm"
  "iterationModel": "claude-sonnet-4-6",   // NEW: default = foreground model
  "iterationProvider": "anthropic",        // NEW
  "iterationThinkingLevel": "minimal",     // NEW: off|minimal|low|medium|high|xhigh
  "iterationTimeoutSeconds": 600,          // NEW
  "iterationToolCallCap": 20,              // NEW
  "noImprovementK": 10,                    // NEW: stop after K iters with no improvement
  "autoKeepThreshold": 0,                  // NEW: min % improvement to auto-keep
  "llmVeto": false                         // NEW: enable optional keep-veto pass
}
```

### 5.9 Widget updates

Existing widget already has a `runningExperiment` slot (`index.ts:131`). Reuse it:
- On `tool_execution_start`, set `runningExperiment = { command: ev.toolName, startedAt: Date.now() }`.
- On `agent_end` for iteration, clear it.
- Existing spinner handling already renders it.

No new UI code; just a new writer.

### 5.10 Auto-resume deprecation

At `index.ts:1464` the `agent_end` handler schedules a resume. Gate it:

```typescript
if (runtime.config.harnessMode === "llm") { /* existing code */ }
```

In `harness` mode the harness owns continuation, so the auto-resume nudge is redundant.

### 5.11 Skill changes (`skills/autoresearch-create/SKILL.md`)

**Before** (current): long prose about "LOOP FOREVER", asi annotations, confidence scoring, etc.

**After**: structural tool-contract with a shortened Loop Rules section:

```markdown
## Flow

1. Gather: goal, command, metric + direction, files in scope, constraints.
2. git checkout -b autoresearch/<goal>-<date>
3. Write autoresearch.md and autoresearch.sh. Commit.
4. Call start_loop. STOP. The harness takes over.

## Tool Contract

- `start_loop` — call exactly once at the end of setup. No parameters. Returns immediately.
- `init_experiment`, `run_experiment`, `log_experiment` — available for MANUAL use only. The harness does not use them.

## Do Not

- Do not loop manually. Do not call run_experiment after start_loop.
- Do not edit autoresearch.jsonl. The harness and iteration agents own it.
```

---

## 6. Implementation Steps

Ordered. Each step ends at a testable checkpoint.

### Step 1 — Typed config loader and schema
- Write `extensions/pi-autoresearch/config.ts` with `loadConfig(cwd: string): Config`.
- Replace `readMaxExperiments()` calls in `index.ts` with the new loader.
- **Test:** `tests/config.test.ts` — load defaults, load full file, reject bad types.

### Step 2 — Iteration log writer (`iter-log.ts`)
- `openIterationLog(workDir, segment, iter)` returns `{ record(ev), recordError(err), close(), path }`.
- **Test:** write 10 events, assert file has 12 lines (2 meta + 10 events).

### Step 3 — `announce_hypothesis` tool factory (`announce-tool.ts`)
- Factory returns a pi-coding-agent Tool instance that captures the description via a callback.
- **Test:** mock agent calls it with `{ description: "x" }`, callback receives "x".

### Step 4 — Iteration prompt builder (`iter-prompt.ts`)
- `buildIterationPrompt(workDir, state, iter)` returns `{ systemPrompt, userMessage }`.
- Reads `autoresearch.md`, pulls last 5 jsonl lines, reads `autoresearch.ideas.md` if present.
- **Test:** snapshot test — given fixture inputs, prompt contains expected sections.

### Step 5 — Harness rule engine
- `decideStatus`, `hasStalled`, `commitMessageFromIter` as pure functions in `harness.ts`.
- **Test:** `tests/harness.test.ts` — table-driven cases for each decision path.

### Step 6 — Git hygiene helpers
- `ensureCleanGit`, `gitCommitAll`, `gitResetHardToLastGood`, `appendTriedBullet`.
- **Test:** integration test in a temp git repo — create dirty state, assert stash; create commit, assert reset returns to it.

### Step 7 — Main harness loop
- Wire together steps 1–6 in `runHarnessLoop`.
- Include abort signal wiring, timeout wrapper, tool-call cap.
- **Test:** `tests/harness.integration.test.ts` with a fake `createAgentSession` stub that just calls `announce_hypothesis` and a fake `autoresearch.sh` that prints `METRIC total_s=42`.

### Step 8 — `start_loop` tool registration in `index.ts`
- Add tool handler; wire `runtime.harness = { running, abort, ... }`.
- Gate existing auto-resume behind `harnessMode === "llm"`.
- Handle `session_shutdown` → abort harness.

### Step 9 — Observability wiring
- Subscribe callback writes to iter-log and updates widget via existing `runningExperiment` slot.
- Throttle widget updates to 10 Hz.
- **Test:** manual — run a short loop, observe widget text changing during iteration.

### Step 10 — Skill update
- Rewrite `SKILL.md` per §5.11.
- **Test:** manual — `/autoresearch test this` produces a running harness within ~30 s of setup.

### Step 11 — Stop conditions + `/autoresearch off`
- `/autoresearch off` now also calls `runtime.harness.abort?.abort()`.
- `maxIterations`, `noImprovementK` enforced in the loop.
- **Test:** set `maxIterations: 3`, confirm it halts after 3 jsonl lines.

### Step 12 — Regression pass against existing jsonl files
- Place a pre-migration jsonl fixture in `tests/fixtures/`, run `reconstructState`, assert state matches expected.

### Step 13 — autoresearch-finalize end-to-end check
- Run the new harness on a fixture, then run `finalize.sh` on the result. Assert branches are created as before.

### Step 14 — Documentation
- README: new config keys, `harnessMode`, short note that the loop is now harness-driven.

### Step 15 — Version bump and release
- `package.json` 1.0.1 → 1.1.0.
- CHANGELOG entry.

---

## 7. Verification Steps

Each must be executed and recorded before shipping.

1. **Unit suite** — `pnpm test` passes for `config.test.ts`, `iter-log.test.ts`, `harness.test.ts`.
2. **Integration** — `harness.integration.test.ts` passes with mocked agent.
3. **Durability test** — construct an agent stub that throws mid-prompt. Assert jsonl gains one `crash` line.
4. **Fresh context proof** — grep harness.ts for `SessionManager.` — must be exactly one match, `SessionManager.inMemory()`.
5. **Regression fixture** — existing `autoresearch.jsonl` loads into `reconstructState` with identical state to old code (diff the `ExperimentState` object).
6. **Finalize end-to-end** — produce 5 iterations with new harness, then run `finalize.sh` and check branch count + commit messages.
7. **Abort test** — start a loop, send `/autoresearch off`, measure time to `running = false` (< 5 s allowed benchmark finish).
8. **Performance** — log timestamps at end of iter N benchmark and start of iter N+1 prompt. Delta < 10 s.
9. **Weak-model empirical test** — run against Haiku-class model for 20 iterations against a known test-speed benchmark. Confirm every iteration produces a jsonl line.
10. **Existing interface smoke** — `/autoresearch optimize test runtime` → setup → loop runs → `/autoresearch export` opens dashboard → `/autoresearch off` stops → `/skill:autoresearch-finalize` succeeds.

---

## 8. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| pi SDK API changes between versions | Medium | High | Pin peer dep range; add integration test that imports `createAgentSession` directly; monitor `@mariozechner/pi-coding-agent` changelog. |
| Iteration agent creates unrelated file changes (noise in commits) | Medium | Medium | Harness runs `git diff --name-only` before commit; if changed files outside "Files in Scope" list in autoresearch.md, log as `discard` with an `asi.reason` and revert. |
| Git stash at harness start loses user's uncommitted work | Low | High | Safety-stash is labeled `autoresearch-safety-stash`; surfaced in final summary; never auto-popped. |
| `SessionManager.inMemory()` still leaks state via provider cache | Low | Medium | Confirm by log inspection on first integration test; if needed, add explicit cache busting. |
| Tool-call cap too strict, agent can't accomplish anything | Medium | Medium | Default 20 is generous; configurable. If hit, status = `crash` with an explanatory `asi`. |
| Prompt cache misses every iteration (new last-5 runs) | Medium | Low | Split system prompt: stable portion (autoresearch.md + rules) first, dynamic portion (last-N runs) last; providers cache the stable prefix. |
| Iteration agent model unavailable / rate-limited | Low | High | `pi.exec`-style retry with backoff; fall back to foreground model after 3 failures; log a `crash` line so the loop continues. |
| Two concurrent `start_loop` calls | Low | Medium | Guard with `runtime.harness.running` — second call returns a "already running" message. |
| Widget spam / TUI jank during heavy iteration | Medium | Low | Throttle widget updates to 10 Hz; drop intermediate tool-start events. |
| Migration: existing users on `harnessMode: undefined` get new behavior | Certain | Low | Default is `"harness"`. Document escape hatch. Add a one-time notice in the widget on first run: "Autoresearch now uses harness-driven loops. Set `harnessMode: llm` in autoresearch.config.json to restore old behavior." |
| `autoresearch.checks.sh` backpressure not wired into harness path | Low (will be built) | Medium | Harness calls checks after benchmark; failure → `checks_failed` status; same semantics as today. Covered in integration test. |

---

## 9. Open Questions / Deferred

- **Hypothesis generation as a separate agent call (planner → executor split).** Discussed in brainstorming; deferred to a v1.2 follow-up once v1.1 stabilizes. Rationale: don't compound risk.
- **Structured `autoresearch.hypotheses.jsonl`** replacing free-form `autoresearch.ideas.md`. Deferred for the same reason; current format works.
- **Subprocess (`pi --mode json`) fallback for non-Node consumers.** Not needed today — we live in the extension's Node process. Revisit if the extension needs to be portable outside pi.

---

## 10. Changelog

- `1.1.0` (planned) — Harness-driven loop. New config keys. `start_loop` tool. Backward-compatible jsonl schema. Escape hatch via `harnessMode: "llm"`.

---

## 11. Summary

This plan externalizes the experiment loop from the LLM to a deterministic in-process harness built on pi's SDK (`createAgentSession` + `SessionManager.inMemory()`). The harness guarantees jsonl durability, git hygiene, and per-iteration isolation — the three failure modes that weaker models trigger in the current design. The user-facing interface, files on disk, widget/dashboard, and `autoresearch-finalize` are unchanged. Risk is bounded by an `harnessMode: "llm"` escape hatch and by 15 verification checkpoints before release.
