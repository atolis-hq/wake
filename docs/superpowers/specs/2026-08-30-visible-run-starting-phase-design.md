# Visible Run Starting Phase Design

## Outcome

Wake must expose a dispatched execution attempt immediately, including while it is preparing a
workspace. The work-item card appears in Active, the run appears in run collections and detail,
and operators see `Starting` until the activity runner actually begins. The same run then
transitions to `Running` and finally to its existing terminal status.

This closes an observability gap without redefining an activation claim as a workspace fact or
pretending the activity runner has started.

## Current gap

Execution currently allocates a Run ID and appends `execution.activation-claimed`, then acquires
the attempt workspace, and only afterward appends `execution.run-started`. Workspace preparation
can take minutes. During that interval:

- the board projection has no Run event from which to move the primary card to Active;
- the execution projection has no Run stream to list or retrieve;
- a pre-start failure releases the activation without leaving a visible Run outcome; and
- `startedAt` is captured before preparation, so a completed run can later report the entire
  duration despite having been invisible for most of it.

An activation claim cannot be presented directly as `Preparing workspace`. It is the exclusive
right to attempt an activation, applies even when no workspace is required, and contains neither
the complete Run context nor proof that workspace preparation began.

## Decision

Add an explicit first Run-stream fact, `execution.run-preparation-started`. Append it immediately
after the activation claim succeeds and before workspace acquisition. Its payload carries the
Run identity established at dispatch: activation, activity, optional stage, workflow instance,
orchestration group, attempt, runner descriptor, and preparation start time.

The Run state gains `starting` as a non-terminal transport status. Folding
`run-preparation-started` creates the Run view with status `starting`. Folding the existing
`run-started` fact changes it to `started` and records the acquired workspace, when present.
Existing terminal facts remain terminal. Both `starting` and `started` are active states.

`run-started` retains its precise meaning: execution is ready and the activity runner is being
entered. It is no longer required to be the first Run-stream fact.

## Lifecycle

```text
activity requested
    -> activation claimed
    -> run preparation started     visible as Starting
    -> workspace acquired/prepared
    -> run started                 visible as Running
    -> succeeded | failed | cancelled | ambiguous
    -> activation released
```

Activities that do not need a workspace still pass through Starting, normally too briefly to be
observed. The label describes the attempt lifecycle rather than asserting that all activities
perform Git workspace work.

If preparation fails after the Run preparation fact is durable, Execution records `run-failed`
on that Run before releasing resources. The failed attempt therefore remains visible and can be
diagnosed. Failures before activation ownership or before the preparation fact is appended do not
create phantom Runs.

## Projection and API behavior

The execution projection and `runs-by-workflow-instance` projection include a Run from
`run-preparation-started`, so it is immediately available through:

- the global Runs collection;
- Run detail;
- work-item detail and its Runs table; and
- any refresh policy based on an active Run.

The API keeps one Run resource rather than synthesizing a temporary row. A starting Run has:

- `status: "starting"`;
- `active: true`;
- `startedAt` set to preparation start;
- no `finishedAt`; and
- no workspace or execution result yet.

The existing `started` status is presented as `Running` in user-facing status labels. The Runs
table shows an increasing elapsed duration for both Starting and Running rows; terminal duration
is preparation start through finish. `RunView.startedAt` remains the beginning of the overall
attempt. A new optional `executionStartedAt`, sourced from the later `run-started` fact, records
when activity execution actually began. Historical `run-started`-first streams set both values to
their existing start timestamp. This preserves current duration meaning while allowing
execution-only timing to be exposed separately.

## Board behavior

The board projection consumes `run-preparation-started` as the beginning of an active attempt. It
registers the Run against the work item, increments the Run count once, and adds an active-run
entry keyed by Run ID with phase `starting` and the preparation timestamp.

For a primary workflow instance, this moves the card to Active. The card displays the stage/action
with `Starting`. On `run-started`, the same keyed entry changes to phase `running`; it is not added
a second time and the Run count is not incremented again.

Child workflow runs retain the existing non-driving rule: they appear in the card's active-run
details and totals but do not move the primary card out of Needs Input. Multiple simultaneous
starting or running Runs remain independently keyed by Run ID.

Terminal events remove only their own active-run entry. A primary card leaves Active according to
the existing workflow and terminal-outcome rules once no driving Run remains.

## Recovery and compatibility

Recovery treats both `starting` and `started` as non-terminal attempts. A stale Starting run can
be failed or recovered deterministically and its activation claim released; it must not remain
permanently active after a crash during workspace preparation.

Existing journals remain valid because their Run streams begin with `run-started`. The fold accepts
both the historical `run-started`-first shape and the new preparation-then-start shape. Existing
projection checkpoints can be rebuilt without migration. Newly written streams always use the new
shape.

The event decoder, stream/event compatibility checks, functional catalogue, module specification,
and scenario catalogue are updated as required by the new durable fact.

## Verification

Tests cover:

- Run folding from Starting to Running and each terminal outcome;
- a preparation failure producing a visible failed Run and releasing resources;
- crash recovery of a stale Starting run;
- immediate runs-by-workflow membership from the preparation fact;
- board placement, label transition, child-run behavior, and simultaneous Runs;
- API collection/detail responses for a Starting Run with no end state;
- live elapsed duration in the Runs table and Active board card; and
- a file-backed end-to-end scenario that pauses workspace acquisition and proves the Run and card
  are visible before allowing preparation to complete.
