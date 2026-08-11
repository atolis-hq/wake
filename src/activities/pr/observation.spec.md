# PR Observation — Component Specification

## Type, purpose, and scope

Aggregate. PR Observation turns provider-observed pull-request facts (state,
revisions, checks, review signals) into the module's own durable
`pr.*`/`review.*` facts, recorded on the correlated Resource's own stream. It
is the sole writer of these facts and the source PR Merge & Review Authority
and PR Approve & Merge Decision both read from.

## Ubiquitous language

- **Observation** — a caller's report of a pull request's current
  state/revisions/checks, for a Resource already correlated to a WorkItem.
- **Acceptance signal** — a caller's report that a specific human or bot
  accepted, or requested changes on, a specific revision.
- **Accepted review** — the current revision's most recent trusted
  acceptance; a revision change or a changes-requested signal invalidates
  it.

## Responsibilities and boundaries

Observation owns deciding whether an `observe` command is a first discovery
or a change to already-recorded state (and which of revision/state/checks
actually changed), recording review acceptance/changes-requested/rejection
facts, and the read models (`PullRequestView`, accepted-signal history)
folded purely from those facts.

It does not decide whether a reviewer's acceptance is *trustworthy* — Review
Authorization, part of PR Merge & Review Authority, decides that; Observation
only records the resulting trusted/untrusted fact. It does not decide
whether the WorkItem's pull request may currently be approved or merged —
that is Authority's decision, not Observation's.

## Core policies, invariants, and behaviours

- An `observe` command MUST be rejected unless its Resource has exactly one
  `primary` correlation to the named WorkItem, has no recorded
  primary-correlation conflict, and is a PR-shaped resource; and the named
  WorkItem itself MUST exist.
- The first `observe` for a Resource MUST record `pr.discovered` with the
  observation's full state, and MUST NOT record a discovery fact twice for
  the same Resource.
- A later `observe` MUST record only the facts for what actually changed
  relative to the currently recorded view: `pr.revision-changed` when head
  or base revision differs, `pr.state-changed` when state differs,
  `pr.checks-changed` when checks differ — independently, so a single
  observation can record any combination of these three, or none.
- A revision change MUST invalidate the prior accepted review and prior
  changed-files evidence for that Resource; a state or checks change alone
  MUST NOT.
- Accepting a review signal MUST first check for a rejection condition
  (missing or non-PR-shaped Resource, correlation conflict, or the signal's
  revision no longer being the current head): when one applies, it MUST
  record `pr.review-rejected` with that reason and record nothing else.
- Otherwise, accepting a review signal MUST record
  `review.acceptance-signal-recorded` (always, as an audit trail) together
  with either `pr.review-accepted` (when the actor is authorized to accept)
  or `pr.review-rejected` with reason `untrusted-actor` (when not),
  recorded as a single atomic pair.
- A changes-requested signal MUST record `pr.review-changes-requested` when
  no rejection condition applies, or `pr.review-rejected` with the rejection
  reason otherwise — never both.
- `pr.review-changes-requested` MUST clear any currently accepted review for
  that Resource without altering revision or changed-files evidence.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `pr.discovered` | A verified, PR-shaped Resource is observed for the first time | An initial `PullRequestView` now exists for this Resource. |
| `pr.revision-changed` | A later observation reports a different head/base revision | New commits landed; prior review and changed-files evidence for the old revision no longer apply. |
| `pr.state-changed` | A later observation reports a different open/closed/merged state | The pull request's lifecycle state moved. |
| `pr.checks-changed` | A later observation reports a different checks state | Whether checks are passing changed. |
| `pr.review-accepted` | A trusted human accepts the current head revision | The current revision now has a trusted, current acceptance. |
| `review.acceptance-signal-recorded` | Any acceptance signal, trusted or not, is observed | An audit record of the attempt, independent of whether it counted. |
| `pr.review-changes-requested` | A reviewer requests changes on the current head revision | Any currently accepted review is no longer current. |
| `pr.review-rejected` | An observed review signal cannot be accepted as given | The attempted signal did not become an accepted review, for the recorded reason. |

## Conceptual schema

**PullRequestView** (per Resource; the fold of its own `pr.*`/`review.*`
facts)

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | The PR-shaped Resource this view is for; also its fold key. |
| `workItemId` | WorkItem identity | Recorded at discovery; not revised by later observations. |
| `state` | closed vocabulary: `open` / `closed` / `merged` | Current lifecycle state as last observed. |
| `headRevision` | string | Current head revision as last observed. |
| `baseRevision` | string | Current base revision as last observed. |
| `checks` | closed vocabulary: `unknown` / `pending` / `passing` / `failing` | Current checks state as last observed. |
| `acceptedReview` | Accepted review entry (optional) | Present only while the current head revision has a trusted, unsuperseded acceptance. |
| `changedFiles` | list of string (optional) | Files the head revision changed, when the provider reported them; cleared on revision change until re-reported. |

**Accepted review entry** (child of PullRequestView)

| Field | Type | Description |
| --- | --- | --- |
| `revision` | string | The revision that was accepted. |
| `actorId` | string | Who accepted it. |
| `acceptedEventId` | Event identity | The `pr.review-accepted` fact this entry came from. |

**Accepted signal view** (per acceptance-signal fact; not scoped to the
current revision)

| Field | Type | Description |
| --- | --- | --- |
| `resourceId` | Resource identity | The Resource the signal was about. |
| `revision` | string | The revision the signal was about. |
| `actorId` | string | Who signalled. |
| `actorKind` | closed vocabulary: `human` / `bot` | |
| `acceptedEventId` | Event identity | Correlates to the `pr.review-accepted` fact recorded for the same acceptance, if any. |
| `trusted` | boolean | Whether Review Authorization judged this signal trustworthy at the time it was recorded. |

## Dependencies and system role

- Resources (Observation depends on it) — reads `ResourceView` and
  correlations to gate `observe`, and appends its own `pr.*`/`review.*`
  facts onto the Resource's stream; it never writes a resource-identity
  fact.
- Work (Observation depends on it) — requires the WorkItem to exist;
  read-only, never writes `work.*` facts.
- Review Authorization, part of PR Merge & Review Authority (Observation
  depends on it) — decides whether an acceptance signal is trustworthy;
  Observation only records the resulting fact.
- PR Merge & Review Authority (depends on Observation) — reads
  `PullRequestView` and accepted-signal history as its authority-decision
  input.
- Integrations' GitHub inbound translator (depends on Observation) — the
  production caller of `observe`/`acceptReviewSignal`/`requestChangesSignal`,
  turning provider webhook/poll events into these commands.

## Decisions, exclusions, and deferred capability

- Observation does not retain revision history in its read model; only the
  current revision's state is queryable there, though every transition
  remains in the event log.
- Observation does not verify a review's `providerEventId` against the
  provider itself; it trusts the caller's translation layer to have
  deduplicated provider-side events before calling.
