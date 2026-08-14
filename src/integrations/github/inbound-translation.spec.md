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
- **Formal review command** — a `reviewKind: 'formal'` comment body of
  exactly `/accepted` or `/changes`, translated to `acceptReviewSignal`/
  `requestChangesSignal` on Activities' PR Observation.
- **Issue approval command** — a `reviewKind: 'issue'` comment body of
  exactly `/approved` or `/changes` (case-insensitive, `/changes` may carry
  trailing feedback text), translated to a generic Orchestration signal for
  whichever gate the correlated WorkItem's workflow is currently waiting on.
- **Watch-gate verdict marker** — a fenced ```` ```json ```` block in a
  comment body containing `{ "wake": { "watchGateVerdict": { "runId",
  "outcome" } } }`, recognized as a candidate report of a watch's own agent
  run outcome.

## Responsibilities and boundaries

This component owns: resolving whether an observed external key is new or
already correlated to a WorkItem; for a new, eligible object, calling Work
Admission with the intake decision's tags; for an already-correlated
object, updating the Resource's revision, concluding its WorkItem when the
observation carries a terminal outcome, and, for a pull request, calling PR
Observation's `observe`; translating a formal review command into
`acceptReviewSignal`/`requestChangesSignal`; translating an issue approval
command into a generic Orchestration signal; and recognizing and verifying a
watch-gate verdict marker before signalling Orchestration with it. It does
not decide review trust or approve/merge authority — Activities' PR
Observation and Authority do. It does not decide what a watch-gate verdict
or an issue approval means inside a workflow — Orchestration does; this
component only verifies the claim is genuine and forwards it. It does not
poll GitHub itself — GitHub Inbound Evidence does.

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
- A revision change whose observation carries an `outcome` MUST call
  work-conclusion for the object's WorkItem, with a reason naming the
  adapter and external key, after `discover` and before any pull-request
  observation for that same event.
- A newly admitted object MUST be granted `commentable` capability always;
  a pull request MUST additionally be granted `reviewable`, `revisioned`,
  and `changed-files`; an issue is granted no further capability. This
  component does not grant `approvable` or `mergeable` to a newly admitted
  pull request — those are granted separately, when Artifact Verification
  (`provider.ts`'s `verifyArtifact`) is the path that first discovers the
  Resource for a Wake-created PR.
- A newly admitted pull request's initial PR Observation MUST be recorded
  as Work Admission's `beforeStart` hook, so it is visible before the
  WorkItem's workflow starts.
- Objective and tags for a newly admitted object come from the observed
  title and the intake decision's own tags; neither is re-derived from
  anything else.
- A `reviewKind: 'formal'` comment body other than exactly `/accepted` or
  `/changes` MUST NOT produce a formal review command; nothing is recorded
  for it. `/accepted` MUST be translated to `acceptReviewSignal`, and
  `/changes` to `requestChangesSignal`; both carry the comment's own
  provider event id as the resulting fact's correlating event id, so
  Activities' idempotency and rejection semantics for that command apply
  unchanged.
- When a formal review command's external key has no known Resource yet,
  this component MUST mint a fresh Resource id for the resulting command
  rather than reject it; Activities' PR Observation itself is what rejects
  an unknown or non-PR-shaped Resource.
- A `reviewKind: 'issue'` comment body other than exactly `/approved` or
  `/changes` (optionally followed by feedback text) MUST NOT produce an
  issue approval command. A recognized command with no known Resource for
  its external key MUST be a no-op — issue approval never mints an
  identity. For each of that Resource's primary-correlated WorkItems whose
  workflow instance is currently waiting on a signal, `/approved` MUST
  accept that wait with a `done` outcome and `/changes` with a `rejected`
  outcome, addressed to whichever `signalKind` the instance actually named;
  this component does not restrict which gate an issue approval resolves.
  The resulting signal's `actorDecision.authorized` MUST be `true` only
  when the commenting actor's kind is human.
- A watch-gate verdict marker MUST be ignored unless its `outcome` is
  `DONE` or `REJECTED` (never `BLOCKED`/`FAILED`), and unless the named
  `runId` resolves to a run that actually succeeded with that same outcome
  — this component MUST NOT trust the marker's own claim about a run
  without independently verifying it against the run's own durable record.
  A verified marker MUST also resolve to a workflow instance that is a
  watch's spawned child, whose parent workflow instance is currently
  waiting on a watch-gate-verdict signal naming that same child's watch;
  any other case MUST be ignored. Only when every check passes does this
  component signal the parent workflow instance, authorized as the named
  watch.
- Every command issued by this component MUST carry a `CommandContext`
  whose `commandId` derives from the originating evidence event's own id
  and whose actor identifies the GitHub adapter, not a human.

## Dependencies and system role

- GitHub Inbound Evidence (this component depends on it) — the sole source
  of the evidence this component translates.
- Work Admission (this component depends on it) — called for every newly
  admitted object.
- Work Conclusion (this component depends on it) — called for a
  reobservation whose evidence carries a terminal `outcome`.
- Resources (this component depends on it) — reads `ResourceView` and
  correlations, and calls `discover` for a revision change on an
  already-known object.
- Activities' PR Observation (this component depends on it) — `observe`,
  `acceptReviewSignal`, `requestChangesSignal`.
- Orchestration (this component depends on it) — `acceptSignal`, for an
  issue approval command and for a verified watch-gate verdict.
- Execution (this component depends on it) — reads a `RunRepository` view
  to verify a watch-gate verdict marker's claimed run and outcome before
  trusting it.
- The module's own intake-rule evaluation (this component depends on it) —
  GitHub only supplies its own facet mapping; eligibility and tagging
  semantics are the module's, not GitHub's own.

## Decisions, exclusions, and deferred capability

- This component's granted pull-request capability list is `commentable`,
  `reviewable`, `revisioned`, `changed-files`; it does not currently grant
  `approvable` or `mergeable` (Artifact Verification grants those instead,
  for the Wake-created-PR discovery path). Activities' PR merge policy reads
  `changed-files` capability/evidence to authorize `maxFilesChanged` and
  `blockedPaths` checks, so this component's changed-files evidence (fetched
  per poll in `pr-source.ts` and forwarded through `ExternalWorkObservedPayload.changedFiles`)
  is load-bearing for that policy, not merely descriptive.
