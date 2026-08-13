# Work controls and global tick pause — design

Status: approved for implementation planning.

## Goal

Restore the legacy operator controls in the target architecture: freeze,
unfreeze, and confirmed soft deletion for a WorkItem, plus a global pause that
stops every tick before it polls, reconciles, schedules, delivers, advances,
or executes work.

## Authority and scope

Legacy `src/` and its UI tests establish the operator-facing behavior only.
`src-next/` keeps ownership in Work, Resources, Control Plane, Bootstrap, and
the API/Web surfaces; it must not reuse legacy handlers or projections.

This design supersedes the narrow global-dispatch interpretation in
`2026-08-02-control-plane-advancement-wiring-design.md` for an operator pause:
an operator-paused control plane prevents the complete TickPipeline, not only
advancement selection. Runner-specific pauses retain their present, local
meaning.

## Decisions

### Global pause

Control Plane records global pause/resume as durable control facts and exposes
the resulting paused status through the existing API read model. Every tick
entry point — API manual tick, CLI tick, resident host, and scheduled host —
uses the same paused guard before invoking TickPipeline stages. A paused tick
returns a typed no-work/paused outcome without calling the poller, inbound
translator, schedule reconciler, projector/reaction stages, delivery, or
`advanceOnce`. The manual `tick` API command is rejected with an explicit
conflict while paused, so it cannot be mistaken for a successful refresh.

The web status band offers `Pause ticks` when active. While paused it displays
the paused status and `Resume ticks`; it does not display `Tick now` (the
advance control). This reflects the server guarantee rather than attempting to
enforce pause only in the browser.

### Work lifecycle

Work owns durable `work.frozen`, `work.unfrozen`, and `work.deleted` lifecycle
events and folds them into its WorkItem view. The view has explicit frozen and
deleted state rather than encoding either as a workflow stage or run result.
Repeated freeze/unfreeze/delete commands are idempotent: they do not append a
duplicate fact once the requested state is already reached. Deleted WorkItems
reject subsequent lifecycle commands and are omitted from operator list/board
read models.

Eligibility is a Control Plane concern consuming the Work view: a frozen or
deleted WorkItem is never selected for activation/execution. Unfreezing an open
item restores ordinary eligibility; it does not manufacture an activation or
otherwise override workflow policy.

### Deletion and resources

Deletion is a soft Work lifecycle transition, preceded by browser confirmation.
It additionally retracts every active resource correlation for that WorkItem
using Resources-owned `resources.work-correlation-retracted` facts. Resource
identity and history remain durable, but its active-correlation projection no
longer reserves it; a future WorkItem may therefore correlate it normally.
The cross-domain operation is composed in an application-level command rather
than by Work importing Resources or a UI route editing projections.

### API and web behavior

Bootstrap composes public application commands behind the already-declared API
routes for freeze, unfreeze, delete, pause, resume, and tick. The API preserves
idempotency keys and presents unavailable/conflict conditions through the
existing problem-details contract.

The Work detail overview shows a Freeze/Unfreeze control and a destructive
Delete control. Delete opens a confirmation with the legacy intent: remove the
item from the board and release its resource correlations. Each action is
disabled while pending, reports its failure accessibly, and refreshes the work,
board, resources, events, and status queries. A completed delete returns the
operator to the list/board rather than retaining a stale detail view.

## Error handling

- A manual tick during global pause returns a conflict and performs no pipeline
  work; the hidden UI button is a convenience, not the guard.
- A deleted or terminal WorkItem cannot be frozen, unfrozen, or deleted again.
- Resource unlinking is retry-safe: command idempotency and retraction folding
  ensure a retry cannot leave a resource reserved by deleted work.
- A command failure leaves the UI usable and shows the server problem; no local
  optimistic lifecycle state becomes authoritative.

## Verification

- Work unit tests prove event decoding/folding, idempotency, deleted-command
  rejection, and frozen/deleted eligibility.
- Resource/application tests prove deleting work retracts every active
  correlation and permits a later correlation of the same resource.
- Control Plane and host tests prove a global pause prevents every TickPipeline
  dependency, including polling, and blocks manual tick; resume restores the
  normal shared path. Runner pause tests prove the behavior remains local.
- Composed API tests cover each command and its status/problem response.
- Web tests cover status-band toggling and hidden tick button, freeze/unfreeze,
  delete confirmation, mutation feedback, cache refresh/navigation, and the
  command request shape.

## Out of scope

- Hard deletion of journal facts, resources, or run history.
- Reusing legacy HTTP/UI code or legacy lifecycle record shapes.
- Changing per-runner pause semantics.
- Adding new workflow or dispatch policy beyond suppressing eligibility for
  frozen/deleted WorkItems.
