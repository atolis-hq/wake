# kernel

## Purpose
Stable universal primitives and ports.
## Owns
Event envelopes, identifiers, relations, and storage/clock/ID ports.
## Does not own
Domain policy, filesystem adapters, workflows, execution, or providers.
## Invariants
Imports no Wake module; shared types carry no domain policy. `createEventData`
is the low-level construction primitive and is called only by the event
factory of the module that owns the event namespace. `EventJournal` accepts
`EventData`; legacy draft contracts and `append` are not part of the port.
## Public contracts
`index.ts` is the only public entry.
## Configuration
No configuration namespace.
## Relations and events
Defines universal primitives, not domain semantics. Journal adapters, not
publishers, assign stream, sequence, position, and recording metadata to form
an `EventEnvelope`.
## Failure and recovery
Ports expose failures; facts remain append-only.
## Extension rules
Add only universal stable concepts.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
