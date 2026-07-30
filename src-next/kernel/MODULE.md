# kernel

## Purpose
Stable universal primitives and ports.
## Owns
Event envelopes, identifiers, relations, and storage/clock/ID ports.
## Does not own
Domain policy, filesystem adapters, workflows, execution, or providers.
## Invariants
Imports no Wake module; shared types carry no domain policy.
## Public contracts
`index.ts` is the only public entry.
## Configuration
No configuration namespace.
## Relations and events
Defines universal primitives, not domain semantics.
## Failure and recovery
Ports expose failures; facts remain append-only.
## Extension rules
Add only universal stable concepts.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
