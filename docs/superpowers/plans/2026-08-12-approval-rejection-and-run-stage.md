# Approval Rejection and Run Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent rejected approvals from advancing a workflow and make each run report its immutable originating stage.

**Architecture:** Signal handling will use an explicit rejection target or re-request the current stage. Stage provenance will flow from activity requests through execution’s durable run-started event into `RunView`; API context will no longer derive it from mutable workflow state.

**Tech Stack:** TypeScript, Vitest, Zod, event-sourced orchestration and execution projections.

---

## File Structure

- `src/orchestration/domain/signal-policy.ts` — safe rejected-signal routing.
- `test/unit/orchestration/signals.test.ts` and `test/unit/integrations/github/inbound-review-signals.test.ts` — domain and `/changes` regressions.
- `src/orchestration/contracts/events.ts`, `event-decoder.ts`, `views.ts`, and stage activation call sites — stage carried by primary activity requests.
- `src/execution/contracts/commands.ts`, `events.ts`, `views.ts`, `application/run-lifecycle.ts`, and `domain/run.ts` — durable run-stage provenance.
- `src/bootstrap/surface-api-run-context.ts` — API enrichment that preserves recorded stage.
- `test/unit/execution/event-contracts.test.ts`, `test/unit/execution/run.test.ts`, and `test/integration/bootstrap/surface-api-run-context.test.ts` — durable-contract, projection, and presentation tests.

### Task 1: Restart the current stage after a rejected approval

**Files:**

- Modify: `test/unit/orchestration/signals.test.ts`
- Modify: `src/orchestration/domain/signal-policy.ts`

- [ ] **Step 1: Write the failing tests**

Add a state at `refine`, waiting for `approved`, with a success resume target of `implement`. Submit an authorized human signal with `outcome: ActivityOutcomeKind.Rejected`. Assert the appended events are `SignalAccepted` then `ActivityRequested`, and the latter has `activity: 'refine'`. Add a companion test proving an explicit `onRejectResume` is honored.

```ts
expect(events.map((event) => event.eventType)).toEqual([
  OrchestrationEventType.SignalAccepted,
  OrchestrationEventType.ActivityRequested,
]);
expect(events.at(-1)?.payload).toMatchObject({ activity: 'refine' });
```

- [ ] **Step 2: Verify the test is red**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/signals.test.ts`

Expected: FAIL because the rejection follows the success `implement` resume target.

- [ ] **Step 3: Implement minimal safe routing**

In `acceptSignal`, branch on rejected signals before `expected.resume`. If `expected.onRejectResume` exists, call `resumeToTarget`; otherwise request the stage in `definition.stages[stageName(state.currentStage)]` with `nextOrdinal(state)`, the stage activity/input/execution, and no `StageEntered`. Keep non-rejected signals on the current success path.

```ts
if (signal.outcome === ActivityOutcomeKind.Rejected) {
  if (expected.onRejectResume !== undefined)
    resumeToTarget(events, definition, state, input, expected.onRejectResume);
  else requestCurrentStage(events, definition, state, input);
} else if (expected.resume !== undefined) {
  resumeToTarget(events, definition, state, input, expected.resume);
} else requestCurrentStage(events, definition, state, input);
```

- [ ] **Step 4: Verify green**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/orchestration/signals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/domain/signal-policy.ts test/unit/orchestration/signals.test.ts
git commit -m "fix: restart stage after rejected approval"
```

### Task 2: Cover `/changes` and `/approved` through GitHub inbound handling

**Files:**

- Modify: `test/unit/integrations/github/inbound-review-signals.test.ts`

- [ ] **Step 1: Write the integration regression**

Configure `refine: on.done.then: implement` with the default approval wait. Complete refine, apply `/changes`, and assert `{ status: 'active', currentStage: 'refine', pendingActivation: { activity: 'refine' } }`. Complete that retry, apply `/approved`, and assert `{ status: 'active', currentStage: 'implement', pendingActivation: { activity: 'implement' } }`.

- [ ] **Step 2: Verify green**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/integrations/github/inbound-review-signals.test.ts`

Expected: PASS; Task 1 fixes the behavior without GitHub-specific routing changes.

- [ ] **Step 3: Commit**

```bash
git add test/unit/integrations/github/inbound-review-signals.test.ts
git commit -m "test: cover rejected issue approval"
```

### Task 3: Persist the originating stage with primary activations and runs

**Files:**

- Modify: `src/orchestration/contracts/events.ts`
- Modify: `src/orchestration/contracts/event-decoder.ts`
- Modify: `src/orchestration/contracts/views.ts`
- Modify: `src/orchestration/domain/decision-events.ts`
- Modify: `src/orchestration/domain/activation-policy.ts`
- Modify: `src/orchestration/domain/transition.ts`
- Modify: `src/orchestration/domain/retry-policy.ts`
- Modify: `src/orchestration/domain/operator-retry-policy.ts`
- Modify: `src/orchestration/domain/signal-policy.ts`
- Modify: `src/execution/contracts/commands.ts`
- Modify: `src/execution/contracts/events.ts`
- Modify: `src/execution/contracts/views.ts`
- Modify: `src/execution/application/run-lifecycle.ts`
- Modify: `src/execution/domain/run.ts`
- Test: `test/unit/execution/event-contracts.test.ts`
- Test: `test/unit/execution/run.test.ts`

- [ ] **Step 1: Write failing contract and projection tests**

Extend a canonical run-started event with `stage: 'refine'`. Assert `foldRun([started])` includes `stage: 'refine'`. Add an empty-stage event and assert `decodeExecutionEvent` throws.

```ts
expect(foldRun([started])).toMatchObject({ stage: 'refine' });
expect(() => decodeExecutionEvent(emptyStageEvent)).toThrow(/stage/);
```

- [ ] **Step 2: Verify the tests are red**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts`

Expected: FAIL because run events and views do not have a stage field.

- [ ] **Step 3: Implement durable provenance**

Add optional `stage` to `ActivityRequestedPayload`, `ActivityActivationView`, `ExecutionActivation`, `RunStartedPayload`, and `RunView`. Validate orchestration stage using its branded stage schema and run stage with `z.string().min(1).optional()`. Add the field to the activation helper options:

```ts
...(options.stage === undefined ? {} : { stage: options.stage }),
```

Pass stage for initial, transition, retry, operator-retry, and rejected-signal primary activations. Do not add it to supplemental or follow-on activities. Copy `activation.stage` in `startRun` and `started.payload.stage` in `foldRun`.

- [ ] **Step 4: Verify green**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts test/unit/orchestration/signals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration src/execution test/unit/execution test/unit/orchestration/signals.test.ts
git commit -m "feat: persist workflow stage on runs"
```

### Task 4: Present the run’s stored stage in both lists

**Files:**

- Modify: `src/bootstrap/surface-api-run-context.ts`
- Create: `test/integration/bootstrap/surface-api-run-context.test.ts`

- [ ] **Step 1: Write the failing API-context tests**

Pass `withWorkflowContext` a run with `stage: 'refine'` and an orchestration lookup with `currentStage: 'implement'`; assert it returns workflow `default` and stage `refine`. A second stage-less run must remain stage-less.

```ts
expect(await withWorkflowContext(root, refinedRun)).toMatchObject({
  workflowName: 'default', stage: 'refine',
});
expect(await withWorkflowContext(root, stageLessRun)).not.toHaveProperty('stage');
```

- [ ] **Step 2: Verify the tests are red**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/bootstrap/surface-api-run-context.test.ts`

Expected: FAIL because the current implementation rewrites both runs to `implement`.

- [ ] **Step 3: Implement presentation-only enrichment**

Fetch the workflow only to add its name; never set `stage` here:

```ts
return instance === null ? run : { ...run, workflowName: instance.workflowName };
```

- [ ] **Step 4: Verify green**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/bootstrap/surface-api-run-context.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/surface-api-run-context.ts test/integration/bootstrap/surface-api-run-context.test.ts
git commit -m "fix: show originating stage for each run"
```

### Task 5: Verify the completed change

**Files:**

- Modify only if a focused verification identifies a compatibility or formatting defect.

- [ ] **Step 1: Run affected unit suites**

Run: `npm run test:unit -- test/unit/orchestration/signals.test.ts test/unit/integrations/github/inbound-review-signals.test.ts test/unit/execution/event-contracts.test.ts test/unit/execution/run.test.ts`

Expected: PASS.

- [ ] **Step 2: Run API integration suites**

Run: `npm run test:integration -- test/integration/bootstrap/surface-api-run-context.test.ts test/integration/surfaces/api.test.ts`

Expected: PASS.

- [ ] **Step 3: Type-check and format-check**

Run: `npm run build && npm run format:check`

Expected: both commands exit 0.

- [ ] **Step 4: Inspect final state**

Run: `git status --short`

Expected: no uncommitted changes.
