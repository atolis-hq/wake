# Watch Trigger Race Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the watch-reactor race where a `while: {statuses: [waiting]}` watch can permanently miss its trigger because the upstream fact it currently listens for (`execution.run-succeeded`) can be journaled — and consumed by the checkpoint-based reactor — before a *later* tick's Advancement actually writes the orchestration state transition (`orchestration.signal-wait-started`) that the watch's `while` condition needs.

**Architecture:** Retarget the two production watch-gate patterns (`plan-review`, `pr-review` style: `while: {statuses: [waiting]}` paired with `watchGates`) to trigger off `orchestration.signal-wait-started` instead of `execution.run-succeeded`. That event is written atomically, in the same append, as the state transition it represents — there is no possible interleaving where the event exists but the state doesn't yet reflect it. This also lets the reactor's cross-instance correlation become simpler and more precise: an orchestration event is already stream-scoped to its owning WorkflowInstance (`event.stream.id`), so `watch-reactor.ts` gets a new, synchronous resolver for this case instead of relying only on the existing async run-repository lookup (`resolveRunWorkflowInstanceId`), which stays as the fallback for genuinely external, non-orchestration triggering events (e.g. `pr.checks-changed`).

**Tech Stack:** TypeScript, Vitest, Zod (config schema), the existing event-sourced journal/checkpoint/reactor pattern in `src/orchestration` and `src/persistence`.

**Spec:** No separate design doc — the spec is this plan plus the current module contract at `src/orchestration/domain/child-workflow-policy.spec.md` (section "Reacting to a Watch match", updated by Task 2) and `docs/workflows.md` (updated by Task 3).

## Global Constraints

- Do not touch `src/orchestration/application/advance-workflow.ts`'s outcome-acceptance sequencing — it already appends `activity-outcome-accepted` and `signal-wait-started` atomically in one call; nothing there needs to change.
- Do not implement the reconciliation/self-healing sweep discussed separately — it is out of scope for this plan and will be filed as its own GitHub issue after this work lands (not a task here).
- `canonicalEventName` in `src/orchestration/contracts/config.ts` already accepts any dotted lowercase event name (`z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)`) — no schema change is needed to allow `orchestration.signal-wait-started` in `watches[].on.events`.
- Follow CLAUDE.md: keep concrete decisions in domain/application files, decode persisted events before folding, compare closed concepts through exported vocabulary (`OrchestrationEventType.SignalWaitStarted`, not a raw string literal, in source — the raw string is fine in YAML config and prose).
- Do not touch `docs/superpowers/` design/plan history other than this new plan file — only `docs/workflows.md` and the one module spec file are current-state docs in scope.

---

## File Structure

- Modify: `src/orchestration/application/watch-reactor.ts` — add a synchronous stream-based resolver for orchestration-namespace triggering events, used ahead of the existing async run-lookup resolver.
- Modify: `test/unit/orchestration/watch-reactor.test.ts` — unit test proving the new resolver scopes an `orchestration.signal-wait-started` event to its own stream's WorkflowInstance and not to an unrelated match.
- Modify: `src/orchestration/domain/child-workflow-policy.spec.md` — update the "Reacting to a Watch match" section to describe the dual resolver (run-lifecycle facts via run lookup, orchestration-stream events via direct stream correlation).
- Modify: `docs/workflows.md` — retarget the `pr-review` watch-gate example to `orchestration.signal-wait-started` and add guidance on which trigger event to use for which watch shape.
- Modify: `test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts` — retarget the scenario's watch config to the new event and adapt the proof (a sibling instance independently entering the same `while` state must not spuriously trigger another instance's watch) to fit the new trigger, since the old "child's own retry re-emits run-succeeded" premise no longer applies once the trigger is `signal-wait-started`.
- Modify: `test/unit/orchestration/approval-authority.test.ts` — update the `reviewWatch` fixture's `on.events` for consistency with the real production pattern (low risk; this fixture doesn't exercise reactor dispatch, only approval-authority computation).

---

## Task 1: Add a stream-based trigger resolver to the watch reactor

**Files:**
- Modify: `src/orchestration/application/watch-reactor.ts`
- Test: `test/unit/orchestration/watch-reactor.test.ts`

**Interfaces:**
- Consumes: `isWorkflowInstanceStream` (already exported from `src/orchestration/contracts/streams.ts`), `workflowInstanceId` (already imported in this file from `../contracts/identifiers.js`).
- Produces: `resolveTriggerWorkflowInstanceId(event, runs)` replaces the direct call site of `resolveRunWorkflowInstanceId` inside `react()`. `resolveRunWorkflowInstanceId` itself is unchanged and kept as the fallback.

- [ ] **Step 1: Write the failing unit test**

Add this test to `test/unit/orchestration/watch-reactor.test.ts` (append after the existing `'does not inspect an unrelated domain payload for causal metadata'` test, keeping the same file's existing imports — it already imports `workflowInstanceStream` and `workflowInstanceId` from `'../../../src/orchestration/index.js'`):

```ts
it('scopes an orchestration state-transition event to its own stream, not an unrelated match', async () => {
  const requested: string[] = [];
  const reactor = createWatchReactor({
    async listWatchMatches() {
      return [
        {
          parent: { workflowInstanceId: workflowInstanceId('primary:work-a') },
          watch: { id: 'plan-review', workflow: workflowName('plan-review'), maxPerGroup: 1 },
        },
        {
          parent: { workflowInstanceId: workflowInstanceId('primary:work-b') },
          watch: { id: 'plan-review', workflow: workflowName('plan-review'), maxPerGroup: 1 },
        },
      ];
    },
    async requestChild(request) {
      requested.push(request.parentWorkflowInstanceId);
      return {};
    },
    async rejectCausalActivation() {
      throw new Error('must not reject; the unrelated match should simply be skipped');
    },
  });

  await reactor.react(
    canonicalEvent(
      OrchestrationEventType.SignalWaitStarted,
      'signal-wait-a',
      { signalKind: 'orchestration.watch-gate-verdict', from: [{ kind: 'watch', watch: 'plan-review' }] },
      workflowInstanceStream(workflowInstanceId('primary:work-a')),
    ),
    {
      commandId: 'react-signal-wait-a',
      correlationId: 'corr-1' as never,
      occurredAt: '2026-08-14T20:07:41.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );

  expect(requested).toEqual(['primary:work-a']);
});
```

This needs `workflowName` in scope — the file already imports it from `'../../../src/orchestration/contracts/identifiers.js'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/orchestration/watch-reactor.test.ts -t "scopes an orchestration state-transition event"`
Expected: FAIL — `requested` will be `['primary:work-a', 'primary:work-b']` (both matches fire) because `react()` currently only resolves a source instance id for run-lifecycle events; an orchestration event resolves to `undefined`, so the `sourceWorkflowInstanceId !== undefined` guard never filters anything for it.

- [ ] **Step 3: Implement the resolver**

In `src/orchestration/application/watch-reactor.ts`:

1. Add the import (alongside the existing `../contracts/identifiers.js` import block):

```ts
import { isWorkflowInstanceStream } from '../contracts/streams.js';
```

2. Replace the call site inside `react()`:

```ts
      const causalCycle = orchestrationCausalCycleId(selectOrchestrationEvent(event));
      const sourceWorkflowInstanceId = await resolveRunWorkflowInstanceId(event, runs);
```

with:

```ts
      const causalCycle = orchestrationCausalCycleId(selectOrchestrationEvent(event));
      const sourceWorkflowInstanceId = await resolveTriggerWorkflowInstanceId(event, runs);
```

3. Add the new resolver directly above `resolveRunWorkflowInstanceId`, and update that function's doc comment to describe the split:

```ts
/**
 * A run-lifecycle event (e.g. `execution.run-succeeded`) fires for every run
 * in the system, including a watch's own spawned child re-running its own
 * activity on retry. An orchestration event, by contrast, is already scoped
 * to its owning WorkflowInstance via its own stream, so it needs no lookup —
 * only run-lifecycle events fall through to the async resolver below.
 * Without either scoping, `listWatchMatches` would treat any currently-
 * eligible parent's declared event type as a match regardless of which
 * instance actually produced the triggering event, causing an unrelated
 * WorkflowInstance's own retry or state transition to spuriously re-trigger
 * a different instance's Watch.
 */
async function resolveTriggerWorkflowInstanceId(
  event: PersistedEvent,
  runs: Pick<RunRepository, 'load'> | undefined,
): Promise<string | undefined> {
  if (isWorkflowInstanceStream(event.stream)) return event.stream.id;
  return resolveRunWorkflowInstanceId(event, runs);
}

async function resolveRunWorkflowInstanceId(
  event: PersistedEvent,
  runs: Pick<RunRepository, 'load'> | undefined,
): Promise<string | undefined> {
  if (runs === undefined) return undefined;
  const runEvent = selectRunExecutionEvent(event);
  if (runEvent === null) return undefined;
  const run = (await runs.load(runEvent.stream.id)).view;
  return run?.workflowInstanceId;
}
```

(The body of `resolveRunWorkflowInstanceId` itself is unchanged — only its doc comment moves to the new wrapper above it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/orchestration/watch-reactor.test.ts`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/application/watch-reactor.ts test/unit/orchestration/watch-reactor.test.ts
git commit -m "fix: scope watch triggers from orchestration events by their own stream"
```

---

## Task 2: Update the child-workflow-policy module spec

**Files:**
- Modify: `src/orchestration/domain/child-workflow-policy.spec.md`

**Interfaces:**
- Consumes: nothing new — this is prose only, describing the behavior Task 1 implemented.

- [ ] **Step 1: Update the "Reacting to a Watch match" section**

In `src/orchestration/domain/child-workflow-policy.spec.md`, replace the paragraph at lines 82–93 (starting "When the triggering event is a run-lifecycle fact...") with:

```markdown
- When the triggering event is itself scoped to a single WorkflowInstance —
  either an orchestration event on that instance's own stream (e.g.
  `orchestration.signal-wait-started`), or a run-lifecycle fact (e.g.
  `execution.run-succeeded`) — the reactor resolves that event's own owning
  WorkflowInstance id and discards any (parent, Watch) match whose parent is
  not that instance. An orchestration event's owning instance is read
  directly from its stream; a run-lifecycle event's owning instance requires
  resolving the run's own WorkflowInstance id first, because a run-lifecycle
  event fires for every run in the system, including one belonging to a
  Watch's own already-started child re-running its own Activity on retry.
  Without this scoping, any currently-eligible parent's declared event type
  would match regardless of which instance actually produced the triggering
  event, spuriously re-triggering the Watch. A triggering event that is
  neither orchestration-stream-scoped nor a run-lifecycle fact (e.g.
  `pr.checks-changed`) is not scoped this way.
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestration/domain/child-workflow-policy.spec.md
git commit -m "docs: sync child-workflow-policy spec with the dual trigger resolver"
```

---

## Task 3: Update workflow configuration documentation

**Files:**
- Modify: `docs/workflows.md`

**Interfaces:**
- Consumes: nothing — prose and YAML example only.

- [ ] **Step 1: Retarget the watch-gate example and add guidance**

In `docs/workflows.md`, in the "Watches and watch gates" section, change the example's trigger event (currently `on: { events: [execution.run-succeeded] }` at line 311) to:

```yaml
        on: { events: [orchestration.signal-wait-started] }
```

Then add this paragraph directly after the code block (before the "### Repair a newly failing CI check" heading):

```markdown
Use `orchestration.signal-wait-started` as the trigger whenever a watch's
`while.statuses` includes `waiting` and the watch exists to gate a
`watchGates` wait — that event is written atomically with the state
transition it represents, so the watch can never observe a stage/status
match that hasn't actually happened yet. Reserve a raw domain fact (like
`execution.run-succeeded` or `pr.checks-changed`) for a watch whose
`while.statuses` includes `active` and that is reacting to something
genuinely external to this instance's own advancement — see the failing-CI
example below, which watches `pr.checks-changed` while the stage is still
`active`, not waiting on a gate at all.
```

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `npx prettier --check docs/workflows.md` (or open the diff and read it — this is prose, no automated test covers it, but keep the format check green if the repo runs prettier over Markdown; if `npm run format:check` doesn't cover `docs/`, skip this and just proofread the diff.)

- [ ] **Step 3: Commit**

```bash
git add docs/workflows.md
git commit -m "docs: guide watch-gate configs to trigger off the wait-state transition"
```

---

## Task 4: Retarget and adapt the watch-scoping E2E test

**Files:**
- Modify: `test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts`

**Interfaces:**
- Consumes: `world.configureWorkflow`, `world.createWork`, `world.startWorkflow`, `world.advance`, `world.events`, `world.viewWorkflow`, `world.orchestration.listAll`, `world.acceptSignal` — all existing `TestWorld` methods already used by this file; no new test-support surface needed.

The existing scenario proves scoping via a watch child's own activity retry re-emitting `execution.run-succeeded`. That premise no longer applies once the trigger is `orchestration.signal-wait-started`, because an activity-level retry (`retry: { max: 1 }`) does not itself emit a new `signal-wait-started` — only entering a signal wait does. Replace it with a scenario proving the same underlying property (one instance's own trigger event does not spuriously dispatch another instance's watch) using two independent sibling WorkItems that both become eligible for the same watch around the same time.

- [ ] **Step 1: Replace the scenario body**

Replace the full contents of `test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts` with:

```ts
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { watchId, workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { WatchGateVerdictSignal } from '../../../src/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-004',
    title: "one WorkflowInstance's own wait-state transition does not re-trigger a sibling's watch",
    given: [
      "a watchGate whose watch subscribes to 'orchestration.signal-wait-started' (the real " +
        'production trigger, not a synthetic test-only event name), declared on a workflow ' +
        'shared by two independent, unrelated WorkItems',
    ],
    when: [
      'both sibling instances independently reach the same watched stage and enter waiting ' +
        'around the same time, each producing its own signal-wait-started event',
    ],
    then: [
      'each sibling gets exactly its own child requested for its own trigger — one signal-wait ' +
        "-started event never spawns a watch child for the other, unrelated instance — and both " +
        'parents advance past the gate once their own child resolves it',
    ],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('work'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
    world.registerActivity({
      name: activityName('review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
    world.configureWorkflow('review', {
      stages: {
        check: {
          activity: 'review',
          with: {},
          on: { done: { then: 'done' } },
        },
      },
    });
    world.configureWorkflow('parent', {
      stages: {
        work: {
          activity: 'work',
          with: {},
          on: { done: { then: 'done', watchGates: ['review'] } },
        },
      },
      watches: [
        {
          id: 'review',
          while: { stages: ['work'], statuses: ['waiting'] },
          on: { events: ['orchestration.signal-wait-started'] },
          workflow: 'review',
          maxPerGroup: 1,
        },
      ],
    });

    const workA = await world.createWork({ objective: 'prove watch trigger scoping (a)' });
    const workB = await world.createWork({ objective: 'prove watch trigger scoping (b)' });
    const parentA = await world.startWorkflow({
      workItemId: workA.workItemId,
      workflowName: workflowName('parent'),
    });
    const parentB = await world.startWorkflow({
      workItemId: workB.workItemId,
      workflowName: workflowName('parent'),
    });

    await world.advance(workA.workItemId);
    await world.advance(workB.workItemId);
    await world.advance(workA.workItemId);
    await world.advance(workB.workItemId);

    const requests = await world.events('orchestration.child-requested');
    const budgetExhausted = await world.events('orchestration.group-budget-exhausted');
    expect(requests).toHaveLength(2);
    expect(budgetExhausted).toHaveLength(0);

    const childA = (await world.orchestration.listAll()).find(
      (workflow) => workflow.parentWorkflowInstanceId === parentA.workflowInstanceId,
    );
    const childB = (await world.orchestration.listAll()).find(
      (workflow) => workflow.parentWorkflowInstanceId === parentB.workflowInstanceId,
    );
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();
    expect(childA?.workflowInstanceId).not.toBe(childB?.workflowInstanceId);

    for (const parent of [parentA, parentB]) {
      await world.acceptSignal(parent.workflowInstanceId, {
        kind: WatchGateVerdictSignal,
        outcome: 'done',
        authority: { kind: 'watch', watch: watchId('review') },
        actorId: 'test',
        actorDecision: { authorized: true, evidenceId: `${parent.workflowInstanceId}-verdict` },
        providerEventId: `${parent.workflowInstanceId}-verdict`,
      });
      const resolved = await world.viewWorkflow(parent.workflowInstanceId);
      expect(resolved?.status).toBe('completed');
    }
  },
);
```

- [ ] **Step 2: Run the scenario to see it fails before Task 1's fix would explain why**

Run: `npx vitest run test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts`
Expected: PASS, since Task 1 already landed the resolver fix by this point in the plan. (If you are executing tasks out of order, this scenario is expected to FAIL before Task 1's resolver change — with more than 2 `child-requested` events — since without it, one instance's `signal-wait-started` matches every currently-eligible instance.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts
git commit -m "test: adapt E2E-DARKFACTORY-004 to the signal-wait-started trigger"
```

---

## Task 5: Update the approval-authority fixture for consistency

**Files:**
- Modify: `test/unit/orchestration/approval-authority.test.ts`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Update the fixture**

In `test/unit/orchestration/approval-authority.test.ts`, change:

```ts
const reviewWatch = {
  id: 'pr-review',
  while: { stages: ['implement'], statuses: [WorkflowStatus.Waiting] },
  on: { events: ['execution.run-succeeded'] },
  workflow: 'default',
  maxPerGroup: 3,
};
```

to:

```ts
const reviewWatch = {
  id: 'pr-review',
  while: { stages: ['implement'], statuses: [WorkflowStatus.Waiting] },
  on: { events: ['orchestration.signal-wait-started'] },
  workflow: 'default',
  maxPerGroup: 3,
};
```

- [ ] **Step 2: Run the test to confirm it's unaffected**

Run: `npx vitest run test/unit/orchestration/approval-authority.test.ts`
Expected: PASS — this fixture only feeds compiled config into approval-authority computation; it does not exercise reactor dispatch, so the specific event name is not asserted on.

- [ ] **Step 3: Commit**

```bash
git add test/unit/orchestration/approval-authority.test.ts
git commit -m "test: align approval-authority fixture with the real watch trigger event"
```

---

## Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Build and type-check**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 2: Architecture and vocabulary lint**

Run: `npm run lint:architecture`
Expected: succeeds — no new magic strings were introduced outside YAML/prose; `OrchestrationEventType.SignalWaitStarted` is used in source where required.

- [ ] **Step 3: Spec drift check**

Run: `npm run check:specs`
Expected: succeeds — `child-workflow-policy.spec.md` was updated in Task 2 to match the Task 1 code change.

- [ ] **Step 4: Focused unit tests**

Run: `npx vitest run test/unit/orchestration/watch-reactor.test.ts test/unit/orchestration/approval-authority.test.ts`
Expected: PASS.

- [ ] **Step 5: Affected E2E scenario**

Run: `npx vitest run test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts`
Expected: PASS.

- [ ] **Step 6: Full lint and format check**

Run: `npm run lint` and `npm run format:check`
Expected: both succeed.

- [ ] **Step 7: Fix any fallout, then re-run Steps 1–6 until clean**

No commit for this task — fixes belong to whichever earlier task's files they touch; amend that task's commit only if you are still on the same task's step, otherwise make a small follow-up commit describing the fix.

---

## Task 7: Branch and pull request

**Files:** none (git/GitHub operations only)

- [ ] **Step 1: Confirm all prior commits are in place**

Run: `git log --oneline -8` and `git status --short`
Expected: five commits from Tasks 1–5 (Task 6 has none unless fallout needed fixing), clean working tree.

- [ ] **Step 2: Push the branch**

The branch should already have been created before Task 1 (`git checkout -b fix/watch-trigger-race`, run once, before starting Task 1's Step 1). Push it:

```bash
git push -u origin fix/watch-trigger-race
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "fix: close the watch-trigger race by matching on the wait-state transition" --body "$(cat <<'EOF'
## Summary
- Watches shaped like `while: {statuses: [waiting]}` + `watchGates` triggered off `execution.run-succeeded`, an upstream fact that can be journaled well before the later Advancement tick that actually writes the matching `waiting` state. The checkpoint-based watch reactor evaluates state live and checkpoints are one-shot, so it could consume the triggering event before the state caught up, permanently orphaning the watch (observed live on atolis-hq/wake#582 — see the issue thread for the original diagnosis).
- Retargets that pattern to `orchestration.signal-wait-started`, which is written atomically with the state transition it represents, and adds a synchronous stream-based resolver to `watch-reactor.ts` so an orchestration event scopes to its own WorkflowInstance without the async run-repository lookup that only run-lifecycle facts need.
- Updates `docs/workflows.md` and the `child-workflow-policy` module spec to describe when to use the state-transition event versus a raw external fact (e.g. `pr.checks-changed`), and adapts `E2E-DARKFACTORY-004` to prove cross-instance scoping under the new trigger.

## Test plan
- [x] `npm run build`
- [x] `npm run lint:architecture`
- [x] `npm run check:specs`
- [x] `npx vitest run test/unit/orchestration/watch-reactor.test.ts test/unit/orchestration/approval-authority.test.ts`
- [x] `npx vitest run test/e2e/scenarios/dark-factory-watch-trigger-scoping.test.ts`
- [x] `npm run lint` / `npm run format:check`

Note for deploy: any live `config.workflows.yaml` using the old `execution.run-succeeded` trigger for a `statuses: [waiting]` watch-gate must only be retargeted to `orchestration.signal-wait-started` *after* this fix is built into the running image — on the old binary, that event has no source-instance resolver at all, so it would match every currently-eligible instance system-wide instead of just its own, which is worse than the bug this PR fixes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Record the PR URL for the user**

No commit — just report the URL `gh pr create` prints.

---

## Self-Review Notes

- **Spec coverage:** resolver fix (Task 1), spec sync (Task 2), docs guidance (Task 3), scoping-test adaptation (Task 4), fixture consistency (Task 5), verification (Task 6), branch/PR (Task 7). The reconciliation sweep and the live `~/wake-home` config update are intentionally excluded from this plan — the former is a separate GitHub issue, the latter is a post-merge deployment step gated on the image actually being rebuilt (see PR body note above), to be done by hand after Task 7, not as a plan task.
- **Placeholder scan:** every step has literal code, exact file paths, and exact commands — no TBDs.
- **Type consistency:** `resolveTriggerWorkflowInstanceId` returns `Promise<string | undefined>`, matching the existing `sourceWorkflowInstanceId` local's usage at the call site (compared against `match.parent.workflowInstanceId`, itself a `WorkflowInstanceId` which is a branded `string`) — same shape `resolveRunWorkflowInstanceId` already returned, so no downstream type changes are needed.
