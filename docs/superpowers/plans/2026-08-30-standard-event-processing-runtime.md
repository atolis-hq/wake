# Standard Event-Processing Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's remaining hand-written durable reaction loops with one explicit, persistence-neutral, push-woken event-processing runtime.

**Architecture:** A new `eventing` supporting module owns processor definitions, hosting, projection adaptation, rebuilds, catch-up, and health. Persistence supplies only concrete journal/checkpoint/projection/serialisation adapters; bounded modules own typed handlers; Bootstrap registers and supervises every processor while reconciliation and non-journal scheduled work remain separate.

**Tech Stack:** TypeScript 6, Node.js 24, existing Kernel persistence ports, Vitest unit/integration/E2E suites.

---

### Task 1: Extract the common Eventing module

**Files:**
- Create: `src/eventing/MODULE.md`
- Create: `src/eventing/module.json`
- Create: `src/eventing/index.ts`
- Create: `src/eventing/contracts/event-processor.ts`
- Move and rewrite: `src/persistence/application/durable-subscription-host.ts` to `src/eventing/application/event-processor-host.ts`
- Move and rewrite: `src/persistence/application/projection-subscription.ts` to `src/eventing/application/projection-processor.ts`
- Move: `src/persistence/application/subscription-run-serialiser.ts` to `src/eventing/contracts/processor-run-serialiser.ts`
- Modify: `src/persistence/index.ts`
- Modify: `src/persistence/module.json`
- Modify: `src/persistence/MODULE.md`
- Create: `test/unit/eventing/event-processor-host.test.ts`
- Move/update: `test/integration/persistence/projection-runner.test.ts` to `test/integration/eventing/projection-processor.test.ts`
- Modify: `test/integration/persistence/subscription-run-serialiser.test.ts`

- [ ] **Step 1: Write failing processor contract and host tests**

Create tests that import the wished-for Eventing API and prove stable consumer
identity, selector filtering, ordered handling, ignored-event cursor progress,
bounded reads, checkpoint-after-success, no checkpoint after failure,
independent processor progress, push wake-up, cancellation, retry health, lag,
and same-consumer serialisation.

```ts
const definition: EventProcessorDefinition<{ value: number }> = {
  consumer: 'reactor:sample',
  name: 'sample',
  owner: 'test',
  category: EventProcessorCategory.Reactor,
  replay: EventProcessorReplay.Idempotent,
  select: (event) =>
    event.eventType === 'sample.recorded'
      ? { value: (event.payload as { value: number }).value }
      : null,
  handle: async (message) => handled.push(message.value),
};

const pass = await host.runOnce(definition);
expect(pass).toEqual({ checkpoint: 2, eventCount: 2, handledCount: 1 });
expect(await checkpoints.load('reactor:sample')).toBe(2);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run test/unit/eventing/event-processor-host.test.ts`

Expected: FAIL because `src/eventing/index.ts` and the processor API do not
exist.

- [ ] **Step 3: Implement the minimal Eventing contracts and host**

Implement closed vocabulary values for category and replay policy, validate
stable distinct consumer identities without changing existing `projection:*`,
`reactor:*`, `subscriber:*`, and adapter inbound names, and adapt each selected
message in journal order. Preserve the existing arm/recheck/wait journal semantics,
bounded batch validation, retry backoff, abort handling, and keyed run
serialisation. Extend health with owner, category, journal head, lag, and
attempt/success/failure timestamps.

- [ ] **Step 4: Verify GREEN and refactor projection support**

Run:

```bash
npx vitest run test/unit/eventing/event-processor-host.test.ts
npx vitest run test/integration/eventing/projection-processor.test.ts test/integration/persistence/subscription-run-serialiser.test.ts
```

Expected: PASS. `ProjectionDefinition` remains a Kernel contract;
`createProjectionProcessor` and `ProjectionRebuilder` live in Eventing and use
the same processor lock.

- [ ] **Step 5: Update module boundaries and commit**

Update module manifests and architecture declarations so Eventing depends only
on Kernel and Persistence depends on Kernel plus Eventing. Remove the old
Persistence subscription exports rather than retaining compatibility aliases.

```bash
git add src/eventing src/persistence test/unit/eventing test/integration/eventing test/integration/persistence
git commit -m "refactor: extract standard event processor runtime"
```

### Task 2: Migrate projection and activation processors

**Files:**
- Modify: `src/bootstrap/projection-runtime.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/control-plane/application/activation-scheduler-subscriber.ts`
- Modify: `src/control-plane/module.json`
- Modify: `src/control-plane/MODULE.md`
- Modify: `test/unit/bootstrap/projection-runtime.test.ts`
- Modify: `test/unit/control-plane/activation-scheduler-subscriber.test.ts`
- Modify: `test/integration/bootstrap/runtime.test.ts`

- [ ] **Step 1: Write failing imports, registry, and health tests**

Change tests to require Eventing types and assert that projections and the
activation scheduler are ordinary named processor definitions hosted by the
same runtime mechanics. Preserve `projection:<name>` and
`subscriber:control-plane.activation-scheduler` identities.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/bootstrap/projection-runtime.test.ts test/unit/control-plane/activation-scheduler-subscriber.test.ts test/integration/bootstrap/runtime.test.ts
```

Expected: FAIL on old Persistence subscription imports and bespoke host
composition.

- [ ] **Step 3: Migrate composition to Eventing**

Use `EventProcessorHost`, `EventProcessorDefinition`, projection adapters, and
the shared injected processor serialiser. Keep the scheduler's startup and
fallback reconciliation behavior separate from event handling, and keep its
global scheduling critical section distinct from the processor lock.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2 and expect PASS.

```bash
git add src/bootstrap src/control-plane test/unit/bootstrap test/unit/control-plane test/integration/bootstrap
git commit -m "refactor: host projections and scheduling as processors"
```

### Task 3: Migrate Orchestration reactors

**Files:**
- Modify: `src/orchestration/application/watch-reactor.ts`
- Modify: `src/orchestration/application/resource-transition-reactor.ts`
- Modify: `src/orchestration/module.json`
- Modify: `src/orchestration/MODULE.md`
- Modify: `test/unit/orchestration/watch-reactor.test.ts`
- Modify: `test/unit/orchestration/resource-transition-reactor.test.ts`
- Modify: `test/unit/orchestration/coordination-recovery.test.ts`
- Modify: `test/e2e/support/world.ts`

- [ ] **Step 1: Write failing processor-definition tests**

Require both factories to expose module-owned processor definitions with
stable existing consumers. Assert selectors ignore unrelated namespaces,
handlers derive the existing command contexts, and neither production reactor
loads or saves checkpoints.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/orchestration/watch-reactor.test.ts test/unit/orchestration/resource-transition-reactor.test.ts test/unit/orchestration/coordination-recovery.test.ts
```

Expected: FAIL because the factories still expose manual `runOnce` loops.

- [ ] **Step 3: Implement handlers and definitions**

Retain `react` as the directly testable business handler. Remove journal and
checkpoint ownership from normal processing, remove `runOnce` and `drain`, and
expose `processor` definitions consumed by Bootstrap. Keep watch reconciliation
as a separate reconciler using its distinct durable recovery checkpoint.
Replace the resource-transition `drain` coordination hook with an explicit
Eventing catch-up barrier supplied by Bootstrap.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2 plus
`npx vitest run test/e2e/scenarios/resource-transition-reactor.test.ts` when
present, and expect PASS.

```bash
git add src/orchestration test/unit/orchestration test/e2e/support/world.ts
git commit -m "refactor: express orchestration reactions as processors"
```

### Task 4: Migrate Integration reactors

**Files:**
- Modify: `src/integrations/application/artifact-registration-reactor.ts`
- Modify: `src/integrations/application/agent-run-publication-reactor.ts`
- Modify: `src/integrations/delivery/application/delivery-outcome-reactor.ts`
- Modify: `src/integrations/module.json`
- Modify: `src/integrations/MODULE.md`
- Modify: `test/integration/integrations/artifact-registration-reactor.test.ts`
- Modify: `test/unit/agent-run-publication-reactor.test.ts`
- Modify: `test/unit/integrations/delivery-outcome-reactor.test.ts`
- Modify: `test/e2e/scenarios/agent-run-publication-boundary.test.ts`
- Modify: `test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`

- [ ] **Step 1: Write failing standard-handler tests**

Require stable processor definitions for artifact registration, agent-run
publication, and delivery outcomes. Prove irrelevant events are skipped,
replayed selected events remain idempotent, and the classes no longer own
checkpoint loops.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/integration/integrations/artifact-registration-reactor.test.ts test/unit/agent-run-publication-reactor.test.ts test/unit/integrations/delivery-outcome-reactor.test.ts
```

Expected: FAIL because only `runOnce` entry points exist.

- [ ] **Step 3: Extract selectors and handlers**

Keep event decoding and all business dependencies inside Integrations. Remove
checkpoint dependencies and `runOnce`; expose processors using the original
consumer identities. Preserve deterministic command IDs and existing
idempotency protections.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2 and the two listed E2E scenarios; expect PASS.

```bash
git add src/integrations test/integration/integrations test/unit test/e2e/scenarios
git commit -m "refactor: standardise integration event reactors"
```

### Task 5: Migrate provider inbound translation

**Files:**
- Modify: `src/integrations/contracts/intake.ts`
- Modify: `src/integrations/contracts/provider.ts`
- Modify: `src/integrations/fake/inbound-translator.ts`
- Modify: `src/integrations/github/application/inbound-translator.ts`
- Modify: `src/integrations/fake/provider.ts`
- Modify: `src/integrations/github/provider.ts`
- Modify: `test/integration/integrations/provider-registry.test.ts`
- Modify: `test/integration/integrations/inbound-translator.test.ts`
- Modify: `test/integration/integrations/pr-source.test.ts`

- [ ] **Step 1: Write failing provider processor tests**

Replace `InboundTranslation.runOnce` expectations with an
`EventProcessorDefinition`. Assert each configured adapter has a distinct
preserved consumer identity, accepts only its adapter's evidence, retries via
the common host, and performs pending-correlation recovery through an explicit
reconciler rather than before every event batch.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/integration/integrations/provider-registry.test.ts test/integration/integrations/inbound-translator.test.ts test/integration/integrations/pr-source.test.ts
```

Expected: FAIL because providers still expose pass-based inbound translators.

- [ ] **Step 3: Implement provider-owned translation processors**

Expose a processor from each translator, retain provider validation and typed
translation at the integration boundary, remove checkpoint storage from the
translator constructors, and retain existing durable retry/failure facts.
Make pending-correlation recovery a separate provider reconciler called by the
maintenance lane.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2 and expect PASS.

```bash
git add src/integrations test/integration/integrations
git commit -m "refactor: subscribe provider inbound translation"
```

### Task 6: Compose and supervise the unified runtime

**Files:**
- Create: `src/bootstrap/event-processor-runtime.ts`
- Modify: `src/bootstrap/integration-runtime.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `src/bootstrap/runner-tick-adapter.ts`
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Modify: `src/bootstrap/surface-api-applications.ts`
- Modify: `src/control-plane/application/runner-pipeline.ts`
- Modify: `test/unit/bootstrap/surface-cli-applications.test.ts`
- Modify: `test/unit/bootstrap/surface-api-system-applications.test.ts`
- Modify: `test/unit/control-plane/runner-pipeline.test.ts`
- Modify: `test/integration/bootstrap/runtime.test.ts`
- Modify: `test/e2e/scenarios/tick-resident-equivalence.test.ts`

- [ ] **Step 1: Write failing registry and resident-lifecycle tests**

Assert one explicit registry contains every projection, coordinator, reactor,
and translator exactly once; resident startup launches one common host;
shutdown aborts and awaits it; one degraded processor does not stop siblings;
and health reports owner, category, checkpoint, head, and lag for every entry.

- [ ] **Step 2: Write failing real-time transition tests**

Append representative inbound, orchestration, artifact, delivery, and run
facts while the resident runtime is active. Wait on durable processor
checkpoints—not sleeps or manual passes—and assert their visible/domain effects
occur before the fallback interval.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/bootstrap/surface-cli-applications.test.ts test/unit/bootstrap/surface-api-system-applications.test.ts test/unit/control-plane/runner-pipeline.test.ts test/integration/bootstrap/runtime.test.ts test/e2e/scenarios/tick-resident-equivalence.test.ts
```

Expected: FAIL because reactors still run through the runner pipeline and
there is no unified registry.

- [ ] **Step 4: Implement explicit Bootstrap registration**

Compose all definitions once using the shared processor serialiser. Remove
reactor, publication, and inbound translation loops from runner/intake
pipelines. Retain schedules, polling, delivery activities, provider
maintenance, and reconciliation in their appropriate lanes. Convert one-shot
dependencies to named `catchUp` or `catchUpThrough` barriers. Ensure activation
scheduling happens after fact-producing catch-up and before delivery as today.

- [ ] **Step 5: Aggregate health and remove split supervision**

Replace separate projection and scheduler lifecycle/health assembly with the
unified runtime while retaining domain-specific reconciliation failure detail.
Do not retain a legacy configuration or alternate host path.

- [ ] **Step 6: Verify GREEN and commit**

Run the command from Step 3 and expect PASS.

```bash
git add src/bootstrap src/control-plane test/unit/bootstrap test/unit/control-plane test/integration/bootstrap test/e2e/scenarios/tick-resident-equivalence.test.ts
git commit -m "feat: supervise one real-time processor registry"
```

### Task 7: Remove legacy loops and update current-state documentation

**Files:**
- Modify: `src/eventing/MODULE.md`
- Create: `src/eventing/SPEC.md`
- Modify: `src/persistence/MODULE.md`
- Modify: `src/persistence/SPEC.md`
- Modify: `src/bootstrap/MODULE.md`
- Modify: `src/bootstrap/SPEC.md`
- Modify: `src/control-plane/MODULE.md`
- Modify: `src/control-plane/SPEC.md`
- Modify: `src/orchestration/MODULE.md`
- Modify: `src/integrations/MODULE.md`
- Modify: `docs/architecture/modules.md` if present
- Modify: current reference documentation found by the legacy scan

- [ ] **Step 1: Scan for legacy architecture**

Run:

```bash
rg -n "DurableSubscription|runOnce\(limit|checkpoints\.(load|save).*reactor|reactor.*checkpoints\.(load|save)|projectionSubscriptions|activationSchedulerSubscriber" src test docs --glob '!docs/superpowers/**' --glob '!docs/adrs/**' --glob '!docs/reports/**' --glob '!docs/handoffs/**'
```

Classify every match. Production manual cursor loops and split runtime types
must be removed; explicit one-shot catch-up, schedule watermarks, provider poll
watermarks, surface diagnostics, and reconciler checkpoints may remain.

- [ ] **Step 2: Add architecture enforcement tests**

Extend architecture checks so domain/adapter modules may define processors but
cannot instantiate the host or concrete serialiser, Persistence cannot own
handlers, and only Bootstrap composes the complete registry.

- [ ] **Step 3: Update current-state specifications**

Describe the implemented processor guarantees, ownership, health, explicit
registration, reconciliation lane, and persistence independence. Do not edit
historical ADRs, reports, handoffs, plans, or design inputs.

- [ ] **Step 4: Run static checks and commit**

Run:

```bash
npm run check:catalogue
npm run check:scenarios
npm run check:specs
npm run lint:architecture
npm run format:check
git diff --check
```

Expected: PASS.

```bash
git add src docs test
git commit -m "docs: define Wake event processor architecture"
```

### Task 8: Full verification and branch-wide review

**Files:**
- Modify only files required by concrete failures caused by this change.

- [ ] **Step 1: Run the fast verification gate**

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 2: Run integration and E2E suites**

Run:

```bash
npm run test:integration
npm run test:e2e
npm run test:web
npm run knip
```

Expected: PASS. Any environment-only failure must be reproduced and reported
with its exact command and output.

- [ ] **Step 3: Request branch-wide spec and code review**

Review against the design and confirm: all deployed consumer identities are
preserved; no production reactor owns a checkpoint loop; processors are
push-woken; one failure cannot stop siblings; projections rebuild under the
live lock; reconciliation is separate; Bootstrap registration is explicit;
and no SQLite or external framework dependency was introduced.

- [ ] **Step 4: Fix findings through TDD and re-run affected gates**

For each behavioral finding, add the smallest failing regression test, observe
the expected failure, implement the correction, and re-run focused and broad
relevant checks.

- [ ] **Step 5: Confirm branch state**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -15
```

Expected: only intentional committed implementation remains on
`feat/event-driven-runtime`.
