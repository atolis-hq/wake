# Work Admission — Component Specification

## Type, purpose, and scope

Policy/process. Work Admission is the single process by which a newly
observed external object, already judged eligible and already assigned a
Resource/WorkItem identity pair by its caller, becomes Wake work: it
discovers the Resource, creates the WorkItem, correlates the two, and starts
the WorkItem's workflow.

## Responsibilities and boundaries

Work Admission owns the fixed order of that sequence and the correlation
role it uses. It does not decide eligibility or tags — its caller (a
provider's inbound translation) has already decided both. It does not mint
the `ResourceId`/`WorkItemId` it is given, and it does not decide which
workflow to start; it asks a caller-supplied `WorkflowRouter` for the
workflow name and never proposes one itself.

## Core policies, invariants, and behaviours

- A call MUST discover the Resource, then create the WorkItem, then
  correlate the Resource to the WorkItem, then — if the caller supplied a
  `beforeStart` hook — run it, then start the WorkItem's workflow, in that
  exact order.
- The Resource-to-WorkItem correlation MUST use the `primary` role. Work
  Admission never issues a `secondary` correlation.
- The started workflow's instance id and orchestration group id MUST be
  derived deterministically from the WorkItemId alone, so a repeated
  admission call for the same WorkItemId always targets the same workflow
  instance rather than minting a new one.
- The workflow name MUST come from the injected `WorkflowRouter`, given the
  observation's tags, kind, and adapter; Work Admission MUST NOT decide a
  workflow name by any other means.
- A caller-supplied `beforeStart` hook, when present, MUST run after
  correlation and before the workflow starts, so any evidence it records
  (e.g. an initial PR observation) is visible to the workflow's entry stage
  from its first tick.
- Acceptance, rejection, and idempotency of the individual `discover`,
  `create`, `correlate`, and `start` calls belong to Resources, Work, and
  Orchestration respectively; Work Admission enforces only the ordering and
  the primary-correlation role stated above, and does not itself decide
  whether a step succeeds.

## Conceptual schema

**AdmitObservedWork** (the process's own input)

| Field | Type | Description |
| --- | --- | --- |
| `adapter` | Adapter identity | Which provider instance observed this object. |
| `resourceId` | Resource identity | Already minted by the caller. |
| `workItemId` | WorkItem identity | Already minted by the caller. |
| `kind` | Resource kind | The kind of Resource to discover (e.g. issue, pull request). |
| `externalKey` | adapter + provider key | The provider-side locator the Resource correlates to. |
| `capabilities` | list of Resource capability | What the discovered Resource can do (commentable, reviewable, ...). |
| `objective` | string | The WorkItem's initial objective. |
| `tags` | list of string | The WorkItem's initial tags, already decided by the caller's intake decision. |
| `revision` | string (optional) | The Resource's observed revision, when the provider reports one. |
| `title` | string (optional) | The Resource's observed title, when the provider reports one, recorded onto the Resource alongside its discovery. |

## Dependencies and system role

- Resources (Work Admission depends on it) — `discover` and `correlate`;
  Work Admission never writes a resource-identity fact itself.
- Work (Work Admission depends on it) — `create`; Work Admission never
  writes a `work.*` fact itself.
- Orchestration (Work Admission depends on it) — `start`, using the
  `WorkflowRouter`'s selected workflow name.
- `WorkflowRouter` (Work Admission depends on it) — supplied by the caller,
  not composed here; Work Admission only asks it for a name.
- GitHub Inbound Translation and the fake provider's inbound translator
  (both depend on Work Admission) — the two current callers, each deciding
  eligibility and tags before calling in.

## Decisions, exclusions, and deferred capability

- Work Admission's caller persists the identity pair before invoking this
  sequence. If a failure partway through is retried, the same idempotent
  `discover`, `create`, `correlate`, and `start` operations resume with that
  pair rather than minting a second WorkItem.
