# persistence

## Purpose
Filesystem and in-memory implementations of Kernel storage ports and Eventing
processor-run serialisation.
## Owns
JSONL journal, projections, checkpoints, locks, processor-run serialisation,
and diagnostics.
## Does not own
Domain projectors, business policy, or composition.
## Invariants
Depends only on Kernel and Eventing; projections never reconstruct events.
## Public contracts
`index.ts` is the only public entry. Eventing owns processor definitions,
runtime health, projection adaptation, and rebuilds. Persistence provides the
concrete in-memory and file-backed processor-run serialisers they require.
## Configuration
Owns `persistence`.
## Relations and events
Persists envelopes without defining domain semantics.
## Failure and recovery
Atomic writes and checkpoints make replay idempotent. A keyed serialiser holds
the same-consumer file lock across checkpoint load, handler execution, and
checkpoint save. Callers compose Eventing with an explicit serialiser: memory
hosts use the in-memory keyed serialiser and filesystem hosts use the
file-backed keyed serialiser.

Filesystem checkpoints use a versioned injective UTF-8 base64url filename.
They read legacy checkpoint filenames when a v2 file is absent, then write
future progress to the v2 filename. Legacy files remain for forward migration
and best-effort downgrade replay, but binary downgrade after a checkpoint reset
is unsupported. Checkpoint-path migration is independent of runtime
architecture, and a binary rollback does not discard durable facts.
## Extension rules
Adapters implement Kernel ports and Bootstrap selects them.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
