# execution

## Purpose
Runs, dispatch, runners, workspaces, supervision, and recovery.
## Owns
Run lifecycle, leases, runners, workspaces, cancellation, results, and transcripts.
## Does not own
Workflow transitions, provider policy, or global selection.
## Invariants
Workspaces are optional; attempts never decide workflow state.
Run events are tied to Run streams; activation claim events are tied to activation streams.
## Public contracts
`index.ts` is the only public entry.
## Configuration
Uses strict root `transcripts`: opt-in `enabled` defaults to `false` and
non-negative `retentionMs` defaults to `86400000` (24 hours).
## Relations and events
Owns `execution.` events and `run.` relations.
## Failure and recovery
Leases and result envelopes make recovery explicit. Transcript capture is
filesystem-only; post-close marker/sweep maintenance pauses with dispatch and
retries operational filesystem failures on later ticks.
## Extension rules
Concrete adapters stay in infrastructure and Bootstrap wires them.
## Scenarios
E2E-RUN-001, E2E-RECOVERY-001, E2E-OPS-TRANSCRIPT-001.
