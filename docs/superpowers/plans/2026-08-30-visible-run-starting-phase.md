# Visible Run Starting Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every dispatched attempt immediately visible as an active `Starting` Run, then transition that same Run to `Running` when workspace preparation completes and activity execution begins.

**Architecture:** Introduce `execution.run-preparation-started` as the first fact on new Run streams and add `starting` to the closed Run status vocabulary. The execution fold, membership and board projections derive immediate visibility from that fact; `run-started` remains the execution boundary and adds `executionStartedAt` plus workspace facts. A Run lease covers both preparation and execution so recovery, capacity and maintenance treat both phases as one active attempt.

**Tech Stack:** TypeScript, Zod event contracts, append-only event journal, rebuildable projections, React, TanStack Query, Vitest, Wake scenario harness.

---

## File map

- `src/execution/contracts/events.ts`: declare and decode the new Run preparation fact.
- `src/execution/contracts/event-factory.ts`: permit creation of the new typed Run event.
- `src/execution/contracts/vocabulary.ts`: own `starting` and the shared active-status predicate.
- `src/execution/contracts/views.ts`: expose `executionStartedAt` separately from attempt `startedAt`.
- `src/execution/domain/run.ts`: fold both historical and new Run stream shapes.
- `src/execution/application/execution-projection.ts`: index Run membership at preparation time.
- `src/execution/application/run-lifecycle.ts`: append preparation before workspace acquisition and execution start afterward.
- `src/execution/application/execution-service.ts`: hold and renew the Run lease throughout preparation and make preparation failures durable.
- `src/execution/application/{recovery-service,run-liveness-service,active-run-cancellation}.ts`: treat Starting and Running as active.
- `src/control-plane/application/advance-once-dispatch.ts`: count Starting Runs against capacity and idempotency.
- `src/bootstrap/{board-projection,surface-api-workflow-diagrams,surface-cli-applications}.ts`: project and operationally respect Starting Runs.
- `src/surfaces/api/{contracts/execution,presenters/execution}.ts`: present the new phase as active.
- `src/surfaces/web/src/features/{runs/runs,board/board-card}.tsx`: show Starting immediately, Running after transition, and live active duration.
- Tests named in each task provide the RED/GREEN evidence; current-state module specifications and `docs/events.md` are updated with the implementation.

### Task 1: Define the durable preparation fact and Run fold

**Files:**
- Modify: `src/execution/contracts/events.ts`
- Modify: `src/execution/contracts/event-factory.ts`
- Modify: `src/execution/contracts/vocabulary.ts`
- Modify: `src/execution/contracts/views.ts`
- Modify: `src/execution/domain/run.ts`
- Test: `test/unit/execution/event-contracts.test.ts`
- Test: `test/unit/execution/run.test.ts`

- [ ] **Step 1: Write failing contract and fold tests**

Add this complete preparation sample to the event-contract table and use it in the fold tests:

```ts
const preparing = runEvent(ExecutionEventType.RunPreparationStarted, {
  activationId: activationId('activation-1'),
  activity: activityName('agent'),
  stage: 'implementation',
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  attempt: 1,
  startedAt: '2026-08-30T10:00:00.000Z',
  runner: { name: 'codex', model: 'gpt-5.6-terra' },
});
const running = runEvent(ExecutionEventType.RunStarted, {
  ...preparing.payload,
  startedAt: '2026-08-30T10:03:00.000Z',
  workspace: { mode: WorkspaceMode.Branch, path: 'workspaces/item-1', branch: 'wake/item-1' },
});

expect(foldRun([preparing])).toMatchObject({
  status: RunStatus.Starting,
  startedAt: '2026-08-30T10:00:00.000Z',
  executionStartedAt: undefined,
});
expect(foldRun([preparing, running])).toMatchObject({
  status: RunStatus.Started,
  startedAt: '2026-08-30T10:00:00.000Z',
  executionStartedAt: '2026-08-30T10:03:00.000Z',
  workspace: running.payload.workspace,
});
```

Also retain a regression asserting that a historical stream beginning with `RunStarted` folds with both `startedAt` and `executionStartedAt` equal to the historical timestamp, and assert `RunFailed` is accepted directly after preparation.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts`

Expected: FAIL because `RunPreparationStarted` and `RunStatus.Starting` do not exist.

- [ ] **Step 3: Implement the contract and state machine**

Add the closed values and predicate:

```ts
export const RunStatus = defineClosedVocabulary({
  Starting: 'starting',
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Ambiguous: 'ambiguous',
} as const);

export function isActiveRunStatus(status: RunStatus): boolean {
  return status === RunStatus.Starting || status === RunStatus.Started;
}

export type FinishedRunStatus = Exclude<
  RunStatus,
  typeof RunStatus.Starting | typeof RunStatus.Started
>;
```

Add `RunPreparationStarted: 'execution.run-preparation-started'`, give it the identity/runner payload currently carried by `RunStarted` without `workspace`, and add its strict Zod branch and event-factory cases. Add `executionStartedAt?: string` to `RunView`.

Refactor `foldRun` so the initial event is either preparation or historical `RunStarted`. Preparation creates status Starting. A later `RunStarted` validates the immutable identity, sets status Started, `executionStartedAt`, and workspace. Terminal events apply to either active status; other liveness events use `isActiveRunStatus`.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npx vitest run test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract slice**

```bash
git add src/execution/contracts src/execution/domain/run.ts test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts
git commit -m "feat: add durable run starting phase"
```

### Task 2: Persist Starting before workspace preparation

**Files:**
- Modify: `src/execution/application/run-lifecycle.ts`
- Modify: `src/execution/application/execution-service.ts`
- Modify: `src/execution/application/run-liveness-service.ts`
- Test: `test/unit/execution/execution-service.test.ts`
- Test: `test/unit/execution/runner-selection.test.ts`

- [ ] **Step 1: Write controlled-workspace RED tests**

Use a workspace provider whose `acquire` records entry and awaits a deferred promise. Start `service.attempt` without awaiting it, then assert the journal already contains one preparation fact and no execution-start fact:

```ts
await acquisitionEntered.promise;
const duringPreparation = await journal.readAll(0);
expect(duringPreparation.map((event) => event.eventType)).toContain(
  ExecutionEventType.RunPreparationStarted,
);
expect(duringPreparation.map((event) => event.eventType)).not.toContain(
  ExecutionEventType.RunStarted,
);
expect(foldRun(runEvents(duringPreparation))).toMatchObject({ status: RunStatus.Starting });

releaseAcquisition.resolve(workspaceLease);
await attempt;
expect(foldRun(runEvents(await journal.readAll(0)))).toMatchObject({
  status: RunStatus.Started,
  workspace: workspaceLease,
});
```

Add a second test in which `acquire` rejects. Assert the same Run ends Failed, contains no `RunStarted`, releases the activation, and releases any partially allocated lease exactly once.

- [ ] **Step 2: Run the service tests and confirm RED**

Run: `npx vitest run test/unit/execution/execution-service.test.ts test/unit/execution/runner-selection.test.ts`

Expected: FAIL because the Run does not exist until workspace acquisition returns.

- [ ] **Step 3: Split preparation from execution start**

Add `prepareRun` to `run-lifecycle.ts`; it appends `RunPreparationStarted` at expected sequence zero. Change `startRun` to load the prepared Run, append `RunStarted` at its current sequence, set its payload timestamp from `clock.now()`, and then retain the existing liveness behavior.

In `ExecutionService.attempt`, use this ordering:

```ts
await claimActivationForAttempt(runtime, activation, currentRunId, owner, preparationStartedAt);
claimed = true;
await prepareRun({
  dependencies: runLifecycleDependencies(runtime),
  runId: currentRunId,
  activation,
  context,
  attempt: prior.length + 1,
  startedAt: preparationStartedAt,
  runner,
});
await claimRun(runtime.repository, runtime.dependencies.clock, runtime.config, currentRunId, owner);
renewal = renewWhileActive(runtime, currentRunId, owner);
lease = await acquireAttemptWorkspace(runtime, activation, context, currentRunId);
await startRun({ dependencies: runLifecycleDependencies(runtime), runId: currentRunId, lease });
```

Pass the already-running renewal into completion instead of creating a second renewal. In the catch path, use `persisted.view !== null && isActiveRunStatus(persisted.view.status)` and record a durable failure before cleanup/release. Update `recordRunFailure` in `run-lifecycle.ts` and claim/renew guards in `run-liveness-service.ts` to accept either active status. Update `existingRun` to return an existing Starting or Started attempt instead of minting another Run. Ensure `renewal.stop()` is awaited in every error and completion path.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run: `npx vitest run test/unit/execution/execution-service.test.ts test/unit/execution/runner-selection.test.ts`

Expected: PASS, including the controlled preparation and failure cases.

- [ ] **Step 5: Commit the lifecycle slice**

```bash
git add src/execution/application/run-lifecycle.ts src/execution/application/execution-service.ts src/execution/application/run-liveness-service.ts test/unit/execution/execution-service.test.ts test/unit/execution/runner-selection.test.ts
git commit -m "feat: persist runs before workspace preparation"
```

### Task 3: Make Starting operationally active and recoverable

**Files:**
- Modify: `src/execution/application/recovery-service.ts`
- Modify: `src/execution/application/active-run-cancellation.ts`
- Modify: `src/execution/infrastructure/workspace/git-workspace.ts`
- Modify: `src/control-plane/application/advance-once-dispatch.ts`
- Modify: `src/bootstrap/surface-api-workflow-diagrams.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Test: `test/unit/execution/recovery.test.ts`
- Test: `test/unit/execution/cancellation.test.ts`
- Test: `test/unit/control-plane/advance-once.test.ts`
- Test: `test/integration/execution/workspace-recovery.test.ts`

- [ ] **Step 1: Write RED tests for every active-run consumer**

Add the shared-predicate assertion below, then construct Starting fixtures with the existing Run test helper for each consumer:

```ts
expect(isActiveRunStatus(RunStatus.Starting)).toBe(true);
expect(isActiveRunStatus(RunStatus.Started)).toBe(true);
expect(isActiveRunStatus(RunStatus.Succeeded)).toBe(false);
```

```ts
await expect(dispatchWithExistingRun(RunStatus.Starting)).resolves.toMatchObject({ runs: 0 });
expect(await activeRunIdsForWorkflow(RunStatus.Starting)).toEqual(['run-starting']);
expect(await retainedWorkspaceIds(RunStatus.Starting)).toContain('run-starting');
expect((await recovery.recover('run-starting', 'recovery')).status).toBe(RunStatus.Failed);
expect(inspector.inspect).not.toHaveBeenCalled();
```

Use the established helpers in each named test file rather than exporting these illustrative helper names into production.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run test/unit/execution/recovery.test.ts test/unit/execution/cancellation.test.ts test/unit/control-plane/advance-once.test.ts test/integration/execution/workspace-recovery.test.ts`

Expected: FAIL where code compares only with `RunStatus.Started`.

- [ ] **Step 3: Replace phase-specific active checks**

Use `isActiveRunStatus(run.status)` in capacity, idempotency, cancellation, liveness, workspace retention, workflow-diagram activity, shutdown and maintenance quiescence. In `RecoveryService.recover`, branch Starting before inspecting external execution:

```ts
if (run.status === RunStatus.Starting)
  return this.appendFailure(currentRunId, run, 'Preparation was interrupted before execution started');
if (run.status !== RunStatus.Started) return requireRun(run);
```

Keep the existing unexpired Run lease guard for both phases. Permit failure appends while either phase is active, but keep ambiguity and external-execution reconciliation exclusive to Started.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npx vitest run test/unit/execution/recovery.test.ts test/unit/execution/cancellation.test.ts test/unit/control-plane/advance-once.test.ts test/integration/execution/workspace-recovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the operational slice**

```bash
git add src/execution src/control-plane/application/advance-once-dispatch.ts src/bootstrap/surface-api-workflow-diagrams.ts src/bootstrap/surface-cli-applications.ts test/unit/execution test/unit/control-plane/advance-once.test.ts test/integration/execution/workspace-recovery.test.ts
git commit -m "fix: treat starting runs as active work"
```

### Task 4: Project Starting onto the board and Run indexes

**Files:**
- Modify: `src/execution/application/execution-projection.ts`
- Modify: `src/bootstrap/board-projection.ts`
- Test: `test/unit/execution/execution-projection.test.ts`
- Test: `test/unit/bootstrap/board-projection.test.ts`

- [ ] **Step 1: Write projection RED tests**

Assert `runsByWorkflowInstanceProjection` registers the Run on preparation and does not duplicate it on `RunStarted`. For the board, fold work creation, primary workflow start, preparation, and execution start:

```ts
expect(afterPreparation.cards[workId]).toMatchObject({
  condition: 'active',
  runCount: 1,
  activeRuns: {
    'run-1': { action: 'implementation', phase: 'starting', startedAt: preparationAt },
  },
});
expect(afterRunStarted.cards[workId]).toMatchObject({
  runCount: 1,
  activeRuns: {
    'run-1': { action: 'implementation', phase: 'running', startedAt: preparationAt },
  },
});
```

Add these explicit assertions using the file's existing event builder:

```ts
expect(project([...primaryEvents, prepare('run-1'), fail('run-1')]).cards[workId]).toMatchObject({
  condition: 'error',
  activeRuns: {},
  runCount: 1,
});
expect(Object.keys(project([...primaryEvents, prepare('run-1'), prepare('run-2')]).cards[workId]!.activeRuns)).toEqual([
  'run-1',
  'run-2',
]);
expect(project([...approvalWaitEvents, childPrepare('run-child')]).cards[workId]).toMatchObject({
  condition: 'needs-input',
  awaitingApproval: true,
});
expect(project([...primaryEvents, historicalRunStarted('run-old')]).cards[workId]).toMatchObject({
  condition: 'active',
  runCount: 1,
});
```

Keep these helpers local to `board-projection.test.ts` and implement them with its existing typed envelope factory.

- [ ] **Step 2: Run the projection tests and confirm RED**

Run: `npx vitest run test/unit/execution/execution-projection.test.ts test/unit/bootstrap/board-projection.test.ts`

Expected: FAIL because preparation facts are not selected into membership or board state.

- [ ] **Step 3: Implement one keyed active entry per attempt**

Index membership on either first fact, guarded by `includes`. Extend `StoredActiveRun` with:

```ts
readonly phase: 'starting' | 'running';
```

On preparation, register `runs[runId]`, increment `runCount`, add the Starting entry, clear stale primary outcome, and make a non-child/non-finished card Active. On `RunStarted`, update the existing entry to Running and add only missing historical entries; do not double-count. Terminal events keep removing exactly one keyed entry and calculating total duration from preparation `startedAt`.

- [ ] **Step 4: Run projection tests and confirm GREEN**

Run: `npx vitest run test/unit/execution/execution-projection.test.ts test/unit/bootstrap/board-projection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the projection slice**

```bash
git add src/execution/application/execution-projection.ts src/bootstrap/board-projection.ts test/unit/execution/execution-projection.test.ts test/unit/bootstrap/board-projection.test.ts
git commit -m "feat: project starting runs in real time"
```

### Task 5: Present Starting in API, board and Runs UI

**Files:**
- Modify: `src/surfaces/api/contracts/execution.ts`
- Modify: `src/surfaces/api/contracts/board.ts`
- Modify: `src/surfaces/api/presenters/execution.ts`
- Modify: `src/bootstrap/surface-api-applications.ts`
- Modify: `src/surfaces/web/src/api/decoders.ts`
- Modify: `src/surfaces/web/src/features/runs/runs.tsx`
- Modify: `src/surfaces/web/src/features/board/board-card.tsx`
- Test: `test/unit/bootstrap/surface-api-execution-applications.test.ts`
- Test: `test/unit/bootstrap/surface-api-board-applications.test.ts`
- Test: `src/surfaces/web/test/runs.test.tsx`
- Test: `src/surfaces/web/test/board.test.tsx`
- Test: `src/surfaces/web/test/refresh-policy.test.ts`

- [ ] **Step 1: Write API and UI RED tests**

Assert the Run API returns `status: 'starting'`, `active: true`, `startedAt`, no `finishedAt`, and no `executionStartedAt`. Assert the board response preserves active-run `phase`.

Render a Starting row/card and assert the literals `Starting`, the run link, and a non-empty elapsed duration are present. Render the same Run as Started and assert `Running`. Keep terminal status rendering unchanged.

- [ ] **Step 2: Run API/web tests and confirm RED**

Run: `npx vitest run test/unit/bootstrap/surface-api-execution-applications.test.ts test/unit/bootstrap/surface-api-board-applications.test.ts src/surfaces/web/test/runs.test.tsx src/surfaces/web/test/board.test.tsx src/surfaces/web/test/refresh-policy.test.ts`

Expected: FAIL because phase is absent, Started renders as `STARTED`, and active duration is blank.

- [ ] **Step 3: Implement response and labels**

Expose optional `executionStartedAt` and active-run phase in the API contracts/decoder. Present active with the shared predicate:

```ts
active: isActiveRunStatus(value.status),
...(value.executionStartedAt === undefined
  ? {}
  : { executionStartedAt: value.executionStartedAt }),
```

Use this user-facing mapping in `runs.tsx`:

```ts
function runStatus(run: RunResponse): string {
  if (run.status === 'starting') return 'Starting';
  if (run.status === 'started') return 'Running';
  return run.resolution?.sentinel ?? run.sentinel;
}

function runDuration(run: RunResponse): string {
  const end = run.finishedAt === undefined ? Date.now() : Date.parse(run.finishedAt);
  return fmtDuration(end - Date.parse(run.startedAt));
}
```

The existing 3-second active refresh supplies rerenders. Board cards render `${activeRun.action} starting` or `${activeRun.action} running` from phase and retain elapsed time.

- [ ] **Step 4: Run API/web tests and confirm GREEN**

Run: `npx vitest run test/unit/bootstrap/surface-api-execution-applications.test.ts test/unit/bootstrap/surface-api-board-applications.test.ts src/surfaces/web/test/runs.test.tsx src/surfaces/web/test/board.test.tsx src/surfaces/web/test/refresh-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the surface slice**

```bash
git add src/surfaces src/bootstrap/surface-api-applications.ts test/unit/bootstrap/surface-api-execution-applications.test.ts test/unit/bootstrap/surface-api-board-applications.test.ts
git commit -m "feat: show starting runs across operator surfaces"
```

### Task 6: Prove the boundary end to end and update current-state documentation

**Files:**
- Create: `test/e2e/scenarios/run-starting-visibility.test.ts`
- Modify: `src/execution/SPEC.md`
- Modify: `src/execution/domain/run.spec.md`
- Modify: `src/execution/application/execution-service.spec.md`
- Modify: `src/execution/application/execution-projection.spec.md`
- Modify: `src/execution/infrastructure/workspace/workspace.spec.md`
- Modify: `src/bootstrap/board-projection.spec.md`
- Modify: `src/bootstrap/surface-api-applications.spec.md`
- Modify: `docs/events.md`

- [ ] **Step 1: Write the paused-workspace E2E scenario**

Create a scenario whose configured workspace prepare command writes a `prepare-entered` marker and waits for a `prepare-release` marker. Start advancement without awaiting it, wait for `prepare-entered`, catch up subscription projections, and assert:

```ts
expect((await api.execution.list({ limit: 20 })).items[0]).toMatchObject({
  status: RunStatus.Starting,
  active: true,
});
expect((await api.board.list({ limit: 20 })).items[0]).toMatchObject({
  condition: 'active',
  activeRuns: expect.objectContaining({
    [runId]: expect.objectContaining({ phase: 'starting' }),
  }),
});
```

Write the release marker, await advancement, catch up projections, and assert that the same Run ID is now Started/Running rather than a second row. Finish the fake runner and assert the same row becomes terminal.

- [ ] **Step 2: Run the E2E scenario and confirm it passes**

Run: `npx vitest run test/e2e/scenarios/run-starting-visibility.test.ts`

Expected: PASS with one Run visible in all three phases.

- [ ] **Step 3: Update authoritative documentation**

Document the preparation-first stream, Starting/active semantics, Run lease coverage, backward-compatible RunStarted-first fold, board phase transition, and `executionStartedAt`. Add `execution.run-preparation-started` to `docs/events.md`. Remove statements that define RunStarted as the creation of a Run or describe the entire preparation interval as pre-Run.

- [ ] **Step 4: Run catalogue/specification gates**

Run: `npm run check:catalogue && npm run check:scenarios && npm run check:specs && npm run lint:architecture`

Expected: catalogue, scenario and architecture checks PASS; `check:specs` reports no new drift attributable to Execution, Bootstrap or Surfaces.

- [ ] **Step 5: Commit scenario and documentation**

```bash
git add test/e2e/scenarios/run-starting-visibility.test.ts src/execution src/bootstrap/*.spec.md docs/events.md
git commit -m "test: prove run visibility during workspace preparation"
```

### Task 7: Cross-cutting verification and review

**Files:**
- Review only: all files changed since `ddc90d6f`

- [ ] **Step 1: Run the complete local verification gate**

Run: `npm run verify`

Expected: build, catalogue, scenarios, architecture, lint, formatting and fast tests PASS.

- [ ] **Step 2: Run relevant integration, E2E and web suites serially**

Run: `npx vitest run --pool=forks --maxWorkers=1 test/integration/execution test/integration/bootstrap`

Expected: PASS.

Run: `npx vitest run --pool=forks --maxWorkers=1 test/e2e/scenarios/run-starting-visibility.test.ts test/e2e/scenarios/workspace-crash-recovery.test.ts test/e2e/scenarios/recover-active-run.test.ts`

Expected: PASS.

Run: `npm run test:web`

Expected: PASS.

- [ ] **Step 3: Inspect the final diff and journal compatibility**

Run: `git diff --check ddc90d6f..HEAD && git status --short && git log --oneline ddc90d6f..HEAD`

Expected: no whitespace errors, only intentional working-tree changes, and the task commits listed above. Confirm tests include both historical RunStarted-first events and new preparation-first streams.

- [ ] **Step 4: Request two-stage code review**

Dispatch one reviewer against the design/spec for requirement coverage, then a second reviewer against maintainability, event ownership, recovery races and backward compatibility. Apply accepted findings test-first and rerun the smallest affected checks.

- [ ] **Step 5: Commit review fixes if any**

If review produced changes, inspect `git status --short`, stage each reviewed source/test/document path individually, and run `git commit -m "fix: address starting run review findings"`. If review produced no changes, do not create an empty commit.
