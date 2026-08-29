# persistence

## Purpose
Filesystem and in-memory implementations of Kernel storage ports, durable
subscriptions, and serialisation.
## Owns
JSONL journal, projections, checkpoints, locks, durable subscription tailing,
and diagnostics.
## Does not own
Domain projectors, business policy, or composition.
## Invariants
Depends only on Kernel; projections never reconstruct events.
## Public contracts
`index.ts` is the only public entry. Durable subscription handlers receive
bounded journal batches and must make effects idempotent from stable event
identities: a successful handler is checkpointed afterwards, so a crash or
failed checkpoint can replay its batch.
## Configuration
Owns `persistence`.
## Relations and events
Persists envelopes without defining domain semantics.
## Failure and recovery
Atomic writes and checkpoints make replay idempotent. Named subscription
consumers have independent durable checkpoints, volatile health, and retry
backoff; one consumer's failure cannot stop another. A keyed serialiser holds
the same-consumer file lock across checkpoint load, handler execution, and
checkpoint save. Callers compose the host with an explicit serialiser: memory
hosts use the in-memory keyed serialiser and filesystem hosts use the
file-backed keyed serialiser. Subscription fallback and batch values are
positive safe integers; batches are capped at 10,000 facts.

Filesystem checkpoints use a versioned injective UTF-8 base64url filename.
They read legacy checkpoint filenames when a v2 file is absent, then write
future progress to the v2 filename. Legacy files remain for forward migration
and best-effort downgrade replay, but binary downgrade after a checkpoint reset
is unsupported. This storage migration is separate from configuration-only
inline/subscriber runtime rollback.
## Extension rules
Adapters implement Kernel ports and Bootstrap selects them.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
