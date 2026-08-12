# Approval Rejection and Run Stage Design

## Goal

Prevent a work item from advancing after a human requests changes, and show the
stage at which each run was created rather than the workflow's later stage.

## Context and Root Cause

The live work item `wk_d29yay0wMWt6dmhxdjBqcjZmYTRnMzBldHl0cnJmZg`
has a two-stage default workflow: `refine` then `implement`. Its first run was
created as activation ordinal 1 in `refine`, but its response currently reports
`implement` after the workflow advanced.

Two independent defects cause the reported behaviour:

1. A rejected approval signal with no explicit `onRejectResume` falls through
   to the success resume target. For `refine -> implement`, `/changes` therefore
   advances to `implement`.
2. API run context is enriched by reading `WorkflowInstanceView.currentStage` at
   response time. Historic runs consequently display the workflow's current
   stage instead of their own activation stage.

## Design

### Approval rejection invariant

An approval route may advance only when it receives an accepted (`done`) signal
from an authorized actor. A rejected signal, including GitHub `/changes`, must
never use the approval route's success resume target.

For a rejected signal:

- If the wait declares `onRejectResume`, resume to that configured target.
- Otherwise request a new activation of the workflow's current stage.

This retains intentional custom rejection routing while making the default
approval behaviour safe: a rejection from `refine` creates another `refine`
activation; it cannot activate `implement`.

### Run-stage provenance

Persist the primary workflow stage alongside the activation/run at creation
time. API presentation uses that immutable provenance for both `/runs` and a
work item's embedded run list. It must not infer a historic run's stage from a
mutable workflow projection.

Runs that cannot be associated with a stage continue to omit the optional
stage field rather than invent a value.

## Tests

Regression coverage will prove:

1. A default `refine -> implement` approval wait followed by `/changes`
   creates a new `refine` activation and leaves `implement` unrequested.
2. The same wait followed by `/approved` advances to `implement`.
3. After a workflow advances to `implement`, the historic first run still
   presents as stage `refine` in both the global and work-detail run lists.

## Scope

The change is limited to orchestration signal handling, activation/run stage
provenance, API enrichment, and their tests. It does not change explicit
`onRejectResume` semantics, approval authorities, workflow configuration, or
the UI table itself.
