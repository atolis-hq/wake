# Agent Sentinel Outcome Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's four-sentinel vocabulary (`DONE`/`BLOCKED`/`FAILED`/`AWAITING_APPROVAL`) with a generic four-sentinel vocabulary (`DONE`/`REJECTED`/`BLOCKED`/`FAILED`) that separates "did the agent conclude" from "does this need a human gate," fixing `pr-review`'s overload of `FAILED` to mean "needs changes" (issue #476) and relocating the approval gate to pure policy.

**Architecture:** `REJECTED` becomes the generic sentinel for any evaluative stage's negative-with-known-next-step verdict, replacing `pr-review`'s (and `plan-review`'s) misuse of `FAILED` for that purpose. `AWAITING_APPROVAL` is deleted from the agent-facing vocabulary; the approval gate becomes a boolean (`approvalGated`) computed from the stage's existing `skipApproval` config and carried on the `RUN_COMPLETED_EVENT` payload, replacing the `DONE`→`AWAITING_APPROVAL` sentinel coercion `tick-runner.ts` already performed. The two independently-drifting `isAwaitingApproval` predicates in `tick-runner.ts` and `policy-engine.ts` are unified on the canonical `context.status === 'awaiting-approval'` field. See `docs/adrs/0002-agent-sentinel-outcome-model.md` for full rationale.

**Tech Stack:** TypeScript, zod, vitest.

## Global Constraints

- Full vocabulary reference: see `docs/adrs/0002-agent-sentinel-outcome-model.md`'s table. `DONE` = completed, no gate (or gated by policy). `REJECTED` = completed evaluation, negative verdict, known corrective next step. `BLOCKED` = could not decide, needs a human's judgment on substance. `FAILED` = could not execute, technical/environmental.
- `AWAITING_APPROVAL` must never again be emitted or expected as a literal agent sentinel value after this plan. It may still appear as an internal `workItemStatusValues`/`workflowOutcomeValues`/run-record `status` value (those already exist and are unaffected).
- The event-replay guarantee is load-bearing: `rm -rf .wake/state/` + replay must reproduce projections identically (`CLAUDE.md`). Any historical event payload with `sentinel: "AWAITING_APPROVAL"` must still fold to the same practical state after this change.
- Run `npm run verify` (not a manual build+test) before considering any task done, per `CLAUDE.md`. Files you touch must be prettier-clean (`npx prettier --check <file>`); write new/edited files with `npx prettier --write --end-of-line lf <file>` if `format:check` flags CRLF noise on files you didn't touch — ignore those, don't "fix" them.
- Every new/changed runner-invocation-facing prompt text must keep `--max-turns` and wall-clock timeout untouched — this plan does not touch runner invocation limits, only sentinel vocabulary and prompt wording.
- Whenever this plan changes CLI/config surface (it does not — `skipApproval` config already exists and keeps its meaning), `README.md`/`docs/configuration.md` must be updated per `CLAUDE.md`'s documentation-requirements section. Task 9 handles the doc updates this plan does require (vocabulary wording only, no surface change).

---

### Task 1: Core vocabulary — `stages.ts`, `schema.ts`, `workflows.ts`, `work-item-status.ts`

**Files:**
- Modify: `src/domain/stages.ts:3-13`
- Modify: `src/domain/schema.ts:1216-1224` (`synthesizeBodyFromEnvelope`), `src/domain/schema.ts:1226-1330` (`parseRunnerResult`), `src/domain/schema.ts:1353-1357` (`parseRunnerResultSentinel`)
- Modify: `src/domain/workflows.ts:252-263` (`nextStage`)
- Modify: `src/domain/work-item-status.ts` (whole file)
- Test: `test/domain/schema.test.ts`
- Test: `test/domain/work-item-status.test.ts` (create if it doesn't exist — confirm with `Glob test/domain/work-item-status.test.ts` first; the touch-point inventory found no dedicated file for it)
- Test: `test/domain/workflows.test.ts` (confirm existence the same way; add cases inline if it exists, else fold into `test/domain/schema.test.ts`'s nextStage-adjacent coverage — check `Grep -n "nextStage" test/domain/*.test.ts` for the current home of this coverage before deciding)

**Interfaces:**
- Produces: `runnerSentinelValues = ['DONE', 'REJECTED', 'BLOCKED', 'FAILED'] as const` and the four exported constants `doneRunnerSentinel`, `rejectedRunnerSentinel`, `blockedRunnerSentinel`, `failedRunnerSentinel` from `src/domain/stages.ts` — every later task imports `rejectedRunnerSentinel` from here, never the string literal `'REJECTED'`, matching the existing pattern for the other three constants.
- Produces: `RunnerSentinel` type (`src/domain/types.ts`, unchanged export site, now resolves to `'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'` automatically via `typeof runnerSentinelValues[number]`).
- Produces: `parseRunnerResult(result: string): { status: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'; body: string; envelope: 'structured' | 'degraded' | 'missing'; result?: ... }` and `parseRunnerResultSentinel(result: string): 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'` — every later task that reads a raw sentinel goes through these.
- Produces: `nextStage(stage: Stage, sentinel: RunnerSentinel, workflow: WorkflowDefinition): Stage | null` — returns `null` for `BLOCKED`, `FAILED`, and `REJECTED`; only `DONE` follows `onDone`. (The `DONE`-but-approval-gated case is handled by the caller in Task 3, not here — this function has no knowledge of gating.)
- Produces: `workItemStatusForRunOutcome(input: { sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'; stage: Stage; approvalGated?: boolean }): WorkItemStatus` — `DONE` + `approvalGated: true` → `'awaiting-approval'`; `REJECTED` → `'changes-requested'`; `BLOCKED` → `'blocked'`; `FAILED` → `'failed'`; otherwise `stage === 'done' ? 'done' : 'queued'`. Later tasks (Task 4) call this with the new `approvalGated` argument.

- [ ] **Step 1: Update `stages.ts`'s sentinel vocabulary**

Replace `src/domain/stages.ts:3-13`:

```typescript
export const doneRunnerSentinel = 'DONE';
export const rejectedRunnerSentinel = 'REJECTED';
export const blockedRunnerSentinel = 'BLOCKED';
export const failedRunnerSentinel = 'FAILED';

export const runnerSentinelValues = [
  doneRunnerSentinel,
  rejectedRunnerSentinel,
  blockedRunnerSentinel,
  failedRunnerSentinel,
] as const;
```

- [ ] **Step 2: Write the failing tests for `parseRunnerResult`/`parseRunnerResultSentinel` REJECTED handling**

Add to `test/domain/schema.test.ts` near the other `parseRunnerResult` cases (search for `describe('parseRunnerResult'` or similar to place these alongside):

```typescript
it('parses a structured REJECTED envelope', () => {
  const result = parseRunnerResult(
    [
      'Reviewed the diff, needs changes.',
      '```wake-result',
      '{ "status": "REJECTED" }',
      '```',
    ].join('\n'),
  );
  expect(result.status).toBe('REJECTED');
  expect(result.envelope).toBe('structured');
});

it('parses a bare trailing REJECTED sentinel (degraded envelope)', () => {
  const result = parseRunnerResult('Reviewed the diff, needs changes.\nREJECTED');
  expect(result.status).toBe('REJECTED');
  expect(result.envelope).toBe('degraded');
});

it('no longer recognizes AWAITING_APPROVAL as a bare sentinel', () => {
  const result = parseRunnerResult('Done with the work.\nAWAITING_APPROVAL');
  // AWAITING_APPROVAL is not a valid runnerSentinelSchema value anymore, so
  // the last line fails to parse as a sentinel and the whole reply is
  // treated as a non-envelope body, same as any other unrecognized trailer.
  expect(result.envelope).toBe('missing');
  expect(result.status).toBe('BLOCKED');
});
```

Also update `synthesizeBodyFromEnvelope`'s expectations: find the existing test asserting on `AWAITING_APPROVAL`'s synthesized body (`'Ready for approval.'`) and delete it; add:

```typescript
it('synthesizes a body for a bare REJECTED envelope with no prose', () => {
  const result = parseRunnerResult('```wake-result\n{ "status": "REJECTED" }\n```');
  expect(result.body).toBe('Run rejected — needs changes.');
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx vitest run test/domain/schema.test.ts -t "REJECTED"`
Expected: FAIL — `runnerSentinelSchema` doesn't accept `'REJECTED'` yet, and `synthesizeBodyFromEnvelope` has no `REJECTED` label.

- [ ] **Step 4: Update `schema.ts`'s sentinel-shaped functions**

In `src/domain/schema.ts`, update `synthesizeBodyFromEnvelope` (currently L1216-1224):

```typescript
function synthesizeBodyFromEnvelope(envelope: z.infer<typeof wakeResultEnvelopeSchema>): string {
  const labels: Record<string, string> = {
    DONE: 'Run completed.',
    REJECTED: 'Run rejected — needs changes.',
    BLOCKED: 'Run blocked — needs input.',
    FAILED: 'Run failed.',
  };
  return labels[envelope.status] ?? 'Run finished.';
}
```

Update `parseRunnerResult`'s return-type annotation (currently L1226-1230) and the fenced-sentinel-stripping regex (currently L1248):

```typescript
export function parseRunnerResult(result: string): {
  status: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  body: string;
  envelope: 'structured' | 'degraded' | 'missing';
  result?: z.infer<typeof wakeResultEnvelopeSchema>;
} {
```

```typescript
      const jsonContent =
        rawContent.replace(/\n(?:DONE|REJECTED|BLOCKED|FAILED)[ \t]*\n?$/, '') || rawContent;
```

Update `parseRunnerResultSentinel`'s return type (currently L1353-1357):

```typescript
export function parseRunnerResultSentinel(
  result: string,
): 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED' {
  return parseRunnerResult(result).status;
}
```

`runnerSentinelSchema` (`schema.ts:37`) needs no edit — it already derives from `runnerSentinelValues`, which Step 1 changed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/domain/schema.test.ts`
Expected: PASS. If any other `test/domain/schema.test.ts` case asserted on `AWAITING_APPROVAL` as a valid bare/structured sentinel, update it now to use `REJECTED` or delete it if it was specifically testing the retired value — grep first: `Grep -n "AWAITING_APPROVAL" test/domain/schema.test.ts`.

- [ ] **Step 6: Update `workflows.ts`'s `nextStage`**

In `src/domain/workflows.ts:252-263`:

```typescript
export function nextStage(
  stage: Stage,
  sentinel: RunnerSentinel,
  workflow: WorkflowDefinition,
): Stage | null {
  if (sentinel === 'BLOCKED' || sentinel === 'FAILED' || sentinel === 'REJECTED') {
    return null;
  }

  const runnableStage = stage === universalQueueStage ? stageAfterQueue(workflow) : stage;
  return workflow.stages[runnableStage]?.onDone ?? null;
}
```

Add or update a test (locate the file/describe block covering `nextStage` via `Grep -rn "nextStage(" test/domain/`):

```typescript
it('does not advance the stage on REJECTED', () => {
  expect(nextStage('implement', 'REJECTED', workflow)).toBeNull();
});
```

- [ ] **Step 7: Update `work-item-status.ts`**

Replace the whole `workItemStatusForRunOutcome` function in `src/domain/work-item-status.ts:26-40`:

```typescript
export function workItemStatusForRunOutcome(input: {
  sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  stage: Stage;
  approvalGated?: boolean;
}): WorkItemStatus {
  if (input.sentinel === 'DONE' && input.approvalGated === true) {
    return 'awaiting-approval';
  }
  if (input.sentinel === 'REJECTED') {
    return 'changes-requested';
  }
  if (input.sentinel === 'BLOCKED') {
    return 'blocked';
  }
  if (input.sentinel === 'FAILED') {
    return 'failed';
  }
  return input.stage === 'done' ? 'done' : 'queued';
}
```

Add tests (create `test/domain/work-item-status.test.ts` if `Glob` confirms it doesn't exist yet):

```typescript
import { describe, expect, it } from 'vitest';
import { workItemStatusForRunOutcome } from '../../src/domain/work-item-status.js';

describe('workItemStatusForRunOutcome', () => {
  it('maps a gated DONE to awaiting-approval', () => {
    expect(
      workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'implement', approvalGated: true }),
    ).toBe('awaiting-approval');
  });

  it('maps an ungated DONE on a non-terminal stage to queued', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'implement' })).toBe('queued');
  });

  it('maps an ungated DONE on the terminal stage to done', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'DONE', stage: 'done' })).toBe('done');
  });

  it('maps REJECTED to changes-requested regardless of approvalGated', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'REJECTED', stage: 'implement' })).toBe(
      'changes-requested',
    );
  });

  it('maps BLOCKED to blocked', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'BLOCKED', stage: 'implement' })).toBe(
      'blocked',
    );
  });

  it('maps FAILED to failed', () => {
    expect(workItemStatusForRunOutcome({ sentinel: 'FAILED', stage: 'implement' })).toBe(
      'failed',
    );
  });
});
```

- [ ] **Step 8: Run the full domain test slice**

Run: `npx vitest run test/domain`
Expected: PASS (aside from files this task hasn't touched yet that reference `AWAITING_APPROVAL` — those belong to later tasks; note any failures here for the task that owns that file, don't fix them in this task).

- [ ] **Step 9: Commit**

```bash
git add src/domain/stages.ts src/domain/schema.ts src/domain/workflows.ts src/domain/work-item-status.ts test/domain/schema.test.ts test/domain/work-item-status.test.ts test/domain/workflows.test.ts
git commit -m "domain: replace AWAITING_APPROVAL sentinel with REJECTED"
```

---

### Task 2: `event-builders.ts` — `createPublishIntentEvent` outcome-kind derivation

**Files:**
- Modify: `src/core/event-builders.ts:47-155`
- Test: locate its test file via `Grep -rl "createPublishIntentEvent" test/` (the touch-point inventory didn't name one explicitly — confirm before writing steps; if none exists, add cases to `test/core/tick-runner.test.ts` where `createPublishIntentEvent`'s behavior is presently exercised indirectly)

**Interfaces:**
- Consumes: `RunnerSentinel` type from Task 1 (now `'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'`).
- Produces: `createPublishIntentEvent(input: { ...; sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED'; approvalGated?: boolean; ... }): EventEnvelope` — Task 3 passes the new `approvalGated` argument.

- [ ] **Step 1: Write the failing test**

```typescript
it('derives an approval-request kind for a gated DONE', () => {
  const event = createPublishIntentEvent({
    ...baseInput, // reuse whatever fixture the existing suite already builds for this function
    sentinel: 'DONE',
    approvalGated: true,
  });
  expect((event.payload as { kind: string }).kind).toBe('approval-request');
});

it('derives a status-update kind for REJECTED', () => {
  const event = createPublishIntentEvent({ ...baseInput, sentinel: 'REJECTED' });
  expect((event.payload as { kind: string }).kind).toBe('status-update');
});

it('derives a status-update kind for an ungated DONE', () => {
  const event = createPublishIntentEvent({ ...baseInput, sentinel: 'DONE', approvalGated: false });
  expect((event.payload as { kind: string }).kind).toBe('status-update');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -t "derives an approval-request kind"`
Expected: FAIL — `approvalGated` isn't a recognized input field, and `kind` still branches on `sentinel === 'AWAITING_APPROVAL'`.

- [ ] **Step 3: Update `createPublishIntentEvent`**

In `src/core/event-builders.ts`, change the input type at L47-58 to add `approvalGated?: boolean` and update the sentinel union:

```typescript
export function createPublishIntentEvent(input: {
  projection: IssueStateRecord;
  runId: string;
  action: AgentAction;
  runnerResult: AgentRunResult;
  parsedRunnerResult: ParsedRunnerResult;
  sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
  approvalGated?: boolean;
  occurredAt: string;
  workspacePath?: string;
  startedAt: string;
  previousFailureClass?: string;
}): EventEnvelope {
```

Replace the `kind` derivation at L112-119:

```typescript
      kind:
        input.sentinel === 'DONE' && input.approvalGated === true
          ? 'approval-request'
          : input.sentinel === 'BLOCKED'
            ? 'question'
            : input.sentinel === 'FAILED'
              ? 'failure'
              : 'status-update',
```

(`REJECTED` and an ungated `DONE` both fall through to `'status-update'` — a rejection is feedback for a human to read, not a failure or a question requiring an answer.)

The `derivedHints.stage` line (L151-153) needs no change: `input.sentinel === 'DONE' ? 'done' : input.projection.wake.stage` already correctly leaves `REJECTED` on the current stage (only `'DONE'` maps to `'done'`), and Task 3 ensures `sentinel` passed in here is never a gated `DONE` still headed to `'done'` incorrectly — a gated `DONE` genuinely doesn't move to `'done'` from Wake's stage-advancement perspective until approved, which is a pre-existing characteristic of this hint, not something this plan changes.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run -t "kind"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/event-builders.ts
git commit -m "core: derive publish-intent kind from approvalGated instead of AWAITING_APPROVAL sentinel"
```

---

### Task 3: `tick-runner.ts` — remove the AWAITING_APPROVAL coercion, compute `approvalGated`, rewire outcome computation

This is the largest and most load-bearing task — everything else in `tick-runner.ts` (run-record status, `workflowOutcome`, `nextStage` advancement, the `isAwaitingApproval`/`watcherStatus` predicates, and the pr-review watcher-verdict wiring) hangs off the single `sentinel`/`approvalGated` pair computed here.

**Files:**
- Modify: `src/core/tick-runner.ts:97-104` (`TickOutcome` type)
- Modify: `src/core/tick-runner.ts:378-380` (`isAwaitingApproval`)
- Modify: `src/core/tick-runner.ts:1247-1254` (`watcherStatus`)
- Modify: `src/core/tick-runner.ts:2206-2467` (the coercion, `nextStage`, `workflowOutcome`, run-record finalization, `isReviewRejection`, `runCompletedEvent` payload, pr-review audit block at L2239-2296)
- Modify: `src/core/tick-runner.ts:2497-2529` (watcher outbound delivery)
- Test: `test/core/tick-runner.approval.test.ts`
- Test: `test/core/tick-runner.test.ts`

**Interfaces:**
- Consumes: `runnerSentinelSchema`/`RunnerSentinel` (Task 1), `createPublishIntentEvent`'s new `approvalGated` param (Task 2), `workItemStatusForRunOutcome`'s new `approvalGated` param (Task 1).
- Produces: `RUN_COMPLETED_EVENT` payload now carries `approvalGated: boolean` (in addition to `sentinel`) — Task 4 (`projection-updater.ts`) and Task 5 (`policy-engine.ts`) consume this field and the rebuilt `context.status === 'awaiting-approval'` predicate.
- Produces: `isAwaitingApproval(projection: IssueStateRecord): boolean` now reads `projection.context.status === 'awaiting-approval'` instead of `lastRunSentinel`.

- [ ] **Step 1: Write the failing tests**

In `test/core/tick-runner.approval.test.ts`, find the existing test named `'coerces DONE to AWAITING_APPROVAL when runner metadata signals skipApproval=false'` (around L223 per the grep) and replace its body's assertions:

```typescript
it('marks a gated DONE approvalGated without changing the sentinel', async () => {
  // ...existing setup that drives a run with skipApproval: false metadata...
  const result = await tick(/* existing args */);
  expect(result.sentinel).toBe('DONE');
  const events = /* however this test currently reads the appended event log */;
  expect(events).toContain('"sentinel":"DONE"');
  expect(events).toContain('"approvalGated":true');
});
```

Every other fixture in this file that sets `context: { lastRunSentinel: 'AWAITING_APPROVAL', ... }` to mean "this item is currently gated on approval, waiting for a human reply" must change to `context: { lastRunSentinel: 'DONE', status: 'awaiting-approval', ... }` — that's the ~14 remaining `lastRunSentinel: 'AWAITING_APPROVAL'` occurrences the grep found in this file (L466, 541, 627, 700, 784, 865, 964, 1053, 1143, 1260, 1345, 1439, 1533, 1603, 1731, 1930). Apply this exact substitution to each: remove `lastRunSentinel: 'AWAITING_APPROVAL'`, add `lastRunSentinel: 'DONE'` and `status: 'awaiting-approval'` alongside whatever other context fields (e.g. `pendingApprovalAction`) that fixture already sets.

Also update the two assertions that check the outcome of a run that should land in the approval-gated state (around L400-404 and L1209, `'Renamed it and pushed.\nAWAITING_APPROVAL'` fixtures at L1368/L1468 too — those simulate an agent literally emitting the retired sentinel and must become `'Renamed it and pushed.\nDONE'`, asserting on the resulting `approvalGated: true` payload field instead):

```typescript
expect((result as { sentinel?: string }).sentinel).toBe('DONE');
// ...
expect(projection?.context.status).toBe('awaiting-approval');
expect(projection?.context.lastRunSentinel).toBe('DONE');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/core/tick-runner.approval.test.ts`
Expected: FAIL — the coercion and `isAwaitingApproval` still key off the retired sentinel value.

- [ ] **Step 3: Update `TickOutcome`, `isAwaitingApproval`, `watcherStatus`**

`src/core/tick-runner.ts:97-104`:

```typescript
      sentinel?: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
```

`src/core/tick-runner.ts:378-380`:

```typescript
  function isAwaitingApproval(projection: IssueStateRecord): boolean {
    return projection.context.status === 'awaiting-approval';
  }
```

`src/core/tick-runner.ts:1247-1254`:

```typescript
  function watcherStatus(projection: IssueStateRecord): string {
    const sentinel = projection.context.lastRunSentinel;
    if (isAwaitingApproval(projection)) return 'awaiting-approval';
    if (sentinel === 'REJECTED') return 'rejected';
    if (sentinel === 'BLOCKED') return 'blocked';
    if (sentinel === 'FAILED') return 'failed';
    if (sentinel === 'DONE') return 'done';
    return 'pending';
  }
```

- [ ] **Step 4: Replace the coercion with an `approvalGated` computation**

Replace `src/core/tick-runner.ts:2206-2221`:

```typescript
        const parsedRunnerResult = parseRunnerResult(runnerResult.result);
        const sentinel = parsedRunnerResult.status;
        // The approval gate is pure policy, never the agent's word choice —
        // a DONE on a stage configured with skipApproval: false is gated
        // regardless of what the agent wrote (ADR 0002).
        const skipApproval = runnerResult.metadata?.skipApproval;
        const approvalGated = sentinel === 'DONE' && skipApproval === false;
        // A canceled run must not advance the stage regardless of what the
        // runner echoed back — the snapshot it acted on was superseded.
        const nextStage =
          cancellationReason !== null
            ? null
            : approvalGated
              ? null
              : isLateralReadOnlyAction(action, deps.config) && sentinel === 'DONE'
                ? null
                : lifecycle.nextStageFromSentinel(claimedStage, sentinel, workflow);
```

Every later reference to `rawSentinel` in this function (the pr-review audit block's `inputsConsidered.rawSentinel` at L2264, and the `runCompletedEvent` payload's conditional `rawSentinel` field at L2434) is now dead — there is no coercion left to diverge from. Remove both:
- In the audit block's `inputsConsidered` object, delete the `rawSentinel,` line.
- In the `runCompletedEvent` payload, delete `...(rawSentinel !== sentinel ? { rawSentinel } : {}),`.

- [ ] **Step 5: Update the pr-review audit verdict mapping**

Replace `src/core/tick-runner.ts:2266-2275`:

```typescript
            outcome: {
              sentinel,
              verdict:
                prReviewTargetResourceUri === null
                  ? 'uncertain'
                  : sentinel === 'DONE'
                    ? 'approved'
                    : sentinel === 'REJECTED'
                      ? 'changes-requested'
                      : 'uncertain',
              reasoning: parsedRunnerResult.body,
```

- [ ] **Step 6: Update `workflowOutcome` and run-record finalization**

Replace `src/core/tick-runner.ts:2346-2382`:

```typescript
        // Canceled runs don't produce a meaningful workflow outcome; the input
        // they acted on was superseded so the sentinel is not authoritative.
        const workflowOutcome: WorkflowOutcome | undefined =
          cancellationReason !== null
            ? undefined
            : sentinel === 'DONE'
              ? approvalGated
                ? 'AWAITING_APPROVAL'
                : 'DONE'
              : sentinel === 'REJECTED'
                ? 'CHANGES_REQUESTED'
                : sentinel === 'BLOCKED'
                  ? 'BLOCKED'
                  : undefined;

        await transitionRunLifecycle('FINALISING');
        const finalisingRecord = (await deps.stateStore.readRunRecord(runId))!;
        const failureContext =
          sentinel === 'FAILED'
            ? classifyFailedRun({
                projection: candidate,
                record: finalisingRecord,
                failureClass: runnerResult.failureClass ?? 'task',
                ...(workspacePath === undefined ? {} : { workspacePath }),
                envelope: parsedRunnerResult.envelope,
                sentinel,
              })
            : undefined;
        await deps.stateStore.writeRunRecord({
          ...finalisingRecord,
          lifecycle: 'TERMINAL',
          status:
            sentinel === 'DONE'
              ? approvalGated
                ? 'awaiting-approval'
                : 'completed'
              : sentinel === 'REJECTED'
                ? 'rejected'
                : sentinel === 'BLOCKED'
                  ? 'blocked'
                  : 'failed',
          finishedAt,
```

(`sentinel === 'FAILED'` unchanged as the sole `undefined` fallthrough for `workflowOutcome` is a pre-existing gap, not introduced here — leave it as-is; it's out of this plan's scope.)

The run-record `status` field's zod schema (`src/domain/schema.ts:487-494`) needs a `'rejected'` value added — modify it now:

```typescript
    status: z.enum([
      'running',
      'completed',
      'awaiting-approval',
      'rejected',
      'blocked',
      'failed',
      'superseded',
    ]),
```

- [ ] **Step 7: Update `isReviewRejection` and the `runCompletedEvent`/publish-intent payloads**

Replace `src/core/tick-runner.ts:2410-2413`:

```typescript
        const isReviewRejection =
          watcherRun &&
          sentinel === 'REJECTED' &&
          (prReviewTargetResourceUri !== null || watcherSuccessPolicy?.approve === true);
```

In the `runCompletedEvent` payload (around L2430-2467), add `approvalGated` alongside `sentinel`:

```typescript
          payload: {
            action,
            sentinel,
            approvalGated,
            allowAutoApproval: runnerResult.metadata?.allowAutoApproval === true,
```

Update `createPublishIntentEvent`'s call site (around L2482-2495) to pass the new field:

```typescript
        const publishIntent = createPublishIntentEvent({
          projection: candidate,
          runId,
          action,
          runnerResult,
          parsedRunnerResult,
          sentinel,
          approvalGated,
          occurredAt: finishedAt,
```

- [ ] **Step 8: Update the watcher outbound-delivery branches**

Replace `src/core/tick-runner.ts:2501-2529`:

```typescript
          if (
            prReviewTargetResourceUri !== null &&
            (sentinel === 'DONE' || sentinel === 'REJECTED')
          ) {
            await deliverOutboundEvent({
              ...publishIntent,
              sourceRefs: {
                ...publishIntent.sourceRefs,
                resourceUri: prReviewTargetResourceUri,
              },
              payload: {
                ...publishIntent.payload,
                kind: sentinel === 'DONE' ? 'approval-request' : 'status-update',
                body:
                  sentinel === 'DONE'
                    ? `${parsedRunnerResult.body}\n\n${prReviewApprovalMarker}`
                    : `${parsedRunnerResult.body}\n\n<!-- wake:pr-review-changes-requested -->`,
                idempotencyKey: `${runId}:pr-review-verdict-comment`,
              },
            });
          } else if (
            watcherDispatch !== null &&
            watcherSuccessPolicy?.approve === true &&
            (sentinel === 'DONE' ||
              sentinel === 'REJECTED' ||
              sentinel === 'FAILED' ||
              sentinel === 'BLOCKED')
          ) {
            // No PR surface to carry the verdict comment: the child's sentinel
            // is its verdict. Publish the review body for every verdict so the
            // human sees why; only an ungated DONE resolves the parent's
            // pending gate (checked below via isAwaitingApproval).
            await deliverOutboundEvent(publishIntent);
```

(A genuine `FAILED`/`BLOCKED` review with a PR target now correctly produces no direct PR review comment — same as `BLOCKED` already did before this change; only `DONE`/`REJECTED` post a review-verdict comment onto the PR, since only those are actual verdicts.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/core/tick-runner.approval.test.ts test/core/tick-runner.test.ts`
Expected: PASS for cases this task's fixture updates cover. Any remaining failures referencing `changesRequested`/`isReviewRejection` behavior for a `FAILED`/`BLOCKED` watcher run belong to this task too — grep `Grep -n "isReviewRejection\|changesRequested" test/core/tick-runner*.test.ts` and update any fixture that expected a `FAILED` or `BLOCKED` watcher sentinel to fold `changesRequested: true` — it no longer does; only `REJECTED` does. Change those fixtures' sentinel to `REJECTED` if the test's intent was "review rejection," or assert `changesRequested` is absent if the test's intent was genuinely "review failed to execute."

- [ ] **Step 10: Commit**

```bash
git add src/core/tick-runner.ts src/domain/schema.ts test/core/tick-runner.approval.test.ts test/core/tick-runner.test.ts
git commit -m "core: relocate approval gate to policy, replace pr-review FAILED overload with REJECTED"
```

---

### Task 4: `projection-updater.ts` — fold `approvalGated`, `REJECTED`, and legacy `AWAITING_APPROVAL` events

**Files:**
- Modify: `src/core/projection-updater.ts:289-455`
- Test: locate via `Grep -rl "RUN_COMPLETED_EVENT" test/core/` (likely `test/core/projection-updater.test.ts` or folded into `tick-runner.test.ts` — confirm before writing steps)

**Interfaces:**
- Consumes: `RUN_COMPLETED_EVENT` payload's new `approvalGated: boolean` field (Task 3), `rejectedRunnerSentinel` constant (Task 1), `workItemStatusForRunOutcome`'s new `approvalGated` parameter (Task 1).
- Produces: `context.status`/`context.pendingApprovalAction`/`context.lastRunSentinel` folding that never stores the literal string `'AWAITING_APPROVAL'` in `lastRunSentinel` even when replaying a historical event that carries it.

- [ ] **Step 1: Write the failing tests**

Add to the relevant projection-fold test file:

```typescript
it('normalizes a legacy AWAITING_APPROVAL payload sentinel to DONE + approvalGated on replay', async () => {
  const legacyEvent = buildRunCompletedEvent({
    // however this suite constructs a RUN_COMPLETED_EVENT envelope —
    // match the existing helper/fixture pattern in this file
    sentinel: 'AWAITING_APPROVAL',
    action: 'implement',
  });
  const projection = await fold(baseProjection, legacyEvent);
  expect(projection.context.lastRunSentinel).toBe('DONE');
  expect(projection.context.status).toBe('awaiting-approval');
});

it('sets pendingApprovalAction only when approvalGated is true on a DONE', async () => {
  const gatedEvent = buildRunCompletedEvent({
    sentinel: 'DONE',
    approvalGated: true,
    action: 'implement',
  });
  const projection = await fold(baseProjection, gatedEvent);
  expect(projection.context.pendingApprovalAction).toBe('implement');
  expect(projection.context.status).toBe('awaiting-approval');
});

it('folds REJECTED to changes-requested status and does not set blockedFromStage', async () => {
  const rejectedEvent = buildRunCompletedEvent({ sentinel: 'REJECTED', action: 'pr-review' });
  const projection = await fold(baseProjection, rejectedEvent);
  expect(projection.context.status).toBe('changes-requested');
  expect(projection.context.blockedFromStage).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -t "AWAITING_APPROVAL\|approvalGated\|REJECTED"` (adjust the `-t` pattern to match how the suite names these, or run the whole file)
Expected: FAIL.

- [ ] **Step 3: Update the `RUN_COMPLETED_EVENT` payload type and add legacy normalization**

In `src/core/projection-updater.ts`, update the inline payload type (L290-313) — change `sentinel?: string` handling by adding a normalization step immediately after destructuring, before any of the existing logic at L315 onward:

```typescript
    const payload = event.payload as {
      action?: string;
      sentinel?: string;
      approvalGated?: boolean;
      nextStage?: IssueStateRecord['wake']['stage'];
      runId?: string;
      sessionId?: string;
      sessionCli?: string;
      workspacePath?: string;
      reason?: string;
      handledCommentId?: string;
      failureClass?: string;
      failurePhase?: string;
      processStarted?: boolean;
      workspaceChanged?: boolean;
      externalSideEffects?: string;
      retrySafety?: string;
      blockReason?: string;
      executionOutcome?: string;
      workflowOutcome?: string;
      watcherRun?: boolean;
      allowAutoApproval?: boolean;
      changesRequested?: boolean;
      reviewFeedbackBody?: string;
    };

    // A historical event stream may still carry the retired AWAITING_APPROVAL
    // sentinel (pre-ADR-0002). Normalize it here, once, so every branch below
    // and the strict runnerSentinelSchema validation on context.lastRunSentinel
    // only ever see the current four-value vocabulary — replaying an old event
    // stream must still land on the same practical state (approval-gated).
    const isLegacyAwaitingApproval = payload.sentinel === 'AWAITING_APPROVAL';
    const sentinel = isLegacyAwaitingApproval ? 'DONE' : payload.sentinel;
    const approvalGated = payload.approvalGated === true || isLegacyAwaitingApproval;
```

- [ ] **Step 4: Replace every `payload.sentinel`/`'AWAITING_APPROVAL'` reference in the fold body with `sentinel`/`approvalGated`**

Every occurrence below is in the block starting at the current L354 (`if (payload.watcherRun === true) ...`) through L455. Use the local `sentinel`/`approvalGated` constants from Step 3 instead of `payload.sentinel` and the literal `'AWAITING_APPROVAL'`:

```typescript
    const isForwardProgression =
      payload.nextStage !== undefined && payload.nextStage !== current.wake.stage;
    const stageChanged =
      payload.nextStage !== undefined && payload.nextStage !== current.wake.stage;
    const isFailed = sentinel === 'FAILED';
    const isCompletedCustomCommand =
      payload.action !== undefined &&
      sentinel === doneRunnerSentinel &&
      config !== undefined &&
      isCustomCommandAction(payload.action, config);
    const shouldClearSession = isForwardProgression || isFailed;
    const currentFailureCount =
      typeof current.context.failureCount === 'number' &&
      Number.isInteger(current.context.failureCount)
        ? current.context.failureCount
        : 0;
    const nextContext: Record<string, unknown> = {
      ...current.context,
      lastFailureClass: payload.failureClass,
      failureCount:
        payload.failureClass !== undefined
          ? currentFailureCount + 1
          : sentinel === doneRunnerSentinel || sentinel === rejectedRunnerSentinel
            ? 0
            : currentFailureCount,
      ...(payload.handledCommentId === undefined
        ? {}
        : { lastHandledCommentId: payload.handledCommentId }),
      ...(sentinel === undefined || isCompletedCustomCommand ? {} : { lastRunSentinel: sentinel }),
      ...(payload.action === undefined || isCompletedCustomCommand
        ? {}
        : { lastRunAction: payload.action }),
      ...(sentinel === doneRunnerSentinel && payload.action !== undefined && !isCompletedCustomCommand
        ? { lastCompletedAction: payload.action }
        : {}),
      // Remembered so the approval path knows which action to resume or
      // skip when a human posts /approved. Set only for an approval-gated
      // DONE — REJECTED/BLOCKED/FAILED never gate on human sign-off this way.
      ...(sentinel === doneRunnerSentinel && approvalGated && payload.action !== undefined
        ? { pendingApprovalAction: payload.action }
        : {}),
      ...(sentinel === doneRunnerSentinel && approvalGated
        ? { pendingApprovalAllowAutoApproval: payload.allowAutoApproval === true }
        : {}),
      ...(payload.executionOutcome !== undefined
        ? { lastExecutionOutcome: payload.executionOutcome }
        : {}),
      ...(payload.workflowOutcome !== undefined
        ? { lastWorkflowOutcome: payload.workflowOutcome }
        : {}),
      ...(payload.failurePhase !== undefined ? { lastFailurePhase: payload.failurePhase } : {}),
      ...(payload.processStarted !== undefined
        ? { lastProcessStarted: payload.processStarted }
        : {}),
      ...(payload.workspaceChanged !== undefined
        ? { lastWorkspaceChanged: payload.workspaceChanged }
        : {}),
      ...(payload.externalSideEffects !== undefined
        ? { lastExternalSideEffects: payload.externalSideEffects }
        : {}),
      ...(payload.retrySafety !== undefined ? { lastRetrySafety: payload.retrySafety } : {}),
      ...(sentinel === undefined || isCompletedCustomCommand
        ? {}
        : {
            status: workItemStatusForRunOutcome({
              sentinel: sentinel as 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED',
              stage: payload.nextStage ?? current.wake.stage,
              approvalGated,
            }),
          }),
      // A fresh, ungated DONE resolves whatever changes were previously
      // requested — reset the loop counter and stored feedback. A gated DONE
      // is still pending human sign-off, not yet a fresh resolution.
      ...(sentinel === doneRunnerSentinel && !approvalGated
        ? { changesRequestedCount: 0, changesRequestedFeedback: undefined }
        : {}),
    };

    if (sentinel === 'BLOCKED' || sentinel === 'FAILED') {
      nextContext.blockedFromStage = current.wake.stage;
    } else if (sentinel !== undefined) {
      delete nextContext.blockedFromStage;
    }
    if (!(sentinel === doneRunnerSentinel && approvalGated) && !isCompletedCustomCommand) {
      delete nextContext.pendingApprovalAction;
      delete nextContext.pendingApprovalAllowAutoApproval;
    }
```

Import `rejectedRunnerSentinel` alongside the existing `doneRunnerSentinel` import at the top of the file.

Note the `changesRequestedCount`/`changesRequestedFeedback` reset condition changed from `sentinel === doneRunnerSentinel || sentinel === 'AWAITING_APPROVAL'` to `sentinel === doneRunnerSentinel && !approvalGated` — a gated `DONE` (the old `AWAITING_APPROVAL`) previously also reset the counter; that's preserved by checking `approvalGated` is false only resets on an *ungated* completion. Re-examine: the original intent was "any DONE-or-equivalent resets it," including the gated case (since `AWAITING_APPROVAL` was itself already the gated-DONE case and was included). Correct this to match original intent — a gated `DONE` should still reset the counter, same as before:

```typescript
      ...(sentinel === doneRunnerSentinel
        ? { changesRequestedCount: 0, changesRequestedFeedback: undefined }
        : {}),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core` (broad, since this fold function is exercised from multiple test files per the touch-point inventory)
Expected: PASS for this task's new cases. Fixture-level failures elsewhere referencing `AWAITING_APPROVAL` belong to Task 3/6/7 — cross-check against those tasks' file lists before "fixing" a failure that's actually owned by a different task.

- [ ] **Step 6: Commit**

```bash
git add src/core/projection-updater.ts
git commit -m "core: fold approvalGated and REJECTED in projection-updater, normalize legacy AWAITING_APPROVAL events"
```

---

### Task 5: `policy-engine.ts` — unify `isAwaitingApproval`, add `REJECTED` eligibility handling

**Files:**
- Modify: `src/core/policy-engine.ts:1, 35-38, 202-272`
- Test: `test/core/policy-engine.test.ts`

**Interfaces:**
- Consumes: `context.status` (canonical, Task 1/4), `rejectedRunnerSentinel` (Task 1).
- Produces: `isAwaitingApproval(issue: IssueStateRecord): boolean` (module-private, now `context.status === 'awaiting-approval'`) — used by `resolveApprovalTransition`, `resolveChangesRequestedAction`, `resolveNextEligibleAction`, `isEligible`, unaffected in call shape.

- [ ] **Step 1: Write the failing tests**

Add to `test/core/policy-engine.test.ts` near the existing `isEligible`/`isAwaitingApproval`-adjacent cases (search `Grep -n "isAwaitingApproval\|lastRunSentinel: 'AWAITING_APPROVAL'" test/core/policy-engine.test.ts` first to find where the 15 existing occurrences live and match their fixture style):

```typescript
it('treats a REJECTED run as ineligible for immediate retry, same as BLOCKED', () => {
  const issue = buildIssue({ context: { lastRunSentinel: 'REJECTED' } });
  expect(policyEngine.isEligible(issue, config)).toBe(false);
});

it('does not treat lastRunSentinel DONE without status awaiting-approval as gated', () => {
  const issue = buildIssue({ context: { lastRunSentinel: 'DONE' } });
  expect(policyEngine.resolveApprovalTransition(issue)).toBeNull();
});

it('treats status awaiting-approval as gated regardless of lastRunSentinel wording', () => {
  const issue = buildIssue({
    context: { lastRunSentinel: 'DONE', status: 'awaiting-approval', pendingApprovalAction: 'implement' },
  });
  expect(policyEngine.resolveApprovalTransition(issue)).not.toBeNull();
});
```

Update every existing fixture in this file using `lastRunSentinel: 'AWAITING_APPROVAL'` to mean "gated" (the 15 occurrences the touch-point inventory found) to `lastRunSentinel: 'DONE', status: 'awaiting-approval'` instead, same substitution pattern as Task 3 Step 1.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `policy-engine.ts`**

`src/core/policy-engine.ts:1`:

```typescript
import { failedRunnerSentinel, rejectedRunnerSentinel } from '../domain/stages.js';
```

`src/core/policy-engine.ts:35-38`:

```typescript
function isAwaitingApproval(issue: IssueStateRecord): boolean {
  const context = issue.context as Record<string, unknown>;
  return context.status === 'awaiting-approval';
}
```

`src/core/policy-engine.ts:202-230` — add a `REJECTED` branch alongside the existing `BLOCKED` one (a rejected run isn't retried the way a `FAILED` run is; it's resolved via the changes-requested action path, same as `BLOCKED` isn't retried but resolved via the blocked-resume path):

```typescript
      if (lastRunSentinel === 'REJECTED') {
        return false;
      }

      if (lastRunSentinel === 'BLOCKED') {
        return false;
      }
```

`chooseRetryActionAfterHumanReply` (`src/core/policy-engine.ts:237-272`) is intentionally left untouched — a `REJECTED` verdict resolves via `resolveChangesRequestedAction`/the `changes-requested` work-item status path (Task 4's fold already routes it there), not via this function's `blockedFromStage`-resume mechanism, which stays scoped to genuine `BLOCKED`/`FAILED`. Confirm this with a test rather than editing the function:

```typescript
it('does not route REJECTED through the BLOCKED/FAILED human-reply retry path', () => {
  const issue = buildIssue({ context: { lastRunSentinel: 'REJECTED', blockedFromStage: 'implement' } });
  expect(policyEngine.chooseRetryActionAfterHumanReply(issue, workflow)).toBeNull();
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/policy-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/policy-engine.ts test/core/policy-engine.test.ts
git commit -m "core: unify isAwaitingApproval on context.status, add REJECTED eligibility handling"
```

---

### Task 6: Secondary consumers — `ui-data.ts`, `work-item-labels.ts`

**Files:**
- Modify: `src/adapters/http/ui-data.ts:49-92` (`deriveCondition`)
- Modify: `src/domain/work-item-labels.ts` — no functional change required; verify only (see Step 3)
- Test: `test/adapters/ui-data.test.ts`
- Test: `test/domain/work-item-labels.test.ts`

**Interfaces:**
- Consumes: run-record `sentinel`/`status` fields (Task 3's new `'rejected'` run-record status value), `context.status` (Task 1/4/5).

- [ ] **Step 1: Write the failing test**

Add to `test/adapters/ui-data.test.ts` (find the existing `deriveCondition`-adjacent cases via `Grep -n "AWAITING_APPROVAL\|deriveCondition" test/adapters/ui-data.test.ts`):

```typescript
it('surfaces needs-human for a run-record status of awaiting-approval', () => {
  const item = buildItem({ context: { status: 'awaiting-approval' } });
  const lastRun = buildRunRecord({ status: 'awaiting-approval', sentinel: 'DONE' });
  expect(deriveCondition(item, lastRun, config).condition).toBe('needs-human');
});

it('does not surface error for a REJECTED run', () => {
  const item = buildItem({ context: { status: 'changes-requested' } });
  const lastRun = buildRunRecord({ status: 'rejected', sentinel: 'REJECTED' });
  const result = deriveCondition(item, lastRun, config);
  expect(result.condition).not.toBe('error');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/adapters/ui-data.test.ts`
Expected: FAIL if the existing 3 `AWAITING_APPROVAL`-matching assertions in this file (per the touch-point inventory) still reference the retired literal — otherwise the new cases alone should already pass once Task 3's run-record `'rejected'` status exists, but write them first regardless per TDD.

- [ ] **Step 3: Update `deriveCondition`**

Replace `src/adapters/http/ui-data.ts:68-75`:

```typescript
  if (
    lastRun?.status === 'blocked' ||
    lastRun?.status === 'awaiting-approval' ||
    lastRun?.sentinel === 'BLOCKED'
  ) {
    return { condition: 'needs-human', reason: `sentinel ${lastRun?.sentinel ?? stage}` };
  }
```

(The `lastRun?.sentinel === 'AWAITING_APPROVAL'` disjunct is deleted outright — that value can never occur on a run record produced after Task 3, and `lastRun?.status === 'awaiting-approval'` already covers the same condition via the run-record `status` field, which Task 3 already sets correctly for a gated `DONE`.)

`lastRun?.sentinel === 'FAILED'` at L83-85 needs no change — `REJECTED` correctly does not fall into that branch, since it isn't a failure; it falls through to the final `'ready'` condition (or whatever condition a `'rejected'`-status run-record should read as — confirm with the test in Step 1 that it isn't `'error'`; if product intent is that a rejected review should itself read as `needs-human` too since a corrective action needs a human to eventually notice, add that as an explicit branch instead of relying on fallthrough — check with whoever owns the UI board copy before deciding; default to leaving it as the `'ready'` fallthrough since `REJECTED` has a known automatic corrective next step per ADR 0002, not a human-blocking one).

Verify `work-item-labels.ts`'s `legacyStatusFallback` (`src/domain/work-item-labels.ts:39-51`) needs no edit: it reads `projection.context.lastRunSentinel` as a loosely-typed field (not validated against `runnerSentinelSchema` at that call site), so its `sentinel === 'AWAITING_APPROVAL'` branch remains harmless dead-data tolerance for any on-disk projection that hasn't been rebuilt since before this plan — Task 4's fold normalization means freshly-folded projections will never produce that value again, but this fallback intentionally stays permissive for stale, not-yet-rebuilt state. Add one test confirming it still works for both the legacy and new shapes:

```typescript
it('still treats an unrebuilt legacy AWAITING_APPROVAL projection as awaiting-approval', () => {
  const projection = buildProjection({ context: { lastRunSentinel: 'AWAITING_APPROVAL' } });
  expect(legacyStatusFallback(projection)).toBe('awaiting-approval'); // exported for this test, or test via labelsForWorkItem's public surface if not exported
});
```

(If `legacyStatusFallback` isn't exported, test this indirectly through `labelsForWorkItem`'s existing public surface instead — check the file before writing this step for real.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/ui-data.test.ts test/domain/work-item-labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/http/ui-data.ts test/adapters/ui-data.test.ts test/domain/work-item-labels.test.ts
git commit -m "adapters: drop retired AWAITING_APPROVAL sentinel check from board condition derivation"
```

---

### Task 7: Prompt harness — `stage-prompt.ts`, `claude-runner.ts`

**Files:**
- Modify: `src/adapters/runner/stage-prompt.ts:125-220`
- Modify: `src/adapters/claude/claude-runner.ts:7, 189`
- Test: `test/adapters/claude-runner.test.ts`
- Test: locate `stage-prompt.ts`'s own test file via `Grep -rl "sentinelListForApproval\|sentinelInstructionsForApproval" test/`

**Interfaces:**
- Produces: `sentinelListForApproval(reviewShaped: boolean): string` — signature changes from taking `skipApproval` to taking whether the stage is evaluative (needs `REJECTED` in its vocabulary). Returns `'DONE, REJECTED, BLOCKED, FAILED'` or `'DONE, BLOCKED, FAILED'`.
- Produces: `sentinelInstructionsForApproval(reviewShaped: boolean): string` — same parameter change; the `AWAITING_APPROVAL` instruction line is deleted entirely.

- [ ] **Step 1: Write the failing tests**

Locate `stage-prompt.ts`'s test file and existing cases covering `sentinelListForApproval`/`sentinelInstructionsForApproval` (grep first), then add:

```typescript
it('lists DONE, BLOCKED, FAILED for a non-evaluative stage regardless of skipApproval', () => {
  expect(sentinelListForApproval(false)).toBe('DONE, BLOCKED, FAILED');
});

it('lists REJECTED for an evaluative (review-shaped) stage', () => {
  expect(sentinelListForApproval(true)).toBe('DONE, REJECTED, BLOCKED, FAILED');
});

it('never mentions AWAITING_APPROVAL in sentinel instructions', () => {
  expect(sentinelInstructionsForApproval(false)).not.toContain('AWAITING_APPROVAL');
  expect(sentinelInstructionsForApproval(true)).not.toContain('AWAITING_APPROVAL');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -t "sentinelListForApproval\|sentinelInstructionsForApproval"`
Expected: FAIL — current signature takes `skipApproval` and still emits `AWAITING_APPROVAL`.

- [ ] **Step 3: Update `stage-prompt.ts`**

Replace `src/adapters/runner/stage-prompt.ts:129-147`:

```typescript
export function sentinelListForApproval(reviewShaped: boolean): string {
  return reviewShaped ? 'DONE, REJECTED, BLOCKED, FAILED' : 'DONE, BLOCKED, FAILED';
}

function sentinelInstructionsForApproval(reviewShaped: boolean): string {
  const lines = [
    '- DONE: the stage objective is complete.',
    ...(reviewShaped
      ? [
          '- REJECTED: you evaluated the target and it does not meet the bar — explain what needs to change. Wake routes this back to a corrective stage; you do not need to ask a human what to do next.',
        ]
      : []),
    '- BLOCKED: you need clarification from a human or cannot proceed safely.',
    '- FAILED: something prevented you from completing this stage at all.',
  ];
  return lines.join('\n');
}
```

Find every call site of these two functions within `buildHarnessPrompt` (currently passing `skipApproval`) and update them to pass whatever boolean the stage template already exposes to mean "this stage renders a verdict on an external artifact" — check the existing `StagePromptResult`/template frontmatter for a field that already distinguishes this (e.g. a `reviewShaped`/`evaluative` frontmatter key may not yet exist). If no such field exists, add one: a new optional prompt-template frontmatter key, e.g. `sentinelVocabulary: 'review' | 'default'` (default `'default'`), read the same way `skipApproval`/`maxTurns` frontmatter is already parsed in this file (mirror that parsing helper's pattern exactly — locate it via `Grep -n "frontmatter\." src/adapters/runner/stage-prompt.ts`). Set `sentinelVocabulary: review` in `prompts/pr-review.md` and `prompts/plan-review.md`'s frontmatter in Task 8.

Remove `skipApproval`'s involvement in prompt vocabulary text entirely — it is no longer read anywhere in `stage-prompt.ts` for this purpose. Confirm `skipApproval` is still threaded through to `runnerResult.metadata` (consumed by Task 3's `approvalGated` computation in `tick-runner.ts`) — that plumbing is unrelated to prompt text and must NOT be removed; only its use inside `sentinelListForApproval`/`sentinelInstructionsForApproval` goes away.

- [ ] **Step 4: Update `claude-runner.ts`**

`src/adapters/claude/claude-runner.ts:189` currently calls `sentinelListForApproval(skipApproval)` for the resume/continuation nudge text. Update the call site to pass the same `reviewShaped`/`sentinelVocabulary`-derived boolean used in Step 3, threaded through however this file already has access to the stage's prompt metadata (check what's in scope at L189 — likely already has the parsed template's frontmatter available; use it the same way).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/adapters/claude-runner.test.ts` plus `stage-prompt.ts`'s test file
Expected: PASS. Update the 8 `AWAITING_APPROVAL` occurrences the touch-point inventory found in `test/adapters/claude-runner.test.ts` — grep them first (`Grep -n "AWAITING_APPROVAL" test/adapters/claude-runner.test.ts`) and replace fixtures/assertions expecting that literal in prompt text with the `REJECTED`-inclusive or plain `DONE, BLOCKED, FAILED` list depending on whether that test's stage is review-shaped.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/runner/stage-prompt.ts src/adapters/claude/claude-runner.ts test/adapters/claude-runner.test.ts
git commit -m "adapters: drop AWAITING_APPROVAL from agent-facing prompt vocabulary, add REJECTED for review-shaped stages"
```

---

### Task 8: Prompt content — `prompts/pr-review.md`, `prompts/plan-review.md`

**Files:**
- Modify: `prompts/pr-review.md` (frontmatter + L29-32 verdict mapping)
- Modify: `prompts/plan-review.md` (frontmatter + L31-46 verdict mapping/envelope example)

**Interfaces:**
- Consumes: the new `sentinelVocabulary: 'review'` frontmatter key from Task 7.

- [ ] **Step 1: Update `prompts/pr-review.md`**

Add `sentinelVocabulary: review` to the frontmatter block (alongside `skipApproval: true`). Replace the verdict mapping (currently L29-32):

```markdown
Verdict mapping:
- Use `DONE` only when you are confident the PR is safe to merge.
- Use `REJECTED` when the PR needs changes; explain the required changes clearly. Wake will route this back to the author automatically — you do not need to ask what happens next.
- Use `BLOCKED` when you cannot determine a safe verdict (e.g. you can't find exactly one plausible PR for this work item).
- Use `FAILED` only when something prevented you from completing the review itself (e.g. no GitHub access, the diff couldn't be retrieved) — not when the PR's contents are the problem.
```

- [ ] **Step 2: Update `prompts/plan-review.md`**

Add `sentinelVocabulary: review` to its frontmatter. Replace its verdict mapping (currently L31-34) with the same pattern as pr-review.md's above, substituting "the plan" for "the PR" throughout. Update the envelope example (currently L36-46) so the `{ "status": "REJECTED" }` example (and the "substituting FAILED or BLOCKED" prose) reflects the new four-value vocabulary, not the old FAILED-as-rejection framing.

- [ ] **Step 3: Manually verify the prompt renders as expected**

Run: `npm run tick` against a fake-ticketing fixture that exercises `pr-review` (check `.wake/` fixtures under this repo's own dev Wake home, or `npm run smoke:claude` if that's the faster path to confirm the harness prompt assembles without error) — this is prompt-text only, no automated test exists for prose content; confirm by eye that `sentinelListForApproval(true)` output (`'DONE, REJECTED, BLOCKED, FAILED'`) appears correctly substituted into the assembled prompt.

- [ ] **Step 4: Commit**

```bash
git add prompts/pr-review.md prompts/plan-review.md
git commit -m "prompts: fix pr-review/plan-review verdict mapping to use REJECTED instead of FAILED"
```

---

### Task 9: Docs — `docs/configuration.md`, `docs/workflows.md`, `docs/prompts.md`

**Files:**
- Modify: `docs/configuration.md:451-497, 675-685`
- Modify: `docs/workflows.md:162-164, 166-215`
- Modify: `docs/prompts.md:47-59`

**Interfaces:** None — documentation only, describing current-state behavior per `CLAUDE.md`'s documentation requirements (no "used to"/"previously" prose).

- [ ] **Step 1: Update `docs/workflows.md`**

Replace the passage at L162-164 (or nearest current line — re-locate via `Grep -n "AWAITING_APPROVAL" docs/workflows.md` since line numbers may have drifted since the inventory was taken):

```markdown
When a runner reports `DONE`, Wake follows the stage's `onDone` transition — unless the stage is configured with `skipApproval: false`, in which case Wake waits for a human approval before advancing. If the runner reports `BLOCKED`, `FAILED`, or `REJECTED`, Wake does not take the `onDone` transition automatically.
```

Replace the stage-watcher passage (L166-215's relevant lines):

```markdown
the watched child workflow run completes `DONE` or `REJECTED` — the sentinel is the child's verdict, so a `BLOCKED` or `FAILED` child never triggers it. A child `REJECTED` verdict posts the review body as feedback without approving.
```

- [ ] **Step 2: Update `docs/configuration.md`**

Apply the same `DONE`/`REJECTED`/`BLOCKED`/`FAILED` wording fix to the `### stages` watch/onSuccess passage at L451-497. Replace the `AWAITING_APPROVAL` mention at L675-685:

```markdown
`wake:auto` is an operator opt-in label for deterministic approval of eligible approval-gated stages (stages configured with `skipApproval: false` whose run completed `DONE`).
```

- [ ] **Step 3: Update `docs/prompts.md`**

Replace the passage at L47-59:

```markdown
`skipApproval: true` means the prompt may complete with `DONE` and Wake advances immediately. When `skipApproval: false`, a `DONE` completion is held for human approval before Wake advances — the agent still reports `DONE`; Wake applies the gate itself, the agent is never asked to report a different sentinel for this. `allowAutoApproval: true` applies only to prompts that still require an approval gate (`skipApproval: false`): when a `DONE` run on such a prompt completes, Wake records the pending action as eligible for deterministic auto-approval.
```

- [ ] **Step 4: Verify no other doc references the retired term**

Run: `Grep -rn "AWAITING_APPROVAL" docs/ README.md` (excluding `docs/adrs/`, `docs/handoffs/`, `docs/plans/`, `docs/reports/`, `docs/vision-inputs/`, `docs/superpowers/` per `CLAUDE.md`'s historical-record carve-out)
Expected: no matches outside those excluded directories.

- [ ] **Step 5: Commit**

```bash
git add docs/configuration.md docs/workflows.md docs/prompts.md
git commit -m "docs: describe the approval gate as policy-derived, not an agent-emitted AWAITING_APPROVAL sentinel"
```

---

### Task 10: Full verification pass

**Files:** None — verification only.

- [ ] **Step 1: Run the full verify pipeline**

Run: `npm run verify`
Expected: lint, format:check, build, and test all pass. Per `CLAUDE.md`, ignore any `format:check` CRLF false positives on files this plan did not touch; for every file this plan did touch, confirm `npx prettier --check <file>` is clean.

- [ ] **Step 2: Grep for any remaining stray literal references**

Run: `Grep -rn "AWAITING_APPROVAL" src/ test/ prompts/` (this should now only match `docs/adrs/0002-agent-sentinel-outcome-model.md` if any docs grep is included, and legitimate legacy-tolerance code — `work-item-labels.ts`'s `legacyStatusFallback` and `projection-updater.ts`'s normalization step from Task 4)
Expected: every remaining match is one of those two intentional legacy-compatibility sites; anything else is a missed call site from an earlier task — fix it and re-run `npm run verify`.

- [ ] **Step 3: Confirm no task left a TODO/placeholder**

Run: `Grep -rn "TODO\|FIXME" src/domain/stages.ts src/domain/schema.ts src/domain/workflows.ts src/domain/work-item-status.ts src/core/tick-runner.ts src/core/projection-updater.ts src/core/policy-engine.ts src/core/event-builders.ts src/adapters/http/ui-data.ts src/adapters/runner/stage-prompt.ts src/adapters/claude/claude-runner.ts`
Expected: no new matches introduced by this plan.
