# surfaces

## Purpose
CLI, API, and UI presentation over public applications and views.
## Owns
Command parsing, HTTP presentation, UI data, authorization, and formatting.
## Does not own
Stores, adapter clients, domain policy, or composition.
## Invariants
Cross-domain responses nest domains and surfaces do not write state directly.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `surfaces`.
## Relations and events
Defines no canonical event or relation semantics.
## Failure and recovery
Returns explicit authorization, validation, and conflict results.
## Extension rules
Call public applications and views only.
## Scenarios
E2E-SURFACE-001, E2E-OPS-001.
