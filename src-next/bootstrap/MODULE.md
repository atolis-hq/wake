# bootstrap

## Purpose
Configuration loading, dependency composition, and process startup.
## Owns
Root schema composition, paths, concrete adapter selection, and hosts.
## Does not own
Domain policy, provider payloads, or persistence semantics.
## Invariants
Only Bootstrap knows the complete application graph.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `bootstrap` composition and root configuration loading.
## Relations and events
Defines no canonical event or relation semantics.
## Failure and recovery
Validates composition and exposes operational diagnostics without mutating facts.
## Extension rules
Select concrete adapters here; never leak them into domains.
## Scenarios
E2E-CONFIG-001, E2E-OPS-INIT-001, E2E-OPS-001.
