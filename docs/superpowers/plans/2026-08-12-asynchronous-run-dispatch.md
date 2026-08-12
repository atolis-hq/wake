# Asynchronous Run Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and expose an active Run before agent execution completes so the existing GitHub label reconciler publishes `wake:status.working` without blocking other Wake work.

**Architecture:** Split the current synchronous execution attempt into durable dispatch and asynchronous completion. Dispatch validates, claims, allocates, and appends RunStarted, then returns the started view. A worker owns activity execution, terminal facts, release, cleanup, and process-local cancellation. AdvanceOnce reports a started run as progress and existing completed-run recovery accepts its terminal outcome later.

**Tech Stack:** TypeScript, Vitest, event journal, RunRepository, GitHub label reconciliation.

---

### Task 1: Split durable dispatch from worker completion

**Files:** Modify `src/execution/application/execution-service.ts`; optionally modify `execution-activity.ts`; test `test/unit/execution/execution-service.test.ts`.

- [ ] Write a failing controlled-handler test: an activity blocks on a Promise; `service.attempt` must resolve with a started Run after RunStarted is durable, before the handler resolves. Release the handler and assert the same Run eventually succeeds. Test a repeated attempt returns the existing started Run without a second worker.
- [ ] Run `npx vitest run test/unit/execution/execution-service.test.ts`; expect failure because attempt currently awaits activity completion.
- [ ] Extract `dispatchExecution` from `attemptExecution`: preserve validation, existing-run lookup, activation claim, workspace acquisition, and startRun. Reload the started Run, launch `void runWorker(...)`, and return the started view. `runWorker` retains executeActivity, terminal success/failure facts, activation release, active-map cleanup, workspace release, and cleanup diagnostics. Pre-start failures continue releasing an acquired workspace.

```ts
await startRun(startInput);
const started = (await runtime.repository.load(currentRunId)).view!;
void runWorker(runtime, workerInput).catch(() => undefined);
return started;
```

- [ ] Run `npx vitest run test/unit/execution/execution-service.test.ts test/unit/execution/recovery.test.ts`; expect PASS.
- [ ] Commit Task 1 as `feat: dispatch runs asynchronously`.

### Task 2: Treat started runs as AdvanceOnce progress

**Files:** Modify `src/control-plane/application/advance-once.ts`; test `test/unit/control-plane/advance-once.test.ts` and `test/e2e/scenarios/golden-path.test.ts`.

- [ ] Add a failing ExecutionPort test that returns a started Run; assert AdvanceOnce marks the activation started, returns progressed with run and activation IDs, and does not call acceptOutcome. On a later invocation with a terminal Run, assert existing completed-run recovery accepts it once.
- [ ] Run `npx vitest run test/unit/control-plane/advance-once.test.ts`; expect started currently maps to blocked.
- [ ] Add the explicit started branch before terminal result handling.

```ts
if (run.status === RunStatus.Started)
  return { kind: 'progressed', activationId: selected.activation.activationId, runId: run.runId };
```

- [ ] Run `npx vitest run test/unit/control-plane/advance-once.test.ts test/e2e/scenarios/golden-path.test.ts`; expect PASS.
- [ ] Commit Task 2 as `feat: progress after run dispatch`.

### Task 3: Prove working label reconciliation occurs while a run is active

**Files:** Test `test/unit/control-plane/runner-pipeline.test.ts`, `test/integration/integrations/github-state-sync.test.ts`, and, if needed, `test/integration/bootstrap/runtime.test.ts`.

- [ ] Add a failing pipeline test that a dispatch-progress result reaches post-advance projection and react stages while controlled execution remains pending. Add a GitHub state-sync test seeded with an active primary workflow and old `wake:status.failed`; assert reconciliation replaces it with `wake:status.working` and preserves stage/workflow labels.
- [ ] Run `npx vitest run test/unit/control-plane/runner-pipeline.test.ts test/integration/integrations/github-state-sync.test.ts`; expect the dispatch sequencing assertion to fail before Task 1 and 2.
- [ ] Keep existing post-advance order `catchUpProjections → deliver → catchUpProjections → react`; do not add a GitHub-specific execution hook. Make only deterministic fixture adjustments needed for the async worker.
- [ ] Re-run `npx vitest run test/unit/control-plane/runner-pipeline.test.ts test/integration/integrations/github-state-sync.test.ts test/integration/bootstrap/runtime.test.ts`; expect PASS.
- [ ] Commit Task 3 as `test: reconcile working status after dispatch`.

### Task 4: Document and verify behavior

**Files:** Modify `docs/workflows.md`; add a scenario only if Task 1–3 cannot prove active-run label reconciliation end to end.

- [ ] Add a concise operations note: started Runs are durable and shown as working while the runner executes; terminal labels remain outcome-derived; recovery after restart uses durable active-run recovery; comments are unchanged.
- [ ] Run focused suites: `npx vitest run test/unit/execution/execution-service.test.ts test/unit/execution/recovery.test.ts test/unit/control-plane/advance-once.test.ts test/unit/control-plane/runner-pipeline.test.ts test/integration/integrations/github-state-sync.test.ts`.
- [ ] Run broader verification: `npm run test:unit`, `npm run test:integration`, and `npm run build`. If a scenario was added, also run it and `npm run check:scenarios`.
- [ ] Run `git diff --check` and inspect `git status --short` before committing documentation as `docs: describe live run status`.
