# Standard Event-Processing Runtime Design

## Outcome

Wake processes every durable journal reaction through one explicit, low-latency
processor model. Projections, reactors, coordinators, and inbound translators
share lifecycle, checkpoint, retry, cancellation, catch-up, and health
mechanics, while bounded modules continue to own event decoding and business
effects.

The runtime remains embedded and requires no new infrastructure. The existing
JSONL and in-memory persistence adapters remain supported. SQLite may later be
added behind the same Kernel ports without changing processors or handlers.

## Decision

Introduce an `eventing` supporting module rather than adopting an external
event-sourcing framework. Wake adopts the established processor, projector,
reactor, handler, checkpoint, and reconciliation patterns, but retains its
typed envelopes, stream restrictions, journal wake signal, explicit Bootstrap
composition, and domain-specific orchestration.

An external framework with custom persistence is not selected because Wake
would still have to implement its global message source, push-based journal
wake-up, checkpoint and lock adapters, retry supervision, health, catch-up
barriers, rebuild exclusion, envelope translation, and reconciliation. The
available embedded SQLite consumer is polling-based, which conflicts with the
low-latency goal, and the evaluated framework's current licensing and pre-1.0
status make it unsuitable as Wake's foundation.

## Architectural model

Every durable reaction is a named event processor with its own cursor. It
reads globally ordered journal facts, selects and decodes module-owned
messages, invokes an idempotent handler, and advances its cursor only after a
successful bounded batch.

```text
EventJournal
    |
    v
EventProcessorHost
  - durable cursor
  - push wake plus safety fallback
  - bounded batches
  - retry and cancellation
  - keyed serialisation
  - health and lag
    |
    +-- projector ----> rebuildable read model
    +-- reactor ------> idempotent durable/external effect
    +-- coordinator --> durable process progression
    +-- translator ---> provider evidence to internal commands

Reconciler -----------> separate startup/periodic recovery lane
```

## Ownership

### Kernel

Kernel retains only universal facts and ports: event envelopes, identifiers,
stream references, journal reads/appends/wake notification, checkpoints,
projections, clocks, and cancellation-compatible contracts. It does not own
processor policy, retries, health, or application handlers.

### Eventing

The new `eventing` module depends only on Kernel and owns:

- `EventProcessorDefinition<Message>` and its stable identity, owner, category,
  selector, handler, replay policy, and bounded batch size;
- `EventProcessorHost`, one-pass and through-position catch-up, resident
  lifecycle, retry, cancellation, health, and lag;
- the processor-run serialisation port;
- projection-to-processor adaptation and rebuild coordination;
- shared processor contract-test helpers where those improve module tests.

The host provides at-least-once delivery. A failed batch does not advance its
checkpoint. Previously completed effects in a replayed batch must therefore be
idempotent from stable event identities.

### Persistence

Persistence depends on Kernel and Eventing. It owns concrete JSONL/in-memory
journals, projection and checkpoint stores, file locks, and file/in-memory
processor-run serialisers. It does not own handler lifecycle or domain policy.

### Bounded modules

Each bounded module owns stable processor definitions and handlers. A selector
returns `null` for irrelevant facts and performs the module's normal persisted
event decoding for its own namespace. Handlers own idempotency and business
effects; they do not load or save processor checkpoints.

### Bootstrap

Bootstrap composes one explicit runtime registry. There is no decorator,
reflection, automatic discovery, transient event bus, or second workflow
language. The registry is the searchable description of every resident
processor and is the source for unified health reporting.

## Processor contract

The public contract has this shape:

```ts
export interface EventProcessorDefinition<Message = EventEnvelope> {
  readonly consumer: string;
  readonly name: string;
  readonly owner: string;
  readonly category: 'projection' | 'reactor' | 'coordinator' | 'translator';
  readonly replay: 'rebuildable' | 'idempotent' | 'disabled';
  readonly batchSize?: number;
  select(event: EventEnvelope): Message | null;
  handle(message: Message, event: EventEnvelope, signal: AbortSignal): Promise<void>;
}
```

The durable `consumer` is a stable module-owned processor identifier rather
than a storage path. Persistence encodes it safely when storing a checkpoint.
Existing consumer identities are preserved during migration so deployed
checkpoints continue from their current global positions. Eventing validates
that every registered consumer is distinct.

Processors are serial within a consumer. Parallel partition processing is not
included because advancing a global cursor past incomplete partitions would
introduce gap tracking and recovery complexity without a measured need.

## Projection specialization

Existing `ProjectionDefinition` remains the pure fold contract. Eventing
adapts it to a `projection:<name>` processor and preserves the stored
`lastGlobalPosition` idempotency guard. Rebuild holds the same consumer lock as
the live processor while it clears, resets, replays, and checkpoints.

## Reconciliation

Reconciliation remains visibly separate from ordinary event handling. It may
run on startup and on a bounded periodic safety cadence, but it does not own
the normal low-latency path and does not hide a whole-journal scan inside every
event handler. Watch and activation recovery retain their domain-specific
logic and expose their health separately where relevant.

## Runtime composition

The resident process starts one host over all registered definitions:

```ts
runtimeProcessors = [
  ...projectionProcessors,
  activationSchedulerProcessor,
  watchProcessor,
  resourceTransitionProcessor,
  artifactRegistrationProcessor,
  agentRunPublicationProcessor,
  deliveryOutcomeProcessor,
  ...providerInboundProcessors,
];
```

Schedules, provider polling, outbound delivery activities, maintenance, and
reconciliation are not journal processors. When one-shot execution needs a
fresh dependency, it uses an explicit processor catch-up barrier rather than
calling a legacy reactor loop.

## Health

Every registered processor reports:

- consumer identity, owner, category, and status;
- durable checkpoint, current journal head, and lag;
- consecutive failures and bounded last error;
- last attempt, success, and failure times when available.

Statuses distinguish starting, catching up, healthy, degraded, and stopped.
Health remains process-local; facts and checkpoints remain durable.

## Migration constraints

- Preserve all deployed consumer names and journal data.
- Remove manual `load checkpoint -> readAll -> handle -> save checkpoint`
  loops from production reactors and translators.
- Remove the old subscription types from Persistence after imports migrate;
  do not keep a parallel legacy runtime or configuration switch.
- Preserve one-shot freshness barriers and activation scheduler semantics.
- Migrate through failing focused tests before implementation changes.
- Update only current-state specifications and reference documentation;
  historical plans, reports, and ADRs remain unchanged.

## SQLite boundary

SQLite is not required for this work. A future `SqliteEventJournal`,
`SqliteCheckpointStore`, and `SqliteProjectionStore` can implement the current
Kernel ports and use the same Eventing host. That decision should be driven by
measured journal/query performance or a need for atomic embedded storage, not
by processor standardisation.
