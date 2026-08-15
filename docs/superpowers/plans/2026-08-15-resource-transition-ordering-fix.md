# Resource-Transition Ordering Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issue #604 — bound the unbounded lock-wait loop in the
resource-transition ordering coordinator (production liveness hazard), then
replace the whole cross-process mutex mechanism with a local idempotency
guard in `acceptResourceTransition`, and fix a self-looping example in
`docs/workflows.md`.

**Architecture:** `src/bootstrap/resource-transition-ordering.ts` currently
serializes every trigger-carrying journal append and every signal acceptance
through one `OperationCoordinator` backed by a cross-process file lock with
an unbounded retry loop. Step 1 bounds that loop with a timeout so a wedged
holder can no longer block the system forever. Step 2 deletes the mechanism
entirely: `createResourceTransitionReactor` already serializes its own
`runOnce`/`drain` in-process (a `serialize` fallback already exists in that
file, unused because callers currently pass the external coordinator
instead); `acceptResourceTransition` gets a local catch-reload-check guard
matching the existing precedent in `advance-workflow.ts`
(`retryBlockedFailedStage` / `resumeBlockedStageForChanges`); and
`test/e2e/support/world.ts` already demonstrates the resulting simpler
wiring (`setAcceptSignalOperationCoordinator` just drains then runs the
operation, no external coordinator object).

**Tech Stack:** TypeScript, Vitest.

**Spec:** GitHub issue https://github.com/atolis-hq/wake/issues/604 (full
text below). No separate design doc — this plan argues directly from the
issue. Do not edit `docs/superpowers/specs/2026-08-15-resource-transition-reactor-design.md`
or `docs/superpowers/plans/2026-08-15-resource-transition-reactor.md`; they
are historical and out of scope per AGENTS.md.

## Global Constraints

- Do not blanket-revert #602. The reactor, the capability-keyed evidence
  port, `OrchestrationRepository.list`, and the Bootstrap extractions stay.
- `src/persistence/filesystem/file-lock.ts` (`staleRequiresDeadProcess`,
  immutable owner records) stays unchanged — it is independently used by
  `FileEventJournal.append` (via `withFileLock`) and
  `src/bootstrap/update-maintenance-lease.ts`. Confirmed by reading both
  call sites; no action needed there.
- Follow the existing catch-reload-check-marker-rethrow idempotency pattern
  from `src/orchestration/application/advance-workflow.ts:172-179` — do not
  branch on the error type (`WrongExpectedSequenceError`); catch broadly
  like that precedent does.
- `docs/workflows.md` must describe the system as it exists now (AGENTS.md).

## Issue text (for reference)

Two concurrent `applyResourceTransition` calls for the same instance with
different `commandId`s are reachable by design (wait-start catch-up path vs.
live fact path derive different command ids for the same evidence). With the
same `commandId` the journal's identical-event-id idempotent write absorbs
the duplicate; with different ids the loser's `repository.append` throws an
unhandled `WrongExpectedSequenceError`.

P1: `waitForFileLock` in `src/bootstrap/resource-transition-ordering.ts:47-56`
retries every 10ms in an unbounded loop with `staleRequiresDeadProcess: true`.
An alive-but-hung holder can never be stolen from or time out, wedging every
`pr.review-accepted` / `pr.state-changed` / `pr.checks-changed` append
system-wide, indefinitely, with no surfaced error.

Tidy-up: prefer the local guard already idiomatic in this codebase
(`advance-workflow.ts`) over the global mutex. Add a local guard to
`acceptResourceTransition` (catch → reload → return current view if
`acceptedSignalIds` already contains the evidence id or the instance has
left `Waiting` → otherwise rethrow), then delete
`createTriggerAwareEventJournal` and `createResourceTransitionOrdering`,
dropping `resourceTransitionOrdering` / `resourceTransitionTriggers` from
`composePersistence` and the composition root. Keep in-process serialization
of the reactor's own `runOnce`/`drain`.

Secondary: the shipped lock path is never exercised by the suites (fixed by
deleting it, so moot). `docs/workflows.md`'s `resourceTransitions` example
routes failing checks back to `implement` with no bound — fix the docs.

---

## File Structure

- Modify: `src/bootstrap/resource-transition-ordering.ts` (Task 1, then
  deleted in Task 3)
- Modify: `test/unit/bootstrap/resource-transition-ordering.test.ts` (Task 1
  adds a test, Task 3 deletes the whole file)
- Modify: `src/orchestration/application/resource-transition-matching.ts`
  (Task 2 — local guard)
- Modify: `test/unit/orchestration/resource-transition-matching.test.ts`
  (Task 2 — new concurrent-different-commandId test, rewritten comment)
- Modify: `src/orchestration/application/resource-transition-reactor.ts`
  (Task 3 — drop unused `coordinate` param)
- Modify: `src/bootstrap/index.ts`, `src/bootstrap/persistence-composition.ts`,
  `src/bootstrap/composition-root.ts`, `src/bootstrap/integration-runtime.ts`
  (Task 3 — remove the mechanism's wiring)
- Modify: `src/orchestration/SPEC.md` (Task 3 — describe the new wiring)
- Modify: `docs/workflows.md` (Task 4 — fix the self-loop example)

---

### Task 1: Bound `waitForFileLock` with a timeout (P1)

**Files:**
- Modify: `src/bootstrap/resource-transition-ordering.ts`
- Test: `test/unit/bootstrap/resource-transition-ordering.test.ts`

**Interfaces:**
- Produces: `ResourceTransitionLockTimeoutError` (exported `Error` subclass),
  updated `createResourceTransitionOrdering(lockPath?: string, lockTimeoutMs?: number): OperationCoordinator`
  (new optional second parameter, default `30_000`).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/bootstrap/resource-transition-ordering.test.ts` (new `it`
alongside the existing ones, same file, same imports already present):

```ts
it('fails closed instead of spinning forever when the lock is held by a live, unresponsive holder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-resource-ordering-timeout-'));
  const lockPath = join(root, 'resource-transition-ordering.lock');
  const first = createResourceTransitionOrdering(lockPath);
  const second = createResourceTransitionOrdering(lockPath, 50);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));

  const firstOperation = first(async () => {
    await held;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await expect(second(async () => 'unreachable')).rejects.toThrow(
    /Timed out.*resource-transition ordering lock/,
  );

  release();
  await firstOperation;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/bootstrap/resource-transition-ordering.test.ts -t "fails closed"`
Expected: FAIL — currently `second(...)` hangs (the test times out) because
`waitForFileLock` retries forever.

- [ ] **Step 3: Implement the bounded wait**

In `src/bootstrap/resource-transition-ordering.ts`, replace the body from
`export function createResourceTransitionOrdering` through the end of
`waitForFileLock` with:

```ts
const defaultLockTimeoutMs = 30_000;

export class ResourceTransitionLockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for resource-transition ordering lock: ${path}`);
    this.name = 'ResourceTransitionLockTimeoutError';
  }
}

export function createResourceTransitionOrdering(
  lockPath?: string,
  lockTimeoutMs = defaultLockTimeoutMs,
): OperationCoordinator {
  const active = new AsyncLocalStorage<boolean>();
  let queue: Promise<unknown> = Promise.resolve();
  const coordinate: OperationCoordinator = <Result>(operation: () => Promise<Result>) => {
    if (active.getStore() === true) return operation();
    const result = queue.then(async () => {
      const lock =
        lockPath === undefined ? undefined : await waitForFileLock(lockPath, lockTimeoutMs);
      try {
        return await active.run(true, operation);
      } finally {
        await lock?.release();
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  return coordinate;
}

async function waitForFileLock(lockPath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await acquireFileLock(lockPath, {
      staleAfterMs: 60_000,
      staleRequiresDeadProcess: true,
    });
    if (lock.acquired) return lock;
    if (Date.now() >= deadline) throw new ResourceTransitionLockTimeoutError(lockPath, timeoutMs);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
```

Leave `createTriggerRegistry` and `createTriggerAwareEventJournal` (below
this in the same file) untouched for this task — they are deleted in Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/bootstrap/resource-transition-ordering.test.ts`
Expected: PASS (all four tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/resource-transition-ordering.ts test/unit/bootstrap/resource-transition-ordering.test.ts
git commit -m "fix(bootstrap): bound resource-transition ordering lock wait with a timeout"
```

---

### Task 2: Local idempotency guard in `acceptResourceTransition`

**Files:**
- Modify: `src/orchestration/application/resource-transition-matching.ts`
- Test: `test/unit/orchestration/resource-transition-matching.test.ts`

**Interfaces:**
- Consumes: `OrchestrationRepository.load(id)` returns
  `{ sequence: number; view: WorkflowInstanceView | null }`;
  `WorkflowInstanceView.acceptedSignalIds: readonly string[]`;
  `WorkflowInstanceView.waitingFor: SignalExpectationView | undefined`
  (already imported in this file).
- Produces: `acceptResourceTransition` keeps its existing signature and
  return type (`Promise<WorkflowInstanceView | null>`); behavior changes
  only on a racing `repository.append` failure.

- [ ] **Step 1: Write the failing test**

In `test/unit/orchestration/resource-transition-matching.test.ts`, replace
the comment block above the existing
`'two overlapping applies of the same confirmed evidence, same command context, produce exactly one state change'`
test (the block starting `// The genuine duplicate-evidence race...` through
`// way — see the report for that finding.`) with:

```ts
// The genuine duplicate-evidence race: both calls load the instance while it
// is still Waiting (neither has appended yet), so signal-policy's
// acceptedSignalIds guard cannot see the other call — it only protects a
// reload after a prior apply has already landed (see the sequential test
// above). Same command context: acceptResourceTransition derives the same
// causationId/eventId for both, and the journal's append() recognises the
// second draft as already-recorded instead of re-checking the expected
// sequence. Different command contexts (below) derive different eventIds,
// so the second append genuinely conflicts on sequence — that's what
// acceptResourceTransition's local catch-reload-check guard covers.
```

Then add a new test immediately after the existing same-context test:

```ts
it('two overlapping applies of the same confirmed evidence, different command contexts, produce exactly one state change', async () => {
  const { journal, service, instance, baseContext } = await waitingService();
  const mergedFact = eventEnvelope(
    ActivityEventType.PrStateChanged,
    { state: PullRequestState.Merged },
    prStream,
  );
  const matches = await service.listResourceTransitionMatches(mergedFact);
  const target = matches[0]!.transitions[0]!.target;

  const [first, second] = await Promise.all([
    service.applyResourceTransition(instance.workflowInstanceId, target, mergedFact.eventId, {
      ...baseContext,
      commandId: 'apply-concurrent-a',
    }),
    service.applyResourceTransition(instance.workflowInstanceId, target, mergedFact.eventId, {
      ...baseContext,
      commandId: 'apply-concurrent-b',
    }),
  ]);

  expect(first?.currentStage).toBe('after-merge');
  expect(second?.currentStage).toBe('after-merge');
  const stageEnteredCount = (await journal.readAll(0)).filter(
    (event) =>
      event.eventType === OrchestrationEventType.StageEntered &&
      event.stream.id === instance.workflowInstanceId &&
      (event.payload as { stage?: string }).stage === 'after-merge',
  ).length;
  expect(stageEnteredCount).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/orchestration/resource-transition-matching.test.ts -t "different command contexts"`
Expected: FAIL — the loser's `repository.append` throws an unhandled
`WrongExpectedSequenceError`, so `Promise.all` rejects instead of resolving.

- [ ] **Step 3: Implement the guard**

In `src/orchestration/application/resource-transition-matching.ts`, replace
the body of `acceptResourceTransition` from `if (decision.kind === 'append')`
to the end with:

```ts
  if (decision.kind === 'append') {
    try {
      await repository.append(id, loaded.sequence, decision.events);
    } catch (error) {
      const reloaded = await repository.load(id);
      if (
        reloaded.view !== null &&
        (reloaded.view.acceptedSignalIds.includes(evidenceId) ||
          reloaded.view.waitingFor === undefined)
      )
        return reloaded.view;
      throw error;
    }
  }
  return (await repository.load(id)).view;
}
```

(The rest of the function — the `loaded`/`definition`/`decision` setup above
— is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/orchestration/resource-transition-matching.test.ts`
Expected: PASS (all tests in the file, including the new one and the
unchanged same-context test).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/application/resource-transition-matching.ts test/unit/orchestration/resource-transition-matching.test.ts
git commit -m "fix(orchestration): tolerate concurrent resource-transition applies under different command ids"
```

---

### Task 3: Delete the global mutex; keep in-process reactor serialization

**Files:**
- Delete: `src/bootstrap/resource-transition-ordering.ts`
- Delete: `test/unit/bootstrap/resource-transition-ordering.test.ts`
- Modify: `src/bootstrap/index.ts`
- Modify: `src/bootstrap/persistence-composition.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/orchestration/application/resource-transition-reactor.ts`
- Modify: `src/orchestration/SPEC.md`

**Interfaces:**
- Consumes: `createResourceTransitionReactor`'s existing internal `serialize`
  fallback (already present, unused today because `coordinate` is always
  passed) — no new code needed for in-process serialization, only removal of
  the parameter that bypasses it.
- Produces: `PersistenceComposition` loses `resourceTransitionOrdering` and
  `resourceTransitionTriggers`; `IntegrationRuntimeInput` loses the same two
  fields; `createResourceTransitionReactor` drops its 5th parameter.

This task has no new failing test to write first — it is a deletion/rewire
that must keep every existing passing test green (including
`test/e2e/scenarios/resource-transitions.test.ts`, which already exercises
the drain-before-accept ordering property this task preserves). Verify by
running the full affected suite at the end, matching
`test/e2e/support/world.ts`'s existing wiring pattern exactly (it already
does this without any external coordinator — see lines 150-174 there).

- [ ] **Step 1: Simplify `createResourceTransitionReactor`**

In `src/orchestration/application/resource-transition-reactor.ts`:
- Remove the `coordinate?: OperationCoordinator` parameter from
  `createResourceTransitionReactor`'s signature (currently the 5th param).
- Remove the `import type { OperationCoordinator } from './orchestration-service.js';` line.
- Change `return (coordinate ?? serialize)(() => runBatch(limit));` to
  `return serialize(() => runBatch(limit));` in `runOnce`.
- Change `return (coordinate ?? serialize)(async () => {` to
  `return serialize(async () => {` in `drain`.

- [ ] **Step 2: Remove the mechanism's exports and files**

- Delete `src/bootstrap/resource-transition-ordering.ts`.
- Delete `test/unit/bootstrap/resource-transition-ordering.test.ts`.
- In `src/bootstrap/index.ts`, remove the line
  `export * from './resource-transition-ordering.js';`.

- [ ] **Step 3: Simplify `composePersistence`**

In `src/bootstrap/persistence-composition.ts`, remove the
`createResourceTransitionOrdering` / `createTriggerAwareEventJournal` /
`createTriggerRegistry` import and rewrite the file to:

```ts
import type { CheckpointStore, Clock, EventJournal, ProjectionStore } from '../kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
} from '../persistence/index.js';
import type { WakePaths } from './paths.js';

export interface PersistenceCompositionOptions {
  readonly journal?: EventJournal;
  readonly projections?: ProjectionStore;
  readonly checkpoints?: CheckpointStore;
  readonly decorateJournal?: (journal: EventJournal) => EventJournal;
  readonly decorateProjections?: (projections: ProjectionStore) => ProjectionStore;
  readonly decorateCheckpoints?: (checkpoints: CheckpointStore) => CheckpointStore;
}

export interface PersistenceComposition {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly checkpoints: CheckpointStore;
}

function identity<T>(value: T): T {
  return value;
}

export function composePersistence(
  paths: WakePaths,
  clock: Clock,
  options: PersistenceCompositionOptions,
): PersistenceComposition {
  return {
    journal: (options.decorateJournal ?? identity)(
      options.journal ?? new FileEventJournal(paths.dataRoot, clock),
    ),
    projections: (options.decorateProjections ?? identity)(
      options.projections ?? new FileProjectionStore(paths.dataRoot),
    ),
    checkpoints: (options.decorateCheckpoints ?? identity)(
      options.checkpoints ?? new FileCheckpointStore(paths.dataRoot),
    ),
  };
}
```

- [ ] **Step 4: Update `composition-root.ts`**

In `src/bootstrap/composition-root.ts`:
- Change the `composePersistence` destructure from
  `const { journal, projections, checkpoints, resourceTransitionOrdering, resourceTransitionTriggers } = composePersistence(...)`
  to `const { journal, projections, checkpoints } = composePersistence(paths, clock, options);`.
- Remove the `resourceTransitionOrdering,` and `resourceTransitionTriggers,`
  lines from the `composeIntegrationRuntime({...})` call argument object.

- [ ] **Step 5: Update `integration-runtime.ts`**

In `src/bootstrap/integration-runtime.ts`:
- Remove `import type { TriggerRegistry } from './resource-transition-ordering.js';`.
- Remove `type OperationCoordinator,` from the `../orchestration/index.js`
  import list (keep the rest of that import block as-is).
- Remove the `readonly resourceTransitionOrdering: OperationCoordinator;`
  and `readonly resourceTransitionTriggers: TriggerRegistry;` fields from
  `IntegrationRuntimeInput`.
- Remove the two lines
  `input.resourceTransitionTriggers.register(resourceTransitionEvidence.triggers);`
  and `input.resourceTransitionTriggers.freeze();`.
- Change the `createResourceTransitionReactor` call from 5 arguments to 4
  (drop the trailing `input.resourceTransitionOrdering,` argument):

```ts
  const resourceTransitions = createResourceTransitionReactor(
    input.orchestration,
    resourceTransitionEvidence,
    input.journal,
    input.checkpoints,
  );
```

- Change the coordinator wiring from

```ts
  input.orchestration.setAcceptSignalOperationCoordinator((operation) =>
    input.resourceTransitionOrdering(async () => {
      await resourceTransitions.drain();
      return operation();
    }),
  );
```

  to (matching `test/e2e/support/world.ts:170-173` exactly):

```ts
  input.orchestration.setAcceptSignalOperationCoordinator(async (operation) => {
    await resourceTransitions.drain();
    return operation();
  });
```

- [ ] **Step 6: Update `src/orchestration/SPEC.md`**

Replace this passage (around line 170-174):

```
- The composed service may run an entire ordinary signal acceptance through
  an operation coordinator. Production composition holds its shared
  resource-transition ordering coordinator across the reactor drain and the
  complete signal acceptance operation, so a transition fact already in the journal
  is considered before a later signal can resolve the same wait.
```

with:

```
- The composed service may run an entire ordinary signal acceptance through
  an operation coordinator. Production composition drains the
  resource-transition reactor before every signal acceptance, so a
  transition fact already in the journal is considered before a later
  signal can resolve the same wait. `acceptResourceTransition` also
  tolerates two concurrent applications of the same evidence issued under
  different command identities: on an append conflict it reloads and treats
  the transition as already applied when the evidence id appears in
  `acceptedSignalIds` or the instance has left `Waiting`, rethrowing only a
  genuine conflict.
```

Replace this passage (around line 260-264):

```
- Bootstrap (depends on this module) composes the resource-transition reactor
  with a concrete evidence policy and its journal/checkpoint stores. That
  policy is the boundary that knows resource capability and correlation;
  Bootstrap installs one ordering coordinator around every reactor run and around
  the combined reactor drain plus complete signal acceptance operation.
```

with:

```
- Bootstrap (depends on this module) composes the resource-transition reactor
  with a concrete evidence policy and its journal/checkpoint stores. That
  policy is the boundary that knows resource capability and correlation.
  The reactor serializes its own `runOnce`/`drain` calls in-process; Bootstrap
  wires signal acceptance to drain the reactor first, with no external lock.
```

- [ ] **Step 7: Run the affected test suites**

Run, in order, fixing any remaining reference to the deleted exports:

```bash
npx vitest run test/unit/bootstrap
npx vitest run test/unit/orchestration
npx vitest run test/e2e/scenarios/resource-transitions.test.ts
```

Expected: all PASS. If TypeScript reports an unused-import or missing-export
error anywhere else (search first with
`grep -rn "resourceTransitionOrdering\|resourceTransitionTriggers\|TriggerRegistry\|createResourceTransitionOrdering\|createTriggerAwareEventJournal\|createTriggerRegistry" src test`),
remove that reference the same way.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(orchestration): replace the resource-transition mutex with in-process serialization"
```

---

### Task 4: Fix the self-looping `resourceTransitions` example in docs

**Files:**
- Modify: `docs/workflows.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Add a bound-required note after the example**

In `docs/workflows.md`, the example at (originally) lines 171-184 is:

```yaml
on:
  done:
    then: merge
    watchGates: [pr-review]
    resourceTransitions:
      - events: [pr.review-accepted]
      - events: [pr.state-changed]
        where: { state: merged }
        then: done
      - events: [pr.checks-changed]
        where: { checks: failing }
        then: implement
```

Its `pr.checks-changed { checks: failing }` entry routes back to `implement`
with no bound: `resourceTransitions` entries have no `repeat` field (the
schema in `src/orchestration/contracts/config.ts` is a closed union of
`events`/`where`/`then` only), and resuming through one
(`resumeToTarget` in `src/orchestration/domain/transition.ts`) does not
increment or check `route.repeat`/`repeatCounts` the way an ordinary route
target does. So a route cannot be bounded by adding `repeat` to it — that
key is only valid on the outer route (`on.done`), and it would not apply to
resourceTransitions resumes even there.

Directly after the closing ` ``` ` of that YAML block (before the
`Wake processes resourceTransitions through two durable reactor paths...`
paragraph), insert:

```markdown
A `resourceTransitions` entry that routes back to the same stage is not
bounded by `repeat` — that option applies only to an ordinary route
transition, not to a resource-transition resume. If failing checks can route
back into the stage that produced them, as above, verify the target
Activity's own behavior bounds retries (for example, a repair template that
gives up after N attempts), or route to a distinct stage instead of looping.
```

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `Read docs/workflows.md` (or open it) and confirm the new paragraph sits
between the YAML block and the `Wake processes resourceTransitions...`
paragraph, with correct Markdown spacing (blank line before and after).

- [ ] **Step 3: Commit**

```bash
git add docs/workflows.md
git commit -m "docs(workflows): warn that resourceTransitions resumes are not bounded by repeat"
```

---

### Task 5: Full verification pass

**Files:** None (verification only).

- [ ] **Step 1: Run the fast unit suite**

Run: `npm run test:fast`
Expected: PASS.

- [ ] **Step 2: Run the E2E suite**

Run: `npm run test:e2e`
Expected: PASS (in particular
`test/e2e/scenarios/resource-transitions.test.ts`).

- [ ] **Step 3: Run spec-drift and architecture checks**

Run: `npm run check:specs` then `npm run lint:architecture`
Expected: PASS. If `check:specs` reports drift beyond the two passages
already updated in Task 3 Step 6, use the `sync-module-specs` skill to bring
the flagged files current — do not hand-edit further without checking what
the tool actually flagged.

- [ ] **Step 4: Run the full local verification gate**

Run: `npm run verify`
Expected: PASS. Report any failure with its exact output before proceeding
to a PR; do not claim completion without this passing (or without an
explicit, named reason a specific check was left to CI, per AGENTS.md).

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "fix(orchestration): bound and then replace the resource-transition ordering mutex" --body "..."
```

Body should summarize: the P1 bounded-wait fix, the local idempotency guard
in `acceptResourceTransition` with its new concurrent-different-commandId
test, deletion of the cross-process mutex in favor of the reactor's existing
in-process serialization, confirmation that `file-lock.ts`'s
`staleRequiresDeadProcess` changes were kept (used independently by
`FileEventJournal` and `update-maintenance-lease.ts`), and the
`docs/workflows.md` fix. Reference "Closes #604".
