# Run projection — Component Specification

## Type, purpose, and scope

Projection. The Run projection is the pure, rebuildable fold that turns a
Run's `execution.run-*` facts into its queryable `RunView`, registered for
production replay so callers read a materialised view instead of replaying
a stream themselves on every query.

## Responsibilities and boundaries

The Run projection owns keying and folding `execution.run-*` facts, one
projected value per `RunId`. It does not own any command, does not decide
whether an event is accepted, and is not a source of truth: it is derived
entirely from the Run aggregate's own facts and MUST be reproducible by
discarding and rebuilding it from the event journal.

## Core policies, invariants, and behaviours

- The projection MUST select only events belonging to a Run stream; an
  event on any other stream (including an activation-claim stream) MUST be
  ignored (selection returns nothing to fold).
- The projection's key MUST be the Run stream's own id, so each Run
  accumulates its own independent projected value.
- The projected value MUST be derived by reusing the Run aggregate's own
  fold over the accumulated event list, not a separate derivation — the
  projection and the aggregate's `load` path MUST agree on `RunView` for
  the same event history.
- Before the first `RunPreparationStarted` fact (or a historical first
  `RunStarted` fact) for a Run is folded, the projection's value MUST report
  a `null` view. A preparation fact alone projects an active `starting` view;
  its later `RunStarted` updates that same key to `started` rather than
  creating another view.
- Rebuilding the projection from an empty checkpoint against the full event
  journal MUST reproduce the same `RunView` per `RunId` as folding each
  Run's stream directly.

## Conceptual schema

| Field | Type | Description |
| --- | --- | --- |
| `events` | list of Run execution event | The accumulated, decoded event history folded so far for this key. |
| `view` | RunView or null | The current derived view; `null` until creation has been folded. A preparation-created view has no `executionStartedAt` or workspace. See the module specification's RunView table for its fields. |

## Dependencies and system role

- Eventing — the projection registration contract (selection, initial value,
  and fold-forward `project` step) that production replay drives.
- Run (depends on) — supplies the exact fold this projection reuses; a
  change to the aggregate's fold changes this projection's output
  identically, by construction.
- Execution service, and any other reader of Run state (depend on this
  projection) — read `RunView` through it rather than re-decoding and
  folding a Run stream themselves.

## Decisions, exclusions, and deferred capability

- The projection keeps every decoded event alongside the derived view
  rather than only the view, so a rebuild never needs to re-read the
  journal mid-fold; this trades memory for not needing a second read path.
