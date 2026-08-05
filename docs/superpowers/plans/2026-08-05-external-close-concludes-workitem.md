# External close concludes work item Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a GitHub issue backing a Wake work item is closed, conclude the work item (close on `completed`, cancel on `not_planned`) — cancelling any active Run and blocking any active workflow — using a provider-neutral seam ready for future adapters, and stop Wake's own PR bodies from triggering GitHub's ambiguous auto-close.

**Architecture:** GitHub's adapter translates its own `state`/`state_reason` into a provider-neutral `ExternalWorkOutcome` (`completed` | `cancelled`) at its own boundary — no GitHub vocabulary crosses out of `integrations/github`. `InboundTranslator` calls a new adapter-neutral `concludeObservedWork` (mirroring the existing `admitObservedWork` seam) whenever a re-observed resource carries that outcome. Because `integrations` cannot depend on `execution` or `control-plane` (see `dependency-cruiser.config.mjs`), the actual cancel-Run/block-workflow cascade is composed once in `bootstrap/composition-root.ts` from control-plane's generalized `work-cancellation-policy.ts` (now exposing both `cancelWork` and `closeWork`) and handed to `integrations` only as a small, locally-defined structural port (`WorkConclusion`) — `integrations` never imports control-plane or execution types.

**Tech Stack:** TypeScript, vitest, zod, dependency-cruiser (`npm run lint:architecture`).

## Global Constraints

- `integrations` may depend only on `kernel`, `work`, `resources`, `activities`, `orchestration` (`dependency-cruiser.config.mjs`, `src-next/integrations/module.json`). Never import `execution` or `control-plane` types into anything under `src-next/integrations/`.
- No GitHub-specific value (`state`, `state_reason`) may be read outside the `integrations/github` package. Everything downstream sees only `ExternalWorkOutcome`.
- Closed vocabularies use `defineClosedVocabulary`/`ValueOf` from `kernel` (see `src-next/integrations/contracts/artifact-vocabulary.ts` for the exact pattern) — never repeat outcome/status literals as magic strings.
- Before finishing, run `npm run lint:contracts`, `npm run lint:architecture`, `npm run knip:next`, and `npm run verify:next` (per `CLAUDE.md`). Until Task 28's legacy-replacement gate lands, also run `npm run verify`.
- Non-goal (explicitly out of scope, do not build): reopening the external ticket does not recover the work item — closing/cancelling stays a one-way terminal move, matching `WorkService.change()`'s existing guard that only accepts commands while `state === Open`.
- Non-goal: an issue that is already closed the first time Wake observes it (a newly-labeled already-closed issue) is still admitted and started like any other observation — this plan does not add intake-time state filtering. Do not add it; it's a separate, unscoped problem.

---

### Task 1: Execution — add the `WorkClosed` cancellation reason

**Files:**
- Modify: `src-next/execution/contracts/vocabulary.ts:21-27`

**Interfaces:**
- Produces: `ExecutionCancellationReason.WorkClosed` (value `'work-closed'`), consumed by Task 2.

- [ ] **Step 1: Add the vocabulary value**

In `src-next/execution/contracts/vocabulary.ts`, change:

```ts
export const ExecutionCancellationReason = defineClosedVocabulary({
  Operator: 'operator',
  WorkCancelled: 'work-cancelled',
  WorkflowSuperseded: 'workflow-superseded',
  Timeout: 'timeout',
  Shutdown: 'shutdown',
} as const);
```

to:

```ts
export const ExecutionCancellationReason = defineClosedVocabulary({
  Operator: 'operator',
  WorkCancelled: 'work-cancelled',
  WorkClosed: 'work-closed',
  WorkflowSuperseded: 'workflow-superseded',
  Timeout: 'timeout',
  Shutdown: 'shutdown',
} as const);
```

- [ ] **Step 2: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: no new errors (this is an additive enum value; nothing yet references it).

- [ ] **Step 3: Commit**

```bash
git add src-next/execution/contracts/vocabulary.ts
git commit -m "feat(next): add WorkClosed execution cancellation reason"
```

---

### Task 2: Control-plane — generalize the cancellation cascade into `cancelWork` + `closeWork`

**Files:**
- Modify: `src-next/control-plane/application/work-cancellation-policy.ts`
- Modify: `src-next/control-plane/application/work-cancellation-policy.spec.md`
- Test: `test-next/unit/control-plane/work-cancellation-policy.test.ts` (new)

**Interfaces:**
- Consumes: `ExecutionCancellationReason.WorkClosed` from Task 1.
- Produces: `WorkConclusionPolicy` interface with `cancelWork(workItemId, reason): Promise<WorkItemView>` (unchanged behavior) and `closeWork(workItemId, reason): Promise<WorkItemView>` (new). `createWorkCancellationPolicy(...): WorkConclusionPolicy` — same constructor signature as today. Consumed by Task 10 (bootstrap) and the E2E test in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `test-next/unit/control-plane/work-cancellation-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createWorkCancellationPolicy } from '../../../src-next/control-plane/index.js';
import { workItemId, type WorkItemId, type WorkItemView } from '../../../src-next/work/index.js';

class FakeClock {
  now() {
    return new Date('2026-08-05T00:00:00.000Z');
  }
}

class SequentialIds {
  private next_ = 1;
  next(prefix: string) {
    return `${prefix}-${this.next_++}`;
  }
}

function fakeWorkPort() {
  const calls: { method: 'close' | 'cancel'; workItemId: WorkItemId; reason: string }[] = [];
  return {
    calls,
    async close(workItemId: WorkItemId, reason: string) {
      calls.push({ method: 'close', workItemId, reason });
      return { workItemId, state: 'closed' } as unknown as WorkItemView;
    },
    async cancel(workItemId: WorkItemId, reason: string) {
      calls.push({ method: 'cancel', workItemId, reason });
      return { workItemId, state: 'cancelled' } as unknown as WorkItemView;
    },
  };
}

function fakeOrchestrationPort(workflows: { workflowInstanceId: string; workItemId: WorkItemId }[]) {
  const blocked: { workflowInstanceId: string; reason: string }[] = [];
  return {
    blocked,
    async listAll() {
      return workflows as never;
    },
    async block(workflowInstanceId: string, reason: string) {
      blocked.push({ workflowInstanceId, reason });
      return null;
    },
  };
}

function fakeExecutionPort() {
  const cancelled: { workflowInstanceIds: readonly string[]; reason: string }[] = [];
  return {
    cancelled,
    async cancelActive(workflowInstanceIds: readonly string[], reason: string) {
      cancelled.push({ workflowInstanceIds, reason });
      return [];
    },
  };
}

describe('createWorkCancellationPolicy', () => {
  it('closeWork calls Work.close, cancels active Runs with WorkClosed, and blocks matching workflows', async () => {
    const id = workItemId('work-close-1');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([
      { workflowInstanceId: 'wf-1', workItemId: id },
      { workflowInstanceId: 'wf-2', workItemId: workItemId('other') },
    ]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    const result = await policy.closeWork(id, 'issue closed as completed');

    expect(result.state).toBe('closed');
    expect(work.calls).toEqual([
      { method: 'close', workItemId: id, reason: 'issue closed as completed' },
    ]);
    expect(execution.cancelled).toEqual([{ workflowInstanceIds: ['wf-1'], reason: 'work-closed' }]);
    expect(orchestration.blocked).toEqual([
      { workflowInstanceId: 'wf-1', reason: 'work closed: issue closed as completed' },
    ]);
  });

  it('cancelWork still calls Work.cancel, cancels active Runs with WorkCancelled, and blocks matching workflows', async () => {
    const id = workItemId('work-cancel-1');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([{ workflowInstanceId: 'wf-3', workItemId: id }]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    const result = await policy.cancelWork(id, 'issue closed as not planned');

    expect(result.state).toBe('cancelled');
    expect(work.calls).toEqual([
      { method: 'cancel', workItemId: id, reason: 'issue closed as not planned' },
    ]);
    expect(execution.cancelled).toEqual([
      { workflowInstanceIds: ['wf-3'], reason: 'work-cancelled' },
    ]);
    expect(orchestration.blocked).toEqual([
      { workflowInstanceId: 'wf-3', reason: 'work cancelled: issue closed as not planned' },
    ]);
  });

  it('closeWork still calls cancelActive with an empty list when there are no matching workflows', async () => {
    const id = workItemId('work-close-2');
    const work = fakeWorkPort();
    const orchestration = fakeOrchestrationPort([]);
    const execution = fakeExecutionPort();
    const policy = createWorkCancellationPolicy(
      work as never,
      orchestration as never,
      execution as never,
      new FakeClock() as never,
      new SequentialIds(),
    );

    await policy.closeWork(id, 'reason');

    expect(execution.cancelled).toEqual([{ workflowInstanceIds: [], reason: 'work-closed' }]);
    expect(orchestration.blocked).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/control-plane/work-cancellation-policy.test.ts`
Expected: FAIL — `closeWork` does not exist on the object returned by `createWorkCancellationPolicy`.

- [ ] **Step 3: Generalize the policy**

Replace the full contents of `src-next/control-plane/application/work-cancellation-policy.ts` with:

```ts
import { ExecutionCancellationReason, type ActiveRunCancellation } from '../../execution/index.js';
import {
  EventActorKind,
  correlationId,
  type Clock,
  type CommandContext,
  type IdGenerator,
} from '../../kernel/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';
import type { WorkItemId, WorkItemView } from '../../work/index.js';
import { ControlStreamKind } from '../contracts/streams.js';

interface WorkPort {
  close(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  cancel(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
}

interface OrchestrationPort {
  listAll(): Promise<readonly WorkflowInstanceView[]>;
  block(
    workflowInstanceId: string,
    reason: string,
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
}

export interface WorkConclusionPolicy {
  cancelWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
  closeWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
}

/** Applies a Work conclusion (close or cancel) consistently to active workflows and their Runs. */
export function createWorkCancellationPolicy(
  work: WorkPort,
  orchestration: OrchestrationPort,
  execution: ActiveRunCancellation,
  clock: Clock,
  ids: IdGenerator,
): WorkConclusionPolicy {
  async function conclude(
    workItemId: WorkItemId,
    reason: string,
    workAction: (context: CommandContext) => Promise<WorkItemView>,
    executionReason: ExecutionCancellationReason,
    blockReasonPrefix: string,
  ): Promise<WorkItemView> {
    const context = commandContext(clock, ids, workItemId);
    const concluded = await workAction(context);
    const workflows = (await orchestration.listAll()).filter(
      (workflow) => workflow.workItemId === workItemId,
    );
    await execution.cancelActive(
      workflows.map((workflow) => workflow.workflowInstanceId),
      executionReason,
    );
    for (const workflow of workflows)
      await orchestration.block(
        workflow.workflowInstanceId,
        `${blockReasonPrefix}: ${reason}`,
        context,
      );
    return concluded;
  }

  return {
    cancelWork(workItemId, reason) {
      return conclude(
        workItemId,
        reason,
        (context) => work.cancel(workItemId, reason, context),
        ExecutionCancellationReason.WorkCancelled,
        'work cancelled',
      );
    },
    closeWork(workItemId, reason) {
      return conclude(
        workItemId,
        reason,
        (context) => work.close(workItemId, reason, context),
        ExecutionCancellationReason.WorkClosed,
        'work closed',
      );
    },
  };
}

function commandContext(clock: Clock, ids: IdGenerator, cause: string): CommandContext {
  return {
    commandId: ids.next('command'),
    correlationId: correlationId(cause),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
  };
}
```

This preserves `cancelWork`'s exact prior behavior (verified by the second test above matching the existing `test-next/e2e/scenarios/cancel-active-run.test.ts` expectations) and adds `closeWork` sharing the same cascade shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/control-plane/work-cancellation-policy.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the existing E2E cancellation test to confirm no regression**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/cancel-active-run.test.ts`
Expected: PASS

- [ ] **Step 6: Update the component spec**

Replace `src-next/control-plane/application/work-cancellation-policy.spec.md` with:

```markdown
# Work Conclusion Policy — Component Specification

## Type, purpose, and scope

Policy/process. The ordered cross-module cascade that applies one WorkItem
conclusion — close (`closeWork`) or cancel (`cancelWork`) — consistently to
its active workflows and their Execution Runs: conclude the WorkItem, cancel
every active Run belonging to its workflows, then block each of those
workflows.

## Responsibilities and boundaries

This component owns the ordering of the cascade — Work first, then
Execution, then Orchestration — and the single command context shared
across every step of one `cancelWork`/`closeWork` call. It does not decide
whether a WorkItem is currently closable/cancellable (Work's own aggregate
does), and it does not decide whether a workflow instance can currently be
blocked (Orchestration's own aggregate does). It does not retry or roll
back a partially-completed cascade, and it does not decide which of the two
outcomes applies to a given external signal — that mapping lives with the
caller (see `integrations/application/work-conclusion.ts`'s
`concludeObservedWork`).

## Core policies, invariants, and behaviours

- `cancelWork`/`closeWork` MUST call Work's `cancel`/`close` command first;
  if that command is rejected (for example because the WorkItem is already
  `closed` or `cancelled`), the cascade MUST stop there — no active Run is
  cancelled and no workflow is blocked.
- On acceptance, the cascade MUST look up every workflow instance belonging
  to the concluded WorkItem by listing all workflow instances and filtering
  by `workItemId` — it does not depend on any WorkItem-scoped orchestration
  query.
- The cascade MUST cancel every active Run of the WorkItem's matching
  workflows in one `cancelActive` call (not per-workflow), before blocking
  any of those workflows. `cancelWork` uses
  `ExecutionCancellationReason.WorkCancelled`; `closeWork` uses
  `ExecutionCancellationReason.WorkClosed`. This call MUST still be made,
  with an empty list, when the WorkItem has no matching workflow instances.
- After the Execution cancellation, the cascade MUST block each matching
  workflow instance in turn with a reason of `'work cancelled: <original
  reason>'` (`cancelWork`) or `'work closed: <original reason>'`
  (`closeWork`), reusing the same command context (the same `commandId` and
  `correlationId`) across the Work-conclude call and every block call in
  the cascade. If a block call is rejected partway through, the remaining
  workflows in the list are not blocked — the cascade does not roll back
  workflows already blocked, and does not retry the rejected one.
- The cascade MUST return the concluded WorkItem's view regardless of how
  many (including zero) workflow instances existed for it.
- This component does not implement its own idempotency: calling
  `cancelWork`/`closeWork` a second time for the same WorkItemId relies
  entirely on Work's own aggregate rejecting a second conclusion of an
  already-final WorkItem, which stops the cascade before any Run or
  workflow is touched again.

## Dependencies and system role

- Work (dependency) — the `close`/`cancel` commands this cascade's first
  step calls; their acceptance/rejection gates the rest of the cascade.
- Execution (dependency) — the `cancelActive` contract this cascade calls
  once per WorkItem conclusion, for every matching workflow instance
  together.
- Orchestration (dependency) — the `listAll` query and `block` command this
  cascade uses to find and block the WorkItem's workflow instances.
- Kernel — Clock, IdGenerator, and command-context conventions for the one
  shared context used across the cascade.
- Dependent: `bootstrap/composition-root.ts` composes this policy and hands
  it to the GitHub provider (and any future adapter) as the structural
  `WorkConclusion` port defined in `integrations/contracts/provider.ts`, so
  `integrations/application/work-conclusion.ts` can call `closeWork` or
  `cancelWork` without `integrations` depending on `control-plane` or
  `execution` directly.

## Decisions, exclusions, and deferred capability

- No operator-facing "cancel work" or "close work" command exists yet
  beyond the external-close reactor; exposing either as a standalone
  command is a deferred capability, not a rejected one.
```

- [ ] **Step 7: Commit**

```bash
git add src-next/control-plane/application/work-cancellation-policy.ts \
  src-next/control-plane/application/work-cancellation-policy.spec.md \
  test-next/unit/control-plane/work-cancellation-policy.test.ts
git commit -m "feat(next): generalize work cancellation cascade into close/cancel conclusion policy"
```

---

### Task 3: Integrations contracts — `ExternalWorkOutcome` vocabulary

**Files:**
- Create: `src-next/integrations/contracts/outcome-vocabulary.ts`
- Modify: `src-next/integrations/index.ts`

**Interfaces:**
- Produces: `ExternalWorkOutcome` (`{ Completed: 'completed', Cancelled: 'cancelled' }`) and its `ValueOf` type, consumed by Tasks 4, 6, 7, 9.

- [ ] **Step 1: Create the vocabulary file**

```ts
import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

// How an external resource (a GitHub issue today; any future adapter's
// ticket) concluded, independent of that provider's own vocabulary.
export const ExternalWorkOutcome = defineClosedVocabulary({
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const);

export type ExternalWorkOutcome = ValueOf<typeof ExternalWorkOutcome>;
```

Save as `src-next/integrations/contracts/outcome-vocabulary.ts`.

- [ ] **Step 2: Export it from the integrations barrel**

In `src-next/integrations/index.ts`, add a line near the other `contracts/` exports (after `export * from './contracts/artifact-vocabulary.js';`):

```ts
export * from './contracts/outcome-vocabulary.js';
```

- [ ] **Step 3: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-next/integrations/contracts/outcome-vocabulary.ts src-next/integrations/index.ts
git commit -m "feat(next): add provider-neutral ExternalWorkOutcome vocabulary"
```

---

### Task 4: Integrations contracts — `WorkConclusion` port on `ProviderServices`

**Files:**
- Modify: `src-next/integrations/contracts/provider.ts`

**Interfaces:**
- Consumes: nothing new (only `WorkItemId`, `WorkItemView` already available from `work`).
- Produces: `WorkConclusion` interface (`closeWork`, `cancelWork`, same shapes as `WorkConclusionPolicy` from Task 2 but declared independently inside `integrations` — `integrations` must never import the control-plane type). `ProviderServices.conclusion: WorkConclusion`. Consumed by Task 5 (work-conclusion.ts), Task 9 (github provider.ts), Task 10 (bootstrap, which supplies the real control-plane policy — structurally compatible, no import needed).

- [ ] **Step 1: Add the port interface and service field**

In `src-next/integrations/contracts/provider.ts`, add `WorkItemId, WorkItemView` to the existing `work/index.js` type import and add a new interface next to `WorkflowRouter`:

```ts
import type { WorkItemId, WorkItemView, WorkService } from '../../work/index.js';
```

(This replaces the existing `import type { WorkService } from '../../work/index.js';` line — merge `WorkItemId` and `WorkItemView` into it.)

Add, directly after the `WorkflowRouter` interface:

```ts
// Structurally matches control-plane's WorkConclusionPolicy without importing
// it — integrations may not depend on control-plane (dependency-cruiser.config.mjs).
// bootstrap/composition-root.ts supplies the real cascade; this is the shape it must satisfy.
export interface WorkConclusion {
  closeWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
  cancelWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
}
```

Add `conclusion` to `ProviderServices`:

```ts
export interface ProviderServices {
  readonly work: WorkService;
  readonly resources: ResourceService;
  readonly resourceLookup: ResourceLookup;
  readonly orchestration: OrchestrationService;
  readonly pullRequests: PullRequestService;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly journal: EventJournal;
  readonly checkpoints: CheckpointStore;
  readonly routing: WorkflowRouter;
  readonly conclusion: WorkConclusion;
}
```

- [ ] **Step 2: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: errors at every existing `ProviderServices` object literal that doesn't yet supply `conclusion` — expected at this point; Task 10 fixes them. Confirm the only errors are missing-property errors on `conclusion`, nothing else.

- [ ] **Step 3: Commit**

```bash
git add src-next/integrations/contracts/provider.ts
git commit -m "feat(next): add WorkConclusion port to ProviderServices"
```

---

### Task 5: Integrations application — `concludeObservedWork`

**Files:**
- Create: `src-next/integrations/application/work-conclusion.ts`
- Modify: `src-next/integrations/index.ts`
- Test: `test-next/unit/integrations/work-conclusion.test.ts` (new)

**Interfaces:**
- Consumes: `ExternalWorkOutcome` (Task 3), `WorkConclusion` (Task 4), `WorkService`/`WorkItemId`/`WorkStatus` (existing `work` module).
- Produces: `WorkConclusionServices { work: WorkService; conclusion: WorkConclusion }`, `ConcludeObservedWork { workItemId: WorkItemId; outcome: ExternalWorkOutcome; reason: string }`, `concludeObservedWork(services, input): Promise<void>`. Consumed by Task 8 (`InboundTranslator`).

- [ ] **Step 1: Write the failing tests**

Create `test-next/unit/integrations/work-conclusion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  concludeObservedWork,
  ExternalWorkOutcome,
  type WorkConclusion,
  type WorkConclusionServices,
} from '../../../src-next/integrations/index.js';
import { workItemId, type WorkItemId, type WorkItemView, type WorkService } from '../../../src-next/work/index.js';

function fakeWork(state: WorkItemView['state'] | null): WorkService {
  return {
    async get(id: WorkItemId) {
      return state === null ? null : ({ workItemId: id, state } as WorkItemView);
    },
  } as unknown as WorkService;
}

function fakeConclusion() {
  const calls: { method: 'closeWork' | 'cancelWork'; workItemId: WorkItemId; reason: string }[] = [];
  const conclusion: WorkConclusion = {
    async closeWork(id, reason) {
      calls.push({ method: 'closeWork', workItemId: id, reason });
      return { workItemId: id, state: 'closed' } as WorkItemView;
    },
    async cancelWork(id, reason) {
      calls.push({ method: 'cancelWork', workItemId: id, reason });
      return { workItemId: id, state: 'cancelled' } as WorkItemView;
    },
  };
  return { calls, conclusion };
}

describe('concludeObservedWork', () => {
  it('closes the work item when the outcome is Completed', async () => {
    const id = workItemId('work-1');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('open'), conclusion };

    await concludeObservedWork(services, { workItemId: id, outcome: ExternalWorkOutcome.Completed, reason: 'issue closed' });

    expect(calls).toEqual([{ method: 'closeWork', workItemId: id, reason: 'issue closed' }]);
  });

  it('cancels the work item when the outcome is Cancelled', async () => {
    const id = workItemId('work-2');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('open'), conclusion };

    await concludeObservedWork(services, { workItemId: id, outcome: ExternalWorkOutcome.Cancelled, reason: 'not planned' });

    expect(calls).toEqual([{ method: 'cancelWork', workItemId: id, reason: 'not planned' }]);
  });

  it('is a no-op when the work item is already concluded', async () => {
    const id = workItemId('work-3');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork('closed'), conclusion };

    await concludeObservedWork(services, { workItemId: id, outcome: ExternalWorkOutcome.Completed, reason: 'echo' });

    expect(calls).toEqual([]);
  });

  it('is a no-op when the work item does not exist', async () => {
    const id = workItemId('work-4');
    const { calls, conclusion } = fakeConclusion();
    const services: WorkConclusionServices = { work: fakeWork(null), conclusion };

    await concludeObservedWork(services, { workItemId: id, outcome: ExternalWorkOutcome.Cancelled, reason: 'missing' });

    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/integrations/work-conclusion.test.ts`
Expected: FAIL — `concludeObservedWork` and `WorkConclusionServices` do not exist.

- [ ] **Step 3: Implement**

Create `src-next/integrations/application/work-conclusion.ts`:

```ts
import { WorkStatus, type WorkItemId, type WorkService } from '../../work/index.js';
import { ExternalWorkOutcome } from '../contracts/outcome-vocabulary.js';
import type { WorkConclusion } from '../contracts/provider.js';

export interface WorkConclusionServices {
  readonly work: WorkService;
  readonly conclusion: WorkConclusion;
}

export interface ConcludeObservedWork {
  readonly workItemId: WorkItemId;
  readonly outcome: ExternalWorkOutcome;
  readonly reason: string;
}

// Mirrors work-admission.ts's shared, adapter-neutral seam: an adapter
// translator calls this once it observes an external resource's terminal
// outcome. Self-idempotent — a duplicate or replayed observation, or Wake's
// own close echoing back through the next poll, is a safe no-op because it
// checks current WorkItem state rather than relying on WorkService's
// throw-on-non-Open guard.
export async function concludeObservedWork(
  services: WorkConclusionServices,
  input: ConcludeObservedWork,
): Promise<void> {
  const current = await services.work.get(input.workItemId);
  if (current === null || current.state !== WorkStatus.Open) return;
  if (input.outcome === ExternalWorkOutcome.Completed) {
    await services.conclusion.closeWork(input.workItemId, input.reason);
  } else {
    await services.conclusion.cancelWork(input.workItemId, input.reason);
  }
}
```

Add to `src-next/integrations/index.ts` (near `export * from './application/work-admission.js';`):

```ts
export * from './application/work-conclusion.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/integrations/work-conclusion.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src-next/integrations/application/work-conclusion.ts \
  src-next/integrations/index.ts \
  test-next/unit/integrations/work-conclusion.test.ts
git commit -m "feat(next): add adapter-neutral concludeObservedWork seam"
```

---

### Task 6: GitHub adapter — thread `state_reason` through issue polling

**Files:**
- Modify: `src-next/integrations/github/contracts/payloads.ts:3-13`
- Modify: `src-next/integrations/github/infrastructure/client-reads.ts:30-53`

**Interfaces:**
- Produces: `GitHubIssuePayload.state_reason?: string | null`. Consumed by Task 7.

- [ ] **Step 1: Add the field to the payload type**

In `src-next/integrations/github/contracts/payloads.ts`, change:

```ts
export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: typeof PullRequestState.Open | typeof PullRequestState.Closed;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly assignees?: readonly ({ readonly login?: string } | null)[] | null;
  readonly pull_request?: Record<string, unknown>;
}
```

to add one field after `state`:

```ts
export interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: typeof PullRequestState.Open | typeof PullRequestState.Closed;
  readonly state_reason?: string | null;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly assignees?: readonly ({ readonly login?: string } | null)[] | null;
  readonly pull_request?: Record<string, unknown>;
}
```

- [ ] **Step 2: Thread it through `normalizeIssue`**

In `src-next/integrations/github/infrastructure/client-reads.ts`, change the `normalizeIssue` parameter type to add `readonly state_reason?: string | null;` (after `readonly state: string;`), and change the function body:

```ts
function normalizeIssue(issue: {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly state_reason?: string | null;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly assignees?: readonly ({ readonly login?: string } | null)[] | null;
  readonly pull_request?: Record<string, unknown>;
}): GitHubIssuePayload {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state:
      issue.state === PullRequestState.Closed ? PullRequestState.Closed : PullRequestState.Open,
    ...(issue.state_reason === undefined ? {} : { state_reason: issue.state_reason }),
    updated_at: issue.updated_at,
    ...(issue.user === undefined ? {} : { user: issue.user }),
    ...(issue.labels === undefined ? {} : { labels: issue.labels }),
    ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
    ...(issue.pull_request === undefined ? {} : { pull_request: issue.pull_request }),
  };
}
```

- [ ] **Step 3: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: no errors (Octokit's `listForRepo` response items include `state_reason` as `string | null | undefined`, structurally compatible).

- [ ] **Step 4: Commit**

```bash
git add src-next/integrations/github/contracts/payloads.ts src-next/integrations/github/infrastructure/client-reads.ts
git commit -m "feat(next): thread GitHub issue state_reason through polling"
```

---

### Task 7: GitHub adapter — map `state_reason` to `ExternalWorkOutcome`

**Files:**
- Modify: `src-next/integrations/github/contracts/events.ts:24-48,142-170`
- Modify: `src-next/integrations/github/infrastructure/issue-source.ts`
- Modify: `src-next/integrations/github/infrastructure/source.ts:175-191`
- Test: `test-next/integration/integrations/github-external-key.test.ts` or a new unit test file — see Step 5

**Interfaces:**
- Consumes: `ExternalWorkOutcome` (Task 3), `GitHubIssuePayload.state_reason` (Task 6).
- Produces: `ExternalWorkObservedPayload.outcome?: ExternalWorkOutcome`, populated by `issueObservation` only when the issue is closed. Consumed by Task 8.

- [ ] **Step 1: Add `outcome` to the payload type and zod schema**

In `src-next/integrations/github/contracts/events.ts`, add the import:

```ts
import { ExternalWorkOutcome } from '../../contracts/outcome-vocabulary.js';
```

(Place alongside the existing `../../../activities/index.js` import block at the top of the file. `ExternalWorkOutcome` is used below both as a type, the same way this file already uses `typeof PullRequestState.Open`, and as a value for the zod enum, the same way it already uses `PullRequestState.Closed`.)

Add one field to `ExternalWorkObservedPayload`, directly after `state`:

```ts
export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state:
    typeof PullRequestState.Open | typeof PullRequestState.Closed | typeof PullRequestState.Merged;
  readonly outcome?: ExternalWorkOutcome | undefined;
  readonly revision: string;
  ...
```

(Leave every other field as-is.)

In the zod `eventSchema` for `GitHubEventType.WorkObserved` (the `.strict()` object around line 146-169), add one line after `state: z.enum([...])`:

```ts
        state: z.enum([PullRequestState.Open, PullRequestState.Closed, PullRequestState.Merged]),
        outcome: z
          .enum([ExternalWorkOutcome.Completed, ExternalWorkOutcome.Cancelled])
          .optional(),
        revision: z.string(),
```

- [ ] **Step 2: Map `state_reason` to `ExternalWorkOutcome` in `issue-source.ts`**

In `src-next/integrations/github/infrastructure/issue-source.ts`, add the import:

```ts
import { ExternalWorkOutcome } from '../../contracts/outcome-vocabulary.js';
```

Add a helper function near the bottom (after `parseRepository`):

```ts
function issueOutcome(issue: GitHubIssuePayload): ExternalWorkOutcome | undefined {
  if (issue.state !== 'closed') return undefined;
  return issue.state_reason === 'not_planned'
    ? ExternalWorkOutcome.Cancelled
    : ExternalWorkOutcome.Completed;
}
```

In `issueObservation`, add one line to the `payload` object, directly after `state: input.issue.state,`:

```ts
      state: input.issue.state,
      outcome: issueOutcome(input.issue),
```

Note: `createEventDraft`'s payload type accepts `outcome: undefined` for open issues since the field is optional in the interface — no `...(x === undefined ? {} : {...})` spread needed here because the zod schema's `.optional()` accepts an explicit `undefined` value the same as an absent key when parsed, and the payload interface allows it directly.

- [ ] **Step 3: Include `outcome` in the polling dedup fingerprint**

In `src-next/integrations/github/infrastructure/source.ts`, in `workFingerprint`, add one line after `state: payload.state,`:

```ts
function workFingerprint(
  payload: Extract<
    ReturnType<typeof issueObservation>['payload'],
    { readonly externalKey: string }
  >,
) {
  return JSON.stringify({
    kind: payload.kind,
    externalKey: payload.externalKey,
    title: payload.title,
    body: payload.body,
    state: payload.state,
    outcome: payload.outcome,
    actor: payload.actor,
    labels: (payload.labels ?? []).filter((label) => !isGitHubWakeMarker(label)).sort(),
    assignees: [...(payload.assignees ?? [])].sort(),
  });
}
```

This keeps a `state_reason` edit (e.g. an issue reclassified from "not planned" to "completed" without any other field changing) from being silently deduped away.

- [ ] **Step 4: Write the unit test**

Create `test-next/unit/integrations/github-issue-outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExternalWorkOutcome } from '../../../src-next/integrations/index.js';
import { issueObservation } from '../../../src-next/integrations/github/index.js';

describe('issueObservation outcome mapping', () => {
  it('has no outcome for an open issue', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: { number: 1, title: 'open issue', body: null, state: 'open', updated_at: '2026-08-05T00:00:00.000Z' },
    });
    expect(event.payload.outcome).toBeUndefined();
  });

  it('maps state_reason "completed" to ExternalWorkOutcome.Completed', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 2,
        title: 'done issue',
        body: null,
        state: 'closed',
        state_reason: 'completed',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Completed);
  });

  it('maps state_reason "not_planned" to ExternalWorkOutcome.Cancelled', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 3,
        title: 'wontfix issue',
        body: null,
        state: 'closed',
        state_reason: 'not_planned',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Cancelled);
  });

  it('treats a closed issue with no state_reason as Completed', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: { number: 4, title: 'legacy closed issue', body: null, state: 'closed', updated_at: '2026-08-05T00:00:00.000Z' },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Completed);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/integrations/github-issue-outcome.test.ts`
Expected: PASS (4 tests). If it fails on the import path, confirm `ExternalWorkOutcome` is exported from `src-next/integrations/index.ts` (Task 3, Step 2) and `issueObservation` from `src-next/integrations/github/index.ts` (already exported today).

- [ ] **Step 6: Full build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src-next/integrations/github/contracts/events.ts \
  src-next/integrations/github/infrastructure/issue-source.ts \
  src-next/integrations/github/infrastructure/source.ts \
  test-next/unit/integrations/github-issue-outcome.test.ts
git commit -m "feat(next): map GitHub issue state_reason to ExternalWorkOutcome"
```

---

### Task 8: GitHub adapter — wire `InboundTranslator` to `concludeObservedWork`

**Files:**
- Modify: `src-next/integrations/github/application/inbound-translator.ts`
- Test: `test-next/integration/integrations/inbound-translator.test.ts`

**Interfaces:**
- Consumes: `concludeObservedWork`, `WorkConclusionServices` (Task 5), `WorkConclusion` (Task 4), `ExternalWorkOutcome` (Task 3).
- Produces: `InboundTranslatorDependencies.conclusion?: WorkConclusion` — a new optional constructor dependency. Consumed by Task 9 (`github/provider.ts`).

- [ ] **Step 1: Write the failing integration test**

Add to `test-next/integration/integrations/inbound-translator.test.ts` (new `describe` block, keep the existing tests and `observation()` helper as-is):

```ts
describe('InboundTranslator conclusion', () => {
  it('closes the work item when a re-observed issue carries a Completed outcome', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const calls: { method: 'closeWork' | 'cancelWork'; reason: string }[] = [];
    const conclusion = {
      async closeWork(workItemId: string, reason: string) {
        calls.push({ method: 'closeWork', reason });
        return work.get(workItemId as never) as never;
      },
      async cancelWork(workItemId: string, reason: string) {
        calls.push({ method: 'cancelWork', reason });
        return work.get(workItemId as never) as never;
      },
    };
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
      conclusion,
    });

    const open = createEventDraft({
      eventId: 'github:issue:owner/repo#9:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#9',
      causationId: 'github:owner/repo#9:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: { ...observation(), externalKey: 'owner/repo#9', revision: 'v1' },
    });
    await journal.append(open.stream, 0, [open]);
    await translator.runOnce();

    const closed = createEventDraft({
      eventId: 'github:issue:owner/repo#9:v2',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#9',
      causationId: 'github:owner/repo#9:v2',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        ...observation(),
        externalKey: 'owner/repo#9',
        revision: 'v2',
        state: 'closed',
        outcome: 'completed',
      },
    });
    await journal.append(closed.stream, 1, [closed]);
    await translator.runOnce();

    expect(calls).toEqual([{ method: 'closeWork', reason: expect.stringContaining('owner/repo#9') }]);
  });

  it('cancels the work item when a re-observed issue carries a Cancelled outcome', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const calls: { method: 'closeWork' | 'cancelWork'; reason: string }[] = [];
    const conclusion = {
      async closeWork(workItemId: string, reason: string) {
        calls.push({ method: 'closeWork', reason });
        return work.get(workItemId as never) as never;
      },
      async cancelWork(workItemId: string, reason: string) {
        calls.push({ method: 'cancelWork', reason });
        return work.get(workItemId as never) as never;
      },
    };
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
      conclusion,
    });

    const open = createEventDraft({
      eventId: 'github:issue:owner/repo#10:v1',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#10',
      causationId: 'github:owner/repo#10:v1',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: { ...observation(), externalKey: 'owner/repo#10', revision: 'v1' },
    });
    await journal.append(open.stream, 0, [open]);
    await translator.runOnce();

    const closed = createEventDraft({
      eventId: 'github:issue:owner/repo#10:v2',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:owner/repo#10',
      causationId: 'github:owner/repo#10:v2',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        ...observation(),
        externalKey: 'owner/repo#10',
        revision: 'v2',
        state: 'closed',
        outcome: 'cancelled',
      },
    });
    await journal.append(closed.stream, 1, [closed]);
    await translator.runOnce();

    expect(calls).toEqual([{ method: 'cancelWork', reason: expect.stringContaining('owner/repo#10') }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.next.integration.config.ts test-next/integration/integrations/inbound-translator.test.ts`
Expected: FAIL — `conclusion` is not a recognized `InboundTranslatorDependencies` field yet (TypeScript error) or the calls array stays empty.

- [ ] **Step 3: Wire the dependency into `InboundTranslator`**

In `src-next/integrations/github/application/inbound-translator.ts`:

Add to the imports:

```ts
import { concludeObservedWork } from '../../application/work-conclusion.js';
import type { WorkConclusion } from '../../contracts/provider.js';
```

Add `conclusion?: WorkConclusion;` to `InboundTranslatorDependencies`:

```ts
interface InboundTranslatorDependencies {
  readonly pullRequests?: PullRequestService;
  readonly ids?: IdGenerator;
  readonly lookup?: ResourceLookup;
  readonly adapter?: AdapterId;
  readonly orchestration?: OrchestrationService;
  readonly routing?: WorkflowRouter;
  readonly intake?: readonly GitHubIntakeRuleConfig[];
  readonly conclusion?: WorkConclusion;
}
```

In the constructor, store it:

```ts
    this.conclusion = dependencies.conclusion;
```

(add next to the other `this.x = dependencies.x;` assignments), and declare the field:

```ts
  private readonly conclusion: WorkConclusion | undefined;
```

(add next to `private readonly intake: readonly IntakeRule[];`).

In `apply()`, inside the `if (!identity.created) { ... }` branch, extend the revision-changed block:

```ts
      if (current.revision !== payload.revision) {
        await this.resources.discover(
          {
            resourceId: current.resourceId,
            kind: current.kind,
            externalKey: current.externalKey,
            capabilities: current.capabilities,
            revision: payload.revision,
          },
          context,
        );
        if (payload.outcome !== undefined && this.conclusion !== undefined) {
          await concludeObservedWork(
            { work: this.work, conclusion: this.conclusion },
            {
              workItemId: identity.workItemId,
              outcome: payload.outcome,
              reason: `${this.adapter} ${payload.externalKey} closed`,
            },
          );
        }
      }
```

(This replaces the existing `if (current.revision !== payload.revision) { await this.resources.discover(...); }` block — the `resources.discover` call stays exactly as it was, the `outcome` check is added after it, inside the same `if`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.next.integration.config.ts test-next/integration/integrations/inbound-translator.test.ts`
Expected: PASS (5 tests: 3 existing + 2 new)

- [ ] **Step 5: Full build and lint check**

Run: `npx tsc -p tsconfig.next.json --noEmit && npm run lint:architecture`
Expected: no errors — confirm `integrations/github/application/inbound-translator.ts` importing `../../application/work-conclusion.js` and `../../contracts/provider.js` does not trip any dependency-cruiser rule (both are inside `integrations`).

- [ ] **Step 6: Commit**

```bash
git add src-next/integrations/github/application/inbound-translator.ts \
  test-next/integration/integrations/inbound-translator.test.ts
git commit -m "feat(next): wire InboundTranslator to concludeObservedWork on issue close"
```

---

### Task 9: GitHub provider — pass `conclusion` through

**Files:**
- Modify: `src-next/integrations/github/provider.ts:69-83`

**Interfaces:**
- Consumes: `services.conclusion: WorkConclusion` (Task 4, will be supplied by bootstrap in Task 10).

- [ ] **Step 1: Pass `conclusion` into the `InboundTranslator` constructor**

In `src-next/integrations/github/provider.ts`, change:

```ts
      inbound: new InboundTranslator(
        services.journal,
        services.checkpoints,
        services.work,
        services.resources,
        {
          pullRequests: services.pullRequests,
          ids: services.ids,
          lookup: services.resourceLookup,
          adapter,
          orchestration: services.orchestration,
          routing: services.routing,
          intake: config.intake,
        },
      ),
```

to add one field:

```ts
      inbound: new InboundTranslator(
        services.journal,
        services.checkpoints,
        services.work,
        services.resources,
        {
          pullRequests: services.pullRequests,
          ids: services.ids,
          lookup: services.resourceLookup,
          adapter,
          orchestration: services.orchestration,
          routing: services.routing,
          intake: config.intake,
          conclusion: services.conclusion,
        },
      ),
```

- [ ] **Step 2: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: still failing only on the `ProviderServices` object literals from Task 4 Step 2 that don't yet supply `conclusion` (Task 10 fixes the real one; check Step 3 below for any test fixtures).

- [ ] **Step 3: Find and note any other `ProviderServices`-shaped test literals**

Run: `grep -rn "ProviderServices" src-next test-next --include=*.ts`

If any test constructs a `ProviderServices` object literal directly (rather than via `composeIntegrationRuntime`), it now needs a `conclusion` field too — add a minimal fake (`{ closeWork: async () => { throw new Error('unused'); }, cancelWork: async () => { throw new Error('unused'); } }`) to keep it compiling. Do this now if any exist; otherwise this step is a no-op (as of this plan's writing, none do — only `github/provider.ts` and `composition-root.ts` reference the shape).

- [ ] **Step 4: Commit**

```bash
git add src-next/integrations/github/provider.ts
git commit -m "feat(next): pass WorkConclusion port into the GitHub provider's InboundTranslator"
```

---

### Task 10: Bootstrap — compose and supply the real `WorkConclusion`

**Files:**
- Modify: `src-next/bootstrap/composition-root.ts`

**Interfaces:**
- Consumes: `createWorkCancellationPolicy` (Task 2), `WorkConclusion` (Task 4, satisfied structurally).
- Produces: `ProviderServices.conclusion` populated with the real cascade for every composed provider.

- [ ] **Step 1: Import `createWorkCancellationPolicy`**

In `src-next/bootstrap/composition-root.ts`, add `createWorkCancellationPolicy` to the existing `../control-plane/index.js` import list:

```ts
import {
  ControlStreamKind,
  DispatchPolicy,
  ScheduleService,
  createAdvanceOnce,
  createRunnerControlService,
  createTickPipeline,
  createWorkCancellationPolicy,
  ineligibleRunners,
  type ControlPlaneView,
  type TickPipeline,
} from '../control-plane/index.js';
```

- [ ] **Step 2: Compose the policy and pass it into `providers`**

In `composeIntegrationRuntime`, find:

```ts
  const providers = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      work: input.work,
      resources: input.resources,
      resourceLookup: input.lookup,
      pullRequests: input.pullRequests,
      orchestration: input.orchestration,
      ids: input.ids,
      clock: input.clock,
      journal: input.journal,
      checkpoints: input.checkpoints,
      routing: createWorkflowRouter(input.config.orchestration),
    },
  );
```

and change it to:

```ts
  const providers = registry.compose(
    await hydrateFakeProviderEvidence(input.wakeRoot, input.config.integrations),
    {
      work: input.work,
      resources: input.resources,
      resourceLookup: input.lookup,
      pullRequests: input.pullRequests,
      orchestration: input.orchestration,
      ids: input.ids,
      clock: input.clock,
      journal: input.journal,
      checkpoints: input.checkpoints,
      routing: createWorkflowRouter(input.config.orchestration),
      conclusion: createWorkCancellationPolicy(
        input.work,
        input.orchestration,
        input.execution,
        input.clock,
        input.ids,
      ),
    },
  );
```

(`input.execution` is already part of `IntegrationRuntimeInput` — see `composition-root.ts:222` — it's just not threaded into `providers` yet.)

- [ ] **Step 3: Build check**

Run: `npx tsc -p tsconfig.next.json --noEmit`
Expected: no errors — this was the last missing piece from Task 4's `ProviderServices.conclusion` addition.

- [ ] **Step 4: Commit**

```bash
git add src-next/bootstrap/composition-root.ts
git commit -m "feat(next): compose the work conclusion cascade for provider services"
```

---

### Task 11: E2E — full cascade from a neutral outcome to Run cancellation and workflow blocking

**Files:**
- Modify: `test-next/e2e/support/world.ts`
- Test: `test-next/e2e/scenarios/external-close-concludes-work.test.ts` (new)

**Interfaces:**
- Consumes: `TestWorld.cancellation` (existing), `createWorkCancellationPolicy` (Task 2).
- Produces: `TestWorld.closeWork(workItemId, reason)`, mirroring the existing `cancelWork` helper.

- [ ] **Step 1: Write the failing E2E test**

Create `test-next/e2e/scenarios/external-close-concludes-work.test.ts`, modeled directly on `test-next/e2e/scenarios/cancel-active-run.test.ts`:

```ts
import { expect, it } from 'vitest';
import { z } from 'zod';
import { resId } from '../../support/identities.js';

import { activityName } from '../../../src-next/activities/index.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import { workflowName } from '../../../src-next/orchestration/index.js';
import { resourceKind } from '../../../src-next/resources/index.js';
import { TestWorld } from '../support/world.js';

it('E2E-EXEC-CONCLUDE-001 closeWork cancels a live fake Run and blocks the workflow', async () => {
  const world = new TestWorld();
  let complete!: () => void;
  world.registerActivity({
    name: activityName('long-running'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(_invocation, context) {
        await context.reportExternalExecution({
          kind: 'process',
          id: 'fake-process-1',
          startedAt: context.occurredAt,
        });
        return new Promise((resolve) => {
          complete = () => resolve({ kind: 'done' });
        });
      },
    },
  });
  world.configureWorkflow('closable', {
    stages: {
      run: {
        activity: 'long-running',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
      },
    },
  });
  const work = await world.createWork({ objective: 'close via external ticket completion' });
  const resource = await world.discoverResource({
    resourceId: resId('1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: 'fake', key: 'issues/1' },
    capabilities: [],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate',
    correlationId: correlationId('close'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('closable'),
  });
  const advancing = world.advance(work.workItemId);
  await activeRun(world);

  await world.closeWork(work.workItemId, 'issue closed as completed');

  expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'closed' });
  expect((await world.viewRuns())[0]).toMatchObject({
    status: 'cancelled',
    cancellation: { reason: 'work-closed', confirmedAt: expect.any(String) },
  });

  complete();
  await expect(advancing).resolves.toMatchObject({ kind: 'blocked' });
  expect(await world.viewWorkflow(workflow.workflowInstanceId)).toMatchObject({
    status: 'blocked',
  });
});

async function activeRun(world: TestWorld) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [run] = await world.viewRuns();
    if (run?.externalExecution !== undefined) return run;
    await Promise.resolve();
  }
  throw new Error('Expected an active fake Run');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/external-close-concludes-work.test.ts`
Expected: FAIL — `world.closeWork` is not a function yet.

- [ ] **Step 3: Add `closeWork` to `TestWorld`**

In `test-next/e2e/support/world.ts`, directly after the existing `cancelWork` method:

```ts
  async cancelWork(workItemId: WorkItemId, reason = 'operator cancellation') {
    return this.cancellation.cancelWork(workItemId, reason);
  }

  async closeWork(workItemId: WorkItemId, reason = 'operator close') {
    return this.cancellation.closeWork(workItemId, reason);
  }
```

(`this.cancellation` is already the `WorkConclusionPolicy` object from Task 2 — no other change needed; `restartExecution()` already reconstructs `this.cancellation` with the new `execution`, so `closeWork` survives a restart the same way `cancelWork` does.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/external-close-concludes-work.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test-next/e2e/support/world.ts test-next/e2e/scenarios/external-close-concludes-work.test.ts
git commit -m "test(next): E2E cascade proof for closeWork alongside cancelWork"
```

---

### Task 12: Prompts — stop triggering GitHub's auto-close

**Files:**
- Modify: `prompts/implement.md:23-31,49-51`

**Interfaces:** none (content-only change).

- [ ] **Step 1: Read the current lines to confirm exact text**

Run: `sed -n '20,52p' prompts/implement.md`

- [ ] **Step 2: Replace the closing keyword with a non-magic reference**

In `prompts/implement.md`, change the PR-body instruction (around line 23-24) from:

```
- Open a pull request against main with `gh pr create --base main --head
  {{branch}} --title "<summary>" --body "Closes #{{issueNumber}}
```

to:

```
- Open a pull request against main with `gh pr create --base main --head
  {{branch}} --title "<summary>" --body "Refs #{{issueNumber}}
```

And change the completion-requirements reminder (around line 49-51) from:

```
Reminder of the completion requirements: commit, push {{branch}}, open a PR
with `gh pr create` closing #{{issueNumber}}, and never merge it yourself. The
```

to:

```
Reminder of the completion requirements: commit, push {{branch}}, open a PR
with `gh pr create` referencing #{{issueNumber}}, and never merge it yourself. The
```

Leave every other line (including the `<!-- wake:work-item {{workItemKey}} -->` marker instructions) unchanged.

- [ ] **Step 3: Verify no closing keyword remains**

Run: `grep -in "closes #\|closing #" prompts/implement.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add prompts/implement.md
git commit -m "fix(prompts): reference issues in PR bodies instead of auto-closing them"
```

---

### Task 13: Docs — describe the new behavior

**Files:**
- Modify: `docs/workflows.md`

**Interfaces:** none (documentation-only change).

- [ ] **Step 1: Add a section describing ticket-closure behavior**

In `docs/workflows.md`, insert a new section after `## Labels` (before `## Checklist for a custom workflow`, currently starting at line 251):

```markdown
## Ticket closure

When the ticket backing a work item closes on its source tracker, Wake
concludes the work item to match: closed as completed closes the work
item, closed as not planned (or its provider's equivalent) cancels it.
Either way, Wake cancels any active Run and blocks any active workflow for
that work item — closing the ticket stops the work.

Wake's own generated PR bodies reference the issue (`Refs #<number>`)
rather than using a closing keyword (`Closes #<number>`), so merging a PR
never auto-closes the issue on GitHub. This keeps "the PR merged" and "the
ticket closed" independent signals: a workflow with stages after merge
(review, verify) keeps running until it reaches `done` on its own, and the
ticket only closes when a human closes it or Wake does so as the workflow's
final step.

Reopening the ticket does not currently reopen the work item — closing or
cancelling a work item is a one-way move.
```

- [ ] **Step 2: Proofread against Task 7-12's actual behavior**

Confirm the section doesn't claim anything the implementation doesn't do (no reopen support, no non-GitHub adapter shipped yet — keep the wording adapter-neutral without naming a second provider that doesn't exist).

- [ ] **Step 3: Commit**

```bash
git add docs/workflows.md
git commit -m "docs: describe ticket-closure behavior in workflows.md"
```

---

### Task 14: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full next-architecture gate**

Run: `npm run verify:next`
Expected: passes (architecture + contracts + lint + format + build + web tests + unit tests + architecture tests).

- [ ] **Step 2: Run the E2E suite**

Run: `npm run test:next:e2e`
Expected: passes, including the new `external-close-concludes-work.test.ts` and the untouched `cancel-active-run.test.ts`.

- [ ] **Step 3: Run the legacy gate (still required until Task 28 lands)**

Run: `npm run verify`
Expected: passes — this plan does not touch `src/`, so this should be an unaffected baseline run.

- [ ] **Step 4: Check whether any module spec drifted**

Run: `npm run check:specs`
Expected: flags `control-plane` (its `SPEC.md` `asOf` checkpoint predates the Task 2 change) and possibly `integrations` and `execution`. For each flagged module, use the `sync-module-specs` skill to bring its `SPEC.md` `asOf` checkpoint current — do not hand-edit `asOf` directly.

- [ ] **Step 5: Confirm no stray closing keywords remain anywhere in prompts**

Run: `grep -rin "closes #\|closing #\|fixes #\|resolves #" prompts/`
Expected: no output.
