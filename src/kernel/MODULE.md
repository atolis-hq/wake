# kernel

## Purpose
Stable universal primitives and non-eventing ports.
## Owns
Generic brands and entity references, relations, matching, schema helpers, and
clock/ID ports.
## Does not own
Event contracts or processing, domain policy, filesystem adapters, workflows,
execution, or providers.
## Invariants
Imports no Wake module; shared types carry no domain or eventing policy.
## Public contracts
`index.ts` is the only public entry.
## Configuration
No configuration namespace.
## Relations and events
Defines universal primitives, not domain or event semantics.
## Failure and recovery
Ports expose failures; facts remain append-only.
## Extension rules
Add only universal stable concepts.
## Scenarios
E2E-JOURNAL-001, E2E-PROJECTION-001, E2E-FAULT-001.
