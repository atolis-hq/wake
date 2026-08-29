# bootstrap

## Purpose
Configuration loading, dependency composition, and process startup.
## Owns
Root schema composition, paths, concrete adapter selection, hosts, and
cross-process scheduler serialisation.
## Does not own
Domain policy, provider payloads, or persistence semantics.
## Invariants
Only Bootstrap knows the complete application graph.
In subscriber mode, the durable activation scheduler owns resident scheduling;
one-shot CLI and API ticks run the legacy runner pipeline to produce
schedule/reactor facts, then explicitly poke it and preserve its advancement
result. Scheduler runner eligibility is a position-keyed fold of the durable
control stream, so scheduling does not wait for the independent projection
pump. Bootstrap supervises that subscription beside projection and resident
hosts, composes its filesystem checkpoint lock independently from the global
scheduler critical-section lock, and stops it with the resident signal.
Changing `controlPlane.activationScheduler.mode` back to `inline` is a
configuration-only rollback: durable journal facts and subscriber checkpoints
remain while the inline pipeline again owns scheduling.
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
