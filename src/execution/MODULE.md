# execution

## Purpose
Runs, dispatch, runners, workspaces, supervision, and recovery.
## Owns
Run lifecycle, leases, runners, workspaces, cancellation, results, transcripts,
and live run-outcome reports and summary metrics.
## Does not own
Workflow transitions, provider policy, or global selection.
## Invariants
Workspaces are optional; attempts never decide workflow state.
Run events are tied to Run streams; activation claim events are tied to activation streams.
Delegated execution selects the recorded Repository Resource explicitly. New
writable branches start at the assignment's pinned source commit; the logical
PR base is separate. Workflows without an assignment keep the clone default for
new branches. Existing branch workspaces retain their branch and dirty
state. Run preparation records the assignment, Run start records the checkout,
and successful completion records the resulting HEAD. Read-only reviews in the
same orchestration group use that implementation HEAD, including watch children.
Candidate QA acquires all selected repository leases in deterministic resource-ID order,
checks every checkout against its pinned revision, and releases all leases after partial
failure or Run settlement. Retained refs are re-resolved during acquisition; missing or
moved refs cannot prepare even if the commit is cached locally. Read-only leases may
advance to a later authorized candidate while writable assignment identity stays fixed.
Run start records the candidate and exact prepared repository paths/revisions, and QA
starts a fresh session with the configured recipe, criteria and contributing references.

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

Governed parent maintenance leases the original child branch workspaces in deterministic
child identity order and releases partial acquisitions on failure. New workspaces start at
the selected output revision. A prior ambiguous child or maintenance writer must be
reconciled before another writer acquires the branch. Run start records every target/path;
maintenance never transfers branch or PR ownership to the parent.
