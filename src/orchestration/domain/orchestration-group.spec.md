# OrchestrationGroup — Component Specification

## Type, purpose, and scope

Aggregate. OrchestrationGroup owns two related claim streams that arbitrate
scarce coordination resources across an orchestration group: a WorkItem's
primary-workflow ownership, and a Watch's per-group child budget. Neither
claim carries a status or a lifecycle of its own; each stream is a small,
append-only ledger of who holds a claim.

## Ubiquitous language

- **Primary claim** — the durable record of which WorkflowInstance is a
  WorkItem's one active primary. Scoped by `workItemId`.
- **Group budget claim** — the durable record of which child requests have
  been counted against a Watch's configured `maxPerGroup`. Scoped by the
  pair (orchestration group, Watch).

## Responsibilities and boundaries

OrchestrationGroup owns claim acceptance and rejection for both streams. It
does not decide whether a WorkflowInstance *should* start — that remains
the caller's (WorkflowInstance's start acceptance, and the child workflow
policy's) responsibility; OrchestrationGroup only arbitrates whether a claim
attempt succeeds against the current state of its stream.

## Core policies, invariants, and behaviours

**Primary claim**

- A WorkItem MUST have at most one primary claim owner for the life of its
  primary claim stream.
- Claiming a WorkItem's primary ownership for a WorkflowInstance identity
  that already holds it MUST be accepted as a no-op: no new fact is
  recorded.
- Claiming a WorkItem's primary ownership when a *different* WorkflowInstance
  identity already holds it MUST be rejected.
- Claiming a WorkItem's primary ownership when no claim yet exists MUST
  record it, arbitrated by optimistic append: if a concurrent claim attempt
  wins the append first, the losing attempt MUST re-read the stream and
  re-evaluate against the winner's claim (idempotent accept if it is the
  same identity, rejection otherwise), not surface the write conflict itself
  as an error.
- A claimed primary owner MAY be queried without side effect; a WorkItem
  with no claim yet has no primary owner.

**Group budget claim**

- A given request identity MUST count against a Watch's budget at most
  once: claiming with a request identity already present in the group's
  claimed set MUST be accepted as a no-op that still reports success.
- A new request identity MUST only be accepted while the number of already
  claimed requests is strictly less than the caller-supplied `maxPerGroup`;
  at or beyond that bound, the claim MUST be reported as failed and no new
  fact recorded.
- A successful new claim MUST be recorded by optimistic append, with the
  same re-read-and-re-evaluate arbitration as the primary claim on a
  concurrent write conflict.
- Budget scope is the pair (orchestration group, Watch): two different
  Watches within the same orchestration group, or the same Watch id across
  two different orchestration groups, claim against independent budgets.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.primary-claimed` | A WorkItem's primary claim is first recorded | This WorkflowInstance identity is now the WorkItem's one active primary; the claim is permanent for the stream's life. |
| `orchestration.group-claimed` | A child request's budget slot is first recorded | This request identity now counts against its Watch's `maxPerGroup` for this orchestration group. |

## Conceptual schema

**Primary claim** (stream scoped by `workItemId`)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity | Must match the stream's own scope; validated at decode time. |
| `workflowInstanceId` | WorkflowInstance identity | The primary WorkflowInstance this WorkItem now runs. |

**Group budget claim** (stream scoped by orchestration group and Watch)

| Field | Type | Description |
| --- | --- | --- |
| `key` | orchestration group / Watch stream identity | Must match the stream's own scope; validated at decode time. |
| `requestId` | request identity | The specific child request this claim admits against the budget. |

## Dependencies and system role

- Eventing — event journal conventions for reading and appending its own
  claim streams, and the optimistic-append conflict signal it retries on.
- WorkflowInstance (depends on this component for a primary start) — a
  primary start only proceeds once its WorkItem's primary claim succeeds.
- Child workflow policy (depends on this component for every child request)
  — a child only starts once its Watch's group budget claim succeeds; a
  failed claim produces a `GroupBudgetExhausted` fact on the parent instead.

## Decisions, exclusions, and deferred capability

- There is no command to release a primary claim or a group budget claim.
  A primary claim outlives its WorkflowInstance's own completion or
  blocking; a WorkItem cannot acquire a second primary through this
  mechanism even after its first primary finishes.
- A primary claim's failure (a different owner already holds it) is
  surfaced as a rejection to the caller; a group budget claim's failure is
  surfaced as a typed result (`GroupBudgetExhausted`), not a rejection —
  callers that request children are expected to handle exhaustion as a
  normal, non-error outcome.
