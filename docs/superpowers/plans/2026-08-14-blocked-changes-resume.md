# Blocked `/changes` Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume an eligible blocked agent stage when a human posts `/changes` on its issue.

**Architecture:** Extend the existing operator-retry fact pattern with a distinct eligibility policy for unconfigured blocked agent outcomes. Route issue `/changes` into that policy while preserving waits and leaving UI retry eligibility unchanged.

**Tech Stack:** TypeScript, Vitest, Wake event journal and orchestration projections.

---

### Task 1: Define the recovery policy

**Files:**
- Modify: `src/orchestration/domain/operator-retry-policy.ts`
- Modify: `src/orchestration/domain/interpreter.ts`
- Test: `test/unit/orchestration/operator-retry-policy.test.ts`

- [x] **Step 1: Write the failing policy test**

```ts
expect(isChangesResumeEligible(state)).toBe(true);
expect(requestChangesResume(definition, state, retryInput)).toMatchObject({
  kind: 'append',
  events: [{ eventType: OrchestrationEventType.OperatorRetryRequested }],
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/orchestration/operator-retry-policy.test.ts`

Expected: failure because the changes-resume policy is not exported.

- [x] **Step 3: Implement the minimal policy**

```ts
export function isChangesResumeEligible(view: WorkflowInstanceView): boolean {
  return view.status === WorkflowStatus.Blocked &&
    view.blockReason === 'unconfigured outcome blocked' &&
    view.pendingActivation?.activity === activityName('agent') &&
    view.lastOutcome?.kind === ActivityOutcomeKind.Blocked;
}
```

The decision records `OperatorRetryRequested` with the inbound command identity
and follows it with `ActivityRequested` for the current stage.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/orchestration/operator-retry-policy.test.ts`

Expected: all operator retry policy tests pass.

### Task 2: Route issue `/changes` to the policy

**Files:**
- Modify: `src/orchestration/application/advance-workflow.ts`
- Modify: `src/orchestration/application/orchestration-service.ts`
- Modify: `src/integrations/github/application/inbound-review-signals.ts`
- Test: `test/unit/integrations/github/inbound-review-signals.test.ts`

- [x] **Step 1: Write failing inbound tests**

```ts
await applyHumanIssueCommand(fixture, '/changes clarify the closure provenance');
expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
  status: 'active',
  pendingActivation: { activity: activityName('agent'), ordinal: 2 },
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/integrations/github/inbound-review-signals.test.ts`

Expected: blocked workflows receive no follow-up activation.

- [x] **Step 3: Implement routing and idempotent append**

```ts
if (workflow.waitingFor !== undefined) await orchestration.acceptSignal(...);
else if (resumeBlockedOnChanges)
  await orchestration.resumeBlockedStageForChanges(workflow.workflowInstanceId, commandContext(event));
```

`resumeBlockedStageForChanges` returns unchanged state for an ineligible
workflow and returns the already-resumed state when the command identity was
previously recorded.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/integrations/github/inbound-review-signals.test.ts`

Expected: all inbound review signal tests pass.

### Task 3: Verify the cross-module change

**Files:**
- Verify: `src/orchestration/domain/operator-retry-policy.ts`
- Verify: `src/orchestration/application/advance-workflow.ts`
- Verify: `src/integrations/github/application/inbound-review-signals.ts`

- [x] **Step 1: Run focused regression tests**

Run: `npx vitest run test/unit/orchestration/operator-retry-policy.test.ts test/unit/integrations/github/inbound-review-signals.test.ts`

Expected: 25 tests pass.

- [x] **Step 2: Run type and entrypoint verification**

Run: `npm run build`

Expected: TypeScript compilation, version embedding, and CLI-entrypoint check exit successfully.
