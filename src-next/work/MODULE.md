# work

## Purpose
Durable WorkItems and lifecycle facts.
## Owns
Work identity, descriptions, lifecycle, relations, commands, and views.
## Does not own
Workflow decisions, dispatch, providers, or execution.
## Invariants
Identity is Wake-owned; lifecycle is not workflow position.
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
