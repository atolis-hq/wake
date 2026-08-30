# Standard Event Publishing Design

## Intent

Standardise every production event write in Wake around established event-sourcing terminology and the conventional append-to-stream operation. Bounded modules continue to own event construction and domain policy. Kernel defines the journal contract, Persistence implements it, and Eventing remains an event-shape-agnostic consumer of recorded facts.

This is a complete migration. Wake will not retain a legacy `EventDraft` model, a second publishing API, or direct production calls to the old `EventJournal.append` method.

## Design principles

1. Prefer established event-sourcing terminology and operations. Introduce Wake-specific concepts only for Wake-specific requirements.
2. The bounded module that owns an event constructs it and validates its domain data.
3. The journal assigns persistence facts. Modules never manufacture stream sequence, global position, or recorded time.
4. Publishing mechanics do not contain business retry, conflict recovery, command deduplication, or idempotency policy.
5. Persisted events are decoded by their owning module before folding or handling.
6. Existing Wake homes remain readable without a destructive migration or a legacy runtime mode.

## Library decision

Wake will not adopt a general-purpose event-sourcing framework in this change.

KurrentDB provides an established append-to-stream API and durable server-side subscriptions, but requires a separately operated database service. That violates Wake's no-new-infrastructure constraint.

Emmett is the closest TypeScript framework fit and offers an event-store abstraction plus an SQLite adapter. Adopting it now would still require either replacing or adapting Wake's authoritative filesystem journal, global ordering, change signals, stable per-consumer checkpoints, cross-process exclusion, and live projection rebuild semantics. Its documented SQLite background consumers are polling based, whereas Wake requires immediate push wake-up. A wholesale adoption would also pull Wake's domain and orchestration design toward framework command-handler, projection, and workflow abstractions that Wake does not need.

Wake will instead keep narrow custom implementations behind conventional ports. The resulting API must make a future embedded SQLite, Emmett, or KurrentDB adapter possible without changing bounded modules.

This decision does not authorise Wake to build a generic command bus, aggregate framework, saga framework, or general-purpose event-store product.

## Event model

### EventData

`EventData` is the immutable, module-created event submitted for persistence. It contains the complete logical fact and producer-supplied metadata:

- event identifier;
- event type and schema version;
- occurrence time;
- correlation and causation identifiers;
- actor and source;
- typed payload.

It does not contain a stream sequence, global journal position, or recorded timestamp.

The stream remains an explicit argument to `appendToStream`; it is not duplicated inside `EventData`. Each bounded module's repository or narrow publishing function couples its concrete event-data union to its permitted stream-reference type at compile time. The module decoder enforces the same event-type and stream relationship at runtime when recorded envelopes are read.

### EventEnvelope

`EventEnvelope<EventData>` is the recorded representation returned by the journal. It contains:

- the original `event` data;
- the target `stream`;
- journal-assigned `recordedAt`;
- journal-assigned stream `sequence`;
- journal-assigned `globalPosition`.

Only journal implementations may construct an envelope or assign journal metadata.

### Module terminology

Module event unions follow the same distinction. For example:

- `WorkEventData` is constructed by Work;
- `WorkEvent` is a decoded `EventEnvelope<WorkEventData>`;
- `createWorkEventData` is a Work-owned factory;
- `decodeWorkEvent` validates a recorded Work envelope.

The `Draft`, `EventDraft`, and `createEventDraft` terminology is removed.

## Journal publishing API

Kernel's `EventJournal` is the standard publishing port:

```ts
appendToStream<Stream extends EntityRef, Event extends EventData<string, unknown>>(
  stream: Stream,
  expectedSequence: number,
  events: readonly Event[],
): Promise<readonly EventEnvelope<Event>[]>;
```

The precise TypeScript formulation may use supporting aliases to preserve discriminated unions, but it must retain these semantics.

`appendToStream`:

1. requires at least one event;
2. verifies the supplied expected sequence;
3. appends the complete batch atomically;
4. preserves event order;
5. assigns journal metadata;
6. emits the journal change signal only after successful persistence;
7. returns recorded envelopes in append order.

Wrong expected sequence and storage failures propagate unchanged. The journal does not reread state, retry the append, regenerate identifiers, or deduplicate commands.

## Module publishing pattern

A module handles a command using the conventional event-sourcing sequence:

1. Read the target stream and decode owned envelopes.
2. Fold the current state.
3. Decide which event data to create.
4. Construct the event data through a module-owned typed factory.
5. Append the event data to the typed stream at the observed sequence.
6. Decode returned envelopes when a typed recorded result is required.

Repositories may package read, fold, and append operations. Standalone activities and services may append through the journal port directly, but must use event data constructed by the module that owns the event type.

Business conflict handling stays explicit. A module may reload and retry only through its existing named policy, such as claim-with-CAS retry or durable-intent recovery. The journal never retries a stale decision automatically.

## Cross-module publication

A module must not construct another module's events. Cross-module callers use an exported factory, command-facing service, or narrow publishing port owned by the event's module.

Bootstrap may compose these services but may not construct domain event data. Existing Bootstrap publishers, such as status, quota, and integration intents, move behind their owning module's factory or service.

Provider adapters remain part of Integrations and may construct adapter-owned observation event data after validating external payloads.

## Persistence compatibility

The filesystem journal remains authoritative. Its current flat JSON record format remains the canonical on-disk representation for this change.

Persistence maps between that flat record and the nested in-memory `EventEnvelope<EventData>` model. This is a storage codec, not a legacy runtime path. New and existing records use the same on-disk format, so Wake homes do not contain mixed formats and require no rewrite.

The in-memory journal implements the same contract and metadata semantics. Test fakes may construct envelopes only through shared journal test infrastructure, not ad hoc object literals.

## Eventing relationship

Eventing consumes `EventEnvelope` values from `EventJournal` and remains agnostic to bounded event types and payloads. Processor selectors receive recorded envelopes and delegate decoding to their owning module.

The publishing change must not alter:

- processor consumer identities;
- processor checkpoints;
- push wake-up semantics;
- retry or cancellation behaviour;
- projection rebuild locking;
- resident or one-shot catch-up ordering.

## Architecture enforcement

Symbol-aware architecture checks will enforce:

1. no production reference to `EventDraft`, `EventDraftUnion`, or `createEventDraft`;
2. no production call to the removed `EventJournal.append` API;
3. only journal implementations and approved journal test infrastructure construct `EventEnvelope` or assign `recordedAt`, `sequence`, and `globalPosition`;
4. Bootstrap does not construct bounded event data;
5. a bounded module does not construct event data owned by another module;
6. Persistence does not import bounded event types or construct domain event data;
7. Eventing does not import bounded event types or construct domain event data;
8. module publishing APIs tie their event-data unions to their permitted stream references at compile time, and their decoders enforce the relationship at runtime.

The checks must resolve TypeScript symbols and aliases rather than relying on identifier text. Unrelated local types with similar names remain permitted, while aliased forbidden imports remain detectable.

## Verification

Kernel contract tests run against both in-memory and filesystem journals and prove:

- atomic batch append;
- expected-sequence rejection;
- rejection of empty appends;
- journal-only metadata assignment;
- stable order and positions;
- no change notification after a failed append;
- notification after a successful append;
- existing flat journal fixtures decode into the nested envelope model.

Each bounded module receives focused tests proving its factories return event data, its repository or service appends to the correct stream, and its returned persisted facts are decoded before use.

Architecture fixtures prove both allowed and forbidden ownership cases, including aliases and cross-module imports. Final verification includes the full unit, integration, E2E, web, architecture, specification, formatting, build, and unused-code gates.

## Migration strategy

The implementation proceeds in compile-bounded slices:

1. Introduce `EventData`, nested `EventEnvelope`, and `appendToStream` in Kernel test-first.
2. Update in-memory and filesystem journals plus the compatibility codec.
3. Migrate module event contracts, factories, decoders, and repositories one bounded module at a time.
4. Migrate standalone publishers and cross-module call sites behind owner APIs.
5. Migrate processors, projections, surfaces, fixtures, and tests to the nested envelope shape.
6. Add symbol-aware publishing architecture enforcement.
7. Remove all legacy terminology and APIs, update current-state documentation, and run complete verification.

There is no compatibility overload, feature flag, alternate journal API, or dual in-memory event shape.

## Success criteria

- Every production event is constructed by its owning module as typed `EventData`.
- Every production event write uses `EventJournal.appendToStream`.
- Every journal read returns an `EventEnvelope<EventData>` whose persistence metadata was journal assigned.
- Existing Wake homes remain readable without migration.
- No module loses its current concurrency, retry, idempotency, or recovery semantics.
- Eventing and Persistence remain independent of bounded domain event types.
- Architecture checks prevent the legacy and cross-module construction patterns from returning.
- Full verification passes.
