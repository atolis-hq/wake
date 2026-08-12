# Codex Resume Token Deltas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record Codex resumed invocations with per-run token deltas rather than cumulative session totals.

**Architecture:** Execution derives a typed prior-usage baseline when it selects a resumable session and places it on `RunnerRequest`. The Codex adapter subtracts that baseline from its final cumulative CLI usage snapshot. All generic aggregate displays count input and output once, with cache counters retained only as diagnostics.

**Tech Stack:** TypeScript, Vitest, existing Execution runner contracts.

---

### Task 1: Add a runner usage baseline contract

**Files:**
- Modify: `src/execution/contracts/runner.ts`
- Modify: `src/execution/application/execution-service.ts`
- Test: `test/integration/execution/process-execution.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test for a resumed Codex parser input with a baseline of `{ input: 19, output: 23 }` and a final snapshot of `{ input_tokens: 31, output_tokens: 29 }`, expecting `{ input: 12, output: 6 }`.

```ts
expect(parseCodexOutput(stdout, { input: 19, output: 23 })).toMatchObject({
  tokenUsage: { input: 12, output: 6 },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: FAIL because `RunnerRequest` does not expose a usage baseline and Codex returns the raw snapshot.

- [ ] **Step 3: Write minimal implementation**

Add an optional `usageBaseline` with input, output, cache-read, and cache-write counters to `RunnerRequest`. In `execution-service.ts`, select the resume session and calculate its baseline by summing prior completed run metadata with the same CLI and session ID. Pass the baseline only when resuming.

```ts
readonly usageBaseline?: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: PASS.

### Task 2: Return a safe Codex usage delta

**Files:**
- Modify: `src/execution/infrastructure/runners/claude.ts`
- Modify: `src/execution/infrastructure/runners/codex.ts`
- Test: `test/integration/execution/process-execution.test.ts`

- [ ] **Step 1: Write the failing tests**

Add one test that parses the final Codex snapshot rather than summing multiple `turn.completed` events. Add one test that a negative field delta omits `tokenUsage`. Keep the existing Claude test unchanged to prove it does not apply a baseline.

```ts
expect(parseCodexOutput(twoSnapshots)).toMatchObject({ tokenUsage: { input: 31, output: 29 } });
expect(parseCodexOutput(stdout, { input: 32, output: 23 })).not.toHaveProperty('tokenUsage');
```

- [ ] **Step 2: Run test to verify they fail**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: FAIL because the parser accumulates snapshots and has no non-negative delta guard.

- [ ] **Step 3: Write minimal implementation**

Let the shared CLI parser receive the runner request. Let `parseCodexOutput` accept an optional baseline and retain only the last complete `turn.completed` usage snapshot. Subtract all supplied baseline fields and return usage only if every available delta is non-negative. Do not modify Claude parsing.

```ts
const usage = usageFor(event);
const tokenUsage = usage === undefined ? undefined : subtractUsage(usage, baseline);
return tokenUsage === undefined ? {} : { tokenUsage };
```

- [ ] **Step 4: Run test to verify they pass**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: PASS.

### Task 3: Prevent cache-token double counting

**Files:**
- Modify: `src/execution/contracts/runner.ts`
- Test: `test/unit/execution/runner-selection.test.ts`

- [ ] **Step 1: Write the failing test**

Add an assertion that `agentTokenUsage` for `{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 }` returns `110` tokens, not `195`.

```ts
expect(agentTokenUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 }))
  .toEqual({ tokens: 110, costUsd: 0 });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/runner-selection.test.ts`

Expected: FAIL because aggregate usage adds cache counters to input and output.

- [ ] **Step 3: Write minimal implementation**

Change `agentTokenUsage` to return `inputTokens + outputTokens`; preserve cache counters in metadata for diagnostics.

```ts
tokens: numeric('inputTokens') + numeric('outputTokens'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/runner-selection.test.ts`

Expected: PASS.

### Task 4: Verify the scoped change

**Files:**
- Modify: `src/execution/infrastructure/runners/runners.spec.md`

- [ ] **Step 1: Update the runner specification**

Document that Codex converts a resumed cumulative snapshot into a per-invocation delta using an Execution-supplied baseline, while Claude reports per-invocation JSON usage directly.

- [ ] **Step 2: Run focused validation**

Run: `npx vitest run test/integration/execution/process-execution.test.ts test/unit/execution/runner-selection.test.ts && npm run build`

Expected: all focused tests pass and TypeScript exits successfully.

- [ ] **Step 3: Commit the implementation**

Run: `git add src/execution/contracts/runner.ts src/execution/application/execution-service.ts src/execution/infrastructure/runners/claude.ts src/execution/infrastructure/runners/codex.ts src/execution/infrastructure/runners/runners.spec.md test/integration/execution/process-execution.test.ts test/unit/execution/runner-selection.test.ts docs/superpowers/plans/2026-08-12-codex-resume-token-deltas.md && git commit -m "fix: record resumed Codex usage per run"`
