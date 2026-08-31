---
asOf: dd708e68
---

# Eventing - Module Specification

## Purpose and scope

Eventing provides one persistence-neutral runtime for every durable journal
reaction. Projections, reactors, coordinators, and inbound translators are
named processors with the same cursor, bounded batch, retry, cancellation,
health, catch-up, and resident lifecycle guarantees.

## Responsibilities and boundaries

Eventing owns:

- `EventProcessor` definitions: stable consumer, name, owner, category,
  replay policy, selector, handler, and optional batch size;
- `EventProcessorHost`, which loads checkpoints, reads bounded global journal
  batches, invokes handlers, saves progress only after success, and supervises
  independent processors;
- one-shot and through-position catch-up barriers, cancellation, retry, health,
  and lag reporting;
- the keyed `ProcessorRunSerialiser` port;
- projection adaptation and rebuild locking.

Eventing does not own journal, projection, checkpoint, or lock implementations,
domain event vocabularies, provider payloads, handler policy, or application
composition.

Eventing is domain-agnostic: it receives recorded envelopes, hosts durable
subscriptions and checkpoints, and adapts projections without constructing
event data or knowing an event namespace. Persistence supplies storage and
change notification; Bootstrap composes module factories, projections, and the
explicit processor registry.

## Processor contract

Each processor has a stable consumer identity. Selectors return `null` for
unrelated events and decode their owning module's namespace. Handlers receive a
typed message, its original envelope, and an `AbortSignal`; they own
idempotency and business effects but never load or save the processor cursor.

Processors are serial per consumer. A successful bounded batch advances its
checkpoint to the final event position. A handler or checkpoint failure leaves
the prior checkpoint durable and the failed processor eligible for retry.

## Projection specialization

`ProjectionDefinition` remains a pure fold contract. Eventing adapts it to a
`projection:<name>` processor and preserves the projection store's
`lastGlobalPosition` guard. Rebuild clears the namespace, resets the consumer,
replays through the same processor, and holds the same keyed serialiser as live
processing.

## Runtime and health

Bootstrap registers one explicit processor registry and starts one host over
all resident definitions. The registry includes projection processors,
activation scheduling, orchestration reactions, artifact and delivery
reactions, agent publication, and provider inbound translators. Eventing
validates distinct consumers before startup.

Health is volatile and process-local. Each snapshot reports consumer, owner,
category, status, durable checkpoint, journal head, lag, failure count, and
available attempt/success/failure timestamps. A failed processor does not stop
its siblings.

## Reconciliation and one-shot work

Reconciliation is a separate startup or periodic recovery lane. Watch and
activation recovery retain domain-specific logic and checkpoints; provider
poll and schedule watermarks remain external observation state. One-shot command
freshness uses an explicit catch-up barrier rather than a hidden reactor loop.
Polling, delivery, schedule evaluation, and surface diagnostics are not
journal processors.

## Ownership and extension rules

Bounded modules define and export their processors through public contracts.
They may not construct `EventProcessorHost` or Persistence's concrete
serialisers. Persistence provides only storage adapters and concrete keyed
serialisers; it does not define processor handlers. Bootstrap alone constructs
the host, chooses concrete adapters, and composes the complete registry.

## Dependencies and scenarios

Eventing depends only on Kernel. It is consumed by Persistence for the
serialisation port and by bounded modules for processor definitions; Bootstrap
is the composition root.

E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
