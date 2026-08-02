# GitHub Inbound Translation — Component Specification

## Type, purpose, and scope

Adapter. This component turns `integration.github.*` evidence into Work
Admission calls, Resource state updates, and Activities' PR Observation
commands: it is the production caller of `observe`, `acceptReviewSignal`,
and `requestChangesSignal` for GitHub.

## Ubiquitous language

- **Intake facet mapping** — GitHub's own `kind`/`label`/`assignee`/`author`
  vocabulary, translated onto the module's provider-neutral intake facets so
  the shared intake-rule evaluation applies unchanged.
- **Review command** — a comment body of exactly `/accepted` or `/changes`,
  the only two comment bodies this component treats as a review signal.

## Responsibilities and boundaries

This component owns: resolving whether an observed external key is new or
already correlated to a WorkItem; for a new, eligible object, calling Work
Admission with the intake decision's tags; for an already-correlated
object, updating the Resource's revision and, for a pull request, calling
PR Observation's `observe`; and translating an observed `/accepted`/
`/changes` comment into `acceptReviewSignal`/`requestChangesSignal`. It does
not decide review trust or approve/merge authority — Activities' PR
Observation and Authority do. It does not poll GitHub itself — GitHub
Inbound Evidence does.

## Core policies, invariants, and behaviours

- Resolving an external key MUST check, in order: identities already minted
  earlier in the same translation batch; then the durable lookup for an
  existing correlation; only when neither applies does resolution mint a
  fresh Resource/WorkItem identity pair, and only if the observation's
  intake decision admits it. An ineligible object Wake has never seen MUST
  produce no WorkItem, Resource, or effect.
- An already-correlated Resource whose lookup succeeds but has no `primary`
  correlation to a WorkItem MUST be treated as an error, not silently
  skipped.
- For an already-known object, a revision change MUST call `discover` with
  the new revision before any pull-request observation is applied for that
  same event.
- A newly admitted object MUST be granted `commentable` capability always;
  a pull request MUST additionally be granted `reviewable` and
  `revisioned`; an issue is granted no further capability. This component
  does not grant `approvable`, `mergeable`, or `changed-files` capability to
  a newly admitted pull request.
- A newly admitted pull request's initial PR Observation MUST be recorded
  as Work Admission's `beforeStart` hook, so it is visible before the
  WorkItem's workflow starts.
- Objective and tags for a newly admitted object come from the observed
  title and the intake decision's own tags; neither is re-derived from
  anything else.
- A comment body other than exactly `/accepted` or `/changes` MUST NOT
  produce a review command; nothing is recorded for it.
- An `/accepted` comment MUST be translated to `acceptReviewSignal`, and
  `/changes` to `requestChangesSignal`; both carry the comment's own
  provider event id as the resulting fact's correlating event id, so
  Activities' idempotency and rejection semantics for that command apply
  unchanged.
- When a review command's external key has no known Resource yet, this
  component MUST mint a fresh Resource id for the resulting command rather
  than reject it; Activities' PR Observation itself is what rejects an
  unknown or non-PR-shaped Resource.
- Every command issued by this component MUST carry a `CommandContext`
  whose `commandId` derives from the originating evidence event's own id
  and whose actor identifies the GitHub adapter, not a human.

## Dependencies and system role

- GitHub Inbound Evidence (this component depends on it) — the sole source
  of the evidence this component translates.
- Work Admission (this component depends on it) — called for every newly
  admitted object.
- Resources (this component depends on it) — reads `ResourceView` and
  correlations, and calls `discover` for a revision change on an
  already-known object.
- Activities' PR Observation (this component depends on it) — `observe`,
  `acceptReviewSignal`, `requestChangesSignal`.
- The module's own intake-rule evaluation (this component depends on it) —
  GitHub only supplies its own facet mapping; eligibility and tagging
  semantics are the module's, not GitHub's own.

## Decisions, exclusions, and deferred capability

- This component's granted pull-request capability list is
  `commentable`, `reviewable`, `revisioned`; it does not currently grant
  `approvable`, `mergeable`, or `changed-files`. No built-in Activity
  currently declares a `ResourceRequirement` that checks for them, so this
  has no observed functional effect today, but a caller that adds such a
  requirement in future would need this component updated too.
