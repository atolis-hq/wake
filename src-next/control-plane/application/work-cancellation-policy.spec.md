# Work Conclusion Policy — Component Specification

## Type, purpose, and scope

Policy/process. The ordered cross-module cascade that applies one WorkItem
conclusion — close (`closeWork`) or cancel (`cancelWork`) — consistently to
its active workflows and their Execution Runs: conclude the WorkItem, cancel
every active Run belonging to its workflows, then block each of those
workflows.

## Responsibilities and boundaries

This component owns the ordering of the cascade — Work first, then
Execution, then Orchestration — and the single command context shared
across every step of one `cancelWork`/`closeWork` call. It does not decide
whether a WorkItem is currently closable/cancellable (Work's own aggregate
does), and it does not decide whether a workflow instance can currently be
blocked (Orchestration's own aggregate does). It does not retry or roll
back a partially-completed cascade, and it does not decide which of the two
outcomes applies to a given external signal — that mapping lives with the
caller (see `integrations/application/work-conclusion.ts`'s
`concludeObservedWork`).

## Core policies, invariants, and behaviours

- `cancelWork`/`closeWork` MUST call Work's `cancel`/`close` command first;
  if that command is rejected (for example because the WorkItem is already
  `closed` or `cancelled`), the cascade MUST stop there — no active Run is
  cancelled and no workflow is blocked.
- On acceptance, the cascade MUST look up every workflow instance belonging
  to the concluded WorkItem by listing all workflow instances and filtering
  by `workItemId` — it does not depend on any WorkItem-scoped orchestration
  query.
- The cascade MUST cancel every active Run of the WorkItem's matching
  workflows in one `cancelActive` call (not per-workflow), before blocking
  any of those workflows. `cancelWork` uses
  `ExecutionCancellationReason.WorkCancelled`; `closeWork` uses
  `ExecutionCancellationReason.WorkClosed`. This call MUST still be made,
  with an empty list, when the WorkItem has no matching workflow instances.
- After the Execution cancellation, the cascade MUST block each matching
  workflow instance in turn with a reason of `'work cancelled: <original
  reason>'` (`cancelWork`) or `'work closed: <original reason>'`
  (`closeWork`), reusing the same command context (the same `commandId` and
  `correlationId`) across the Work-conclude call and every block call in
  the cascade. If a block call is rejected partway through, the remaining
  workflows in the list are not blocked — the cascade does not roll back
  workflows already blocked, and does not retry the rejected one.
- The cascade MUST return the concluded WorkItem's view regardless of how
  many (including zero) workflow instances existed for it.
- This component does not implement its own idempotency: calling
  `cancelWork`/`closeWork` a second time for the same WorkItemId relies
  entirely on Work's own aggregate rejecting a second conclusion of an
  already-final WorkItem, which stops the cascade before any Run or
  workflow is touched again.

## Dependencies and system role

- Work (dependency) — the `close`/`cancel` commands this cascade's first
  step calls; their acceptance/rejection gates the rest of the cascade.
- Execution (dependency) — the `cancelActive` contract this cascade calls
  once per WorkItem conclusion, for every matching workflow instance
  together.
- Orchestration (dependency) — the `listAll` query and `block` command this
  cascade uses to find and block the WorkItem's workflow instances.
- Kernel — Clock, IdGenerator, and command-context conventions for the one
  shared context used across the cascade.
- Dependent: `bootstrap/composition-root.ts` composes this policy and hands
  it to the GitHub provider (and any future adapter) as the structural
  `WorkConclusion` port defined in `integrations/contracts/provider.ts`, so
  `integrations/application/work-conclusion.ts` can call `closeWork` or
  `cancelWork` without `integrations` depending on `control-plane` or
  `execution` directly.

## Decisions, exclusions, and deferred capability

- No operator-facing "cancel work" or "close work" command exists yet
  beyond the external-close reactor; exposing either as a standalone
  command is a deferred capability, not a rejected one.
