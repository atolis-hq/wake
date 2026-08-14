# GitHub Label Reconciliation — Component Specification

## Type, purpose, and scope

Adapter. This component reconciles Wake-owned status/stage/workflow labels
on each open WorkItem's correlated GitHub issues and pull requests to match
its workflow's current state, run as a provider's periodic maintenance
cycle rather than the delivery-intent pipeline.

## Ubiquitous language

- **Wake-owned label** — any GitHub label prefixed `wake:`; this component
  is the only writer of these labels, and it never touches any other label.
- **Watching** — a top-level workflow instance has at least one spawned
  watch child whose own workflow instance is not yet completed.

## Responsibilities and boundaries

This component owns computing each open, top-level workflow instance's
desired Wake labels, reading the current label set for each of its
correlated GitHub resources, and writing back only when the two differ. It
does not decide workflow status, stage, or watch state — Orchestration
owns those; this component only renders them as labels. It does not read or
write any non-Wake label. It does not deliver PR approvals, merges,
statuses, or replies — that is GitHub Outbound Delivery, an unrelated path
driven by delivery intents rather than this component's own maintenance
cycle.

## Core policies, invariants, and behaviours

- A WorkItem whose current state is not Open MUST be skipped entirely,
  including the live `getLabels` call that would otherwise run against its
  correlated resources every cycle; a concluded WorkItem's labels are never
  reconciled again once they were last synced while open.
- A child watch's own spawned workflow instance MUST NOT drive its parent
  WorkItem's status/stage/workflow labels; only the top-level (non-child)
  workflow instance does. An active, not-yet-completed child instead adds
  the `wake:watching` label to its parent's desired set, so the issue's own
  progress labels stay stable while a background watch run is in flight.
- The desired label set MUST be exactly `wake:status.<status>`,
  `wake:stage.<stage>`, `wake:workflow.<name>`, plus `wake:watching` only
  when watching; no other Wake-owned label is ever desired.
- Reconciling current labels against a desired set MUST preserve every
  non-Wake-owned label unchanged and replace the full set of Wake-owned
  labels with exactly the desired set.
- A resource whose external key's adapter is not `github` MUST be skipped;
  this component only ever calls GitHub's own label APIs.
- A correlated resource whose current and desired label sets are already
  identical, regardless of label order, MUST NOT issue a write call.
- A `getLabels`/`setLabels` failure for one correlated resource MUST NOT
  stop reconciliation of any other open WorkItem's correlated resources in
  the same `runOnce` pass; the failure is reported via `onError` (defaulting
  to a stderr write identifying the GitHub issue/PR) and the loop continues.

## Dependencies and system role

- Orchestration (this component depends on it) — `listAll` supplies each
  workflow instance's status, current stage, workflow name, and
  parent/child relationship.
- Resources (this component depends on it) — `correlationsForWork` and
  `get` resolve which GitHub issues/pull requests belong to a WorkItem's
  workflow.
- Work (this component depends on it) — `get` determines whether a
  WorkItem is still Open before reconciling its labels.
- GitHub's provider definition (depends on this component) — composes it as
  the provider's `maintenance` cycle, invoked once per tick by the runtime
  composition root, independently of the delivery-intent pipeline.

## Decisions, exclusions, and deferred capability

- Self-echo detection (`isGitHubWakeEcho`) is implemented and exported but
  not called by any composed path; there is no current use of it to
  suppress Wake reacting to its own comments.
