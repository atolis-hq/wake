# execution

## Purpose
Runs, dispatch, runners, workspaces, supervision, and recovery.
## Owns
Run lifecycle, leases, runners, workspaces, cancellation, results, and transcripts.
## Does not own
Workflow transitions, provider policy, or global selection.
## Invariants
Workspaces are optional; attempts never decide workflow state.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Owns `execution`.
## Relations and events
Owns `execution.` events and `run.` relations.
## Failure and recovery
Leases and result envelopes make recovery explicit.
## Extension rules
Concrete adapters stay in infrastructure and Bootstrap wires them.
## Scenarios
E2E-RUN-001, E2E-RECOVERY-001, E2E-OPS-TRANSCRIPT-001.
