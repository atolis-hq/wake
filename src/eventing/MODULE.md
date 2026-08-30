# eventing

## Purpose

The persistence-neutral runtime for durable journal processors.

## Owns

Named processor definitions, typed selection and handling, checkpointed
delivery, bounded catch-up, resident lifecycle, retry, cancellation, health,
projection adaptation, rebuild coordination, and the processor-run
serialisation port.

## Does not own

Journal, checkpoint, projection, or lock implementations; domain event
vocabularies; domain handlers; or application composition.

## Invariants

Processors are at-least-once and serial per consumer. A checkpoint advances
only after a complete bounded batch succeeds. A failed batch remains eligible
for retry. Selectors decode their owning namespace and return null for other
namespaces. Processor consumers are stable and distinct.
Eventing depends only on Kernel event contracts: it neither imports bounded
event vocabularies nor constructs bounded event data or journal envelopes.

## Public contracts

`index.ts` is the only public entry. `EventProcessorDefinition` describes a
bounded module's processor; `EventProcessorHost` owns execution; and
`ProcessorRunSerialiser` describes the injected keyed critical section.

## Configuration

No configuration namespace. Batch limits and retry policy are runtime
contracts supplied by Bootstrap.

## Relations and events

Consumes Kernel envelopes without defining domain event semantics.

## Failure and recovery

Health is process-local. Failed processors retain their durable checkpoint and
retry independently. Projection rebuilds take the same consumer serialiser as
live processing while clearing, replaying, and checkpointing the projection.

## Extension rules

Bounded modules define selectors and idempotent handlers and export processor
definitions. They do not construct a host or a concrete serialiser. Bootstrap
registers the complete processor set and selects Persistence adapters. Event
publication remains behind each bounded module's event factory.

## Scenarios

E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
