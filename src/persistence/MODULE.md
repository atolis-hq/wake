# persistence

## Purpose

Filesystem and in-memory implementations of Kernel storage ports and the
Eventing processor-run serialisation port.

## Owns

JSONL journal, projections, checkpoints, filesystem locks, processor-run
serialisers, and storage diagnostics.

## Does not own

Processor definitions, handlers, host lifecycle, domain policy, or
composition. Eventing owns processor execution and projection adaptation;
Bootstrap selects and wires the concrete adapters.

## Invariants

Depends only on Kernel and Eventing. Persistence stores opaque envelopes and
does not decode domain payloads. Filesystem and in-memory adapters implement
the same observable contracts; filesystem-only locking and atomic rename are
mechanical differences. It does not import bounded event contracts. Only the
journal adapters assign envelope metadata; producers supply `EventData`
through `appendToStream`.

## Public contracts

`index.ts` is the only public entry. Persistence exports storage adapters and
concrete keyed serialisers; it does not export a processor host or handler.

## Configuration

Owns the `persistence` namespace for future storage options. Current paths are
selected by Bootstrap.

## Relations and events

Persists envelopes without defining domain event or relation semantics.

## Failure and recovery

Atomic writes and durable checkpoints make replay retryable. The file-backed
serialiser holds a consumer lock across the caller's checkpoint-load,
handler, and checkpoint-save operation. Projection rebuild locking and
processor retry are Eventing policies, not Persistence handlers.

## Extension rules

Implement Kernel ports and the Eventing serialisation port here. Keep event
selection, bounded event construction and decoding, handlers, and runtime
lifecycle in their owning modules. Do not reintroduce draft vocabulary or a
legacy journal `append` operation.

## Scenarios

E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
