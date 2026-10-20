# eventing

## Purpose

Persistence-neutral event contracts, journal and state ports, projections,
processor runtime, and in-memory adapters.

## Owns

Event data and envelopes, event identifiers and metadata, journal change
signalling, checkpoint/projection/processor-state ports, processor vocabulary,
hosting, replay, health, bounded cancellable journal snapshot scans, and memory
implementations.

## Does not own

Wake domain event schemas, filesystem or Node adapter implementation, Wake-home
paths, Bootstrap composition, providers, or workflow policy.

## Public contracts

The package root and `/memory` export path are the only supported imports.

## Invariants

`ProjectionStore` is for rebuildable read models; `ProcessorStateStore` is for
consumer-owned recovery state. The package imports neither Wake source modules
nor Node filesystem APIs.

## Extension rules

Define portable contracts and runtime capabilities here. Put a concrete storage
adapter in its own package and compose it in the consuming application.

Every journal read (`readStream`, `readAll`, `latestGlobalPosition`) must observe all appends committed before the call, including appends by other processes sharing the storage; adapters may cache only what they can prove is unchanged. `foldedJournalView` keys its value by the last position actually read.

Resident-loop code must never re-read or re-decode history on a journal move.
Per-key state that must survive restarts is a `ProjectionStore` projection,
read with `readCurrentProjection` (catch-up from the processor checkpoint, not
the key's own position). Cross-stream or in-process indexes are a
`foldedJournalView`, which folds only the events after the position it holds.
There is intentionally no "re-derive from `readAll(0)`" helper;
`test/architecture/journal-read-patterns.test.ts` enforces the allowed call sites.
