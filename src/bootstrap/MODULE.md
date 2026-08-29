# bootstrap

## Purpose
Configuration loading, dependency composition, and process startup.
## Owns
Root schema composition, paths, concrete adapter selection, hosts, and
cross-process scheduler serialisation.
## Does not own
Domain policy, provider payloads, or persistence semantics.
## Invariants
Only Bootstrap knows the complete application graph. The durable activation
scheduler owns scheduling; one-shot CLI and API ticks run the runner pipeline
to produce schedule/reactor facts, then explicitly poke the subscriber before
delivery. Scheduler runner eligibility is a position-keyed fold of the durable
control stream, so scheduling does not wait for independently durable
projection subscriptions. Bootstrap supervises the scheduler and projection
subscriptions beside resident hosts, composes their filesystem checkpoint locks
independently from the global scheduler critical-section lock, and stops them
with the resident signal.
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
