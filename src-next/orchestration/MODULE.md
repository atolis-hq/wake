# orchestration

## Purpose
Configured workflow interpretation and durable instances.
## Owns
Definitions, compilation, instances, activations, waits, outcomes, and retry policy.
## Does not own
Agent invocation, workspaces, provider polling, delivery, or global selection.
## Invariants
Interpretation is deterministic; each instance has one primary position.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `orchestration`.
## Relations and events
Owns `orchestration.` events and `workflow.` relations.
## Failure and recovery
Accepted outcomes are current, typed, and replayable.
## Extension rules
No graph mutation, parallel positions, snapshots, or version entities.
## Scenarios
E2E-ORCH-001, E2E-ORCH-WAIT-001, E2E-CHILD-001.
