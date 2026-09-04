# Low-Latency Event-Driven Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable Wake event transitions start promptly without relying on a fast-looking polling loop, while establishing independently checkpointed, concurrently supervised subscriptions as the target runtime architecture.

**Architecture:** Durable journal position is the correctness boundary; change notifications and filesystem watches are advisory accelerators. A Persistence-owned subscription host runs named consumers independently, while one shared Control Plane activation scheduler preserves the existing recovery, reconciliation, capacity, and dispatch semantics. Bootstrap migrates scheduling behind an `inline | subscriber` switch so rollout and rollback do not create a second dispatch implementation.

**Tech Stack:** TypeScript, Node.js, Vitest, append-only event journal, filesystem checkpoints and locks.

---

## Task 1: Make journal waits position-aware and race-free

**Files:**

- Modify: `src/kernel/contracts/event-journal.ts`
- Modify: `src/kernel/contracts/journal-change-signal.ts`
- Modify: `src/kernel/infrastructure/journal-change-signal.ts`
- Modify: `src/persistence/memory/in-memory-event-journal.ts`
- Modify: `src/persistence/filesystem/file-event-journal.ts`
- Test: `test/unit/kernel/journal-change-signal.test.ts`
- Test: `test/integration/persistence/in-memory-event-journal.test.ts`
- Test: `test/integration/persistence/file-event-journal.test.ts`

- [ ] Add a red unit test proving a notification between generation observation and waiter registration resolves immediately rather than waiting for fallback.
- [ ] Add red journal tests for `waitForEventsAfter(position, signal, fallbackMs)`: immediate return when the durable tail is newer, abort, fallback, and append-during-processing interleavings.
- [ ] Run `npx vitest run test/unit/kernel/journal-change-signal.test.ts test/integration/persistence/in-memory-event-journal.test.ts test/integration/persistence/file-event-journal.test.ts` and confirm the new tests fail for the intended lost-wake/cross-instance reason.
- [ ] Replace the split observe/wait protocol with a generation-aware wait. Implement the journal-level wait as arm advisory notification, re-read durable position, then wait; the durable global position remains authoritative.
- [ ] For the filesystem journal, provide a lazy, unref'd, self-healing filesystem watcher that only advances the local advisory generation. Watch failure must degrade to fallback polling.
- [ ] Add a two-`FileEventJournal` test against one root and a many-waiter test. Prove external appends wake promptly when the watcher is available and are still discovered by fallback when it is unavailable.
- [ ] Run the focused command again and commit: `fix: make journal wakeups position-aware`.

## Task 2: Remove stale-cache and resident-loop lost wakes

**Files:**

- Modify: `src/kernel/infrastructure/cached-journal-view.ts`
- Modify: `src/persistence/application/projection-runner.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Test: `test/unit/kernel/cached-journal-view.test.ts`
- Test: `test/integration/persistence/projection-runner.test.ts`
- Test: `test/unit/bootstrap/surface-cli-applications.test.ts`

- [ ] Write barrier-based red tests that append after a pass reads the journal but before it registers its idle wait. Assert the next pass runs without consuming the 30-second fallback.
- [ ] Add a cross-instance cache test proving a reader refreshes when another file-journal instance appends.
- [ ] Run `npx vitest run test/unit/kernel/cached-journal-view.test.ts test/integration/persistence/projection-runner.test.ts test/unit/bootstrap/surface-cli-applications.test.ts` and verify the new interleaving tests fail.
- [ ] Make cached views, the projection pump, and runner idle waiting retain the durable position sampled by their completed pass and wait for events after that position. Keep the fallback for recovery; do not add a drain-the-whole-pipeline loop.
- [ ] Rerun the focused tests and commit: `fix: close resident event wake races`.

## Task 3: Add the supervised durable subscription host

**Files:**

- Create: `src/persistence/application/durable-subscription-host.ts`
- Create: `src/persistence/application/subscription-run-serialiser.ts`
- Modify: `src/persistence/index.ts`
- Modify: `src/persistence/module.json`
- Modify: `src/persistence/MODULE.md`
- Create: `test/unit/persistence/durable-subscription-host.test.ts`
- Create: `test/integration/persistence/subscription-run-serialiser.test.ts`

- [ ] Write red tests proving two named subscribers consume the same facts through independent checkpoints, a slow/failing subscriber does not stall a healthy sibling, backlog is bounded into batches, abort is clean, and degraded health recovers.
- [ ] Write a red integration test proving the same consumer is excluded across two file-backed hosts for the entire load/handle/checkpoint interval while distinct consumers may progress concurrently.
- [ ] Run `npx vitest run test/unit/persistence/durable-subscription-host.test.ts test/integration/persistence/subscription-run-serialiser.test.ts` and confirm contract failures.
- [ ] Implement a Persistence-owned host with stable consumer names, independent checkpoints, bounded reads, at-least-once processing, per-subscriber retry/backoff, and volatile health snapshots.
- [ ] Implement keyed run serialization. The file implementation must hold `subscription-<encoded-consumer>.lock` across load, handler, and checkpoint save; the memory implementation must serialize only equal keys.
- [ ] Require idempotent handlers and deterministic effect identifiers. Do not treat health or notifications as durable state.
- [ ] Update the public module surface and current-state module documentation, rerun focused tests plus `npm run lint:architecture`, and commit: `feat: add durable subscription host`.

## Task 4: Extract one activation scheduler and preserve dispatch safety

**Files:**

- Create: `src/control-plane/application/activation-scheduler.ts`
- Create: `src/control-plane/application/activation-scheduler-ports.ts`
- Modify: `src/control-plane/application/advance-once.ts`
- Modify: `src/control-plane/application/advance-once-dispatch.ts`
- Modify: `src/control-plane/application/advance-once-ports.ts`
- Modify: `src/control-plane/index.ts`
- Create: `src/bootstrap/activation-scheduler-serialiser.ts`
- Test: `test/unit/control-plane/activation-scheduler.test.ts`
- Modify: `test/unit/control-plane/advance-once.test.ts`

- [ ] Characterize the existing order with tests: pause gate, workspace recovery, transcript cleanup, active-run recovery, child reconciliation, terminal-run reconciliation, then fair capacity-aware dispatch.
- [ ] Add a concurrency test proving the scheduler critical section covers capacity read through activation claim, workspace acquisition, and durable `RunStarted`, preventing two processes from exceeding global capacity.
- [ ] Run `npx vitest run test/unit/control-plane/activation-scheduler.test.ts test/unit/control-plane/advance-once.test.ts` and verify the extraction/concurrency tests fail.
- [ ] Extract the existing behavior into one `ActivationScheduler.runOnce()` use case. Make `createAdvanceOnce()` a compatibility facade over the shared scheduler; do not introduce a second dispatch path.
- [ ] Add an injected cross-process scheduler serialiser in Bootstrap. Control Plane must depend only on the port, not filesystem locking.
- [ ] Preserve candidate ordering and current recovery semantics exactly, rerun focused tests plus `npm run lint:architecture`, and commit: `refactor: extract activation scheduler`.

## Task 5: Drive activation scheduling from a durable subscription

**Files:**

- Create: `src/control-plane/application/activation-scheduler-subscriber.ts`
- Modify: `src/control-plane/application/runner-pipeline.ts`
- Modify: `src/control-plane/contracts/config.ts`
- Modify: `src/control-plane/index.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Modify: `src/bootstrap/config/root-schema.ts`
- Modify: `src/bootstrap/initialise.ts`
- Create: `test/unit/control-plane/activation-scheduler-subscriber.test.ts`
- Modify: `test/unit/control-plane/runner-pipeline.test.ts`
- Modify: `test/unit/bootstrap/root-schema.test.ts`
- Modify: `test/integration/bootstrap/runtime.test.ts`

- [ ] Write red tests for startup reconciliation, new-journal-position scheduling, capacity release, pause/resume, expired claims without a new fact, restart from checkpoint, and failure isolation from an intentionally slow legacy reactor.
- [ ] Add config tests for `controlPlane.activationScheduler.mode: inline | subscriber`, defaulting to `inline` for rollback safety.
- [ ] Run `npx vitest run test/unit/control-plane/activation-scheduler-subscriber.test.ts test/unit/control-plane/runner-pipeline.test.ts test/unit/bootstrap/root-schema.test.ts test/integration/bootstrap/runtime.test.ts` and confirm the new behavior is absent.
- [ ] Adapt the scheduler to the durable subscription host. Treat any new journal fact as reconsideration rather than maintaining a fragile event-type allowlist; also run on startup and fallback for lease/claim expiry.
- [ ] In subscriber mode, remove inline scheduling from the resident pipeline critical path and use the same scheduler/subscriber poke for one-shot compatibility. Guard accidental overlap with the scheduler serialiser.
- [ ] Expose subscription health through the composition root and API health checks. Do not run a migrated consumer simultaneously through both the legacy pipeline and the host.
- [ ] Rerun focused tests plus `npm run lint:architecture` and commit: `feat: schedule activations from durable events`.

## Task 6: Prove user-visible latency, update current-state docs, and verify

**Files:**

- Modify: `test/integration/bootstrap/runtime.test.ts`
- Modify or create: `test/e2e/scenarios/terminal-failure-does-not-starve-ready-work.test.ts`
- Modify: `test/e2e/scenarios/tick-resident-equivalence.test.ts`
- Modify: `src/kernel/SPEC.md`
- Modify: `src/persistence/event-journal.spec.md`
- Modify: `src/persistence/projection-runner.spec.md`
- Modify: `src/control-plane/MODULE.md`
- Modify: `src/control-plane/application/advance-once.spec.md`
- Modify: `src/bootstrap/MODULE.md`
- Modify: `docs/configuration.md`

- [ ] Add a composed native-conversation test: record a message for a blocked agent workflow and assert the durable retry/activity facts cause the production-composed fake runner to start without manually draining the full pipeline.
- [ ] Add deterministic barrier-based coverage proving a slow publication/delivery reactor does not delay an unrelated ready activation, and that capacity release promptly starts pending work exactly once.
- [ ] Add resident/tick equivalence and restart coverage for both migration modes. Use sequence traces and deferred barriers, not wall-clock sleep assertions.
- [ ] Update only current-state documentation. Explicitly document advisory wakeups, durable cursors, at-least-once/idempotency expectations, scheduler serialization, migration mode, and fallback reconciliation.
- [ ] Run focused integration/E2E tests, then `npm run check:specs`, `npm run verify`, and `npm run verify:ci`. Record any pre-existing flaky test separately and rerun it in isolation.
- [ ] Request a spec-compliance review and a code-quality/architecture review from fresh agents; address verified findings with focused regression tests.
- [ ] Commit the final docs/test adjustments: `test: verify low-latency event transitions`.

## Acceptance criteria

- [ ] No append/read/wait interleaving can defer known work until the 30-second fallback.
- [ ] A separate process appending to the file journal wakes a resident subscriber promptly when filesystem notification works and is still discovered by bounded fallback when it does not.
- [ ] Many named subscribers progress independently with durable checkpoints; one slow or failed subscriber cannot globally serialize the others.
- [ ] The activation scheduler has one implementation, preserves recovery/capacity/order semantics, and is safe across competing processes.
- [ ] Native conversation resume and terminal-run-to-next-activation transitions use the event-driven path rather than a synthetic full-pipeline loop.
- [ ] Rollback to inline scheduling is configuration-only and does not require deleting durable facts or checkpoints.
- [ ] Architecture, focused tests, and full verification pass, with any unrelated baseline flake reported honestly.
