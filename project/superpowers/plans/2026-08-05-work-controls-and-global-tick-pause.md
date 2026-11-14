# Work Controls and Global Tick Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore freeze, unfreeze, confirmed soft deletion, and a durable global pause that prevents every form of tick work.

**Architecture:** Work owns frozen/deleted lifecycle facts; Resources owns correlation retraction; a composed application coordinates deletion. Control Plane owns durable global pause and a shared pipeline guard. Bootstrap exposes commands and the web surface only renders/calls them.

**Tech Stack:** TypeScript, Zod, Vitest, React, TanStack Query, append-only event journal.

---

### Task 1: Add Work lifecycle facts and idempotent commands

**Files:**
- Modify: `src-next/work/contracts/events.ts`
- Modify: `src-next/work/contracts/views.ts`
- Modify: `src-next/work/domain/work-item.ts`
- Modify: `src-next/work/application/work-service.ts`
- Test: `test-next/unit/work/work-service.test.ts`
- Test: `test-next/unit/work/event-contracts.test.ts`

- [ ] **Step 1: Write the failing Work tests**

```ts
it('freezes and unfreezes an open WorkItem idempotently', async () => {
  await service.create({ workItemId: item, objective: 'Ship controls' }, context);
  expect((await service.freeze(item, context)).frozen).toBe(true);
  expect((await service.unfreeze(item, { ...context, commandId: 'unfreeze' })).frozen).toBe(false);
});

it('soft-deletes once and rejects later Work commands', async () => {
  await service.delete(item, context);
  await expect(service.freeze(item, { ...context, commandId: 'freeze' })).rejects.toThrow('deleted');
});
```

Also assert strict decoding of `work.item-frozen`, `work.item-unfrozen`, and `work.item-deleted` on only a Work stream with an exact empty payload.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test-next/unit/work/work-service.test.ts test-next/unit/work/event-contracts.test.ts`

Expected: FAIL because the commands and event constants do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export const WorkEventType = {
  // existing values
  ItemFrozen: 'work.item-frozen',
  ItemUnfrozen: 'work.item-unfrozen',
  ItemDeleted: 'work.item-deleted',
} as const;

export interface WorkItemView {
  // existing fields
  readonly frozen: boolean;
  readonly deleted: boolean;
}
```

Extend the strict event union/decoder and fold flags from the three events. Add `freeze`, `unfreeze`, and `delete` to `WorkService`; return current state when already at the requested target and append one typed event otherwise.

- [ ] **Step 4: Run the focused test and contracts lint**

Run: `npx vitest run test-next/unit/work/work-service.test.ts test-next/unit/work/event-contracts.test.ts && npm run lint:contracts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-next/work test-next/unit/work
git commit -m "feat(next): add work freeze and soft delete lifecycle"
```

### Task 2: Exclude frozen/deleted Work and release resources on deletion

**Files:**
- Create: `src-next/work/application/work-operator-service.ts`
- Modify: `src-next/control-plane/application/advance-once.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Test: `test-next/unit/work/work-operator-service.test.ts`
- Test: `test-next/unit/control-plane/advance-once.test.ts`
- Test: `test-next/e2e/scenarios/work-resource-correlation.test.ts`

- [ ] **Step 1: Write the failing composed behavior tests**

```ts
it('deletes work and retracts every active resource correlation', async () => {
  await operator.delete(workId, context);
  expect(await resources.correlationsForWork(workId)).toEqual([]);
  await expect(resources.correlate(resourceId, laterWorkId, 'primary', laterContext))
    .resolves.toMatchObject({ workItemId: laterWorkId });
});

it('does not select frozen or deleted work for execution', async () => {
  await work.freeze(item, context);
  await expect(advanceOnce({ maxProgress: 1 })).resolves.toEqual({ kind: 'no-work' });
  expect(attempt).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test-next/unit/work/work-operator-service.test.ts test-next/unit/control-plane/advance-once.test.ts test-next/e2e/scenarios/work-resource-correlation.test.ts`

Expected: FAIL because there is no cross-domain delete command or Work eligibility port.

- [ ] **Step 3: Implement the coordinator and eligibility read**

```ts
export interface WorkOperatorService {
  delete(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
}

async function deleteWorkItem(workItemId: WorkItemId, context: CommandContext) {
  const deleted = await work.delete(workItemId, context);
  for (const correlation of await resources.correlationsForWork(workItemId))
    await resources.retract(correlation.resourceId, workItemId, context);
  return deleted;
}
```

Compose this application in Bootstrap. Give `createAdvanceOnce` a Work read port and remove pending candidates with missing, non-open, frozen, or deleted Work before DispatchPolicy selection.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run test-next/unit/work/work-operator-service.test.ts test-next/unit/control-plane/advance-once.test.ts test-next/e2e/scenarios/work-resource-correlation.test.ts`

Expected: PASS; deletion releases the resource and no execution starts for frozen/deleted work.

- [ ] **Step 5: Commit**

```powershell
git add src-next/work src-next/control-plane/application/advance-once.ts src-next/bootstrap/composition-root.ts test-next/unit test-next/e2e/scenarios/work-resource-correlation.test.ts
git commit -m "feat(next): exclude frozen work and release deleted resources"
```

### Task 3: Pause the complete TickPipeline

**Files:**
- Modify: `src-next/control-plane/application/control-plane-service.ts`
- Modify: `src-next/control-plane/application/tick-pipeline.ts`
- Modify: `src-next/control-plane/contracts/commands.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Test: `test-next/unit/control-plane/control-plane-service.test.ts`
- Test: `test-next/unit/control-plane/tick-pipeline.test.ts`
- Test: `test-next/integration/bootstrap/runtime.test.ts`

- [ ] **Step 1: Write the failing durable-pause tests**

```ts
it('returns paused before calling any TickPipeline stage', async () => {
  const calls: string[] = [];
  const pipeline = createTickPipeline({
    isPaused: async () => true,
    catchUpProjections: mark(calls, 'project'),
    poll: mark(calls, 'poll'),
    translateInbound: mark(calls, 'translate'),
    runSchedules: mark(calls, 'schedule'),
    react: mark(calls, 'react'),
    advance: async () => ({ kind: 'no-work' }),
    deliver: mark(calls, 'deliver'),
  });
  await expect(pipeline.run({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
  expect(calls).toEqual([]);
});
```

Add a service test that pause and resume append the relevant durable facts once and restore ticking after resume.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test-next/unit/control-plane/control-plane-service.test.ts test-next/unit/control-plane/tick-pipeline.test.ts test-next/integration/bootstrap/runtime.test.ts`

Expected: FAIL because the pipeline begins projection/poll work and no operator pause service exists.

- [ ] **Step 3: Implement the shared guard**

```ts
export interface ControlPlaneService {
  pause(context: CommandContext): Promise<ControlPlaneView>;
  resume(context: CommandContext): Promise<ControlPlaneView>;
  isPaused(): Promise<boolean>;
}

if (await stages.isPaused()) return { kind: 'paused' };
```

Implement idempotent pause/resume through the existing Control event stream/projection. Inject `isPaused` into `TickPipelineStages` and check it before every pipeline dependency. Compose exactly one service in `CompositionRoot` and ensure CLI/API/resident/schedule hosts use the composed pipeline.

- [ ] **Step 4: Run focused and host tests**

Run: `npx vitest run test-next/unit/control-plane/control-plane-service.test.ts test-next/unit/control-plane/tick-pipeline.test.ts test-next/unit/control-plane/tick-host.test.ts test-next/unit/control-plane/resident-host.test.ts test-next/integration/bootstrap/runtime.test.ts`

Expected: PASS; pause produces no poll/reconcile/schedule/delivery/execution, resume restores the normal path, and runner pause remains local.

- [ ] **Step 5: Commit**

```powershell
git add src-next/control-plane src-next/bootstrap/composition-root.ts test-next/unit/control-plane test-next/integration/bootstrap/runtime.test.ts
git commit -m "feat(next): pause the full tick pipeline"
```

### Task 4: Expose composed API commands

**Files:**
- Modify: `src-next/bootstrap/surface-api-applications.ts`
- Modify: `src-next/bootstrap/surface-api-work-applications.ts`
- Modify: `src-next/surfaces/api/contracts/work.ts`
- Modify: `src-next/surfaces/api/presenters/work.ts`
- Test: `test-next/integration/surfaces/api-routes.test.ts`
- Test: `test-next/e2e/scenarios/api-domain-shape.test.ts`

- [ ] **Step 1: Write failing API behavior tests**

```ts
it('serves freeze, unfreeze, and delete from the composed Work application', async () => {
  await applications.work.freeze!(workKey, { idempotencyKey: 'freeze-1' });
  expect((await applications.work.detail(workKey))?.data.work)
    .toMatchObject({ frozen: true, deleted: false });
});

it('rejects manual tick while globally paused without calling the pipeline', async () => {
  await applications.controlPlane.pause!({ idempotencyKey: 'pause-1' });
  await expect(applications.controlPlane.tick!({ idempotencyKey: 'tick-1' }))
    .rejects.toMatchObject({ code: 'paused' });
});
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `npx vitest run test-next/integration/surfaces/api-routes.test.ts test-next/e2e/scenarios/api-domain-shape.test.ts`

Expected: FAIL because the public applications omit these command functions.

- [ ] **Step 3: Wire command adapters and transport fields**

```ts
controlPlane: {
  status: () => readControlPlaneStatus(root, now),
  pause: (command) => controlCommands.pause(command),
  resume: (command) => controlCommands.resume(command),
  tick: (command) => controlCommands.tick(command),
},
work: {
  ...createSurfaceWorkApplications(root, now),
  freeze: (key, command) => workCommands.freeze(key, command),
  unfreeze: (key, command) => workCommands.unfreeze(key, command),
  delete: (key, command) => workCommands.delete(key, command),
},
```

Translate opaque Work keys at this boundary; build deterministic command contexts from idempotency keys; return a typed conflict for paused tick. Present `frozen` and `deleted`, remove deleted items from lists/board, and make deleted detail unavailable after deletion.

- [ ] **Step 4: Run API verification**

Run: `npx vitest run test-next/integration/surfaces/api-routes.test.ts test-next/e2e/scenarios/api-domain-shape.test.ts`

Expected: PASS with 200 freeze/unfreeze, accepted deletion, pause/resume, and paused-tick conflict.

- [ ] **Step 5: Commit**

```powershell
git add src-next/bootstrap src-next/surfaces/api test-next/integration/surfaces/api-routes.test.ts test-next/e2e/scenarios/api-domain-shape.test.ts
git commit -m "feat(next): expose work controls and tick pause API"
```

### Task 5: Add the web controls

**Files:**
- Modify: `src-next/surfaces/web/src/components/status.tsx`
- Modify: `src-next/surfaces/web/src/features/work/work.tsx`
- Modify: `src-next/surfaces/web/src/features/features.module.css`
- Test: `src-next/surfaces/web/test/status.test.tsx`
- Test: `src-next/surfaces/web/test/work-detail.test.tsx`

- [ ] **Step 1: Write failing UI interaction tests**

```tsx
it('hides Tick now while paused and posts Resume ticks', async () => {
  renderAppWithControlStatus({ paused: true });
  expect(screen.queryByRole('button', { name: 'Tick now' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Resume ticks' }));
  expect(requests).toContain('/api/v1/control-plane/commands/resume');
});

it('confirms before deleting and then leaves stale detail', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(requests).toContain('/api/v1/work-items/wk_a/commands/delete');
});
```

Also cover cancellation making no delete request, Freeze becoming Unfreeze after success, pending disablement, and problem feedback.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `npx vitest run src-next/surfaces/web/test/status.test.tsx src-next/surfaces/web/test/work-detail.test.tsx`

Expected: FAIL because these controls do not render.

- [ ] **Step 3: Implement the mutations and presentation**

```tsx
{status.data?.data.paused ? (
  <Button onClick={() => resumeMutation.mutate(commandKey('resume'))}>Resume ticks</Button>
) : (
  <>
    <Button onClick={() => pauseMutation.mutate(commandKey('pause'))}>Pause ticks</Button>
    <Button onClick={() => tickMutation.mutate(commandKey('tick'))}>Tick now</Button>
  </>
)}
```

Add Work mutations through `client.work.command`; invalidate work, board, resource, event, and status queries after success; navigate away after deletion. Put the actions below the Work summary, style Delete as destructive, and use the legacy confirmation intent: `Delete this work item from the board and remove its resource correlations?`.

- [ ] **Step 4: Run UI tests and build**

Run: `npx vitest run src-next/surfaces/web/test/status.test.tsx src-next/surfaces/web/test/work-detail.test.tsx && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-next/surfaces/web/src src-next/surfaces/web/test
git commit -m "feat(next): add work and global tick controls to web UI"
```

### Task 6: Verify composed parity and update specifications

**Files:**
- Create: `test-next/e2e/scenarios/work-controls-and-global-pause.test.ts`
- Modify: `src-next/work/SPEC.md`
- Modify: `src-next/control-plane/SPEC.md`
- Modify: `src-next/surfaces/api/api-application.spec.md`

- [ ] **Step 1: Write a full composed scenario**

```ts
it('E2E-WORK-CONTROL-001: pause blocks ticks, freeze blocks execution, and delete releases resources', async () => {
  // Given composed provider, Work, correlation, and runnable activation
  // When pause/resume, freeze/unfreeze, then delete are issued
  // Then paused ticks poll and execute nothing, eligibility follows freeze,
  // and the resource can correlate to another WorkItem.
});
```

- [ ] **Step 2: Run the scenario to verify it fails before the slice is complete**

Run: `npx vitest run test-next/e2e/scenarios/work-controls-and-global-pause.test.ts`

Expected: FAIL until all public seams are connected.

- [ ] **Step 3: Update current-state specifications**

State only the current architecture: Work owns frozen/deleted facts; Resources retracts correlations; global operator pause blocks the complete pipeline; API tick conflicts while paused; and the web surface renders Pause/Resume ticks with confirmed Work controls.

- [ ] **Step 4: Run the required verification set**

Run: `npm run lint:contracts && npm run lint:architecture && npm run knip:next && npm run verify:next && npm run verify`

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```powershell
git add src-next test-next docs
git commit -m "test(next): verify work controls and global tick pause"
```

