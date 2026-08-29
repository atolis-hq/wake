# control-plane

## Purpose
System-level bounded coordination through one activation scheduler, exposed
through the `advanceOnce` compatibility facade.
## Owns
Signals, eligibility, selection, budgets, dispatch coordination, and hosts.
## Does not own
Work, workflow, execution, or provider domain policy.
## Invariants
One-shot ticks run the non-scheduling runner pipeline then poke the durable
subscriber before delivery; resident runner hosts run only that non-scheduling
pipeline. Activation scheduling is owned by the named, durable
`activation-scheduler` subscription. The subscriber depends on a Control Plane
host port; Bootstrap adapts Persistence. It treats every journal fact as a
reconsideration, checkpoints only after a successful pass, and relies on the
shared scheduler serialiser for global capacity safety. Its durable subscriber identity is
`subscriber:control-plane.activation-scheduler`; the distinct scheduler
critical-section identity is `control-plane.activation-scheduler-critical-section`.
Startup and fallback reconciliation failures overlay durable-host health until
a successful scheduler pass clears them. A terminal Run fact releases capacity
by causing this same subscriber to reconsider pending work; the shared
serialiser makes that reconsideration safe with ticks and other processes.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `controlPlane` dispatch limits, schedules, and resident-loop backoff.
Activation scheduling is always performed by the durable subscriber.
## Relations and events
Owns `control.` events; it defines no domain relation semantics.
## Failure and recovery
Selection, caps, pauses, retries, and scheduler serialization remain explicit
and bounded.
## Extension rules
Coordinate public applications; do not absorb their policies.
## Scenarios
E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003, E2E-CONTROL-004.
