# work

## Purpose
Durable WorkItems and lifecycle facts.
## Owns
Work identity, descriptions, lifecycle, relations, commands, and views.
## Does not own
Workflow decisions, dispatch, providers, or execution.
## Invariants
Identity is Wake-owned; lifecycle is not workflow position. Delegation hierarchy
records only validated parent, root and ancestors. Assignment identity and criteria
belong to Orchestration, not Work.
Batch readers (dispatch, gating, capacity) take one `deliverySnapshot()` and answer delivery availability for any number of items from it in memory; they must not read items one at a time. The snapshot is an incrementally extended index of all WorkItems, so it includes writes by other processes, and a malformed item is held (`invalid`) without affecting the others.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `work`.
## Relations and events
Owns `work.` events and relations.
## Failure and recovery
Idempotent commands emit accepted lifecycle facts only.
## Extension rules
Provider shapes stay outside.
## Scenarios
E2E-WORK-001, E2E-WORK-002, E2E-WORK-003.
