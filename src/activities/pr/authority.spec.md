# PR Merge & Review Authority — Component Specification

## Type, purpose, and scope

Policy/process. The deterministic decision of whether a WorkItem's
correlated pull request may currently be approved or merged, and the
review-signal trust rule that decision depends on. Reads Observation's facts
and Resources'/Work's views; owns no stream of its own.

## Ubiquitous language

- **Authority decision** — allowed (with the resolved Resource and its
  revision) or denied (with a `PullRequestDenialCode` reason).
- **Merge policy** — an optional, decision-specific constraint
  (`maxFilesChanged`, `blockedPaths`) that only a merge decision applies; an
  approve decision never sets one.
- **Reviewer authorization evidence** — how a reviewing actor's authority
  was established: a configured reviewer identity, a provider-reported
  permission level, or none.
- **Trusted permission** — the provider permission levels (`write`,
  `maintain`, `admin`) that authorize a human review by themselves, absent a
  configured-reviewer match.

## Responsibilities and boundaries

Authority owns resolving which single Resource a decision targets, the
ordered set of authority checks (correlation → PR existence/state → review →
checks → changed-files) and their denial reasons, and the review-signal
trust rule Observation calls when recording an acceptance signal.

Authority does not record any fact itself — its decision function returns a
value; callers (the merge-authority gate, or PR Approve & Merge Decision)
are responsible for recording the resulting fact. It does not resolve which
Resources are candidates at all — that read comes from Observation and
Resources.

## Core policies, invariants, and behaviours

- Authority MUST be denied `missing-resource` when the WorkItem has no view,
  or the targeted Resource is not a PR-shaped Resource with exactly one
  verified primary correlation to the WorkItem (and no recorded correlation
  conflict), or that Resource has no matching `PullRequestView`.
- Authority MUST be denied `ambiguous-resource` when more than one candidate
  Resource matches an unqualified (primary-role) target.
- Authority MUST be denied `correlation-conflict` when the resolved
  Resource's primary correlation is not exactly one entry for the requesting
  WorkItem, or the Resource itself records a correlation conflict.
- Authority MUST be denied `closed` when the pull request's state is not
  `open`.
- When the decision requires an accepted review: authority MUST be denied
  `stale-approval` when there is no accepted review for the current head
  revision and no untrusted signal was recorded for it either; authority
  MUST be denied `untrusted-actor` when an untrusted signal exists for the
  current head revision, or an accepted review exists but no correlating
  trusted signal is found for it.
- When the decision requires checks: authority MUST be denied
  `checks-pending` while checks are `unknown` or `pending`, and
  `checks-failing` while checks are `failing`.
- When a merge policy is configured (either `maxFilesChanged` set or
  `blockedPaths` non-empty) and the Resource lacks changed-files capability,
  or the current revision's changed files were never reported: authority
  MUST be denied `changed-files-unavailable`.
- When a merge policy is configured and available: authority MUST be denied
  `too-many-files-changed` when the changed-file count exceeds
  `maxFilesChanged`, checked before `blocked-path-changed`, which applies
  when any changed file matches `blockedPaths`.
- A decision with no merge policy configured MUST NOT apply either
  changed-files check, regardless of the Resource's capabilities.
- Checks run in a fixed order (resource/correlation → PR existence/state →
  review → checks → changed-files) and stop at the first denial; a decision
  never reports more than one reason.
- The default options — no explicit `target`, `requireAcceptedReview: true`,
  `requireChecks: true`, no merge policy — apply when a caller omits
  options.
- Review-signal trust: a signal MUST be authorized only when the actor is
  human, the actor is not the resource's own author (case-insensitive
  identity match), and either the actor matches a configured-reviewer
  identity or the actor's provider permission is `write`, `maintain`, or
  `admin`. A bot actor, a self-review, or `none`/unrecognized authorization
  evidence MUST NOT be authorized.
- The merge-authority gate MUST be idempotent by command id: if a
  `pr.merge-authorized` or `pr.merge-denied` fact already exists for the
  same command id, the gate MUST return that recorded result rather than
  decide again or append a duplicate fact.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `pr.merge-authorized` | The gate's authority decision allows the merge | The correlated WorkItem's pull request may currently be merged, at the recorded revision. |
| `pr.merge-denied` | The gate's authority decision denies the merge | The merge may not currently proceed, for the recorded reason. |

## Conceptual schema

**PullRequestAuthorityInput** (assembled per decision; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `work` | WorkItemView or null | The WorkItem the decision is for. |
| `resources` | list of PR-shaped Resource + correlations | Candidate Resources correlated to the WorkItem. |
| `pullRequests` | list of PullRequestView | Observation's current view per candidate Resource. |
| `acceptedSignals` | list of Accepted signal view | Observation's full acceptance-signal history for the candidate Resources. |

**PullRequestAuthorityDecision**

| Field | Type | Description |
| --- | --- | --- |
| `allowed` | boolean | Whether the decision is granted. |
| `resourceId` | Resource identity (allowed only) | The Resource the decision resolved to. |
| `revision` | string (allowed only) | The revision authority was granted for. |
| `reason` | closed vocabulary: PullRequestDenialCode (denied only) | Why authority was denied. |

## Dependencies and system role

- PR Observation (Authority depends on it) — the sole source of
  `PullRequestView` and accepted-signal history this decision reads.
- Resources, Work (Authority depends on them) — read-only capability,
  correlation, and WorkItem-existence checks.
- PR Approve & Merge Decision (depends on Authority) — calls the same
  decision function to resolve an activation's approve/merge outcome.
- PR Observation (depends on Authority's review-trust rule) —
  `acceptReviewSignal` calls it to decide `pr.review-accepted` vs
  `pr.review-rejected`.

## Decisions, exclusions, and deferred capability

- The merge-authority gate and the `authorizeMerge`/`decideAuthority`
  methods it wraps are implemented but not currently invoked from
  production composition; no workflow step currently calls this gate.
- Authority does not enforce any ordering between multiple WorkItems
  targeting the same Resource; correlation-conflict detection is Resources'
  own responsibility, surfaced here only as a denial reason.
