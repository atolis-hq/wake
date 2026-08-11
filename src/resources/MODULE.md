# resources

## Purpose
Canonical Resource identity, capabilities, and correlation.
## Owns
Resource records, correlation policy, capabilities, and projections.
## Does not own
Provider payloads, Work lifecycle, or workflow policy.
## Invariants
Resources are provider-neutral; correlation is explicit and idempotent.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `resources`.
## Relations and events
Owns `resources.` events and `resource.` relations.
## Failure and recovery
Untrusted evidence requires validation before a canonical fact.
## Extension rules
Add capabilities without making providers canonical.
## Scenarios
E2E-WORK-001, E2E-PR-001, E2E-WORK-002.
