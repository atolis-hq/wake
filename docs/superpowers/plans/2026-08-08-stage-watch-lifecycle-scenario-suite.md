# Stage/Watch Lifecycle Scenario Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the six lifecycle scenarios in `docs/superpowers/specs/2026-08-08-stage-watch-lifecycle-scenarios-design.md` into a deterministic, regression-proof `test-next/` suite, building the `watchGate` engine capability the dark-factory half depends on.

**Architecture:** Stages 1–2 need zero production changes (`TestWorld`/`ProcessWorld` scenarios against existing mechanisms). Stage 3 builds `watchGate` in `src-next/orchestration` (new contract fields, config schema, compiler validation, and outcome-dependent resume-target resolution). Stage 4 writes the dark-factory scenarios `watchGate` unblocks. Stage 5 adds one small UI test.

**Tech Stack:** TypeScript, Vitest, Zod, the existing `src-next/orchestration` event-sourced domain model.

## Global Constraints

- Every scenario test follows `test-next/e2e/support/scenario.ts`'s `defineScenario` (Given/When/Then metadata) and existing structural conventions in `test-next/e2e/scenarios/`.
- Run `npx vitest run --config vitest.next.e2e.config.ts <file>` for e2e scenario tasks, `npx vitest run --config vitest.next.unit.config.ts <file>` for unit tasks, per `package.json`'s `test:next:e2e`/`test:next:unit` scripts.
- After every production-code task in Stage 3, run `npm run verify:next` before committing — per `CLAUDE.md`, this is mandatory before any `src-next/` task is considered done.
- No new production code in Stages 1, 2, 4, 5 — those stages are scenario tests only, against Stage 3's completed engine work (Stages 1–2 also work standalone, before Stage 3).
- Commit after each task, not each step within a task.
- **Descoped from this plan, confirmed against real composition code while planning:** the inline-watch-workflow shorthand (`workflow:` as a union of identifier-string or inline `StageConfig`-object) from the design doc's Part C. Making it work for real requires `compileWorkflow` to return more than one `CompiledWorkflow` (the parent plus any synthesized child workflows) and every caller that registers compiled workflows into a `definitions` map (`TestWorld.configureWorkflow`, and production's own config-loading path) to register all of them — a real architectural change, not needed by any scenario below. Stage 4's worked example uses today's already-working explicit two-block form (a `workflows:` entry the watch's own `workflow:` field references by name), exactly as `child-completion.test.ts`/`child-loop-guard.test.ts` already do. The design doc's worked example should be updated to match before anyone treats it as current; flagged for a follow-up, not fixed as part of this plan.
- **Also corrected against real code while planning:** `E2E-LIFECYCLE-004`'s original design asserted GitHub label reconciliation, but `wake-labels.ts`'s reconciler (`createGitHubWakeLabelReconciler`) is wired only onto the GitHub provider (`src-next/integrations/github/provider.ts:27`), never composed for the `fake` provider the fixture uses. Task 1.4 below proves what the fake provider can actually prove — ticket-minting and per-stage delivery-intent recording — and drops the label assertion. Proving GitHub label reconciliation end-to-end needs a GitHub-fake integration test, out of scope here, same as the JSON-marker inbound/outbound translation work already deferred in the design doc.

---

## Stage 1: Plain lifecycle scenarios (1a, 1b, 1c) — no production changes

### Task 1.1: E2E-LIFECYCLE-001 — happy path

**Files:**
- Create: `test-next/e2e/scenarios/lifecycle-happy-path.test.ts`

**Interfaces:**
- Consumes: `TestWorld` (`test-next/e2e/support/world.ts`), `defineScenario` (`test-next/e2e/support/scenario.ts`), `activityName`/`workflowName` from `src-next/orchestration`/`src-next/activities` barrels — all pre-existing, no new production code.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-001',
    title: 'a two-stage workflow completes when both agents succeed first try',
    given: ['a default-shaped workflow with a refine stage then an implement stage'],
    when: ['the refine agent succeeds and then the implement agent succeeds'],
    then: [
      'both stages are entered in order, each producing one successful Run',
      'the workflow reaches completed and the work item stays open',
    ],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('refine'),
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
      name: activityName('implement'),
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
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'implement' } },
        },
        implement: {
          activity: 'implement',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'done' } },
        },
      },
    });
    const work = await world.createWork({ objective: 'ship target architecture' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });

    await world.advance(work.workItemId);
    await world.advance(work.workItemId);

    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.currentStage).toBe('implement');
    const runs = await world.viewRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'succeeded' && run.outcome?.kind === 'done')).toBe(
      true,
    );
    expect((await world.events()).map((event) => event.eventType)).toEqual([
      'work.item-created',
      'orchestration.primary-claimed',
      'orchestration.instance-started',
      'orchestration.stage-entered',
      'orchestration.activity-requested',
      'orchestration.activity-started',
      'execution.activation-claimed',
      'execution.run-started',
      'execution.run-lease-claimed',
      'execution.run-succeeded',
      'execution.activation-released',
      'orchestration.activity-outcome-accepted',
      'orchestration.stage-entered',
      'orchestration.activity-requested',
      'orchestration.activity-started',
      'execution.activation-claimed',
      'execution.run-started',
      'execution.run-lease-claimed',
      'execution.run-succeeded',
      'execution.activation-released',
      'orchestration.activity-outcome-accepted',
      'orchestration.instance-completed',
    ]);
    expect((await world.events('orchestration.stage-entered')).map((event) => event.payload)).toEqual(
      [{ stage: 'refine' }, { stage: 'implement' }],
    );
    expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'open' });
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/lifecycle-happy-path.test.ts`
Expected: PASS (this exact sequence was independently verified by running it during design work — see the design doc's Part A).

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/lifecycle-happy-path.test.ts
git commit -m "test: add E2E-LIFECYCLE-001 happy-path scenario"
```

### Task 1.2: E2E-LIFECYCLE-002 — retry then recover, independently per stage

**Files:**
- Create: `test-next/e2e/scenarios/lifecycle-retry-recovery.test.ts`

**Interfaces:**
- Consumes: same as Task 1.1.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-002',
    title: 'each stage recovers independently after its own failed attempts',
    given: ['refine permits one retry and implement permits two retries, on the same workflow'],
    when: ['refine fails once then succeeds; implement fails twice then succeeds'],
    then: [
      'each stage retries only as many times as it actually failed',
      'the two stages retry counts are tracked independently',
      'the workflow still reaches completed',
    ],
  },
  async () => {
    const world = new TestWorld();
    let refineAttempts = 0;
    let implementAttempts = 0;
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          refineAttempts += 1;
          return refineAttempts === 1 ? { kind: 'failed' } : { kind: 'done' };
        },
      },
    });
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          implementAttempts += 1;
          return implementAttempts <= 2 ? { kind: 'failed' } : { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'implement' }, failed: { retry: { max: 1 }, then: 'await-human' } },
        },
        implement: {
          activity: 'implement',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'done' }, failed: { retry: { max: 2 }, then: 'await-human' } },
        },
      },
    });
    const work = await world.createWork({ objective: 'ship with hiccups' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });

    // refine: attempt 1 fails, attempt 2 succeeds
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    // implement: attempt 1 fails, attempt 2 fails, attempt 3 succeeds
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);

    expect(refineAttempts).toBe(2);
    expect(implementAttempts).toBe(3);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'refine:failed': 1,
      'implement:failed': 2,
    });
    const runs = await world.viewRuns();
    expect(runs).toHaveLength(5);
    expect(runs.map((run) => run.outcome?.kind)).toEqual([
      'failed',
      'done',
      'failed',
      'failed',
      'done',
    ]);
    expect(await world.events('orchestration.retry-counted')).toHaveLength(3);
    expect(await world.events('execution.run-failed')).toHaveLength(3);
    expect(await world.events('execution.run-succeeded')).toHaveLength(2);
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/lifecycle-retry-recovery.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/lifecycle-retry-recovery.test.ts
git commit -m "test: add E2E-LIFECYCLE-002 retry-recovery scenario"
```

### Task 1.3: E2E-LIFECYCLE-003 — retry limit reached, human resumes

**Files:**
- Create: `test-next/e2e/scenarios/lifecycle-retry-limit.test.ts`

**Interfaces:**
- Consumes: `world.acceptSignal`, `world.viewWorkflow`, `resId` (`test-next/support/identities.js`) — all pre-existing, matching `blocked-reply.test.ts`'s pattern.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-003',
    title: 'retry limit reached leaves the workflow waiting; a human reply resumes it',
    given: ['refine permits two retries (three attempts total) before await-human'],
    when: [
      'refine fails three times in a row, exhausting the bound',
      'a human accepts the wait, resuming a fourth attempt that succeeds',
      'implement then succeeds on its first attempt',
    ],
    then: [
      'no fourth attempt happens automatically — only the human signal resumes it',
      "the retry budget is unchanged by the human-resumed attempt",
      'the workflow reaches completed',
    ],
  },
  async () => {
    const world = new TestWorld();
    let refineAttempts = 0;
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          refineAttempts += 1;
          return refineAttempts <= 3 ? { kind: 'failed' } : { kind: 'done' };
        },
      },
    });
    world.registerActivity({
      name: activityName('implement'),
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
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'implement' }, failed: { retry: { max: 2 }, then: 'await-human' } },
        },
        implement: {
          activity: 'implement',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'done' } },
        },
      },
    });
    const work = await world.createWork({ objective: 'ship despite friction' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });

    await world.advance(work.workItemId); // attempt 1: fails, retry granted
    await world.advance(work.workItemId); // attempt 2: fails, retry granted (bound reached)
    await world.advance(work.workItemId); // attempt 3: fails, bound exhausted -> await-human

    // await-human resolves to WorkflowStatus.Waiting, not Blocked — Blocked is
    // reserved for an actual InstanceBlocked fact (repeat.max exceeded, a
    // rejected causal repeat, or a Watch's own budget exhausted).
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('waiting');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'refine:failed': 2,
    });

    const accepted = await world.acceptSignal(workflow.workflowInstanceId, {
      kind: 'failed',
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'human-reply-1' },
      providerEventId: 'github-comment-1',
    });
    expect(accepted.retryCounts).toEqual({ 'refine:failed': 2 });
    expect(accepted.pendingActivation?.ordinal).toBe(4);

    await world.advance(work.workItemId); // attempt 4: succeeds (human-resumed)
    await world.advance(work.workItemId); // implement: succeeds first try

    expect(refineAttempts).toBe(4);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'refine:failed': 2,
    });
    const refineRuns = (await world.viewRuns()).slice(0, 4);
    expect(refineRuns.map((run) => run.outcome?.kind)).toEqual(['failed', 'failed', 'failed', 'done']);
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(1);
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/lifecycle-retry-limit.test.ts`
Expected: PASS. If `acceptSignal`'s expected `kind` doesn't match what the compiled `await-human` route target actually resolves to, the test will fail on `expect(accepted.retryCounts)` with an "ignored" decision — check the resolved `TransitionTarget` for the `failed` route (`compileTarget('await-human', 'failed')` yields `{kind: AwaitSignal, signal: signalName('failed')}` per `orchestration/domain/compiler.ts:216-218`, so `signal.kind` must be the literal string `'failed'`, matching the outcome kind — as used above).

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/lifecycle-retry-limit.test.ts
git commit -m "test: add E2E-LIFECYCLE-003 retry-limit scenario"
```

### Task 1.4: E2E-LIFECYCLE-004 — ticket mint and delivery-intent across the happy path (ProcessWorld)

**Files:**
- Create: `test-next/e2e/fixtures/wake-root-lifecycle/config.yaml`
- Create: `test-next/e2e/fixtures/wake-root-lifecycle/config.workflows.yaml`
- Create: `test-next/e2e/fixtures/wake-root-lifecycle/provider/evidence.json`
- Create: `test-next/e2e/scenarios/lifecycle-ticket-delivery.test.ts`

**Interfaces:**
- Consumes: `ProcessWorld` (`test-next/e2e/support/process-world.ts`) — `create(fixtureName)`, `tick()`, `readProjection<Value>(name)`, `events()`, `dispose()`.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Create the fixture's `config.yaml`**

```yaml
schemaVersion: 1
execution:
  agentRunners:
    fake: { kind: fake, timeoutMs: 5000 }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
controlPlane: {}
integrations:
  fake:
    provider: fake
    enabled: true
    evidenceFile: provider/evidence.json
surfaces:
  api: { enabled: false }
  web: { enabled: false }
```

- [ ] **Step 2: Create the fixture's `config.workflows.yaml`**

```yaml
default:
  entry: refine
  stages:
    refine:
      activity: agent
      with: { prompt: 'refine the ticket' }
      execution: { workspace: none, runnerPool: standard }
      on:
        done: { then: implement }
    implement:
      activity: agent
      with: { prompt: 'implement the ticket' }
      execution: { workspace: none, runnerPool: standard }
      on:
        done: { then: done }
```

- [ ] **Step 3: Create the fixture's `provider/evidence.json`**

```json
[{ "key": "lifecycle#1", "title": "Ship the lifecycle happy path" }]
```

- [ ] **Step 4: Write the scenario test**

```typescript
import { afterEach, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIFECYCLE-004 mints a work item from a ticket and delivers a comment per stage', async () => {
  const world = await ProcessWorld.create('wake-root-lifecycle');
  worlds.push(world);

  await world.runTicksUntilIdle();

  const workItems = await world.readProjection<{ readonly state: string }>('work');
  expect(workItems).toHaveLength(1);

  const publishIntents = (await world.events()).filter(
    (event) => event.eventType === 'agent-run.publish-requested',
  );
  expect(publishIntents.length).toBeGreaterThanOrEqual(2);

  const orchestrationViews = await world.readProjection<{ readonly status: string }>(
    'orchestration',
  );
  expect(orchestrationViews).toHaveLength(1);
  expect(orchestrationViews[0]?.status).toBe('completed');
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/lifecycle-ticket-delivery.test.ts`
Expected: PASS. If `readProjection('work')`/`'orchestration'` names don't match the real projection registry names, check `src-next/bootstrap/composition-root.ts`'s `projections.register(...)` calls for the exact names, and adjust — `live-failure-recovery.test.ts` already uses these exact two names successfully as precedent.

- [ ] **Step 6: Commit**

```bash
git add test-next/e2e/fixtures/wake-root-lifecycle test-next/e2e/scenarios/lifecycle-ticket-delivery.test.ts
git commit -m "test: add E2E-LIFECYCLE-004 ticket-to-delivery ProcessWorld scenario"
```

---

## Stage 2: Watch child that never renders a verdict (2c) — no production changes

### Task 2.1: E2E-DARKFACTORY-003 — watch child exhausts retries without a verdict

**Files:**
- Create: `test-next/e2e/scenarios/dark-factory-child-error.test.ts`

**Interfaces:**
- Consumes: `world.waitForSignal`, `world.triggerWatch` — matching `child-completion.test.ts`'s existing pattern for standing in for an external actor.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { signalName, workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-003',
    title: "a watch child that never renders a verdict leaves its parent untouched",
    given: ['a parent waiting on a review, and a watch child that only ever fails technically'],
    when: ["the child's activity fails three times in a row, exhausting its own retries"],
    then: [
      'the child ends waiting on human input, never completed',
      'no signal is ever accepted against the parent',
      "the parent's status and pending state are untouched",
    ],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('implement'),
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
      name: activityName('pr-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('failed') }).strict(),
      outcomeKinds: ['failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'failed' } as const;
        },
      },
    });
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: { failed: { retry: { max: 2 }, then: 'await-human' } },
        },
      },
    });
    world.configureWorkflow('parent', {
      stages: {
        implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 2,
        },
      ],
    });
    const work = await world.createWork({ objective: 'implement with a flaky reviewer' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('parent'),
    });

    await world.advance(work.workItemId);
    await world.waitForSignal(parent.workflowInstanceId, {
      signalKind: signalName('orchestration.child-completed'),
    });
    const before = await world.viewWorkflow(parent.workflowInstanceId);

    await world.triggerWatch('review.requested', 'review-1');
    await world.advance(work.workItemId); // attempt 1: fails, retry granted
    await world.advance(work.workItemId); // attempt 2: fails, bound exhausted -> await-human

    const childId = `${parent.workflowInstanceId}:watch:pr-review:trigger:review-1`;
    // await-human resolves to WorkflowStatus.Waiting, not Blocked.
    expect((await world.viewWorkflow(childId))?.status).toBe('waiting');
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(0);
    const after = await world.viewWorkflow(parent.workflowInstanceId);
    expect(after).toEqual(before);
    expect(after?.status).toBe('waiting');
    expect(await world.events('orchestration.instance-blocked')).toHaveLength(0);
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/dark-factory-child-error.test.ts`
Expected: PASS. If `retry.max: 2` produces only 2 total attempts instead of 3 (off-by-one against the design doc's "fails 3 times"), check `retry-policy.ts`'s exact bound semantics — `child-loop-guard.test.ts`/`retry-boundary.test.ts` confirm `retry.max: N` permits `N` retries (N+1 attempts total); this scenario deliberately keeps `retry.max: 2` (3 attempts) to match the design doc's Part B exactly — if the sequence above only produces 2 attempts before blocking, add one more `advance()` call and adjust the inline comments.

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/dark-factory-child-error.test.ts
git commit -m "test: add E2E-DARKFACTORY-003 child-error scenario"
```

---

## Stage 3: `watchGate` engine capability

Every task in this stage ends with `npm run verify:next` passing before commit, per Global Constraints.

### Task 3.1: Contract fields — `OrchestrationSignal.outcome`, `SignalExpectation.onRejectResume`

**Files:**
- Modify: `src-next/orchestration/contracts/events.ts`
- Modify: `src-next/orchestration/contracts/views.ts`
- Modify: `src-next/orchestration/contracts/event-decoder.ts`
- Test: `test-next/unit/orchestration/event-contracts.test.ts`

**Interfaces:**
- Consumes: `ActivityOutcomeKind` (`src-next/activities/index.js`), `signalName` (`./identifiers.js`).
- Produces: `OrchestrationSignal.outcome?: ActivityOutcomeKind`, `SignalExpectation.onRejectResume?: TransitionTarget`, `SignalExpectationView.onRejectResume?: TransitionTarget`, `WatchGateVerdictSignal: SignalName` (a fixed, exported signal-kind constant) — consumed by Tasks 3.3–3.5 and Stage 4.

- [ ] **Step 1: Write the failing round-trip test**

Add to `test-next/unit/orchestration/event-contracts.test.ts` (find its existing `SignalWaitStarted`/`SignalAccepted` round-trip tests and add alongside them — match that file's existing style for constructing/decoding an envelope):

```typescript
it('round-trips a SignalWaitStarted event carrying onRejectResume', () => {
  const envelope = /* build using this file's existing envelope-construction helper, with
    payload: { signalKind: signalName('orchestration.watch-gate-verdict'), resume: { kind: 'complete' },
    onRejectResume: { kind: 'stage', stage: stageName('implement') } } */;
  const decoded = selectWorkflowOrchestrationEvent(envelope);
  expect(decoded?.eventType === 'orchestration.signal-wait-started' && decoded.payload.onRejectResume)
    .toEqual({ kind: 'stage', stage: stageName('implement') });
});

it('round-trips a SignalAccepted event carrying outcome', () => {
  const envelope = /* same pattern, payload includes outcome: ActivityOutcomeKind.Rejected */;
  const decoded = selectWorkflowOrchestrationEvent(envelope);
  expect(decoded?.eventType === 'orchestration.signal-accepted' && decoded.payload.outcome).toBe(
    'rejected',
  );
});
```

Match this file's actual existing envelope-construction helper exactly (read the file first — it already has round-trip tests for `SignalWaitStarted`/`SignalAccepted` to copy the pattern from) rather than inventing new helper code.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/event-contracts.test.ts`
Expected: FAIL — `onRejectResume`/`outcome` rejected by `.strict()` schemas, or `WatchGateVerdictSignal` not exported.

- [ ] **Step 3: Extend `SignalExpectation` and `OrchestrationSignal`, add `WatchGateVerdictSignal`**

In `src-next/orchestration/contracts/events.ts`, change the import line:

```typescript
import type { ActivationId, ActivityName, ActivityOutcome } from '../../activities/index.js';
```

to:

```typescript
import type {
  ActivationId,
  ActivityName,
  ActivityOutcome,
  ActivityOutcomeKind,
} from '../../activities/index.js';
```

Add a value import for `signalName` (the type-only import of other identifiers already exists further down — add a separate value import near the top, after the activities import):

```typescript
import { signalName } from './identifiers.js';
```

Change `SignalExpectation` and `OrchestrationSignal`:

```typescript
export interface SignalExpectation {
  readonly signalKind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly from?: readonly ApprovalAuthority[] | undefined;
  readonly resume?: TransitionTarget | undefined;
  readonly onRejectResume?: TransitionTarget | undefined;
}

export interface OrchestrationSignal {
  readonly kind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly actorId: string;
  readonly actorDecision: { readonly authorized: boolean; readonly evidenceId: string };
  readonly providerEventId: string;
  readonly authority?: ApprovalAuthority | undefined;
  readonly outcome?: ActivityOutcomeKind | undefined;
}
```

Add, near the bottom of the file (after `ChildWorkflowRequest`):

```typescript
// The one fixed signal kind every watchGate waits on; the specific watch and
// its own outcome disambiguate which verdict this is, not the signal kind.
export const WatchGateVerdictSignal = signalName('orchestration.watch-gate-verdict');
```

- [ ] **Step 4: Extend `SignalExpectationView`**

In `src-next/orchestration/contracts/views.ts`, change:

```typescript
export interface SignalExpectationView {
  readonly signalKind: SignalName;
  readonly intentEventId?: string;
  readonly resourceId?: string;
  readonly revision?: string;
  readonly from?: readonly ApprovalAuthority[];
  readonly resume?: TransitionTarget;
}
```

to:

```typescript
export interface SignalExpectationView {
  readonly signalKind: SignalName;
  readonly intentEventId?: string;
  readonly resourceId?: string;
  readonly revision?: string;
  readonly from?: readonly ApprovalAuthority[];
  readonly resume?: TransitionTarget;
  readonly onRejectResume?: TransitionTarget;
}
```

- [ ] **Step 5: Fold `onRejectResume` into `waitingFor` on `SignalWaitStarted`**

In `src-next/orchestration/domain/workflow-instance-events.ts`, find `applySignalWaitStarted` and add one more spread:

```typescript
function applySignalWaitStarted(
  state: MutableWorkflowInstance,
  event: FactsOf<typeof OrchestrationEventType.SignalWaitStarted>,
): void {
  state.status = WorkflowStatus.Waiting;
  state.waitingFor = {
    signalKind: event.payload.signalKind,
    ...(event.payload.resourceId === undefined ? {} : { resourceId: event.payload.resourceId }),
    ...(event.payload.revision === undefined ? {} : { revision: event.payload.revision }),
    ...(event.payload.from === undefined ? {} : { from: event.payload.from }),
    ...(event.payload.resume === undefined ? {} : { resume: event.payload.resume }),
    ...(event.payload.onRejectResume === undefined
      ? {}
      : { onRejectResume: event.payload.onRejectResume }),
  };
}
```

- [ ] **Step 6: Extend the zod decode schemas**

In `src-next/orchestration/contracts/event-decoder.ts`, change `expectationSchema`:

```typescript
export const expectationSchema = z
  .object({
    signalKind: brandedStringSchema(signalName),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    from: z.array(approvalAuthoritySchema).min(1).optional(),
    resume: transitionTargetSchema.optional(),
    onRejectResume: transitionTargetSchema.optional(),
  })
  .strict();
```

And `signalSchema`:

```typescript
export const signalSchema = z
  .object({
    kind: brandedStringSchema(signalName),
    resourceId: z.string().optional(),
    revision: z.string().optional(),
    actorId: z.string().min(1),
    actorDecision: z.object({ authorized: z.boolean(), evidenceId: z.string().min(1) }).strict(),
    providerEventId: z.string().min(1),
    childWorkflowInstanceId: workflowInstanceIdSchema.optional(),
    requestId: z.string().optional(),
    authority: approvalAuthoritySchema.optional(),
    outcome: z
      .enum([
        ActivityOutcomeKind.Done,
        ActivityOutcomeKind.Rejected,
        ActivityOutcomeKind.Blocked,
        ActivityOutcomeKind.Failed,
      ])
      .optional(),
  })
  .strict();
```

- [ ] **Step 7: Export `WatchGateVerdictSignal` from the orchestration barrel**

In `src-next/orchestration/index.ts`, find where `OrchestrationEventType` (or a sibling constant from `./contracts/events.js`) is re-exported, and add `WatchGateVerdictSignal` alongside it.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/event-contracts.test.ts`
Expected: PASS.

- [ ] **Step 9: Verify and commit**

Run: `npm run verify:next`
Expected: PASS.

```bash
git add src-next/orchestration/contracts/events.ts src-next/orchestration/contracts/views.ts src-next/orchestration/contracts/event-decoder.ts src-next/orchestration/domain/workflow-instance-events.ts src-next/orchestration/index.ts test-next/unit/orchestration/event-contracts.test.ts
git commit -m "feat(orchestration): add outcome/onRejectResume contract fields for watchGate"
```

### Task 3.2: `watchGates` config schema

**Files:**
- Modify: `src-next/orchestration/contracts/config.ts`
- Test: `test-next/unit/orchestration/compiled-contracts.test.ts`

**Interfaces:**
- Consumes: Task 3.1's contracts (none directly — this task is schema-only).
- Produces: `watchGateConfigSchema`, `WatchGateConfig` type, `CompiledWatchGate` interface, `CompiledOutcomeRoute.watchGates?: readonly CompiledWatchGate[]` — consumed by Task 3.3.

- [ ] **Step 1: Write the failing schema test**

Add to `test-next/unit/orchestration/compiled-contracts.test.ts` (read it first to match its existing style for `outcomeRouteConfigSchema`/`awaitConfigSchema` parsing tests):

```typescript
it('accepts a bare watch id as watchGates shorthand', () => {
  const result = outcomeRouteConfigSchema.safeParse({ then: 'done', watchGates: ['pr-review'] });
  expect(result.success).toBe(true);
});

it('accepts a full watchGates entry with onReject', () => {
  const result = outcomeRouteConfigSchema.safeParse({
    then: 'done',
    watchGates: [{ watch: 'pr-review', onReject: { then: 'implement' } }],
  });
  expect(result.success).toBe(true);
});

it('rejects a watchGates entry with unknown fields', () => {
  const result = outcomeRouteConfigSchema.safeParse({
    then: 'done',
    watchGates: [{ watch: 'pr-review', extra: true }],
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/compiled-contracts.test.ts`
Expected: FAIL — `.strict()` rejects the unrecognized `watchGates` key entirely (all three assertions fail, since the field doesn't exist yet).

- [ ] **Step 3: Add the schema and compiled type**

In `src-next/orchestration/contracts/config.ts`, add after `awaitConfigSchema`:

```typescript
const watchGateConfigSchema = z.union([
  identifier,
  z
    .object({
      watch: identifier,
      onReject: z.object({ then: identifier }).strict().optional(),
    })
    .strict(),
]);

export type WatchGateConfig = z.infer<typeof watchGateConfigSchema>;
```

Change `outcomeRouteConfigSchema` to:

```typescript
export const outcomeRouteConfigSchema = z
  .object({
    activities: z.array(followOnActivityConfigSchema).readonly().optional(),
    then: identifier,
    repeat: bound.optional(),
    retry: bound.optional(),
    await: awaitConfigSchema.optional(),
    watchGates: z.array(watchGateConfigSchema).optional(),
  })
  .strict();
```

Add, after `CompiledAwait`:

```typescript
export interface CompiledWatchGate {
  readonly watch: WatchId;
  readonly onRejectTarget: TransitionTarget;
}
```

Change `CompiledOutcomeRoute` to:

```typescript
export interface CompiledOutcomeRoute extends Omit<
  OutcomeRouteConfig,
  'activities' | 'then' | 'await' | 'watchGates'
> {
  readonly id: string;
  readonly target: TransitionTarget;
  readonly activities?: readonly CompiledFollowOnActivity[];
  readonly await?: CompiledAwait;
  readonly watchGates?: readonly CompiledWatchGate[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/compiled-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify:next`
Expected: PASS (nothing consumes `watchGates` yet, so it's inert config the compiler ignores until Task 3.3 — confirm no existing test broke).

```bash
git add src-next/orchestration/contracts/config.ts test-next/unit/orchestration/compiled-contracts.test.ts
git commit -m "feat(orchestration): add watchGates config schema"
```

### Task 3.3: Compiler validation for `watchGates`

**Files:**
- Modify: `src-next/orchestration/domain/compiler.ts`
- Test: `test-next/unit/orchestration/workflow-compiler.test.ts`

**Interfaces:**
- Consumes: `WatchGateConfig`, `CompiledWatchGate` (Task 3.2).
- Produces: a compiled `CompiledOutcomeRoute.watchGates` a stage's route can carry — consumed by Task 3.4.

- [ ] **Step 1: Write the failing compiler tests**

Add to `test-next/unit/orchestration/workflow-compiler.test.ts` (read its existing structure first — it already calls `compileWorkflow(name, config, activities, knownWorkflowNames)` directly and asserts on the returned `CompiledWorkflow` or asserts a thrown error; match that style):

```typescript
it('compiles a single watchGates entry, defaulting onReject to a self-loop', () => {
  const activities = registryWithDoneActivity('implement');
  const compiled = compileWorkflow(
    'parent',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 1,
        },
      ],
    },
    activities,
    ['parent', 'pr-review'],
  );
  const gate = compiled.stages.implement!.on.done!.watchGates![0]!;
  expect(gate.watch).toBe('pr-review');
  expect(gate.onRejectTarget).toEqual({ kind: 'stage', stage: 'implement' });
});

it('compiles an explicit onReject target', () => {
  const activities = registryWithDoneActivity('implement');
  const compiled = compileWorkflow(
    'parent',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: {
            done: {
              then: 'done',
              watchGates: [{ watch: 'pr-review', onReject: { then: 'await-human' } }],
            },
          },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 1,
        },
      ],
    },
    activities,
    ['parent', 'pr-review'],
  );
  const gate = compiled.stages.implement!.on.done!.watchGates![0]!;
  expect(gate.onRejectTarget.kind).toBe('await-signal');
});

it('rejects a watchGates entry naming an undeclared watch', () => {
  const activities = registryWithDoneActivity('implement');
  expect(() =>
    compileWorkflow(
      'parent',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: { done: { then: 'done', watchGates: ['ghost-watch'] } },
          },
        },
      },
      activities,
    ),
  ).toThrow(/Unknown watch reference/);
});

it('rejects more than one watchGates entry', () => {
  const activities = registryWithDoneActivity('implement');
  expect(() =>
    compileWorkflow(
      'parent',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: { done: { then: 'done', watchGates: ['a', 'b'] } },
          },
        },
        watches: [
          {
            id: 'a',
            while: { stages: ['implement'], statuses: ['waiting'] },
            on: { events: ['e'] },
            workflow: 'a',
            maxPerGroup: 1,
          },
          {
            id: 'b',
            while: { stages: ['implement'], statuses: ['waiting'] },
            on: { events: ['e'] },
            workflow: 'b',
            maxPerGroup: 1,
          },
        ],
      },
      activities,
      ['parent', 'a', 'b'],
    ),
  ).toThrow(/exactly 1 is supported/);
});

it('rejects a route configuring both await and watchGates', () => {
  const activities = registryWithDoneActivity('implement');
  expect(() =>
    compileWorkflow(
      'parent',
      {
        stages: {
          implement: {
            activity: 'implement',
            with: {},
            on: {
              done: {
                then: 'done',
                watchGates: ['pr-review'],
                await: { signal: 'approved', from: ['human'] },
              },
            },
          },
        },
        watches: [
          {
            id: 'pr-review',
            while: { stages: ['implement'], statuses: ['waiting'] },
            on: { events: ['e'] },
            workflow: 'pr-review',
            maxPerGroup: 1,
          },
        ],
      },
      activities,
      ['parent', 'pr-review'],
    ),
  ).toThrow(/cannot configure both await and watchGates/);
});
```

If this file has no existing `registryWithDoneActivity`-style helper, write one matching whatever helper pattern the file already uses to build an `ActivityRegistry` with a single `done`-only activity registered under the given name — do not invent a name not already used in the file's own conventions; read the file first and reuse its existing helper if one exists.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/workflow-compiler.test.ts`
Expected: FAIL — `watchGates` is silently ignored by the compiler today (Task 3.2 only added schema, not compilation), so `compiled.stages.implement!.on.done!.watchGates` is `undefined` and the "rejects" tests never throw.

- [ ] **Step 3: Implement `compileWatchGates` and wire it into `compileStage`**

In `src-next/orchestration/domain/compiler.ts`, add to the type imports from `../contracts/config.js`:

```typescript
import {
  workflowDefinitionConfigSchema,
  type ApprovalAuthority,
  type AwaitConfig,
  type CompiledAwait,
  type CompiledOutcomeRoute,
  type CompiledStage,
  type CompiledSupplementalCommand,
  type CompiledWatchGate,
  type CompiledWorkflow,
  type StageConfig,
  type WatchGateConfig,
  type WorkflowDefinitionConfig,
} from '../contracts/config.js';
```

In `compileStage`, right after the `followOns` computation and before building `compiled`, add the mutual-exclusivity check and compute `watchGates`:

```typescript
function compileStage(
  context: StageCompileContext,
  rawStageName: string,
  stage: StageConfig,
  allStages: WorkflowDefinitionConfig['stages'],
): CompiledStage {
  const { workflowName: compiledWorkflowName, activities, declaredWatchIds } = context;
  const definition = activities.describe(activityName(stage.activity));
  const on = Object.fromEntries(
    Object.entries(stage.on).map(([outcomeKind, route]) => {
      if (!definition.outcomeKinds.includes(outcomeKind))
        throw new Error(
          `Workflow outcome route ${outcomeKind} is not declared by Activity ${definition.name}`,
        );
      if (!isReservedTerminal(route.then) && !(route.then in allStages))
        throw new Error(`Unknown transition target: ${route.then}`);
      if (route.await !== undefined && route.watchGates !== undefined)
        throw new Error(
          `Route ${compiledWorkflowName}:${rawStageName}:${outcomeKind} cannot configure both await and watchGates`,
        );
      const followOns = route.activities?.map((activity) => ({
        use: activityName(activity.use),
        with: activities.validateInput(activityName(activity.use), activity.with),
      }));
      const target = compileTarget(route.then, outcomeKind);
      const compiled: CompiledOutcomeRoute = Object.freeze({
        target,
        ...(route.repeat === undefined ? {} : { repeat: route.repeat }),
        ...(route.retry === undefined ? {} : { retry: route.retry }),
        ...(followOns === undefined ? {} : { activities: Object.freeze(followOns) }),
        ...(route.await === undefined
          ? {}
          : {
              await: compileAwait(
                compiledWorkflowName,
                rawStageName,
                target,
                route.await,
                declaredWatchIds,
              ),
            }),
        ...(route.watchGates === undefined
          ? {}
          : {
              watchGates: compileWatchGates(
                compiledWorkflowName,
                rawStageName,
                outcomeKind,
                route.watchGates,
                declaredWatchIds,
                allStages,
              ),
            }),
        id: `${compiledWorkflowName}:${rawStageName}:${outcomeKind}`,
      });
      return [outcomeKind, compiled];
    }),
  );
  return Object.freeze({
    activity: definition.name,
    with: activities.validateInput(definition.name, stage.with),
    ...(stage.execution === undefined ? {} : { execution: stage.execution }),
    on: Object.freeze(on),
  });
}
```

Add the new `compileWatchGates` function, near `compileAwait`:

```typescript
function compileWatchGates(
  workflow: ReturnType<typeof workflowName>,
  rawStageName: string,
  outcomeKind: string,
  entries: readonly WatchGateConfig[],
  declaredWatchIds: ReadonlySet<string>,
  allStages: WorkflowDefinitionConfig['stages'],
): readonly CompiledWatchGate[] {
  if (entries.length !== 1)
    throw new Error(
      `Route ${workflow}:${rawStageName}:${outcomeKind} configures ${entries.length} watchGates; exactly 1 is supported`,
    );
  const seen = new Set<string>();
  return Object.freeze(
    entries.map((entry) => {
      const normalized = typeof entry === 'string' ? { watch: entry } : entry;
      if (seen.has(normalized.watch))
        throw new Error(`Duplicate watchGates entry for watch "${normalized.watch}"`);
      seen.add(normalized.watch);
      if (!declaredWatchIds.has(normalized.watch))
        throw new Error(
          `Unknown watch reference in workflow "${workflow}" stage "${rawStageName}": "${normalized.watch}"`,
        );
      const onRejectThen = normalized.onReject?.then ?? rawStageName;
      if (!isReservedTerminal(onRejectThen) && !(onRejectThen in allStages))
        throw new Error(`Unknown watchGates onReject target: ${onRejectThen}`);
      return Object.freeze({
        watch: watchId(normalized.watch),
        onRejectTarget: compileTarget(onRejectThen, outcomeKind),
      });
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/workflow-compiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify:next`
Expected: PASS.

```bash
git add src-next/orchestration/domain/compiler.ts test-next/unit/orchestration/workflow-compiler.test.ts
git commit -m "feat(orchestration): compile watchGates config with referential validation"
```

### Task 3.4: `finishRoute` emits a watchGate's `SignalWaitStarted`

**Files:**
- Modify: `src-next/orchestration/domain/transition.ts`
- Test: `test-next/unit/orchestration/signals.test.ts`

**Interfaces:**
- Consumes: `CompiledWatchGate` (Task 3.2), `WatchGateVerdictSignal` (Task 3.1).
- Produces: a `SignalWaitStarted` event carrying `signalKind: WatchGateVerdictSignal`, `from: [watch, human]`, `resume: route.target`, `onRejectResume: gate.onRejectTarget` — consumed by Task 3.5.

- [ ] **Step 1: Write the failing test**

Add to `test-next/unit/orchestration/signals.test.ts` (read its existing `waitingService`-style helper first — the file already builds a compiled workflow, starts it, and drives outcomes through `orchestrationService`; reuse that pattern rather than reinventing setup):

```typescript
it('a route with watchGates emits SignalWaitStarted for the fixed watch-gate signal', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const baseContext = {
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'operator' as const, id: 'owner' },
  };
  await work.create({ workItemId: workId('1'), objective: 'ship' }, { ...baseContext, commandId: 'create-work' });
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: { async execute() { return { kind: 'done' }; } },
  });
  const definition = compileWorkflow(
    'parent',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 1,
        },
      ],
    },
    activities,
    ['parent', 'pr-review'],
  );
  const service = createOrchestrationService(journal, work, { parent: definition });
  const started = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...baseContext, commandId: 'start' },
  );
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: started.workflowInstanceId,
      activationId: started.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...baseContext, commandId: 'run-1' },
  );
  expect(waiting.status).toBe('waiting');
  expect(waiting.waitingFor?.signalKind).toBe('orchestration.watch-gate-verdict');
  expect(waiting.waitingFor?.onRejectResume).toEqual({ kind: 'stage', stage: 'implement' });
  expect(waiting.waitingFor?.from).toEqual([
    { kind: 'watch', watch: 'pr-review' },
    { kind: 'human' },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/signals.test.ts`
Expected: FAIL — `finishRoute` doesn't check `route.watchGates` yet, so the route falls through to the `route.target.kind !== Stage` branch (`resumeToTarget` straight to `Complete`), and the instance completes instead of waiting.

- [ ] **Step 3: Implement the `watchGates` branch in `finishRoute`**

In `src-next/orchestration/domain/transition.ts`, change the imports:

```typescript
import type {
  CompiledOutcomeRoute,
  CompiledWorkflow,
  TransitionTarget,
} from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { OrchestrationEventType, WatchGateVerdictSignal } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from '../contracts/vocabulary.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';
```

Add the new branch as the first check in `finishRoute`, before the existing `route.await` check:

```typescript
export function finishRoute(
  events: WorkflowOrchestrationEventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: TransitionInput,
  route: CompiledOutcomeRoute,
): void {
  if (route.watchGates !== undefined) {
    const gate = route.watchGates[0]!;
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.SignalWaitStarted,
        {
          signalKind: WatchGateVerdictSignal,
          from: Object.freeze([
            { kind: ApprovalAuthorityKind.Watch, watch: gate.watch },
            { kind: ApprovalAuthorityKind.Human },
          ]),
          resume: route.target,
          onRejectResume: gate.onRejectTarget,
        },
        events.length + 1,
      ),
    );
    return;
  }
  if (route.await !== undefined) {
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.SignalWaitStarted,
        { signalKind: route.await.signal, from: route.await.from, resume: route.await.resume },
        events.length + 1,
      ),
    );
    return;
  }
  if (route.target.kind !== TransitionTargetKind.Stage) {
    resumeToTarget(events, definition, state, input, route.target);
    return;
  }
  const count = (state.repeatCounts[route.id] ?? 0) + 1;
  if (route.repeat !== undefined) {
    if (count > route.repeat.max) {
      events.push(
        stateDraft(
          state,
          input,
          OrchestrationEventType.InstanceBlocked,
          { reason: `repeat.max exceeded for ${route.id}` },
          events.length + 1,
        ),
      );
      return;
    }
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.RepeatCounted,
        { routeId: route.id, count },
        events.length + 1,
      ),
    );
  }
  const stage = definition.stages[route.target.stage]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.StageEntered,
      { stage: route.target.stage },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
      }),
      events.length + 2,
    ),
  );
}
```

(`resumeToTarget` itself is unmodified — this only changes `finishRoute`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify:next`
Expected: PASS.

```bash
git add src-next/orchestration/domain/transition.ts test-next/unit/orchestration/signals.test.ts
git commit -m "feat(orchestration): finishRoute emits watchGate SignalWaitStarted with synthesized human override"
```

### Task 3.5: `acceptSignal` branches on the accepted signal's own outcome

**Files:**
- Modify: `src-next/orchestration/domain/signal-policy.ts`
- Test: `test-next/unit/orchestration/signals.test.ts`

**Interfaces:**
- Consumes: `OrchestrationSignal.outcome` (Task 3.1), `SignalExpectation.onRejectResume` (Task 3.1), the `SignalWaitStarted` from Task 3.4.
- Produces: `acceptSignal` resuming to `onRejectResume` when the accepted signal's `outcome === 'rejected'`, falling back to `resume` (or the interrupted-activation resume) exactly as before otherwise — consumed by Stage 4's scenarios.

- [ ] **Step 1: Write the failing tests**

Add to `test-next/unit/orchestration/signals.test.ts`, continuing directly from Task 3.4's test (same compiled `definition`/`service`/`waiting` state — write this as two more `it` blocks reusing a shared setup helper if the file already factors setup into a function; otherwise duplicate the setup from Task 3.4's test, since these are independent scenarios):

```typescript
it('a DONE watch-gate signal resumes to the route target', async () => {
  // ... same setup as Task 3.4's test through `waiting` ...
  const accepted = await service.acceptSignal(
    waiting.workflowInstanceId,
    {
      kind: signalName('orchestration.watch-gate-verdict'),
      outcome: 'done',
      actorId: 'pr-review-bot',
      actorDecision: { authorized: true, evidenceId: 'comment-1' },
      providerEventId: 'comment-1',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    },
    { ...baseContext, commandId: 'verdict-1' },
  );
  expect(accepted.status).toBe('completed');
});

it('a REJECTED watch-gate signal resumes to onRejectResume, not the route target', async () => {
  // ... same setup as Task 3.4's test through `waiting` ...
  const accepted = await service.acceptSignal(
    waiting.workflowInstanceId,
    {
      kind: signalName('orchestration.watch-gate-verdict'),
      outcome: 'rejected',
      actorId: 'pr-review-bot',
      actorDecision: { authorized: true, evidenceId: 'comment-1' },
      providerEventId: 'comment-1',
      authority: { kind: 'watch', watch: watchId('pr-review') },
    },
    { ...baseContext, commandId: 'verdict-1' },
  );
  expect(accepted.status).toBe('active');
  expect(accepted.currentStage).toBe('implement');
  expect(accepted.pendingActivation?.ordinal).toBe(2);
});

it('a human signal satisfies a watch-gate wait even without the watch running', async () => {
  // ... same setup as Task 3.4's test through `waiting` ...
  const accepted = await service.acceptSignal(
    waiting.workflowInstanceId,
    {
      kind: signalName('orchestration.watch-gate-verdict'),
      outcome: 'done',
      actorId: 'a-human',
      actorDecision: { authorized: true, evidenceId: 'issue-comment-9' },
      providerEventId: 'issue-comment-9',
    },
    { ...baseContext, commandId: 'human-verdict-1' },
  );
  expect(accepted.status).toBe('completed');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/signals.test.ts`
Expected: FAIL — the REJECTED case resumes to `route.target` (`Complete`) instead of `onRejectResume`, since `acceptSignal` doesn't branch on `signal.outcome` yet.

- [ ] **Step 3: Implement the branch in `acceptSignal`**

In `src-next/orchestration/domain/signal-policy.ts`, `acceptSignal`'s resume section changes from:

```typescript
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(state, input, OrchestrationEventType.SignalAccepted, { ...signal, authority }, 1),
  ];
  if (expected.resume !== undefined) {
    resumeToTarget(events, definition, state, input, expected.resume);
  } else {
    const stage = definition.stages[stageName(state.currentStage)]!;
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.ActivityRequested,
        activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
          execution: stage.execution,
        }),
        events.length + 1,
      ),
    );
  }
  return { kind: 'append', events };
```

to:

```typescript
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(state, input, OrchestrationEventType.SignalAccepted, { ...signal, authority }, 1),
  ];
  const rejectTarget =
    signal.outcome === ActivityOutcomeKind.Rejected ? expected.onRejectResume : undefined;
  if (rejectTarget !== undefined) {
    resumeToTarget(events, definition, state, input, rejectTarget);
  } else if (expected.resume !== undefined) {
    resumeToTarget(events, definition, state, input, expected.resume);
  } else {
    const stage = definition.stages[stageName(state.currentStage)]!;
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.ActivityRequested,
        activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
          execution: stage.execution,
        }),
        events.length + 1,
      ),
    );
  }
  return { kind: 'append', events };
```

(`ActivityOutcomeKind` is already imported in this file for `acceptWaitingOutcome`/`waitingOutcome` — no new import needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/orchestration/signals.test.ts`
Expected: PASS, including every pre-existing test in the file (this branch only activates when `signal.outcome === 'rejected'`, which no pre-existing Signal construction ever sets — confirm no regression).

- [ ] **Step 5: Verify and commit**

Run: `npm run verify:next`
Expected: PASS.

```bash
git add src-next/orchestration/domain/signal-policy.ts test-next/unit/orchestration/signals.test.ts
git commit -m "feat(orchestration): acceptSignal resumes to onRejectResume on a rejected watch-gate verdict"
```

---

## Stage 4: Dark-factory `watchGate` scenarios (2a, 2b, human override)

### Task 4.1: E2E-DARKFACTORY-001 — happy path, one reject-then-approve cycle

**Files:**
- Create: `test-next/e2e/scenarios/dark-factory-happy-path.test.ts`

**Interfaces:**
- Consumes: Stage 3's `watchGate` mechanism end-to-end via `world.startWorkflow`/`world.advance`/`world.triggerWatch`/`world.acceptSignal`.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-001',
    title: 'dark-factory happy path with one reject-then-approve review cycle',
    given: [
      'refine gated by a plan-review watch, implement gated by a pr-review watch',
      'plan-review always approves; pr-review rejects once, then approves',
    ],
    when: [
      'refine succeeds and plan-review approves',
      'implement succeeds, pr-review rejects, implement runs again',
      'implement succeeds again, pr-review approves',
    ],
    then: [
      'exactly two pr-review children are requested, within budget',
      'the parent status/stage only ever changes via an accepted signal or its own outcome',
      'the workflow reaches completed',
    ],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    world.registerActivity({
      name: activityName('plan-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    let prReviewAttempts = 0;
    world.registerActivity({
      name: activityName('pr-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'rejected']) }).strict(),
      outcomeKinds: ['done', 'rejected'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          prReviewAttempts += 1;
          return prReviewAttempts === 1 ? { kind: 'rejected' } : { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('plan-review', {
      stages: { review: { activity: 'plan-review', with: {}, on: { done: { then: 'done' } } } },
    });
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: { done: { then: 'done' }, rejected: { then: 'done' } },
        },
      },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          on: { done: { then: 'implement', watchGates: ['plan-review'] } },
        },
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'plan-review',
          while: { stages: ['refine'], statuses: ['waiting'] },
          on: { events: ['plan-review.requested'] },
          workflow: 'plan-review',
          maxPerGroup: 1,
        },
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['pr-review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 2,
        },
      ],
    });
    const work = await world.createWork({ objective: 'dark-factory happy path' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });

    await world.advance(work.workItemId); // refine succeeds, waits on plan-review gate
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('waiting');

    await world.triggerWatch('plan-review.requested', 'plan-1');
    await world.advance(work.workItemId); // plan-review child runs to done
    const planChildId = `${parent.workflowInstanceId}:watch:plan-review:trigger:plan-1`;
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: 'orchestration.watch-gate-verdict' as never,
      outcome: 'done' as never,
      actorId: 'plan-review-bot',
      actorDecision: { authorized: true, evidenceId: planChildId },
      providerEventId: `${planChildId}:verdict`,
      authority: { kind: 'watch', watch: 'plan-review' } as never,
    });

    await world.advance(work.workItemId); // implement succeeds, waits on pr-review gate
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('waiting');
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.currentStage).toBe('implement');

    await world.triggerWatch('pr-review.requested', 'pr-1');
    await world.advance(work.workItemId); // pr-review child #1 rejects
    const pr1ChildId = `${parent.workflowInstanceId}:watch:pr-review:trigger:pr-1`;
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: 'orchestration.watch-gate-verdict' as never,
      outcome: 'rejected' as never,
      actorId: 'pr-review-bot',
      actorDecision: { authorized: true, evidenceId: pr1ChildId },
      providerEventId: `${pr1ChildId}:verdict`,
      authority: { kind: 'watch', watch: 'pr-review' } as never,
    });
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.currentStage).toBe('implement');

    await world.advance(work.workItemId); // implement runs again, succeeds
    await world.triggerWatch('pr-review.requested', 'pr-2');
    await world.advance(work.workItemId); // pr-review child #2 approves
    const pr2ChildId = `${parent.workflowInstanceId}:watch:pr-review:trigger:pr-2`;
    await world.acceptSignal(parent.workflowInstanceId, {
      kind: 'orchestration.watch-gate-verdict' as never,
      outcome: 'done' as never,
      actorId: 'pr-review-bot',
      actorDecision: { authorized: true, evidenceId: pr2ChildId },
      providerEventId: `${pr2ChildId}:verdict`,
      authority: { kind: 'watch', watch: 'pr-review' } as never,
    });

    expect(await world.events('orchestration.child-requested')).toHaveLength(3); // 1 plan-review + 2 pr-review
    expect(
      (await world.events('orchestration.child-requested')).filter(
        (event) => (event.payload as { watchId: string }).watchId === 'pr-review',
      ),
    ).toHaveLength(2);
    expect(await world.events('orchestration.stage-entered')).toHaveLength(3); // refine, implement, implement
    expect(await world.events('orchestration.retry-counted')).toHaveLength(0);
    expect(await world.events('orchestration.instance-blocked')).toHaveLength(0);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/dark-factory-happy-path.test.ts`
Expected: PASS. If the `as never` casts on the literal signal `kind`/`outcome`/`authority` string values cause a type error instead of compiling, check `test-next/e2e/support/world.ts`'s `acceptSignal` signature — it types `signal` as `Parameters<typeof this.orchestration.acceptSignal>[1]`, which is the real branded `OrchestrationSignal` type; construct the literal via the exported `signalName`/`watchId` branding functions instead of `as never` if the cast doesn't satisfy the compiler (e.g. `kind: signalName('orchestration.watch-gate-verdict')`, `authority: { kind: 'watch', watch: watchId('pr-review') }` — both already imported patterns in this codebase's other tests). Prefer removing the casts and importing the real brand functions once the test compiles; the `as never` fallback above is a starting point, not the required final form.

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/dark-factory-happy-path.test.ts
git commit -m "test: add E2E-DARKFACTORY-001 dark-factory happy-path scenario"
```

### Task 4.2: E2E-DARKFACTORY-002 — repeated rejection exhausts the watch budget, blocking the parent

**Files:**
- Create: `test-next/e2e/scenarios/dark-factory-loop-guard.test.ts`

**Interfaces:**
- Consumes: same as Task 4.1, plus `child-loop-guard.test.ts`'s pattern for asserting `orchestration.group-budget-exhausted`/`orchestration.instance-blocked`.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-002',
    title: 'three real rejections exhaust the watch budget and block the parent',
    given: [
      'implement gated by a pr-review watch with maxPerGroup: 3',
      'the first review fails twice technically then rejects; the next two reject on their first attempt',
    ],
    when: ['three review cycles each reject in turn, and implement runs a 4th time'],
    then: [
      'exactly three pr-review children are requested, no fourth',
      'the fourth review request exhausts the budget and blocks the parent',
    ],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    let child1Attempts = 0;
    let currentChild = 1;
    world.registerActivity({
      name: activityName('pr-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['failed', 'rejected']) }).strict(),
      outcomeKinds: ['failed', 'rejected'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          if (currentChild === 1) {
            child1Attempts += 1;
            return child1Attempts <= 2 ? ({ kind: 'failed' } as const) : ({ kind: 'rejected' } as const);
          }
          return { kind: 'rejected' } as const;
        },
      },
    });
    world.configureWorkflow('pr-review', {
      stages: {
        review: {
          activity: 'pr-review',
          with: {},
          on: {
            rejected: { then: 'done' },
            failed: { retry: { max: 2 }, then: 'await-human' },
          },
        },
      },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['pr-review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 3,
        },
      ],
    });
    const work = await world.createWork({ objective: 'implement with a persistent objector' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      currentChild = cycle;
      await world.advance(work.workItemId); // implement succeeds, waits on pr-review gate
      await world.triggerWatch('pr-review.requested', `pr-${cycle}`);
      if (cycle === 1) {
        await world.advance(work.workItemId); // attempt 1: fails
        await world.advance(work.workItemId); // attempt 2: fails
        await world.advance(work.workItemId); // attempt 3: rejects
      } else {
        await world.advance(work.workItemId); // rejects first try
      }
      const childId = `${parent.workflowInstanceId}:watch:pr-review:trigger:pr-${cycle}`;
      await world.acceptSignal(parent.workflowInstanceId, {
        kind: 'orchestration.watch-gate-verdict' as never,
        outcome: 'rejected' as never,
        actorId: 'pr-review-bot',
        actorDecision: { authorized: true, evidenceId: childId },
        providerEventId: `${childId}:verdict`,
        authority: { kind: 'watch', watch: 'pr-review' } as never,
      });
    }

    await world.advance(work.workItemId); // implement's 4th attempt, succeeds
    await world.triggerWatch('pr-review.requested', 'pr-4');

    expect(await world.events('orchestration.child-requested')).toHaveLength(3);
    expect(await world.events('orchestration.retry-counted')).toHaveLength(2);
    expect(await world.events('orchestration.group-budget-exhausted')).toHaveLength(1);
    expect(await world.events('orchestration.instance-blocked')).toHaveLength(1);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('blocked');
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/dark-factory-loop-guard.test.ts`
Expected: PASS. If `orchestration.instance-blocked` doesn't fire on the fourth `triggerWatch`, check `child-loop-guard.test.ts`'s exact sequencing for how a budget-exhausted trigger produces `InstanceBlocked` — it may require an explicit `world.advance(work.workItemId)` call after the fourth `triggerWatch`, not just the trigger itself; add one if needed and confirm against that existing test's own pattern.

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/dark-factory-loop-guard.test.ts
git commit -m "test: add E2E-DARKFACTORY-002 loop-guard scenario"
```

### Task 4.3: E2E-DARKFACTORY-004 — a human's own decision always overrides a `watchGate`

**Files:**
- Create: `test-next/e2e/scenarios/dark-factory-human-override.test.ts`

**Interfaces:**
- Consumes: same as Task 4.1, minus any watch trigger.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the scenario test**

```typescript
import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-DARKFACTORY-004',
    title: "a human's own decision always overrides a watchGate",
    given: ['implement gated by a pr-review watch, no watch ever triggered'],
    when: ["a human's own accepted signal carries outcome: done directly"],
    then: ['the gate passes on the human signal alone; no pr-review child is ever requested'],
  },
  async () => {
    const world = new TestWorld();
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    world.registerActivity({
      name: activityName('pr-review'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: { async execute() { return { kind: 'done' } as const; } },
    });
    world.configureWorkflow('pr-review', {
      stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' } } } },
    });
    world.configureWorkflow('dark-factory', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done', watchGates: ['pr-review'] } },
        },
      },
      watches: [
        {
          id: 'pr-review',
          while: { stages: ['implement'], statuses: ['waiting'] },
          on: { events: ['pr-review.requested'] },
          workflow: 'pr-review',
          maxPerGroup: 1,
        },
      ],
    });
    const work = await world.createWork({ objective: 'implement, human overrides the gate' });
    const parent = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('dark-factory'),
    });

    await world.advance(work.workItemId); // implement succeeds, waits on pr-review gate
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('waiting');

    await world.acceptSignal(parent.workflowInstanceId, {
      kind: 'orchestration.watch-gate-verdict' as never,
      outcome: 'done' as never,
      actorId: 'a-human',
      actorDecision: { authorized: true, evidenceId: 'issue-comment-9' },
      providerEventId: 'issue-comment-9',
    });

    expect(await world.events('orchestration.child-requested')).toHaveLength(0);
    expect((await world.viewWorkflow(parent.workflowInstanceId))?.status).toBe('completed');
  },
);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --config vitest.next.e2e.config.ts test-next/e2e/scenarios/dark-factory-human-override.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test-next/e2e/scenarios/dark-factory-human-override.test.ts
git commit -m "test: add E2E-DARKFACTORY-004 human-override scenario"
```

---

## Stage 5: UI coverage — the child-run indicator

### Task 5.1: board-card render assertion for an active child run

**Files:**
- Modify: `src-next/surfaces/web/test/board.test.tsx`

**Interfaces:**
- Consumes: whatever `board.test.tsx` already imports to render a board card with a given work-item view (read the file first — it already builds fixture view objects for other card states; match that pattern for a view carrying an `activeRun`).
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the failing test**

Read `src-next/surfaces/web/test/board.test.tsx` and `src-next/surfaces/web/src/features/board/board-card.tsx` first to find the exact prop/view shape `activeRun` lives on (confirmed present in `board-card.tsx` around its `styles.childRun`/`styles.childRunDot` rendering) and the file's existing render-and-query pattern (likely `render(...)` + `screen.getByText`/`queryByText` from a testing-library import already used elsewhere in the file). Add two tests matching that exact pattern:

```typescript
it('shows the child-run indicator when the work item has an active child run', () => {
  const view = /* this file's existing board-card fixture builder, extended with
    activeRun: { action: 'pr-review', ...whatever other fields board-card.tsx reads } */;
  render(/* however this file already renders a BoardCard with a given view */);
  expect(screen.getByText(/running/i)).toBeInTheDocument();
});

it('does not show the child-run indicator when there is no active child run', () => {
  const view = /* same fixture builder, omitting activeRun */;
  render(/* same render call */);
  expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails (or passes if it happens to already work)**

Run: `npm run test:web`
Expected: either PASS immediately (if `board-card.tsx`'s existing `activeRun` rendering already works correctly and this is genuinely just a missing-test gap, not a missing-feature gap — per the design doc, `board-card.tsx` already renders this, so this is the likely outcome) or FAIL with a concrete mismatch to fix. If it fails, fix `board-card.tsx`'s rendering to match, re-run, confirm PASS. Do not skip this verification step even though the design doc says the underlying render code already exists — confirm it actually works before declaring the gap closed.

- [ ] **Step 3: Commit**

```bash
git add src-next/surfaces/web/test/board.test.tsx
git commit -m "test: assert board card renders the active child-run indicator"
```

---

## Self-Review Notes

- **Spec coverage:** every row in the design doc's AC coverage matrix has a task above, except the two rows explicitly marked "existing" (`workflow-selector.test.ts`/`intake-rules.test.ts` for label-driven workflow selection) and the "Verdict marker → Signal translation itself" row, which is out of scope per the design doc (needs the JSON-marker outbound/inbound work, not scoped here).
- **Two corrections made while planning, not present in the design doc as written:** the inline-watch-workflow shorthand is descoped (Global Constraints), and `E2E-LIFECYCLE-004`'s Then block is narrower than designed (drops the label-reconciliation assertion the fake provider can't produce). Both are called out explicitly above rather than silently diverging from the design doc — the design doc itself should be updated to match before anyone else reads it as current.
- **Type/name consistency checked:** `WatchGateVerdictSignal` (Task 3.1) is the one name used everywhere it's referenced (Tasks 3.4, 3.5, 4.1–4.3's literal `'orchestration.watch-gate-verdict'` strings match it exactly). `CompiledWatchGate.watch`/`onRejectTarget` field names are used consistently in Tasks 3.2–3.4. `outcome`/`onRejectResume` field names match between Task 3.1's contract and every later consumer.
