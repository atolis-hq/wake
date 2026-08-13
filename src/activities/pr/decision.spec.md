# PR Approve & Merge Decision — Component Specification

## Type, purpose, and scope

Aggregate. The `pr.approve`/`pr.merge` built-in Activities and the
`activity-decision` stream that makes each activation's decision idempotent:
exactly one claimed decision (denied, or requested) per activation and
action, and exactly one resulting fact written to its target stream.

## Ubiquitous language

- **Decision claim** — the durable record, on a stream keyed by
  `(activationId, action)`, that an activation's decision resolved to a
  specific decision kind and outcome. First write wins.
- **Decision kind** — `requested` (authority allowed; a delivery intent was
  recorded) or `denied` (a denial reason was recorded).
- **Target resolution** — choosing which single correlated, capability-
  matching Resource an unqualified (`primary`-role) or explicit
  (`{ resourceId }`) target refers to, before authority is even consulted.
- **Delivery intent** — the durable fact meaning "please deliver this
  approve/merge action"; carries an `idempotencyKey` equal to its own event
  id, and the revision authority was granted for.
- **Intent append status** — `appended` (new), `known` (already recorded,
  same event id), `ambiguous` (the append attempt's own success is
  uncertain), or `failed`.

## Responsibilities and boundaries

Decision owns claiming a single outcome per `(activationId, action)`,
resolving which Resource an unqualified target refers to among the
WorkItem's primary-correlated, capability-matching candidates, consulting PR
Merge & Review Authority for the allow/deny decision, and writing the
resulting denial or delivery-intent fact to its target stream exactly once.

It does not decide *whether* authority allows the action — that is PR Merge &
Review Authority's decision, consumed as an input. It does not observe or
maintain pull-request state — that is PR Observation's. It does not itself
delivery an approve/merge action to a provider; a delivery intent is a
request for something outside this module to act on.

## Core policies, invariants, and behaviours

- Target resolution MUST deny `missing-resource` when no primary-correlated,
  capability-matching candidate exists for the WorkItem, and
  `ambiguous-resource` when more than one does. Resolution runs before
  authority is consulted, and its denial is written to the **WorkItem's**
  stream (no Resource was yet resolved to write it to).
- An authority denial (from PR Merge & Review Authority, consulted only
  after a Resource resolves) MUST be written to the **resolved Resource's**
  stream.
- A decision MUST be claimed at most once per `(activationId, action)`: the
  first successful append to that pair's decision stream wins, and every
  later attempt for the same pair MUST return the winning claim unchanged
  rather than reconsider target resolution or authority.
- If two callers race to claim the same `(activationId, action)`, the append
  that loses the race MUST re-read the stream and adopt the winner's claim
  as its own result rather than error or retry the decision.
- Completing a claim MUST write its recorded fact (denial or delivery
  intent) to the fact's own target stream idempotently by the fact's own
  event id: a fact already present with that id counts as already written,
  and MUST NOT be appended again.
- Writing the fact MUST retry an optimistic-append conflict against the
  target stream (re-reading and re-checking for the fact's own event id) up
  to a bounded number of attempts before the write is treated as failed.
- An outcome whose fact could not be confirmed written MUST be reported as a
  `failed` outcome with reason `intent-write-failed`, overriding whatever
  outcome the claim itself recorded (`waiting` for a requested decision,
  `blocked` for a denied one) — the claim is durable, but the caller is only
  told the action succeeded once its fact is confirmed on the target stream.
- An `ambiguous` fact-write result MUST be resolved deterministically before
  it reaches a caller: re-read the target stream and report `known` if the
  fact's event id is now present, `failed` otherwise. A caller never
  observes `ambiguous` directly.
- Approve MUST NOT require an accepted review or passing checks; it applies
  no merge policy. Merge MUST always require an accepted review, MUST
  require checks only when its input's `requireChecks` requests it, and MUST
  apply a merge policy whenever `maxFilesChanged` is set or `blockedPaths` is
  non-empty.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `pr.approve-decision-claimed` | A `pr.approve` activation's decision is claimed for the first time | This activation's approve decision (denied or requested) is now fixed. |
| `pr.merge-decision-claimed` | A `pr.merge` activation's decision is claimed for the first time | This activation's merge decision (denied or requested) is now fixed. |
| `pr.approve-denied` | An approve decision is denied, at target resolution or at authority | The pull request may not currently be approved, for the recorded reason. |
| `pr.merge-denied` | A merge decision is denied, at target resolution or at authority | The pull request may not currently be merged, for the recorded reason. |
| `pr.approve-requested` | An approve decision is allowed | A delivery intent to approve now exists; the Activity reports `waiting`. |
| `pr.merge-requested` | A merge decision is allowed | A delivery intent to merge now exists; the Activity reports `waiting`. |

## Conceptual schema

**Decision claim** (one per `(activationId, action)`, on its own
`activity-decision` stream)

| Field | Type | Description |
| --- | --- | --- |
| `action` | closed vocabulary: `approve` / `merge` | Which built-in Activity this claim is for. |
| `activationId` | Activation identity | The activation this decision was claimed for. |
| `decisionKind` | closed vocabulary: `requested` / `denied` | What the claim resolved to. |
| `outcome` | PullRequestActivityOutcome | The outcome to report for this activation (subject to being overridden to `failed` if the fact write is not confirmed). |
| `fact` | event draft | The denial or delivery-intent fact this claim commits to writing, and to where. |

**Delivery intent fact** (written to the resolved Resource's stream)

| Field | Type | Description |
| --- | --- | --- |
| `idempotencyKey` | string | Equal to the fact's own event id; the value a delivery mechanism can use to deduplicate. |
| `resourceId` | Resource identity | The resolved target. |
| `revision` | string | The revision authority was granted for. |
| `activationId`, `workflowInstanceId` | identities | Correlate the intent back to the requesting activation/workflow. |

## Dependencies and system role

- PR Merge & Review Authority (Decision depends on it) — the sole source of
  the allow/deny decision Decision writes a fact from.
- PR Observation, Resources, Work (Decision depends on them, transitively via
  Authority's input) — Decision itself only reads Resource capability/
  correlation data for target resolution.
- Activity Registry (depends on Decision) — registers `pr.approve`/
  `pr.merge` as built-in Activities backed by this component's handlers.
- Whatever performs delivery (outside this module, depends on Decision) —
  consumes a delivery-intent fact and later reports a `delivery-result`
  signal Orchestration correlates back to the `intentEventId` the claimed
  outcome recorded.

## Decisions, exclusions, and deferred capability

- The `ambiguous` intent-append status exists in the shared vocabulary for a
  future appender whose own write confirmation is genuinely uncertain (e.g.
  a provider-delivery appender); the journal-backed appender this component
  uses today never produces it, only resolves it if received.
- A decision claim, once made, is permanent: there is no command to reclaim
  or reconsider an activation's approve/merge decision after the fact.
