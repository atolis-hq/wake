# Work detail and list surface application — Component Specification

## Type, purpose, and scope

Surface application. This component composes Work's list of WorkItems, and,
for a single WorkItem, its correlated Resources, its Orchestration workflow
instances, the Execution runs belonging to those instances, and any
Activities pull-request state — into the work list and work-detail responses
the HTTP API exposes. It is the API surface application's only component
that reads across this many modules to produce one response.

## Responsibilities and boundaries

This component owns deciding what "belongs to" a WorkItem means for each of
the other modules it reads from, and owns assembling those results into one
response. It does not own any of the underlying facts — WorkItem state,
resource correlation, workflow membership, run membership, and pull-request
state are each owned and projected by their own module — this component only
reads and combines their current projections.

## Core policies, invariants, and behaviours

**Commands**

- `freeze`, `unfreeze`, `delete`, and `retry` MUST decode the caller's key as a
  WorkItemKey first, identically to `detail`, and MUST reject an
  undecodable or unknown key as not found rather than issuing a command
  against it.
- `delete` MUST also retract every resource correlation currently held for
  that WorkItem, alongside deleting the WorkItem itself, so no resource is
  left correlated to an id that can no longer be read back.
- Each command MUST report accepted, keyed by the caller's idempotency key,
  once its underlying Work command has been issued; this component does not
  itself wait for or report the command's downstream projection effects.
- `retry` MUST only issue Orchestration's retry command when the WorkItem is
  open and not deleted, has a primary workflow instance, and that workflow
  satisfies Orchestration's pure operator-retry eligibility policy. Every
  ineligible state, including a policy race while issuing the command, MUST
  return the typed `retry-ineligible` conflict with an explanatory detail;
  unexpected application errors are not recast as policy conflicts.

**List**

- `list` MUST support an optional case-insensitive substring `search` over
  the WorkItem's id and objective together, and an optional `state` filter;
  when both are given, a WorkItem MUST satisfy both to be included. `list`
  MUST exclude any WorkItem whose projection has no current view.
- `list` MUST use the same cursor/freshness pagination semantics as every
  other collection in the API surface application.

**Detail**

- The caller's key MUST be decoded as a WorkItemKey before anything else; a
  key that fails to decode MUST be reported as not found, identically to a
  well-formed key naming a WorkItem that does not exist — this component
  MUST NOT distinguish a malformed key from a missing one in its response.
- When the WorkItem exists, the response MUST include: the WorkItem itself;
  every resource currently correlated to it; every workflow instance whose
  own `workItemId` equals this WorkItem's id, split into at most one primary
  instance (the one with no parent workflow instance) and any number of
  child instances; every run whose `workflowInstanceId` matches one of those
  workflow instances; and, if any correlated resource has a recorded
  pull-request view, that pull request's current state.
- Workflow membership MUST be decided solely by the workflow instance's own
  `workItemId` field; run membership MUST be decided solely by the run's own
  `workflowInstanceId` matching an already-included workflow instance. Runs
  and pull requests are never included by a more direct link to the
  WorkItem itself.
- The WorkItem's own presented value MUST carry an `externalRef` — its
  primary correlated resource's adapter-formatted key — when one exists;
  each presented resource MUST carry a resolved `externalUrl` under the
  same rule the API surface application's resource listing uses. Included
  runs MUST be ordered by start time, most recent first, and each MUST be
  enriched with its owning workflow instance's current `workflowName`/
  `stage` when that instance is still known, matching the API surface
  application's own run presentation.
- The response's freshness metadata MUST reflect every fact that could
  change the assembled content: the WorkItem's own projection; every
  included resource's, workflow instance's, and run's projection; the
  pull-request projection entry, if included; and every resource-correlation
  fact (established, retracted, or conflicted) ever recorded for this
  WorkItem, read from the full event journal rather than from a projection,
  since correlation history is not itself exposed as a per-WorkItem
  freshness source elsewhere.
- A WorkItem with no correlated resources, no workflow instances, no runs,
  and no pull request MUST still be returned as a detail response containing
  just the WorkItem, not treated as not-found.

## Conceptual schema

**Work detail**

| Field | Type | Description |
| --- | --- | --- |
| `work` | WorkItem presentation | The WorkItem itself. |
| `resources` | list of Resource presentation | Every resource currently correlated to this WorkItem. |
| `orchestration.primary` | Workflow instance presentation or null | This WorkItem's parentless workflow instance, if any. |
| `orchestration.children` | list of Workflow instance presentation | Every workflow instance belonging to this WorkItem with a parent. |
| `execution.runs` | list of Run presentation | Every run belonging to any of this WorkItem's workflow instances. |
| `activities.pullRequest` | Pull request presentation, optional | The pull request correlated to one of this WorkItem's resources, if one has ever been recorded. |

## Dependencies and system role

- Work — owns the WorkItem projection this component reads for both list and
  detail, owns the WorkItemKey encode/decode this component's key handling
  relies on, and owns the `freeze`/`unfreeze`/`delete` command semantics this
  component only issues, never implements.
- Resources — owns resource projections, the work-correlation events this
  component scans the journal for to compute detail freshness, the resolved
  external-link presentation `delete` and `detail` both rely on, and the
  correlation-retraction command `delete` issues per correlated resource.
- Orchestration — owns the workflow instance projection this component reads
  to determine workflow membership and primary/child structure.
- Execution — owns the run projection this component reads to determine run
  membership.
- Activities — owns the pull-request projection this component reads to
  attach pull-request state to a detail response.
- API surface application (composed alongside this component) — shares its
  cursor/freshness pagination semantics; both are assembled into one
  `ApiApplications` value by the same composition step.

## Decisions, exclusions, and deferred capability

- Computing a detail response's correlation-history freshness contribution
  scans the entire event journal on every call; this component does not
  maintain a per-WorkItem index of correlation facts to avoid that scan.
- A detail response includes at most one pull request, matched by resource
  correlation; a WorkItem correlated to more than one resource that each
  have their own pull-request view is not disambiguated beyond "the first
  match found."
