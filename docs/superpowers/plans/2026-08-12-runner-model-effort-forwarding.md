# Runner Model and Effort Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward configured model and effort through the shared runner request, with each CLI adapter translating them into its vendor command-line syntax.

**Architecture:** `RunnerRequest` owns portable `model` and `effort` values. Execution resolves both values from the selected named runner and supplies them to Agent Activity; the activity gives them to every runner. Concrete adapters retain responsibility for turning shared values into CLI flags: Codex uses `--model` and `-c model_reasoning_effort=<effort>`, while Claude and Cursor consume only `model`.

**Tech Stack:** TypeScript, Zod, Vitest.

---

### Task 1: Carry the shared settings from runner selection to an invocation

**Files:**
- Modify: `src/activities/contracts/activity.ts`
- Modify: `src/execution/contracts/runner.ts`
- Modify: `src/execution/application/execution-service.ts`
- Modify: `src/execution/application/execution-activity.ts`
- Modify: `src/activities/agent/agent-activity.ts`
- Test: `test/unit/execution/runner-selection.test.ts`

- [ ] **Step 1: Write the failing test**

Add a capturing runner assertion after `await service.attempt(...)` proving the runner receives both configured values:

```ts
expect(standard.requests).toEqual([
  expect.objectContaining({ model: 'test-model', effort: 'high' }),
]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/runner-selection.test.ts`

Expected: FAIL because the request has neither selected runner setting.

- [ ] **Step 3: Write minimal implementation**

Add `effort?: string` beside `model?: string` in the shared activity runner port and `RunnerRequest`. Pass the selected runner's model and effort from `attemptExecution` into `executeActivity`, include them on `ActivityExecutionContext`, and merge them into Agent Activity's request only when the activity/template did not explicitly set `model`. Always include selected `effort` when defined.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/runner-selection.test.ts`

Expected: PASS.

### Task 2: Translate shared effort in the Codex adapter

**Files:**
- Modify: `src/execution/infrastructure/runners/codex.ts`
- Test: `test/integration/execution/process-execution.test.ts`

- [ ] **Step 1: Write the failing test**

Set `effort: 'medium'` in the existing Codex command-shape request and require:

```ts
[
  'exec', '--json', '--model', 'gpt-test',
  '-c', 'model_reasoning_effort=medium',
  'resume', 'prior-session', 'ship',
]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: FAIL because `codexCommandArgs` omits the `-c` pair.

- [ ] **Step 3: Write minimal implementation**

In `codexCommandArgs`, add `...(request.effort === undefined ? [] : ['-c', \`model_reasoning_effort=${request.effort}\`])` immediately after the optional model arguments.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: PASS.

### Task 3: Confirm parity and document the generic contract

**Files:**
- Modify: `test/integration/execution/process-execution.test.ts`
- Modify: `src/execution/infrastructure/runners/runners.spec.md`

- [ ] **Step 1: Add adapter parity tests**

Update the Claude and Cursor command-shape cases to include `effort: 'medium'`, while retaining their existing expected arrays. This proves model continues to be forwarded for all adapters and that adapters without an effort mapping omit it deliberately.

- [ ] **Step 2: Run focused adapter tests**

Run: `npx vitest run test/integration/execution/process-execution.test.ts`

Expected: PASS.

- [ ] **Step 3: Update the runner specification**

Document `effort` alongside `model` in `RunnerRequest`, stating that it is a portable request setting that adapters may map to their vendor-specific option; Codex maps it to `model_reasoning_effort`, while adapters with no native equivalent omit it.

- [ ] **Step 4: Run complete verification**

Run: `npm test`

Expected: PASS with zero test failures.
