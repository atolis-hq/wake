# Orchestration-Owned Agent Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish agent reports only after orchestration resolves their activation, including transport failures.

**Architecture:** The publication reactor consumes orchestration resolution events instead of execution completion events. Structured outcomes resolve through `ActivityOutcomeAccepted`; transport failures receive a typed orchestration event and block decision. The reactor reads the Run for report details but reads workflow state only after the committed resolution.

**Tech Stack:** TypeScript, Zod, Vitest.

---

### Task 1: Publish structured outcomes after their orchestration decision

**Files:**
- Modify: `src/integrations/application/agent-run-publication-reactor.ts`
- Test: `test/unit/agent-run-publication-reactor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
await reactor.runOnce();
expect(await publicationRequests(world)).toEqual([]);
await acceptDoneAndWaitForApproval(world);
await reactor.runOnce();
expect(await publicationRequests(world)).toMatchObject([
  { report: { outcome: 'DONE', awaitingApproval: true } },
]);
```

The fixture must contain a completed agent Run before the first `runOnce`, and append a matching `ActivityOutcomeAccepted` plus `SignalWaitStarted` before the second.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/agent-run-publication-reactor.test.ts`

Expected: the current `execution.run-succeeded` subscription emits the report too early.

- [ ] **Step 3: Implement the minimal boundary**

```ts
if (event.eventType === OrchestrationEventType.ActivityOutcomeAccepted)
  await this.publishAcceptedOutcome(event);
```

Replace the execution terminal subscription. Find the succeeded agent Run by the accepted activation and workflow. Preserve `agent-run:<runId>` idempotency and derive approval presentation after the accepting decision is committed.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/unit/agent-run-publication-reactor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/integrations/application/agent-run-publication-reactor.ts test/unit/agent-run-publication-reactor.test.ts; git commit -m "fix: publish agent outcomes after orchestration resolution"`

### Task 2: Resolve execution transport failures in orchestration

**Files:**
- Modify: `src/orchestration/contracts/events.ts`
- Modify: `src/orchestration/contracts/event-decoder.ts`
- Modify: `src/orchestration/domain/workflow-instance-events.ts`
- Modify: `src/orchestration/application/advance-workflow.ts`
- Modify: `src/orchestration/application/orchestration-service.ts`
- Modify: `src/control-plane/application/advance-once.ts`
- Test: `test/unit/orchestration/activation-failure-resolution.test.ts`
- Test: `test/unit/control-plane/advance-once.test.ts`

- [ ] **Step 1: Write the failing orchestration test**

```ts
const resolved = await service.resolveExecutionFailure(workflowId, {
  activationId, runId: 'run-failed', reason: 'runner exited 1',
}, context);
expect(resolved).toMatchObject({ status: 'blocked', blockReason: 'runner exited 1' });
expect(await events('orchestration.activity-execution-failed')).toHaveLength(1);
```

Repeat that command and assert the event count remains one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/orchestration/activation-failure-resolution.test.ts`

Expected: `resolveExecutionFailure` is absent.

- [ ] **Step 3: Implement the failure-resolution event and command**

```ts
ActivityExecutionFailed: 'orchestration.activity-execution-failed'
```

Its strict payload is `{ activationId, runId, reason }`. Decode it in `event-decoder.ts`. Add `resolveExecutionFailure` to `AdvanceWorkflow` and `OrchestrationService`. When the activation is still pending and unaccepted, append `ActivityExecutionFailed` and `InstanceBlocked` in one decision. Fold the activation as completed and retain `reason` as `blockReason`. Repeated commands append nothing.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/unit/orchestration/activation-failure-resolution.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing control-plane test**

```ts
expect(resolveExecutionFailure).toHaveBeenCalledWith(
  workflow.workflowInstanceId,
  { activationId: activation.activationId, runId: run.runId, reason: 'runner exited 1' },
  expect.anything(),
);
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/unit/control-plane/advance-once.test.ts`

Expected: the failure branch merely returns a blocked result.

- [ ] **Step 7: Wire failed runs to the command**

Add `resolveExecutionFailure` to `OrchestrationPort`; invoke it before returning the blocked result for `RunStatus.Failed`, with `run.failure?.message ?? 'execution failed'` as the reason.

- [ ] **Step 8: Run the focused tests to verify they pass**

Run: `npx vitest run test/unit/orchestration/activation-failure-resolution.test.ts test/unit/control-plane/advance-once.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

Run: `git add src/orchestration src/control-plane/application/advance-once.ts test/unit/orchestration/activation-failure-resolution.test.ts test/unit/control-plane/advance-once.test.ts; git commit -m "fix: resolve failed executions in orchestration"`

### Task 3: Publish failure resolutions and prove the incident ordering

**Files:**
- Modify: `src/integrations/application/agent-run-publication-reactor.ts`
- Test: `test/unit/agent-run-publication-reactor.test.ts`
- Create: `test/e2e/scenarios/agent-run-publication-boundary.test.ts`

- [ ] **Step 1: Write the failing failure-publication test**

```ts
expect(published.payload.report).toMatchObject({
  runId: 'run-failed', outcome: 'FAILED', displayBody: 'runner exited 1',
});
expect(published.payload.report.awaitingApproval).toBeUndefined();
```

The trigger is an `ActivityExecutionFailed` event that names the failed agent Run.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/agent-run-publication-reactor.test.ts`

Expected: the reactor does not consume that event yet.

- [ ] **Step 3: Implement failure publication**

Handle `ActivityExecutionFailed`, load its named Run, and publish the existing report shape using `FAILED` and the durable failure message. Never set `awaitingApproval` for this path.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/unit/agent-run-publication-reactor.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing E2E regression test**

```ts
expect(await deliveryIntents(world)).toEqual([]);
await world.acceptOutcome(workflowId, activationId, { kind: 'done', data: { status: 'DONE' } });
await publications.runOnce();
expect(await deliveryIntents(world)).toMatchObject([
  { report: { outcome: 'DONE', awaitingApproval: true } },
]);
```

Also resolve a transport failure in the composed world, assert its workflow blocks and it receives one failed report, then replay publications and assert the intent count remains one per Run.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run --config vitest.e2e.config.ts test/e2e/scenarios/agent-run-publication-boundary.test.ts`

Expected: FAIL before all boundary handling is wired.

- [ ] **Step 7: Run E2E and targeted regressions**

Run: `npx vitest run --config vitest.e2e.config.ts test/e2e/scenarios/agent-run-publication-boundary.test.ts && npx vitest run test/unit/agent-run-publication-reactor.test.ts test/unit/control-plane/advance-once.test.ts test/unit/control-plane/runner-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Run: `git add src/integrations/application/agent-run-publication-reactor.ts test/unit/agent-run-publication-reactor.test.ts test/e2e/scenarios/agent-run-publication-boundary.test.ts; git commit -m "fix: publish terminal agent reports after resolution"`

### Task 4: Final verification

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 2: Run integration and E2E suites**

Run: `npm run test:integration && npm run test:e2e`

Expected: exit code 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff HEAD~3..HEAD --check && git status --short`

Expected: no whitespace errors and no unintended files.
