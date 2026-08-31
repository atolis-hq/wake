# Control Plane view — Component Specification

## Type, purpose, and scope

Projection. A pure, rebuildable fold of the module's own `control-plane.*`
events on the single `control-plane:global` stream into the current
dispatch-pause and runner-pause read model, plus the derived read used to
compute which runners are currently ineligible for selection.

## Responsibilities and boundaries

This component owns folding the four `control-plane.*` event types into one
keyed view, and the pure `ineligibleRunners` read that derives current
runner eligibility from that view at a given instant. It does not decide
when a pause or resume is warranted, and it does not prune stale entries
from its own stored state — eligibility at a point in time is computed at
read time from stored history, not by rewriting that history.

## Core policies, invariants, and behaviours

- The projection's `select` MUST recognise only events whose type falls in
  this module's own namespace (`control-plane.`), returning `null` for
  anything else, and MUST key every recognised event to the single row
  `'global'` — this module has exactly one durable view, matching its single
  global stream.
- The initial state MUST be `pausedUntil: null`, `runnerPauses: {}` (no
  `reason`).
- `DispatchPaused` MUST overwrite `pausedUntil` and `reason` unconditionally
  with the new event's values, regardless of any prior pause already
  recorded — the latest `DispatchPaused` fact always wins.
- `DispatchResumed` MUST clear `pausedUntil` to `null` and MUST remove the
  `reason` field entirely, not merely leave it stale.
- `RunnerPaused` MUST upsert `runnerPauses[runnerName]` with the event's
  full payload (`cause`, `reason`, `resumeAt`), replacing any prior entry for
  that runner regardless of its previous `cause` — a quota pause can replace
  a manual one and vice versa.
- `RunnerResumed` MUST remove `runnerPauses[runnerName]` entirely,
  regardless of the removed entry's recorded `cause`.
- A quota-caused runner pause whose `resumeAt` has already elapsed is NOT
  pruned from the stored `runnerPauses` map by the projection itself; the
  entry remains until an explicit `RunnerResumed` fact removes it. Only the
  read-time `ineligibleRunners` derivation treats an elapsed `resumeAt` as
  eligible again.
- `ineligibleRunners(view, now)` MUST include a runner name in the returned
  set only while it has a `runnerPauses` entry AND that entry's `resumeAt`
  is either absent (an indefinite manual pause) or later than `now`.
- `createDurableRunnerIneligibility(journal, now)` MUST fold the authoritative
  `control-plane:global` stream for scheduler eligibility. It may reuse that
  folded view only while `journal.latestGlobalPosition()` is unchanged; it
  MUST recompute eligibility against `now` on every read so elapsed quota
  pauses become eligible without requiring a new projection write.
- The projection MUST be a pure fold: rebuilding it from a full replay of
  the `control-plane:global` stream MUST reproduce the same view as the
  live fold, with no dependency on anything outside the events themselves.

## Conceptual schema

**Control Plane view** (keyed by the single row `'global'`)

| Field | Type | Description |
| --- | --- | --- |
| `pausedUntil` | timestamp or null | Current global dispatch pause deadline; `null` when not paused. |
| `reason` | string, optional | Present only while `pausedUntil` is set; the last recorded pause's reason. |
| `runnerPauses` | map of runner name to Runner pause entry | Every runner with an unresumed pause fact recorded for it, including stale, elapsed quota pauses. |

**Runner pause entry** (child entity, one per paused runner name)

| Field | Type | Description |
| --- | --- | --- |
| `cause` | closed vocabulary: `manual` / `quota` | What caused this stored pause; not reinterpreted by the projection. |
| `reason` | string | Human-readable explanation from the recording event. |
| `resumeAt` | timestamp, optional | Present for `quota` pauses; absent for `manual` pauses, which last until an explicit resume. |

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `control-plane.dispatch-paused` | Folded into the view | Replaces `pausedUntil`/`reason` with this fact's values. |
| `control-plane.dispatch-resumed` | Folded into the view | Clears `pausedUntil` and removes `reason`. |
| `control-plane.runner-paused` | Folded into the view | Upserts the named runner's pause entry. |
| `control-plane.runner-resumed` | Folded into the view | Removes the named runner's pause entry, if present. |

## Dependencies and system role

- Eventing — event envelope decoding, the `ProjectionDefinition` contract, and
  the projection registration/rebuild machinery this view is registered
  into.
- Runner Pause and Resume, and the bootstrap runner-quota reporter (both
  depended on by this projection) — the only composed appenders of the
  events this view folds; this projection never appends events itself.
- Advancement (depends on this component) — reads the view indirectly
  through an injected `runnerIneligibility` supplier that calls
  `ineligibleRunners`.
- Execution's runner-status surface (depends on this component) — reads the
  same view to report current runner eligibility.

## Decisions, exclusions, and deferred capability

- Control Plane Service (`control-plane-service.spec.md`) is a composed,
  reachable appender of `control-plane.dispatch-paused`/
  `control-plane.dispatch-resumed` (a manual, operator-triggered pause), so
  `pausedUntil`/`reason` do leave their initial `null`/absent state in the
  current composed system. Advancement's own dispatch-pause gate does not
  read this projection to learn that, though — it calls Control Plane
  Service's independently-folding `isPaused` instead; this projection's
  `pausedUntil` is read only for status display (the API's control-plane
  status surface).
- The count-based, quota-driven dispatch pause Dispatch Policy computes is
  not composed into any path that appends these two events; only the manual
  pause/resume path is live today.
