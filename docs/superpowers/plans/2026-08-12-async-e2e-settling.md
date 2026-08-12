# Async E2E Settling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make asynchronous E2E workflows deterministic without hiding one-tick execution, and provide a fast, safely parallel local test path.

**Architecture:** Keep `TestWorld.advance()` as a single control-plane tick. Add a bounded, test-only settling helper which repeatedly ticks and yields microtasks until no local run is active. Unit and integration configuration explicitly enable file parallelism; E2E remains serial because it includes process and filesystem scenarios.

**Tech Stack:** TypeScript, Vitest 4, npm scripts.

---

### Task 1: Prove and add bounded E2E settling

**Files:**
- Modify: `test/e2e/scenarios/lifecycle-happy-path.test.ts`
- Modify: `test/e2e/support/world.ts`

- [ ] **Step 1: Write the failing scenario expectation**

Replace the first lifecycle tick with the intended API:

```ts
await world.advanceUntilSettled(work.workItemId);
expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('waiting');
```

- [ ] **Step 2: Run the focused scenario and verify RED**

Run: `npm run test:e2e -- test/e2e/scenarios/lifecycle-happy-path.test.ts`

Expected: TypeScript/test failure because `advanceUntilSettled` is absent.

- [ ] **Step 3: Add the minimal helper**

Add this method immediately after `advance()` in `TestWorld`:

```ts
async advanceUntilSettled(workItemId?: WorkItemId): Promise<AdvanceResult> {
  let result: AdvanceResult = { kind: 'no-work' };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await this.advance(workItemId);
    await Promise.resolve();
    if (!(await this.execution.list()).some((run) => run.status === 'started')) return result;
  }
  throw new Error(`Workflow did not settle after 20 ticks:\n${await this.trace()}`);
}
```

- [ ] **Step 4: Run the focused scenario and verify GREEN**

Run: `npm run test:e2e -- test/e2e/scenarios/lifecycle-happy-path.test.ts`

Expected: PASS.

### Task 2: Apply settling only to eventual-state E2E scenarios

**Files:**
- Modify: `test/e2e/scenarios/*.test.ts` that assert a workflow's eventual `waiting`, `blocked`, or `completed` state after dispatch
- Preserve: `test/e2e/scenarios/cancel-active-run.test.ts` and recovery scenarios that intentionally observe an active run

- [ ] **Step 1: Run the E2E suite and record the active-state failures**

Run: `npm run test:e2e`

Expected: failures whose immediate cause is `active`/`running` rather than their expected terminal or waiting state.

- [ ] **Step 2: Replace only eventual-state tick calls**

For each recorded eventual-state failure, change the dispatch call from:

```ts
await world.advance(work.workItemId);
```

to:

```ts
await world.advanceUntilSettled(work.workItemId);
```

Do not change calls stored without awaiting, calls followed by active-run polling, or calls whose assertion expects `started`/`running`.

- [ ] **Step 3: Re-run E2E verification**

Run: `npm run test:e2e`

Expected: the asynchronous active-state failures are resolved; remaining failures, if any, are independent and reported separately.

### Task 3: Add explicit fast and parallel-safe test entry points

**Files:**
- Modify: `package.json`
- Modify: `vitest.unit.config.ts`
- Modify: `vitest.integration.config.ts`
- Modify: `docs/development.md`

- [ ] **Step 1: Write the script/configuration expectations**

Add a `test:fast` package script equal to `npm run test:unit`, and set
`fileParallelism: true` in the unit and integration Vitest configurations.

- [ ] **Step 2: Run the fast command and verify its initial behavior**

Run: `npm run test:fast`

Expected: unit tests execute; any pre-existing failure is captured before documentation changes.

- [ ] **Step 3: Document the local test ladder**

Under `docs/development.md` local commands, document these choices:

```text
focused file -> npm run test:unit -> npm run test:integration -> npm run test:e2e -> npm run verify
```

State that unit and integration test files run in parallel, whereas E2E runs serially because of process and filesystem fixtures.

- [ ] **Step 4: Verify the commands**

Run: `npm run test:fast` and `npm run test:integration`

Expected: both suites run with file parallelism; report results and duration.

### Task 4: Final verification

**Files:**
- Verify: all files changed above

- [ ] **Step 1: Format changed files**

Run: `npx prettier --write package.json vitest.unit.config.ts vitest.integration.config.ts docs/development.md test/e2e/support/world.ts test/e2e/scenarios`

- [ ] **Step 2: Run static checks and the full test command**

Run: `npm run build` then `npm test`

Expected: build passes; full-suite result is reported with its duration and any independent failures.

- [ ] **Step 3: Commit the implementation**

```bash
git add package.json vitest.unit.config.ts vitest.integration.config.ts docs/development.md test/e2e
git commit -m "test: support async e2e settling"
```
