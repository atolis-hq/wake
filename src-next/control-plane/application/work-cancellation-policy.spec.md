# Work Cancellation Policy — Component Specification

## Type, purpose, and scope

Policy/process. The ordered cross-module cascade that applies one WorkItem
cancellation consistently to its active workflows and their Execution Runs:
cancel the WorkItem, cancel every active Run belonging to its workflows,
then block each of those workflows.

## Responsibilities and boundaries

This component owns the ordering of the cascade — Work first, then
Execution, then Orchestration — and the single command context shared
across every step of one `cancelWork` call. It does not decide whether a
WorkItem is currently cancellable (Work's own aggregate does), and it does
not decide whether a workflow instance can currently be blocked
(Orchestration's own aggregate does). It does not retry or roll back a
partially-completed cascade.

## Core policies, invariants, and behaviours

- `cancelWork` MUST call Work's cancel command first; if that command is
  rejected (for example because the WorkItem is already `closed` or
  `cancelled`), the cascade MUST stop there — no active Run is cancelled and
  no workflow is blocked.
- On acceptance, `cancelWork` MUST look up every workflow instance belonging
  to the cancelled WorkItem by listing all workflow instances and filtering
  by `workItemId` — it does not depend on any WorkItem-scoped orchestration
  query.
- `cancelWork` MUST cancel every active Run of the WorkItem's matching
  workflows in one `cancelActive` call (not per-workflow) with reason
  `ExecutionCancellationReason.WorkCancelled`, before blocking any of those
  workflows. This call MUST still be made, with an empty list, when the
  WorkItem has no matching workflow instances.
- After the Execution cancellation, `cancelWork` MUST block each matching
  workflow instance in turn with a reason of `'work cancelled: <original
  reason>'`, reusing the same command context (the same `commandId` and
  `correlationId`) across the Work-cancel call and every block call in the
  cascade. If a block call is rejected partway through, the remaining
  workflows in the list are not blocked — the cascade does not roll back
  workflows already blocked, and does not retry the rejected one.
- `cancelWork` MUST return the cancelled WorkItem's view regardless of how
  many (including zero) workflow instances existed for it.
- This component does not implement its own idempotency: calling
  `cancelWork` a second time for the same WorkItemId relies entirely on
  Work's own aggregate rejecting a second cancel of an already-final
  WorkItem, which stops the cascade before any Run or workflow is touched
  again.

## Dependencies and system role

- Work (dependency) — the cancel command this cascade's first step calls;
  its acceptance/rejection gates the rest of the cascade.
- Execution (dependency) — the `cancelActive` contract this cascade calls
  once per WorkItem cancellation, for every matching workflow instance
  together.
- Orchestration (dependency) — the `listAll` query and `block` command this
  cascade uses to find and block the WorkItem's workflow instances.
- Kernel — Clock, IdGenerator, and command-context conventions for the one
  shared context used across the cascade.
- Would-be dependent: an operator-facing cancel-work command surface, none
  of which composes this policy today.

## Decisions, exclusions, and deferred capability

- This policy is implemented but not reachable from any composed CLI or API
  command; no operator-facing "cancel work" command exists yet. Exposing it
  as a command is a deferred capability, not a rejected one.
