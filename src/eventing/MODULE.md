# eventing

## Purpose
Durable, event-driven processor runtime and projection adaptation.
## Owns
Event processor definitions, checkpointed processing, resident runtime health,
projection processors, and projection rebuilds.
## Does not own
Journal, checkpoint, projection, or lock implementations.
## Invariants
Depends only on Kernel. Processor consumers are serialised by the supplied port;
handlers are at-least-once and checkpoints advance only after a complete batch.
## Public contracts
`index.ts` is the only public entry.
## Configuration
No configuration namespace.
## Relations and events
Consumes Kernel envelopes without defining domain event semantics.
## Failure and recovery
Processor health is volatile. Failed batches keep their durable checkpoint and
retry independently; projection rebuilds share the same consumer serialisation.
## Extension rules
Add generic processor policies and adapters here; keep concrete storage and
locking in Persistence.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
