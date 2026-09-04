# Subscription-Only Real-Time Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy inline activation scheduling and run every registered projection as an independent, durable, event-driven subscription.

**Architecture:** Persistence supplies a reusable one-pass subscription primitive, an idempotent projection batch applier, and a same-consumer-locked rebuilder. Bootstrap wraps each existing projection definition in its own `projection:<name>` durable consumer, supervises all consumers beside the always-on activation scheduler subscriber, and supplies explicit one-shot and delivery freshness barriers without a centralized resident projection pump.

**Tech Stack:** TypeScript, Node.js filesystem adapters, Zod configuration, Vitest unit/integration/E2E tests.

---

### Task 1: Add reusable single-pass durable subscription execution

**Files:**
- Modify: `src/persistence/application/durable-subscription-host.ts`
- Modify: `src/persistence/durable-subscription-host.spec.md`
- Test: `test/unit/persistence/durable-subscription-host.test.ts`

- [ ] **Step 1: Write failing single-pass tests**

Add tests proving that `runOnce` reads only the named consumer's unread bounded
batch, checkpoints after a successful handler, returns the checkpoint and event
count, does not checkpoint a failed handler, and serializes against a resident
loop with the same consumer while allowing a different consumer to proceed.

```ts
const pass = await host.runOnce({
  consumer: 'projection:work',
  batchSize: 2,
  handle: async (events) => handled.push(events.map((event) => event.globalPosition)),
});

expect(pass).toEqual({ checkpoint: 2, eventCount: 2 });
expect(await checkpoints.load('projection:work')).toBe(2);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/unit/persistence/durable-subscription-host.test.ts`

Expected: FAIL because `DurableSubscriptionHost.runOnce` does not exist.

- [ ] **Step 3: Extract the host's shared pass primitive**

Add a public result and method, and make the resident loop call the same method:

```ts
export interface DurableSubscriptionPass {
  readonly checkpoint: number;
  readonly eventCount: number;
}

async runOnce(
  subscription: DurableSubscription,
  signal: AbortSignal = new AbortController().signal,
): Promise<DurableSubscriptionPass> {
  validateSubscription(subscription);
  return this.serialiseRun(subscription.consumer, signal, async () => {
    const checkpoint = await this.checkpoints.load(subscription.consumer);
    const events = await this.journal.readAll(
      checkpoint,
      subscription.batchSize ?? defaultBatchSize,
    );
    if (events.length === 0) return { checkpoint, eventCount: 0 };
    await subscription.handle(events);
    const next = events.at(-1)!.globalPosition;
    await this.checkpoints.save(subscription.consumer, next);
    return { checkpoint: next, eventCount: events.length };
  });
}
```

Keep validation shared by `start` and `runOnce`. Preserve abort-aware keyed
locking, retry/backoff, and health transitions in the resident loop.

- [ ] **Step 4: Run focused persistence tests and verify GREEN**

Run: `npx vitest run test/unit/persistence/durable-subscription-host.test.ts test/integration/persistence/subscription-run-serialiser.test.ts`

Expected: PASS.

- [ ] **Step 5: Update the component specification and commit**

Document single-pass semantics and commit:

```bash
git add src/persistence/application/durable-subscription-host.ts src/persistence/durable-subscription-host.spec.md test/unit/persistence/durable-subscription-host.test.ts
git commit -m "feat: add bounded durable subscription passes"
```

### Task 2: Replace registered projection runs with projection subscriptions

**Files:**
- Create: `src/persistence/application/projection-subscription.ts`
- Modify: `src/persistence/index.ts`
- Modify: `src/persistence/MODULE.md`
- Modify: `src/persistence/SPEC.md`
- Modify: `src/persistence/projection-runner.spec.md`
- Test: `test/integration/persistence/projection-runner.test.ts`

- [ ] **Step 1: Write failing projection subscription tests**

Cover stable consumer naming, idempotent replay after checkpoint failure,
independent progress for a blocked and healthy projection, and rebuild/live-pass
serialization with the same keyed serialiser.

```ts
expect(projectionConsumer(definition)).toBe('projection:sample');
await applyProjectionBatch(definition, projections, events);
await applyProjectionBatch(definition, projections, events);
expect((await projections.read('sample', 'global'))?.value.count).toBe(1);
```

For rebuild, hold the `projection:sample` lock in a live pass, start rebuild,
assert the clear/reset has not begun, release the pass, and then assert replayed
value and checkpoint equal journal head. A sibling projection must remain able
to run throughout.

- [ ] **Step 2: Run the focused integration test and verify RED**

Run: `npx vitest run test/integration/persistence/projection-runner.test.ts`

Expected: FAIL because the projection subscription helpers do not exist.

- [ ] **Step 3: Implement the generic projection mechanics**

Create these public APIs:

```ts
export function projectionConsumer(definition: ProjectionDefinition): string {
  return `projection:${definition.name}`;
}

export function createProjectionSubscription<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
): DurableSubscription;

export async function applyProjectionBatch<Value>(
  definition: ProjectionDefinition<Value>,
  projections: ProjectionStore,
  events: readonly EventEnvelope[],
): Promise<void>;

export class ProjectionRebuilder {
  constructor(
    journal: EventJournal,
    projections: ProjectionStore,
    checkpoints: CheckpointStore,
    serialiseRun: SubscriptionRunSerialiser,
  );
  rebuild<Value>(definition: ProjectionDefinition<Value>, signal?: AbortSignal): Promise<number>;
}
```

`applyProjectionBatch` must preserve the stored `lastGlobalPosition` guard.
`ProjectionRebuilder.rebuild` must hold the same consumer lock across clear,
reset, bounded replay, projection writes, and checkpoint saves.

- [ ] **Step 4: Keep `ProjectionRunner` only where still required by isolated consumers**

Do not keep `runRegisteredOnce` in production composition. Retain or reduce the
class only if standalone module tests or non-runtime helpers still require
single-definition `runOnce`/`rebuild`; route rebuild correctness through the new
same-consumer implementation and remove the global registered-projection
coordination contract from current-state specs.

- [ ] **Step 5: Run persistence coverage and verify GREEN**

Run: `npx vitest run test/integration/persistence/projection-runner.test.ts test/unit/persistence/durable-subscription-host.test.ts test/integration/persistence/subscription-run-serialiser.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence test/integration/persistence/projection-runner.test.ts
git commit -m "feat: project durable facts through subscriptions"
```

### Task 3: Build the Bootstrap projection-subscription runtime

**Files:**
- Rewrite: `src/bootstrap/projection-runtime.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/index.ts`
- Modify: `src/bootstrap/persistence-composition.ts`
- Modify: `src/kernel/infrastructure/cached-journal-view.ts`
- Test: `test/unit/bootstrap/projection-runtime.test.ts`
- Test: `test/integration/bootstrap/runtime.test.ts`

- [ ] **Step 1: Write failing runtime registration and isolation tests**

Assert every definition in `runtimeProjectionDefinitions` maps to exactly one
distinct `projection:<name>` subscription. Start the runtime with one decorated
projection write blocked and prove a sibling projection reaches the same journal
head without waiting.

```ts
expect(runtime.subscriptions.map(({ consumer }) => consumer)).toEqual(
  runtimeProjectionDefinitions.map(({ name }) => `projection:${name}`),
);
```

Add a catch-up test proving a bounded pass can be invoked concurrently for all
definitions and a targeted delivery pass can run independently.

- [ ] **Step 2: Run focused Bootstrap tests and verify RED**

Run: `npx vitest run test/unit/bootstrap/projection-runtime.test.ts test/integration/bootstrap/runtime.test.ts`

Expected: FAIL because `createRuntimeProjectionSubscriptions` and the required
composition-root property do not exist.

- [ ] **Step 3: Implement `RuntimeProjectionSubscriptions`**

Replace `createRuntimeProjectionRunner` and the global file projection lock with
a Bootstrap-owned wrapper around one `DurableSubscriptionHost`, the complete
subscription list, and `ProjectionRebuilder`:

```ts
export interface RuntimeProjectionSubscriptions {
  readonly subscriptions: readonly DurableSubscription[];
  start(signal: AbortSignal): DurableSubscriptionHostRun;
  catchUpOnce(signal?: AbortSignal): Promise<number>;
  catchUp(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  rebuild(definition: ProjectionDefinition, signal?: AbortSignal): Promise<number>;
  health(): readonly SubscriptionHealth[];
}
```

`catchUpOnce` calls `host.runOnce` for every subscription with `Promise.all` and
sums event counts. `catchUp(definition)` runs only the matching subscription.
Use one shared file/in-memory keyed serialiser instance for live passes and
rebuilds. Delete `createFileProjectionRunSerialiser` and the global
`projection-runner.lock` path.

- [ ] **Step 4: Compose the runtime once and migrate direct helpers**

Expose `projectionSubscriptions` on `CompositionRoot` and
`IntegrationRuntime`. Migrate `composeDeliveryRuntime` and test-facing helpers
to explicit bounded subscription passes. Update the cached-journal comment so
it no longer names the legacy registered runner.

- [ ] **Step 5: Run focused Bootstrap and persistence tests**

Run: `npx vitest run test/unit/bootstrap/projection-runtime.test.ts test/integration/bootstrap/runtime.test.ts test/integration/persistence/projection-runner.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bootstrap src/kernel/infrastructure/cached-journal-view.ts test/unit/bootstrap/projection-runtime.test.ts test/integration/bootstrap/runtime.test.ts
git commit -m "feat: compose independent projection subscriptions"
```

### Task 4: Remove inline scheduling and the temporary configuration

**Files:**
- Modify: `src/control-plane/contracts/config.ts`
- Modify: `src/control-plane/application/runner-pipeline.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/runner-tick-adapter.ts`
- Modify: `src/bootstrap/initialise.ts`
- Test: `test/unit/bootstrap/root-schema.test.ts`
- Test: `test/unit/control-plane/runner-pipeline.test.ts`
- Test: `test/unit/bootstrap/surface-cli-applications.test.ts`
- Test: `test/e2e/scenarios/tick-resident-equivalence.test.ts`

- [ ] **Step 1: Write failing fixed-architecture tests**

Replace dual-mode assertions with:

```ts
expect(() => parseConfig({
  controlPlane: { activationScheduler: { mode: 'inline' } },
})).toThrow();
expect(root.activationSchedulerSubscriber).toBeDefined();
```

Assert `RunnerPipelineStages` has no scheduler callback, one-shot ticks always
call `activationSchedulerSubscriber.poke`, resident ticks never call the
scheduler inline, and generated config omits `activationScheduler`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/unit/bootstrap/root-schema.test.ts test/unit/control-plane/runner-pipeline.test.ts test/unit/bootstrap/surface-cli-applications.test.ts test/e2e/scenarios/tick-resident-equivalence.test.ts`

Expected: FAIL on the existing mode field and inline branch.

- [ ] **Step 3: Remove the mode and inline runtime path**

- Delete `ControlPlaneConfig.activationScheduler` and its Zod schema/default.
- Always construct a required `activationSchedulerSubscriber`.
- Remove `advance` and `inlineActivationScheduling` from `RunnerPipelineStages`.
- Make `createOneShotRunnerAdvance` require the subscriber and return its
  `poke()` result.
- Make resident advancement run the non-scheduling pipeline and return
  `{ kind: 'no-work' }` only as the `TickHost` adapter result.
- Remove the generated YAML stanza and all optional subscriber guards.

- [ ] **Step 4: Preserve pause and one-shot ordering**

The runner pipeline still checks pause at stage boundaries. One-shot order must
remain schedules/reactors/publication, projection catch-up, scheduler poke,
then delivery; delivery failure must not prevent dispatch.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/control-plane src/bootstrap test/unit/bootstrap/root-schema.test.ts test/unit/control-plane/runner-pipeline.test.ts test/unit/bootstrap/surface-cli-applications.test.ts test/e2e/scenarios/tick-resident-equivalence.test.ts
git commit -m "refactor: make subscription scheduling mandatory"
```

### Task 5: Supervise real-time projections and preserve delivery freshness

**Files:**
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/runner-tick-adapter.ts`
- Modify: `src/bootstrap/surface-api-applications.ts`
- Test: `test/unit/bootstrap/surface-cli-applications.test.ts`
- Test: `test/unit/bootstrap/surface-api-system-applications.test.ts`
- Test: `test/integration/bootstrap/runtime.test.ts`
- Test: `test/e2e/scenarios/terminal-failure-does-not-starve-ready-work.test.ts`

- [ ] **Step 1: Write failing lifecycle, health, and delivery tests**

Add tests proving resident start launches projection and scheduler subscriptions,
abort awaits both, per-projection degraded health is visible, and a newly
appended delivery intent is delivered without waiting for fallback.

Use a blocked unrelated projection in the delivery scenario and assert it does
not prevent the targeted delivery projection pass or scheduler dispatch.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/unit/bootstrap/surface-cli-applications.test.ts test/unit/bootstrap/surface-api-system-applications.test.ts test/integration/bootstrap/runtime.test.ts test/e2e/scenarios/terminal-failure-does-not-starve-ready-work.test.ts`

Expected: FAIL because the resident projection host and health aggregation are
not yet wired.

- [ ] **Step 3: Replace the projection pump with supervised subscriptions**

In `start.run`, start `root.projectionSubscriptions` before the scheduler and
resident hosts. In `finally`, abort both subscription runs and await both
`done` promises before closing HTTP servers. Delete `runProjectionPump` and its
wait helpers/tests.

- [ ] **Step 4: Add explicit freshness barriers**

One-shot ticks call all-projection catch-up before and after fact-producing
stages and in `finally`. Before `DeliveryService.deliverNext`, call the targeted
delivery projection subscription pass. Do not make the resident runner wait on
unrelated projections.

- [ ] **Step 5: Aggregate subscription health**

Expose one scheduler health check and one check per registered projection. A
starting, degraded, or unexpectedly stopped consumer is degraded; a healthy
consumer is ok. Include consumer checkpoint and consecutive failure count.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bootstrap test/unit/bootstrap/surface-cli-applications.test.ts test/unit/bootstrap/surface-api-system-applications.test.ts test/integration/bootstrap/runtime.test.ts test/e2e/scenarios/terminal-failure-does-not-starve-ready-work.test.ts
git commit -m "feat: supervise real-time projection subscriptions"
```

### Task 6: Migrate projection consumers, rebuilds, and current-state documentation

**Files:**
- Modify: `test/e2e/support/world.ts`
- Modify: `test/e2e/scenarios/api-domain-shape.test.ts`
- Modify: `test/e2e/scenarios/runner-pause-fallback.test.ts`
- Modify: `test/e2e/scenarios/projection-recovery.test.ts`
- Modify: `test/e2e/scenarios/pr-correlation.test.ts`
- Modify: `test/unit/resources/lookup-projections.test.ts`
- Modify: direct `projectionRunner` callers found by `rg`
- Modify: `src/bootstrap/MODULE.md`
- Modify: `src/bootstrap/SPEC.md`
- Modify: `src/control-plane/MODULE.md`
- Modify: `src/control-plane/SPEC.md`
- Modify: `src/control-plane/application/advance-once.spec.md`
- Modify: `src/control-plane/infrastructure/tick-host.spec.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Replace all direct registered-runner calls**

Run:

```bash
rg -n "projectionRunner|runProjectionPump|runRegisteredOnce|createRuntimeProjectionRunner|createFileProjectionRunSerialiser|inlineActivationScheduling|activationScheduler.*mode" src test docs --glob '!docs/superpowers/**'
```

Migrate runtime callers to `projectionSubscriptions.catchUpOnce`, targeted
`catchUp`, or `rebuild`. Remove legacy pump/mode references from current-state
documentation. Historical plans and design records remain unchanged.

- [ ] **Step 2: Add composed real-time projection evidence**

Update `api-domain-shape` or add a focused E2E scenario that starts projection
subscriptions, appends representative orchestration and `run-started` facts,
queries the real board/API application without a manual catch-up call, and
waits on the durable projection checkpoint rather than sleeping.

- [ ] **Step 3: Strengthen rebuild recovery**

Prove rebuild uses the existing `projection:<name>` checkpoint, preserves
journal bytes, reaches journal head, and cannot race a live pass into checkpoint
regression or lost facts.

- [ ] **Step 4: Run affected suites**

Run:

```bash
npx vitest run test/unit/bootstrap test/unit/control-plane test/unit/persistence test/integration/bootstrap test/integration/persistence
npx vitest run test/e2e/scenarios/api-domain-shape.test.ts test/e2e/scenarios/runner-pause-fallback.test.ts test/e2e/scenarios/projection-recovery.test.ts test/e2e/scenarios/pr-correlation.test.ts test/e2e/scenarios/tick-resident-equivalence.test.ts test/e2e/scenarios/terminal-failure-does-not-starve-ready-work.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run static documentation checks and commit**

Run:

```bash
npm run lint:architecture
npm run check:catalogue
npm run check:scenarios
npm run format:check
git diff --check
```

Commit:

```bash
git add src test docs/configuration.md
git commit -m "docs: describe subscription-only runtime"
```

### Task 7: Full verification and final review

**Files:**
- Modify only files required by concrete verification failures caused by this change.

- [ ] **Step 1: Run the fast verification gate**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 2: Run integration, E2E, web, and dead-code gates**

Run:

```bash
npm run test:integration
npm run test:e2e
npm run test:web
npm run knip
```

Expected: PASS, or any baseline/environment-only timeout must be reproduced on
the unchanged base commit and reported precisely.

- [ ] **Step 3: Request branch-wide architecture and code review**

The reviewer must verify:

- no production inline scheduling path remains;
- no scheduler-mode config remains outside historical documents;
- every runtime projection is independently subscribed;
- delivery has an explicit freshness barrier;
- one-shot and resident lifecycle/abort semantics are correct;
- rebuild shares the live consumer lock;
- existing checkpoints migrate without renaming.

- [ ] **Step 4: Fix review findings through TDD and re-run affected gates**

For each finding, add or adjust the smallest failing regression test, verify the
failure, implement the correction, and re-run the focused plus broad relevant
suite.

- [ ] **Step 5: Confirm a clean branch**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -12
```

Expected: clean worktree with all implementation commits on
`feat/event-driven-runtime`.
