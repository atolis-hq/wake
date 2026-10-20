# activities

## Purpose
Activity contract and specialist SDLC capabilities.
## Owns
Typed inputs, resource requirements, outcomes, and specialist policy.
## Does not own
Workflow callbacks, global composition, runners, or adapters.
## Invariants
Every Activity has typed input, resources, outcomes, and a clear result.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `activities`.
## Relations and events
Owns `activity.` events and relations.
## Failure and recovery
Results are validated and idempotently accepted.
## Extension rules
Add named concrete Activities; no callback dumping ground.
## Scenarios
E2E-ACTIVITY-001, E2E-PR-001, E2E-PR-002, E2E-PR-APPROVE-001.

Scoped parent PR approve/merge activities derive the next child-owned target through a
narrow authorization port. Exact revision, original primary owner, capability and target
policy still gate the intent; the requesting parent retains the activity outcome.
