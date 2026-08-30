# Standard Event Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's draft/flat publishing model with module-owned `EventData`, nested recorded `EventEnvelope` values, and the conventional `EventJournal.appendToStream` API without changing the existing on-disk journal format.

**Architecture:** Kernel defines conventional event-store contracts; bounded modules construct typed event data and own retry/idempotency policy; Persistence alone records envelopes while preserving the flat JSONL codec; Eventing consumes recorded envelopes without knowing domain event types. Symbol-aware architecture checks prevent direct envelope construction, foreign event construction, and legacy publishing APIs.

**Tech Stack:** TypeScript, Zod, Vitest, filesystem JSONL persistence, in-memory journal, dependency-cruiser, TypeScript compiler API architecture checks.

---

### Task 1: Adopt EventData terminology repository-wide

**Files:**
- Modify: `src/kernel/contracts/events.ts`
- Modify: `src/kernel/domain/event-envelope.ts`
- Modify: `src/kernel/index.ts`
- Modify: `src/activities/contracts/events.ts`
- Modify: `src/control-plane/contracts/events.ts`
- Modify: `src/conversations/contracts/events.ts`
- Modify: `src/execution/contracts/events.ts`
- Modify: `src/integrations/contracts/artifact-events.ts`
- Modify: `src/integrations/delivery/contracts/events.ts`
- Modify: `src/integrations/github/contracts/events.ts`
- Modify: `src/orchestration/contracts/events.ts`
- Modify: `src/resources/contracts/events.ts`
- Modify: `src/work/contracts/events.ts`
- Modify: every source and test file returned by `rg -l "EventDraft|EventDraftUnion|EventDraftInput|createEventDraft" src test`
- Test: `test/unit/kernel/event-envelope.test.ts`
- Test: `test/unit/execution/event-contracts.test.ts`
- Test: `test/architecture/contract-vocabulary.test.ts`

- [ ] **Step 1: Write failing terminology tests**

Update `test/unit/kernel/event-envelope.test.ts` to import `createEventData` and assert that it constructs immutable producer data with no journal-assigned fields:

```ts
const event = createEventData({
  eventId: 'event-1',
  eventType: 'test.created',
  occurredAt: '2026-08-30T12:00:00.000Z',
  correlationId: 'correlation-1',
  causationId: 'command-1',
  actor: { kind: EventActorKind.System, id: 'test' },
  source: { kind: EventSourceKind.Internal, id: 'test' },
  stream: { kind: 'test', id: '1' },
  payload: { value: 1 },
});
expect(event).not.toHaveProperty('recordedAt');
expect(event).not.toHaveProperty('sequence');
expect(event).not.toHaveProperty('globalPosition');
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/unit/kernel/event-envelope.test.ts
```

Expected: FAIL because `createEventData` and `EventData` do not exist.

- [ ] **Step 3: Rename the universal contracts without changing their shape yet**

In `src/kernel/contracts/events.ts`, rename the declarations mechanically:

```ts
export interface EventData<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly stream: Stream;
  readonly payload: Payload;
}

export type EventDataUnion<Payloads extends object, Stream extends EntityRef> = {
  [Type in keyof Payloads & string]: EventData<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];
```

Rename `EventDraftInput` to `EventDataInput` and `createEventDraft` to `createEventData` in `src/kernel/domain/event-envelope.ts`. Rename every bounded alias from `*EventDraft` to `*EventData` and every `*EventDraftInput` to `*EventDataInput`. This step is a terminology-only mechanical migration; retain the current flat `EventEnvelope extends EventData` shape until Task 3.

Do not add deprecated aliases.

- [ ] **Step 4: Remove every legacy terminology reference**

Run:

```bash
rg -n "EventDraft|EventDraftUnion|EventDraftInput|createEventDraft" src test
```

Expected: no output.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run test/unit/kernel/event-envelope.test.ts test/unit/execution/event-contracts.test.ts test/architecture/contract-vocabulary.test.ts
npm run build
npm run lint:architecture
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: adopt event data terminology"
```

### Task 2: Standardise append-to-stream semantics

**Files:**
- Modify: `src/kernel/contracts/event-journal.ts`
- Modify: `src/persistence/memory/in-memory-event-journal.ts`
- Modify: `src/persistence/filesystem/file-event-journal.ts`
- Modify: `src/bootstrap/persistence-composition.ts`
- Modify: every source and test file returned by `rg -l "\.append\(" src test` after filtering calls whose resolved receiver is `EventJournal`
- Test: `test/integration/persistence/in-memory-event-journal.test.ts`
- Test: `test/integration/persistence/file-event-journal.test.ts`
- Test: `test/unit/kernel/journal-change-signal.test.ts`

- [ ] **Step 1: Write failing journal contract tests**

Add the same assertions to both journal integration suites:

```ts
await expect(journal.appendToStream(stream, 0, [])).rejects.toThrow(
  'appendToStream requires at least one event',
);

const recorded = await journal.appendToStream(stream, 0, [first, second]);
expect(recorded.map((event) => event.sequence)).toEqual([1, 2]);

await expect(journal.appendToStream(stream, 0, [third])).rejects.toBeInstanceOf(
  WrongExpectedSequenceError,
);
expect(await journal.latestGlobalPosition()).toBe(recorded[1]!.globalPosition);
```

Extend the change-signal test so an empty or wrong-sequence append produces no notification and a successful append produces exactly one notification.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/integration/persistence/in-memory-event-journal.test.ts test/integration/persistence/file-event-journal.test.ts test/unit/kernel/journal-change-signal.test.ts
```

Expected: FAIL because `appendToStream` is absent.

- [ ] **Step 3: Replace the journal method and implementations**

Change the Kernel port to:

```ts
appendToStream(
  stream: EntityRef,
  expectedSequence: number,
  events: readonly EventData[],
): Promise<readonly EventEnvelope[]>;
```

Both implementations must begin with:

```ts
if (events.length === 0) throw new Error('appendToStream requires at least one event');
```

Retain atomic batch writes, expected-sequence checking, ordering, lock behaviour, and notification-after-commit semantics. Rename the serialising decorator method in `src/bootstrap/persistence-composition.ts` to `appendToStream` without changing its append-tail ordering.

- [ ] **Step 4: Migrate every EventJournal call and fake**

Use TypeScript receiver types, not textual replacement alone, to change all production calls, repositories, test journals, and mocks from `append` to `appendToStream`. Calls to unrelated repositories and arrays keep their existing `append` names.

Run:

```bash
rg -n "journal\.append\(|\.journal\.append\(" src test
```

Expected: no output.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run test/integration/persistence/in-memory-event-journal.test.ts test/integration/persistence/file-event-journal.test.ts test/unit/kernel/journal-change-signal.test.ts test/integration/bootstrap/runtime.test.ts
npm run build
npm run lint:architecture
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: publish events with append to stream"
```

### Task 3: Introduce the recorded envelope and preserve the flat journal codec

**Files:**
- Modify: `src/kernel/contracts/events.ts`
- Modify: `src/kernel/contracts/event-schema.ts`
- Create: `src/persistence/filesystem/event-record-codec.ts`
- Modify: `src/persistence/filesystem/file-event-journal.ts`
- Modify: `src/persistence/memory/in-memory-event-journal.ts`
- Modify: `src/persistence/index.ts`
- Create: `test/fixtures/journal/current-flat-event.jsonl`
- Modify: `test/support/event-envelope.ts`
- Modify: all source and test consumers of `EventEnvelope` producer fields found by `rg -l "\.event(Type|Id)|\.payload|\.occurredAt|\.correlationId|\.causationId|\.actor|\.source|schemaVersion" src test`
- Test: `test/unit/kernel/event-decoding.test.ts`
- Test: `test/integration/persistence/file-event-journal.test.ts`
- Test: `test/integration/persistence/in-memory-event-journal.test.ts`
- Test: `test/e2e/support.test.ts`

- [ ] **Step 1: Add a current-format compatibility fixture and failing codec test**

Create `test/fixtures/journal/current-flat-event.jsonl` with one valid record in the exact current JSONL shape:

```json
{"eventId":"event-1","eventType":"test.created","schemaVersion":1,"occurredAt":"2026-08-30T12:00:00.000Z","correlationId":"correlation-1","causationId":"command-1","actor":{"kind":"system","id":"test"},"source":{"kind":"internal","id":"test"},"stream":{"kind":"test","id":"1"},"payload":{"value":1},"recordedAt":"2026-08-30T12:00:00.001Z","sequence":1,"globalPosition":1}
```

Add a filesystem test that opens a Wake root containing this fixture and expects:

```ts
expect(events[0]).toEqual({
  event: {
    eventId: eventId('event-1'),
    eventType: 'test.created',
    schemaVersion: 1,
    occurredAt: '2026-08-30T12:00:00.000Z',
    correlationId: correlationId('correlation-1'),
    causationId: causationId('command-1'),
    actor: { kind: EventActorKind.System, id: 'test' },
    source: { kind: EventSourceKind.Internal, id: 'test' },
    payload: { value: 1 },
  },
  stream: { kind: 'test', id: '1' },
  recordedAt: '2026-08-30T12:00:00.001Z',
  sequence: 1,
  globalPosition: 1,
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/integration/persistence/file-event-journal.test.ts -t "reads the current flat journal format as a recorded envelope"
```

Expected: FAIL because the in-memory envelope is still flat.

- [ ] **Step 3: Define the final event types**

Change Kernel to:

```ts
export interface EventData<Type extends string = string, Payload = unknown> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly payload: Payload;
}

export interface EventEnvelope<Event extends EventData = EventData, Stream extends EntityRef = EntityRef> {
  readonly event: Event;
  readonly stream: Stream;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}
```

Remove `stream` from `EventDataInput`; module stream factories remain separate.

- [ ] **Step 4: Implement the filesystem compatibility codec**

In `event-record-codec.ts`, define an internal `FlatEventRecord` schema matching the existing persisted fields. Export only:

```ts
export function decodeEventRecord(value: unknown): EventEnvelope;
export function encodeEventRecord(envelope: EventEnvelope): string;
```

`decodeEventRecord` moves producer fields under `event` and leaves stream/journal fields on the envelope. `encodeEventRecord` flattens the envelope back to the exact existing JSON property set. `file-event-journal.ts` must use these functions for every read and write; it must never serialize the nested object directly.

- [ ] **Step 5: Update journal construction and test infrastructure**

The in-memory journal creates:

```ts
const envelope: EventEnvelope = {
  event: data,
  stream,
  recordedAt: clock.now().toISOString(),
  sequence,
  globalPosition,
};
```

Update `test/support/event-envelope.ts` as the only general test helper allowed to manufacture envelopes. Replace ad hoc envelope literals in tests with this helper except tests specifically exercising invalid decoding.

- [ ] **Step 6: Migrate all consumers to the nested shape**

Use compiler errors to migrate producer fields consistently:

```ts
envelope.event.eventType
envelope.event.eventId
envelope.event.payload
envelope.event.occurredAt
envelope.event.correlationId
envelope.event.causationId
envelope.event.actor
envelope.event.source
envelope.event.schemaVersion
```

Keep `envelope.stream`, `envelope.recordedAt`, `envelope.sequence`, and `envelope.globalPosition` at envelope level. Module decoders return typed `EventEnvelope<ModuleEventData, ModuleStreamRef>` values. Surface presenters explicitly preserve their existing external transport shape; do not expose the internal nesting as an API change.

- [ ] **Step 7: Verify GREEN and on-disk stability**

Run:

```bash
npx vitest run test/unit/kernel/event-decoding.test.ts test/integration/persistence/file-event-journal.test.ts test/integration/persistence/in-memory-event-journal.test.ts test/e2e/support.test.ts
npm run build
npm run lint:architecture
```

Inspect a newly appended JSONL line and compare its property names with `current-flat-event.jsonl`; expect the same flat shape.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "refactor: separate event data from recorded envelopes"
```

### Task 4: Standardise module-owned event-data factories

**Files:**
- Create or modify: `src/activities/contracts/event-factory.ts`
- Create or modify: `src/control-plane/contracts/event-factory.ts`
- Create or modify: `src/conversations/contracts/event-factory.ts`
- Modify: `src/execution/contracts/event-factory.ts`
- Create or modify: `src/integrations/contracts/artifact-event-factory.ts`
- Modify: `src/integrations/delivery/contracts/event-factory.ts`
- Create or modify: `src/integrations/github/contracts/event-factory.ts`
- Create or modify: `src/orchestration/contracts/event-factory.ts`
- Create or modify: `src/resources/contracts/event-factory.ts`
- Create or modify: `src/work/contracts/event-factory.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/control-plane/index.ts`
- Modify: `src/conversations/index.ts`
- Modify: `src/execution/index.ts`
- Modify: `src/integrations/index.ts`
- Modify: `src/integrations/github/index.ts`
- Modify: `src/orchestration/index.ts`
- Modify: `src/resources/index.ts`
- Modify: `src/work/index.ts`
- Modify: every production file returned by `rg -l "createEventData" src --glob '!src/kernel/**'`
- Test: `test/unit/activities/event-contracts.test.ts`
- Test: `test/unit/control-plane/event-contracts.test.ts`
- Test: `test/unit/execution/event-contracts.test.ts`
- Test: `test/unit/kernel/event-decoding.test.ts`
- Test: `test/unit/orchestration/event-contracts.test.ts`
- Test: `test/unit/resources/event-contracts.test.ts`
- Test: `test/unit/work/event-contracts.test.ts`

- [ ] **Step 1: Write failing module-factory tests**

For each bounded module, add one compile/runtime test using its public factory. The Work example is:

```ts
const data = createWorkEventData({
  eventId: 'work-1:created',
  eventType: WorkEventType.Created,
  occurredAt,
  correlationId: 'work-1',
  causationId: 'create-work-1',
  actor,
  source,
  payload: { workItemId: workItemId('work-1'), objective: 'standardise publishing' },
});
expect(data.eventType).toBe(WorkEventType.Created);
expect(data).not.toHaveProperty('stream');
```

Add `@ts-expect-error` cases showing that a foreign payload cannot be passed to the factory and that the module repository rejects a foreign stream-reference type.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/unit/activities/event-contracts.test.ts test/unit/control-plane/event-contracts.test.ts test/unit/execution/event-contracts.test.ts test/unit/kernel/event-decoding.test.ts test/unit/orchestration/event-contracts.test.ts test/unit/resources/event-contracts.test.ts test/unit/work/event-contracts.test.ts
```

Expected: FAIL because the module factory exports do not yet exist.

- [ ] **Step 3: Implement module factories**

Each module factory is the only production code in that module that calls Kernel `createEventData`. It accepts the module's discriminated input union and returns the module's `*EventData` union. Use exhaustive event-type switching where necessary to preserve payload narrowing; do not use `Record<string, unknown>`, reflection, or casts through `unknown`.

The common shape is:

```ts
export function createWorkEventData(input: WorkEventDataInput): WorkEventData {
  switch (input.eventType) {
    case WorkEventType.Created:
    case WorkEventType.Ready:
    case WorkEventType.Closed:
      return createEventData(input);
  }
}
```

Export the factory through the module's public `index.ts`.

- [ ] **Step 4: Migrate owning-module construction**

Replace raw Kernel `createEventData` calls in Activities, Control Plane, Conversations, Execution, Integrations, Orchestration, Resources, and Work with the correct module-owned factory. Domain decision helpers may continue to expose more specific factory functions, but those helpers must delegate to the module contract factory.

Run:

```bash
rg -n "createEventData" src --glob '!src/kernel/**' --glob '!**/contracts/*event-factory.ts'
```

Expected: no output.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:fast
npm run build
npm run lint:architecture
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: construct events through module factories"
```

### Task 5: Remove cross-module and Bootstrap event construction

**Files:**
- Modify: `src/bootstrap/status-publish-activity.ts`
- Modify: `src/bootstrap/runner-quota-reporter.ts`
- Modify: `src/activities/issue/complete.ts`
- Modify: `src/activities/pr/decision-claim.ts`
- Modify: `src/activities/pr/event-drafts.ts`
- Modify: `src/integrations/contracts/artifact-event-factory.ts`
- Modify: `src/integrations/delivery/contracts/event-factory.ts`
- Modify: `src/control-plane/contracts/event-factory.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/control-plane/index.ts`
- Modify: `src/integrations/index.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Test: `test/unit/activities/pr-decision-claim.test.ts`
- Test: `test/unit/activities/pr-intent-outcomes.test.ts`
- Test: `test/integration/bootstrap/runtime.test.ts`
- Test: `test/e2e/scenarios/golden-path.test.ts`

- [ ] **Step 1: Add failing owner-boundary tests**

Add focused tests proving Bootstrap status publication obtains Delivery event data from an Integrations-owned factory/service and quota reporting obtains Control Plane event data from a Control Plane-owned factory. Add a compile test proving Bootstrap cannot import Kernel `createEventData` to construct these facts.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/integration/bootstrap/runtime.test.ts test/unit/activities/pr-decision-claim.test.ts test/unit/activities/pr-intent-outcomes.test.ts
```

Expected: FAIL while cross-module construction remains.

- [ ] **Step 3: Move construction behind owner APIs**

Use owner factories rather than a new command bus:

```ts
const data = createStatusPublishRequestedEventData(input);
await journal.appendToStream(resourceStream(input.resourceId), expectedSequence, [data]);
```

Bootstrap may invoke that exported Integrations factory but may not call Kernel `createEventData`. Apply the same rule to runner quota and Activities PR/resource facts. If a caller needs policy rather than construction alone, expose a narrow owner service and compose it in Bootstrap.

- [ ] **Step 4: Verify no foreign construction remains**

Inspect all module-factory imports with:

```bash
rg -n "create[A-Za-z]+EventData" src/bootstrap src/activities src/control-plane src/conversations src/execution src/integrations src/orchestration src/resources src/work
```

For every cross-module import, confirm that the caller requests construction from the owning exported factory and does not reproduce the owner's event type/payload mapping.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run test/unit/activities/pr-decision-claim.test.ts test/unit/activities/pr-intent-outcomes.test.ts test/integration/bootstrap/runtime.test.ts test/e2e/scenarios/golden-path.test.ts
npm run build
npm run lint:architecture
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "refactor: keep event construction with owners"
```

### Task 6: Enforce the publishing architecture

**Files:**
- Modify: `scripts/check-event-processor-architecture.mjs`
- Modify: `scripts/check-event-processor-architecture.d.mts`
- Rename or create: `scripts/check-event-architecture.mjs`
- Rename or create: `scripts/check-event-architecture.d.mts`
- Modify: `package.json`
- Modify: `test/architecture/event-processor-ownership.test.ts`
- Create: `test/architecture/event-publishing-ownership.test.ts`
- Modify: `src/kernel/MODULE.md`
- Modify: `src/eventing/MODULE.md`
- Modify: `src/persistence/MODULE.md`

- [ ] **Step 1: Write failing symbol-resolution fixtures**

Add fixtures covering these cases:

```ts
// allowed: owning factory
import { createEventData as make } from '../../kernel/index.js';
export const createWorkEventData = (input: WorkEventDataInput) => make(input);

// rejected: Bootstrap construction through an alias
import { createEventData as make } from '../kernel/index.js';
const event = make(input);

// rejected: envelope metadata outside a journal adapter
const envelope: EventEnvelope = { event, stream, recordedAt, sequence: 1, globalPosition: 1 };

// rejected: legacy API
await journal.append(stream, 0, [event]);

// allowed: unrelated local function
const createEventData = (value: string) => value;
```

Also cover namespace imports, re-exported aliases, local assignment aliases, computed properties, and type-only imports.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/architecture/event-publishing-ownership.test.ts
```

Expected: FAIL because publishing ownership is not enforced.

- [ ] **Step 3: Generalise the architecture checker**

Rename the checker to `check-event-architecture` and retain all processor rules. Use a TypeScript `Program` and `TypeChecker` to resolve actual imported symbols and aliases.

Enforce:

- Kernel `createEventData` may be called only from bounded module event-factory files and Kernel tests.
- `EventEnvelope` values and journal metadata may be constructed only by Persistence journal adapters and `test/support/event-envelope.ts`.
- `EventJournal.append` and all legacy Draft symbols are absent from production.
- Bootstrap, Persistence, and Eventing cannot construct bounded event data.
- Persistence and Eventing cannot import bounded event types.
- Module manifests remain the source of event-namespace ownership.

Do not reject unrelated local identifiers or type-only references.

- [ ] **Step 4: Update the static gate and module rules**

Change `npm run lint:architecture` to invoke `check-event-architecture.mjs`. Update the declaration file and test imports. Document the enforced publishing boundary in Kernel, Eventing, and Persistence module docs.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run test/architecture/event-processor-ownership.test.ts test/architecture/event-publishing-ownership.test.ts
npm run lint:architecture
npm run build
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts package.json src test
git commit -m "test: enforce event publishing ownership"
```

### Task 7: Remove legacy publishing references and update current state

**Files:**
- Modify: `src/kernel/SPEC.md`
- Modify: `src/persistence/SPEC.md`
- Modify: `src/eventing/SPEC.md`
- Modify: `src/activities/SPEC.md`
- Modify: `src/bootstrap/SPEC.md`
- Modify: `src/control-plane/SPEC.md`
- Modify: `src/execution/SPEC.md`
- Modify: `src/integrations/SPEC.md`
- Modify: `src/orchestration/SPEC.md`
- Modify: `src/resources/SPEC.md`
- Modify: `src/surfaces/SPEC.md`
- Modify: `src/work/SPEC.md`
- Modify: `src/conversations/MODULE.md`
- Modify: `src/SPEC.md`
- Modify: `docs/architecture.md`
- Modify: `docs/events.md`

- [ ] **Step 1: Run the final legacy scan**

Run:

```bash
rg -n "EventDraft|EventDraftUnion|EventDraftInput|createEventDraft|journal\.append\(|\.journal\.append\(|EventProcessorHost|EventJournal" src test docs --glob '!docs/superpowers/**' --glob '!docs/adrs/**' --glob '!docs/reports/**' --glob '!docs/handoffs/**'
```

Classify every remaining `EventProcessorHost` and `EventJournal` result. Legitimate ports, composition, journal reads, Eventing hosting, and Persistence adapters remain. Legacy draft names, old append calls, foreign construction, and stale current-state documentation do not.

- [ ] **Step 2: Update current specifications and references**

Document:

- `EventData` as module-created producer data;
- `EventEnvelope` as journal-recorded data;
- conventional `appendToStream` semantics;
- flat on-disk compatibility;
- module-owned factories and conflict policy;
- Eventing/Persistence domain agnosticism;
- the evaluated library boundary and future adapter seam.

Update module spec `asOf` values after reviewing each changed module. Do not edit historical ADRs, reports, handoffs, plans, or design inputs.

- [ ] **Step 3: Run all static gates**

Run:

```bash
npm run check:catalogue
npm run check:scenarios
npm run check:specs
npm run lint:architecture
npm run lint
npm run format:check
npm run build
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 4: Commit**

```bash
git add src docs test scripts package.json
git commit -m "docs: define standard event publishing"
```

### Task 8: Full verification and branch-wide review

**Files:**
- Modify only files required by concrete failures caused by this change.

- [ ] **Step 1: Run the fast verification gate**

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 2: Run full behavioural and unused-code gates**

```bash
npm run test:integration
npm run test:e2e
npm run test:web
npm run knip
```

Expected: all commands PASS.

- [ ] **Step 3: Request branch-wide specification review**

Review the implementation against `docs/superpowers/specs/2026-08-30-standard-event-publishing-design.md` and confirm:

- no stored-data migration is required;
- newly written records retain the flat format;
- no legacy Draft or append API remains;
- modules construct their own event data;
- journal implementations alone construct envelopes;
- existing retry/idempotency policies are unchanged;
- Eventing and Persistence remain domain agnostic;
- no event-sourcing framework or new infrastructure dependency was added.

- [ ] **Step 4: Request independent code-quality review**

Review event typing, codec safety, filesystem atomicity, notification ordering, optimistic concurrency, public API compatibility, architecture-checker escapes/false positives, and test quality. Fix every concrete finding through a failing regression test before implementation changes.

- [ ] **Step 5: Confirm final branch state**

```bash
git status --short
git diff --check
git log --oneline --decorate -20
```

Expected: clean `feat/event-driven-runtime` worktree containing only intentional committed changes.
