# Board projection — Component Specification

## Type, purpose, and scope

Projection. The board projection (`operator-board`) folds Work,
Orchestration, and Execution events into one global read model: a per-
WorkItem card carrying its display condition, current workflow stage,
in-flight run, and cumulative run totals — ready for the operator board and
top-level status responses to read without themselves touching Work's,
Orchestration's, or Execution's own projections.

## Ubiquitous language

- **Condition** — the board's own closed five-value display state for a
  card: `ready`, `active`, `needs-input`, `error`, `finished`. Distinct from
  Work's own status and Orchestration's own `WorkflowStatus`; this
  projection derives it from both.
- **Card** — the per-WorkItem read model this projection owns: identity,
  objective, condition, current workflow/stage, awaiting-approval flag,
  active-run summaries, and cumulative run totals (count, tokens, cost,
  duration).
- **Child instance** — a workflow instance carrying a
  `parentWorkflowInstanceId` (spawned by a watch). A child shares its
  parent WorkItem's card but never drives that card's condition, stage, or
  awaiting-approval flag — only a primary (parentless) instance does.

## Responsibilities and boundaries

This component owns deriving one board card per WorkItem from the raw
Work/Orchestration/Execution event stream, and owns the child-instance
non-driving rule that keeps a spawned reviewer/child run from overriding the
primary instance's displayed state. It does not own WorkItem, workflow, or
run state itself — those remain each owning module's own projection — and it
does not own how a card is paginated, sorted, or presented to a caller (the
API surface application's board and status applications do that).

## Core policies, invariants, and behaviours

- A card is created on `ItemCreated` (condition `ready`, zero totals) and
  removed entirely on `ItemDeleted` — deletion is a purge, not a lifecycle
  outcome, so a deleted WorkItem MUST NOT appear in any condition column.
  `ItemClosed`/`ItemCancelled` MUST instead set condition `finished`, and a
  `finished` card MUST NOT be moved out of `finished` by any later workflow
  event — closure is terminal.
- `InstanceStarted` for a primary instance MUST set the card's
  `workflowName`, its `stage` to the workflow's entry stage, reset
  `dwellSince`, and set condition `ready`. `InstanceStarted` for a child
  instance MUST NOT touch the card beyond recording the child's own entry
  stage, for later Run labelling.
- `StageEntered` MUST always reset condition to `ready` regardless of the
  stage's inherited condition (an `error` from the prior stage's failed run,
  or whatever the card held before an unblocking `SignalAccepted`) — a new
  stage starts clean until a Run or a fresh wait signal says otherwise.
- Every other orchestration status-changing event type MUST be resolved
  through the shared status-transition table rather than hand-matched by
  event type, so a new status-changing event automatically reaches the
  board. `SignalWaitStarted` MUST additionally set `awaitingApproval` when
  the wait's signal kind is an approval-awaiting kind; `SignalAccepted`
  MUST clear it.
- `RunStarted` MUST increment `runCount`, record its `activeRuns` entry keyed
  by Run ID (action, optional runner name, start time), and `lastRunAt`; for a primary-instance
  run only, it MUST also set condition `active` and clear
  `awaitingApproval`. A run started under a child instance MUST leave the
  card's condition and `awaitingApproval` untouched — the primary is still
  genuinely waiting on that child.
- A terminal run event (`RunSucceeded`, `RunFailed`, `RunCancelled`,
  `RunAmbiguous`) MUST remove only its own `activeRuns` entry, accumulate its duration into
  `totalDurationMs`, and record `lastRunOutcome`. For `RunSucceeded`
  specifically, the resulting condition MUST follow the run's reported
  outcome kind (`failed` → `error`, `blocked` → `needs-input`, otherwise →
  `ready`), not the transport-level success of the run itself — a run that
  transported successfully but whose agent reported failure or a block MUST
  NOT leave the card looking `ready`. As with `RunStarted`, a terminal event
  for a child-instance run MUST NOT change the card's condition.
- `RunRunnerResultReported` MUST accumulate that report's token usage and
  cost into the card's running totals; it MUST NOT affect condition.
- The projection MUST tolerate events recorded before a given field existed
  (e.g. `children`/`childRuns` on a projection rebuilt from an older event
  history) by treating a missing map as empty rather than failing.

## Event catalogue

This component reacts to Work's `ItemCreated`, `ObjectiveRevised`,
`ItemClosed`, `ItemCancelled`, and `ItemDeleted`; Orchestration's
`InstanceStarted`, `StageEntered`, and every status-changing event (via the
shared transition table, including `SignalWaitStarted`/`SignalAccepted`);
and Execution's `RunStarted`, `RunSucceeded`, `RunFailed`, `RunCancelled`,
`RunAmbiguous`, and `RunRunnerResultReported`. It emits no events of its
own.

## Conceptual schema

**Board card**

| Field | Type | Description |
| --- | --- | --- |
| `workItemKey` / `workItemId` | WorkItemKey / WorkItemId | The card's identity, in both public and internal form. |
| `objective` | string | The WorkItem's current objective. |
| `condition` | Condition | `ready` \| `active` \| `needs-input` \| `error` \| `finished`. |
| `awaitingApproval` | boolean, optional | Present and true only while the primary instance is waiting on an approval-kind signal. |
| `workflowName` / `stage` | string, optional | The primary instance's workflow and current stage. |
| `dwellSince` | timestamp | When the card entered its current stage (or was created, before any stage). |
| `runCount` | number | Total runs started under this WorkItem's workflow instances, including child instances. |
| `activeRuns` | object, keyed by Run ID | Every in-flight run's action label, optional runner name, and start time; empty when nothing is running. |
| `lastRunAt` / `lastRunOutcome` | timestamp / string, optional | The most recently started run's start time, and the most recently finished run's outcome. |
| `totalTokens` / `totalCostUsd` / `totalDurationMs` | number | Cumulative totals across every run recorded for this WorkItem. |

## Dependencies and system role

- Work, Orchestration, Execution — this component's only inputs; it selects
  and folds their event types directly rather than reading their own
  projections.
- Composition root (depends on this component) — registers it for
  production catch-up/rebuild composition.
- API surface application (depends on this component) — the board and
  status responses read this projection's `cards`/`conditionCounts`
  directly; presentation, pagination, and enrichment (external links,
  elapsed-time fields) are that component's own concern, not this one's.

## Decisions, exclusions, and deferred capability

- This projection derives display condition independently of Work's and
  Orchestration's own status vocabularies; it is not a re-export of either
  and MUST NOT be treated as a source of truth for WorkItem or workflow
  state.
- A card's `runCount` and totals include child-instance runs; only
  condition, stage, and `awaitingApproval` follow the primary-instance-only
  rule.
