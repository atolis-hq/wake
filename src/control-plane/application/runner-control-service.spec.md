# Runner Pause and Resume — Component Specification

## Type, purpose, and scope

Policy/process. The only composed command path to a manually-caused runner
pause or resume, and the owner of the pure quota-message-to-resume-deadline
derivation that a separate bootstrap adapter delegates to for
quota-caused pauses.

## Ubiquitous language

- **Manual pause/resume** — the operator-initiated `pause`/`unpause` command
  handled by this component, always recorded with `cause: 'manual'`.
- **Quota resume-deadline derivation** — the pure function that turns a
  provider-reported quota message into a `resumeAt` timestamp, used by the
  quota pause path even though that path's event is appended elsewhere.

## Responsibilities and boundaries

This component owns accepting or rejecting a `pause`/`unpause` command
against a runner name, appending the resulting `RunnerPaused` /
`RunnerResumed` fact, and per-command idempotency for that acceptance. It
also owns computing a quota resume deadline from a provider message. It does
not itself append the quota-caused `RunnerPaused` fact — that fact is
appended by a separate bootstrap-level adapter, which calls this
component's deadline derivation but writes the event itself. It does not
validate that a runner being unpaused was actually paused.

## Core policies, invariants, and behaviours

- `pause`/`unpause` MUST reject with an "unknown runner" error when the
  given runner name is not a member of the configured runner set (the union
  of all configured runner pool names); no event is appended for an unknown
  runner.
- A `pause` command MUST always record `cause: 'manual'` and a fixed
  `reason` of `'paused by operator'` — this service never records a quota
  cause.
- An `unpause` command MUST append `RunnerResumed` once the runner name
  validates, regardless of whether that runner currently has a recorded
  pause of any cause, and regardless of that pause's cause if one exists —
  unpausing a runner that was never paused, or was paused for a different
  reason than expected, is accepted, not rejected.
- Replaying the same `(runnerName, idempotencyKey)` pair for the same
  operation MUST NOT append a second event: the result (success or
  rejection) of the first call for that pair MUST be returned again without
  re-evaluating or re-appending. This idempotency is held only in this
  service's own in-process memory for its lifetime; it MUST NOT be assumed
  to survive a process restart, since it is not backed by a durable
  idempotency record.
- The quota resume-deadline derivation MUST prefer an explicit UTC-qualified
  reset time reported in the message (case-insensitive "resets"/"try again
  at" phrasing followed by a 12-hour clock time and an explicit UTC marker),
  interpreting a matched `12` hour as `00` before applying am/pm.
- When no UTC-qualified time is found, it MUST fall back to the same
  phrasing without a UTC marker, interpreting the matched time in the
  deriving process's own local timezone rather than any runner- or
  provider-specific timezone.
- When neither pattern matches, it MUST fall back to a fixed 30-minute pause
  from `now`.
- In both time-of-day cases, when the computed reset time has already
  passed for the current day relative to `now`, the deadline MUST roll
  forward to the next day, so the derived `resumeAt` is always strictly
  later than `now`.

## Conceptual schema

**Runner control command** (per call; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `runnerName` | string | Must match a configured runner pool member. |
| `idempotencyKey` | string | Caller-supplied key this service's in-memory dedupe is keyed on, together with the operation and runner name. |

## Dependencies and system role

- Eventing — event journal append (optimistic on the global stream's current
  length) and command-context conventions.
- Kernel — Clock and IdGenerator conventions.
- Control Plane view (dependent) — folds the `RunnerPaused`/`RunnerResumed`
  facts this component appends.
- Execution's runner pause/unpause API surface (depends on this component)
  — the only caller of `pause`/`unpause`.
- Bootstrap's runner-quota reporter (depends on this component's quota
  resume-deadline derivation only) — computes `resumeAt` for a
  provider-reported quota condition and appends the resulting
  `control-plane.runner-paused` fact itself, with `cause: 'quota'`; it does
  not call this service's own `pause` method.

## Decisions, exclusions, and deferred capability

- Command idempotency is in-memory only; a durable, restart-surviving
  idempotency record for pause/unpause commands is not implemented.
- This service implements only the manual pause/resume path. The
  quota-caused pause path is composed entirely outside it (in bootstrap),
  sharing only the pure deadline-derivation function.
