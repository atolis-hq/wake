# Orchestration-Owned Agent Publication Design

## Goal

Publish each terminal agent report only after Wake has durably resolved the
activation in orchestration, so the report’s status and approval instructions
match the committed workflow state.

## Problem

Execution completion and orchestration routing are separate durable facts. A
detached agent Run can finish after `advance()` has inspected it and before the
agent-run publication reactor executes. Publishing from `execution.run-succeeded`
therefore permits a GitHub comment to render `Done` before the subsequent
orchestration decision enters an approval wait.

Runner transport failures have a related gap: they produce a failed Run but no
orchestration event that records the activation’s resolution. They cannot use
`activity-outcome-accepted` as a publication boundary.

## Design

Orchestration owns the externally publishable terminal decision.

1. A structured agent result (`DONE`, `REJECTED`, `BLOCKED`, or `FAILED`) remains
   an `execution.run-succeeded` with an ActivityOutcome. `acceptOutcome` appends
   `orchestration.activity-outcome-accepted` and its route events as one decision
   batch.
2. A failed, cancelled, or ambiguous execution is resolved by orchestration with
   a new activation-resolution event and an `instance-blocked` consequence in the
   same decision batch. The event identifies the activation and Run and preserves
   the terminal execution status and human-readable reason.
3. A publication reactor consumes only these orchestration-owned resolution
   events. It loads the referenced Run for agent prose, runner metadata, and
   timing, then derives `awaitingApproval` from the workflow state committed by
   that same decision batch.
4. The existing resource-stream delivery intent remains the outbox and retains
   `agent-run:<runId>` as its idempotency key. A retry/replay must therefore
   produce at most one report for each Run.

## Boundaries

Execution continues to own process facts and never decides presentation.
Orchestration continues to own workflow routing and status. Integrations only
format and deliver an already-resolved report. No event is merged across these
domains; causation is explicit through the activation and Run identifiers.

## Failure behaviour

Structured `BLOCKED` and `FAILED` outcomes follow their configured route and
are published after that route commits. Transport failures, cancellations, and
ambiguous recoveries are blocked by orchestration and then published as failed
reports. Runs that have not been resolved by orchestration are never published.

## Verification

Tests must demonstrate the incident ordering: a detached Run completes after
the advance pass has read it, and no report is requested until outcome acceptance
and the approval wait are committed. Additional tests cover structured blocked
and failed outcomes, plus transport failure resolution, and preserve one-report
idempotency across replay.
