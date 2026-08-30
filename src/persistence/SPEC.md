---
asOf: b3907794
---

# Persistence - Module Specification

## Purpose and scope

Persistence gives Kernel storage ports physical form. It implements the
filesystem and in-memory event journal, projection store, checkpoint store,
filesystem locks, and concrete keyed processor-run serialisers used by
Eventing. The journal is authoritative; projections and checkpoints are
rebuildable operational state.

## Responsibilities and boundaries

Persistence owns:

- append-only JSONL and in-memory journal storage with global and stream order;
- opaque projection values and durable per-consumer checkpoints;
- atomic filesystem writes, file locks, and in-memory equivalents;
- the file and in-memory implementations of Eventing's
  `ProcessorRunSerialiser` port;
- storage reachability diagnostics.

Persistence does not own event decoding, processor definitions, handlers,
checkpoint lifecycle, retry, health, scheduling, or composition. Eventing
owns processor execution and projection adaptation. Bootstrap selects concrete
adapters and composes them.

## Core policies

Filesystem and in-memory adapters have equivalent observable behavior.
Persistence validates only the common Kernel envelope shape and treats domain
payloads as opaque. Global positions are assigned once at append and are never
reassigned by replay or rebuild. Retried writes are idempotent according to
each storage port's contract.

The file-backed processor serialiser holds its consumer-specific lock across
the caller's complete checkpoint-load, handler, and checkpoint-save operation.
It does not load checkpoints, invoke handlers, or advance cursors itself.

## Conceptual schema

| Entity | Durable fields | Meaning |
| --- | --- | --- |
| Event envelope | event identity, type, stream, payload, sequence, global position | One accepted immutable fact. |
| Stored projection | namespace, key, value, last global position | Rebuildable read model value. |
| Checkpoint | consumer, global position | Cursor owned by Eventing's processor host. |

## Components and interactions

| Component | Type | Interaction |
| --- | --- | --- |
| Event journal | adapter | Stores and replays envelopes in global or stream order. |
| Projection store | adapter | Stores rebuildable values stamped with their folded position. |
| Checkpoint store | adapter | Stores opaque consumer cursors for Eventing. |
| File lock | adapter | Serialises filesystem writers and concrete processor runs. |
| Processor-run serialiser | adapter | Supplies keyed exclusion to Eventing and Bootstrap. |

Eventing supplies the host and projection rebuilder. Bounded modules supply
selectors and handlers. Persistence has no dependency on those handlers.

## Dependencies and recovery

Persistence depends on Kernel and Eventing. Bootstrap is the only composition
root and chooses filesystem or in-memory implementations. Corrupt on-disk
envelopes, ordering, and checkpoint data are reported at read time; no domain
repair or synthetic event is created. A processor failure leaves its prior
checkpoint intact for Eventing retry.

## Decisions and exclusions

There is no compaction, archival, or journal deletion. SQLite is a future
adapter behind the same ports. Persistence does not provide a parallel legacy
subscription host or a projection handler runtime.

E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
