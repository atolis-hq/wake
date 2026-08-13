# persistence

## Purpose
Filesystem implementations of Kernel storage ports.
## Owns
JSONL journal, projections, checkpoints, locks, and diagnostics.
## Does not own
Domain projectors, business policy, or composition.
## Invariants
Depends only on Kernel; projections never reconstruct events.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `persistence`.
## Relations and events
Persists envelopes without defining domain semantics.
## Failure and recovery
Atomic writes and checkpoints make replay idempotent.
## Extension rules
Adapters implement Kernel ports and Bootstrap selects them.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
