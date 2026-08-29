# control-plane

## Purpose
System-level bounded coordination through one activation scheduler, exposed
through the `advanceOnce` compatibility facade.
## Owns
Signals, eligibility, selection, budgets, dispatch coordination, and hosts.
## Does not own
Work, workflow, execution, or provider domain policy.
## Invariants
Tick, resident, and schedule hosts use the same bounded advancement capability.
Activation scheduling is either inline or a named, durable `activation-scheduler`
subscription, never both. The subscriber depends on a Control Plane host port;
Bootstrap adapts Persistence. It treats every journal fact as a reconsideration,
checkpoints only after a successful pass, and relies on the shared scheduler
serialiser for global capacity safety. Its durable subscriber identity is
`subscriber:control-plane.activation-scheduler`; the distinct scheduler
critical-section identity is `control-plane.activation-scheduler-critical-section`.
Startup and fallback reconciliation failures overlay durable-host health until
a successful scheduler pass clears them.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `controlPlane`, including `activationScheduler.mode` (`inline` by default
for rollback safety, or `subscriber` for independently supervised resident
scheduling).
## Relations and events
Owns `control.` events; it defines no domain relation semantics.
## Failure and recovery
Selection, caps, pauses, retries, and scheduler serialization remain explicit
and bounded.
## Extension rules
Coordinate public applications; do not absorb their policies.
## Scenarios
E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003, E2E-CONTROL-004.
