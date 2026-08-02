# Dispatch Policy — Component Specification

## Type, purpose, and scope

Policy/process. Two pure decision functions designed to feed Advancement's
selection and to drive global dispatch pause/resume: a fairness-ordered
candidate selection (`DispatchPolicy`), and a count-based dispatch quota
decision (`QuotaPolicy`). Both are implemented as pure functions with no
stream of their own and no side effects.

## Ubiquitous language

- **Dispatch candidate** — one activation eligible for consideration by
  `DispatchPolicy`, carrying a `requestedPosition` fairness key.
- **Dispatch quota** — the count-based cap (`maxDispatches`) that
  `QuotaPolicy` compares against a rolling dispatch count to decide whether
  to permit dispatch, pause, or resume.

## Responsibilities and boundaries

`DispatchPolicy` owns turning a list of candidates and a blocked flag into
an ordered, capped selection. `QuotaPolicy` owns turning a dispatch count
and any existing pause deadline into one of four decisions:
dispatch/pause/paused/resume. Neither function reads or writes any durable
state itself, calls any other module, or decides what `blocked`, the
dispatch count, or `pausedUntil` currently are — those are supplied by a
caller.

## Core policies, invariants, and behaviours

- `DispatchPolicy.select` MUST return an empty list when `state.blocked` is
  `true` or `maxDispatches <= 0`, regardless of the candidate list.
- Otherwise it MUST exclude every candidate that is `cancelled` or already
  has an active run, order the remainder by ascending `requestedPosition`,
  break ties by ascending lexicographic `activationId`, and return at most
  `maxDispatches` of the result.
- `QuotaPolicy.decide` MUST return `resume` when a `pausedUntil` deadline is
  supplied and `now` has reached or passed it, and MUST return `paused`
  (echoing the same deadline) when `now` has not yet reached it.
- When no `pausedUntil` is supplied, `QuotaPolicy.decide` MUST return
  `dispatch` while the given dispatch count is below `maxDispatches`, and
  MUST return `pause` with a deadline of `now + pauseDurationMs` and a fixed
  reason of `'dispatch quota exhausted'` once the count reaches
  `maxDispatches`.
- Both functions MUST throw when given a timestamp that does not parse as a
  valid date, rather than silently treating it as elapsed or unelapsed.

## Conceptual schema

**DispatchCandidate** (per call; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity | The candidate's owning WorkItem. |
| `activationId` | Orchestration activation identity | The candidate itself; also the selection's tie-break key. |
| `requestedPosition` | number | The fairness ordering key; lower is selected first. |
| `hasActiveRun` | boolean | Excludes the candidate from selection when `true`. |
| `cancelled` | boolean | Excludes the candidate from selection when `true`. |

**QuotaDecision** (per call; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `dispatch` / `pause` / `paused` / `resume` | The decision for this call. |
| `resumeAt` | timestamp (`pause`/`paused` only) | The deadline a pause decision carries or a still-paused decision echoes. |
| `reason` | string (`pause` only) | Fixed to `'dispatch quota exhausted'`. |

## Dependencies and system role

- Advancement (would-be dependent) — designed to be the caller of
  `DispatchPolicy.select` in place of Advancement's current unordered
  first-pending-candidate selection.
- Control Plane view / Runner Pause and Resume (would-be dependents) —
  designed so a `QuotaPolicy.decide` result of `pause`/`resume` would drive
  appending `control-plane.dispatch-paused` / `control-plane.dispatch-resumed`.

## Decisions, exclusions, and deferred capability

- Neither `DispatchPolicy` nor `QuotaPolicy` is invoked by any composed
  caller today: Advancement's selection does not call `DispatchPolicy`, and
  no composed process calls `QuotaPolicy` or appends
  `control-plane.dispatch-paused`/`control-plane.dispatch-resumed`.
  `controlPlane.maxDispatches` is validated configuration with no consumer
  today. Wiring either into Advancement is a deferred capability, not a
  rejected one.
