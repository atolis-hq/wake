# Event Transition Resolver Design

## Goal

Keep workflow advancement generic while preserving the V1 primary-pull-request
event-transition policy and its existing trust, freshness, and correlation
checks.

## Design

`AdvanceWorkflow` will depend on an `EventTransitionResolver` application
port. It supplies a waiting workflow and an optional upper journal position,
then receives either no resolution or the earliest eligible resolution with
its evidence event and target.

The concrete `PrimaryPullRequestEventTransitionResolver` remains the V1
implementation. It reads the durable journal and PR authority state, verifies
that exactly one non-conflicted primary PR is correlated to the WorkItem, and
matches only the three compiled primary-PR transition forms. It returns the
earliest matching evidence in journal order. The matcher must compare `where`
against the evidence payload; current PR state is used only to confirm that
historical evidence remains valid when a pending route is reconciled.

`AdvanceWorkflow` continues to own loading the workflow definition and
appending the accepted signal. It no longer imports PR events, PR projections,
or resource-correlation policy. `AcceptSignal` may pass the incoming watch
verdict's journal position as the upper bound, so an earlier event transition
is selected before that later verdict.

## Testing

Focused E2E coverage will prove that a prior qualifying primary-PR fact wins
over a later watch verdict, that non-matching historical state/check facts do
not become evidence, and that a no-match resolver leaves normal watch-gate
handling unchanged. Unit/contract coverage continues to validate the closed
event and predicate vocabulary.

## Scope

This is an internal seam only. Configuration remains restricted to
`on.done.eventTransitions` and its three documented primary-PR facts. Generic
cross-resource configuration and named resource bindings remain out of scope.
