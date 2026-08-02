# Runner quota reporter — Component Specification

## Type, purpose, and scope

Adapter. The runner quota reporter translates an execution runner's
quota-exhaustion signal into a durable control-plane fact, so the rest of the
system can stop assigning work to that runner until it recovers.

## Responsibilities and boundaries

This component owns turning one quota report into one control-plane
`RunnerPaused` fact. It does not decide when a runner has hit quota — that
determination, and the raw message describing it, come from Execution — and
it does not decide how long a pause should last beyond delegating that
computation to control-plane's own quota-message policy; it never computes a
resume deadline itself.

## Core policies, invariants, and behaviours

- Each report MUST append exactly one `RunnerPaused` fact to the
  control-plane's single global stream, at that stream's current length.
- The fact's cause MUST be recorded as quota-triggered, distinct from an
  operator-initiated pause, and its reason MUST carry the reported message
  unchanged.
- The resume deadline MUST be computed by control-plane's own quota-message
  policy from the reported message and the current time; this component
  MUST NOT compute or guess a deadline itself.
- The recorded actor MUST be a system actor, not an operator, reflecting
  that this fact originates from Wake's own execution signal rather than a
  human command.
- The fact's correlation id MUST be derived from the runner's name alone, so
  every quota-triggered pause fact ever recorded for a given runner shares
  one correlation id regardless of how many times quota is reported.
- A report MUST NOT check whether the runner is already paused before
  appending; each call appends a fresh fact unconditionally. Repeated quota
  reports for the same runner therefore accumulate one fact per report in
  the event log, while the control-plane projection that reads them folds
  to the most recently recorded pause per runner, so a runner's eligibility
  always reflects the latest report even though earlier reports remain in
  the log.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `control-plane.runner-paused` | This component is invoked with a runner's quota-exhaustion message | This runner is now ineligible for new work until the computed resume deadline passes; ownership of this event type belongs to control-plane, not to this component. |

## Dependencies and system role

- Control-plane — owns the `RunnerPaused` event type, its schema, and the
  quota-message-to-resume-deadline policy this component delegates to; also
  owns the projection that folds repeated reports for the same runner.
- Execution (depends on this component) — is given this component as a
  callback and calls it whenever a runner invocation reports quota
  exhaustion; Execution never appends control-plane facts directly.

## Decisions, exclusions, and deferred capability

- This component does not deduplicate reports the way an operator-initiated
  pause/unpause command does (which is keyed by an explicit idempotency
  key); a quota report has no caller-supplied idempotency key to dedupe by,
  so repeated reports are accepted as repeated facts by design.
