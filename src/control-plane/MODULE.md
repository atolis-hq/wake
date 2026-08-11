# control-plane

## Purpose
System-level bounded coordination through `advanceOnce`.
## Owns
Signals, eligibility, selection, budgets, dispatch coordination, and hosts.
## Does not own
Work, workflow, execution, or provider domain policy.
## Invariants
Tick, resident, and schedule hosts use the same bounded advancement capability.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `controlPlane`.
## Relations and events
Owns `control.` events; it defines no domain relation semantics.
## Failure and recovery
Selection, caps, pauses, and retries remain explicit and bounded.
## Extension rules
Coordinate public applications; do not absorb their policies.
## Scenarios
E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003.
