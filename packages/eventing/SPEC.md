---
asOf: 5031f5b26b684460a94bb1b97599813cc14c5926
---

# Eventing — Package Specification

## Purpose and scope

Eventing provides neutral event contracts, journal and state ports, durable
processor execution, projection support, and deterministic in-memory adapters.
It is reusable independently of Wake and owns no domain event schema.

## Responsibilities and boundaries

Eventing owns event data/envelopes and their decoding, event identifiers and
metadata, journal notifications, checkpoints, projections, processor-owned
state, serialisation contracts, processor definitions, hosting, health, and
memory adapters. It does not own a filesystem implementation, Wake paths,
configuration, bounded-module policy, or Bootstrap composition.

## Ubiquitous language

- **Event data** — immutable producer data with no journal-assigned metadata.
- **Event envelope** — journal-recorded event data with stream, recorded time,
  stream sequence, and global position.
- **Checkpoint** — a durable cursor for one processor consumer.
- **Projection** — a rebuildable, position-tracked read-model value.
- **Processor state** — opaque recovery data owned by one processor consumer;
  it is not a projection.
- **Processor** — a named, consumer-identified event handler with a replay
  policy, category, and bounded batch handling contract.

## Core policies, invariants, and behaviours

- Event data MUST be immutable, use schema version `1`, and contain no stream,
  sequence, recording-time, or global-position metadata.
- A journal append MUST use a non-empty event-data batch and an expected stream
  sequence. The journal MUST preserve stream and global ordering; callers own
  conflict resolution and idempotency.
- Journal notification is advisory. A processor MUST re-read from its durable
  checkpoint after waking.
- Checkpoints MUST be consumer-scoped and MUST NOT regress.
- Projection processors MUST apply each event at most once for a stored global
  position. A projection rebuild clears its namespace and replays from its
  checkpoint under the consumer serialiser.
- Processor state MUST be addressed by `(consumer, key)` and MUST NOT be used
  as a replacement for a rebuildable projection.
- A processor host MUST serialise a consumer's pass, advance its checkpoint
  only after successful handling, expose health, and retry an independent
  failed processor without stopping siblings.

## Public surface and dependencies

The supported entry points are the package root for contracts and runtime, and
`@atolis-hq/eventing/memory` for in-memory adapters. Package internals are not
public API. Eventing depends only on `zod`; filesystem implementations belong
to `@atolis-hq/eventing-filesystem`, while Wake Bootstrap selects concrete
adapters and composes its registry.

## Decisions, exclusions, and deferred capability

Eventing supplies no filesystem adapter, Wake compatibility re-export, domain
event catalogue, automatic append retry, or general event-id deduplication.
