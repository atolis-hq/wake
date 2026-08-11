# Retry policy — Component Specification

## Type, purpose, and scope

Policy/process. This component decides whether a non-`done` Activity outcome
retries the current Stage's own Activity rather than falling through to that
outcome's configured `OutcomeRoute`, and produces the resulting retry-count
and re-request facts when it does.

## Responsibilities and boundaries

Retry policy owns exactly one decision — may this specific non-`done`
outcome, at this specific Stage, retry again — and the two facts that follow
from a granted retry. It does not decide what happens when a retry is not
granted; that falls back to the activation and transition policy's own
route resolution. It does not itself accept or validate the outcome that
triggered it; the caller has already confirmed the outcome belongs to the
pending Activation before consulting this component.

## Core policies, invariants, and behaviours

- Retry MUST only be considered for a non-`done` outcome that has a
  configured `retry` bound on its route; a route with no `retry` configured
  is never retried by this component.
- An outcome whose data carries `retrySafety: requires-reconciliation` MUST
  NOT be retried, even when the route configures a retry bound and the bound
  is not yet exhausted — this overrides the workflow's own retry
  configuration, because an outcome that requires reconciliation may have
  already taken a partial, non-idempotent effect that a blind re-run would
  repeat.
- The retry count is keyed by `<currentStage>:<outcomeKind>`, so retries for
  different outcome kinds at the same Stage are counted independently.
- A retry MUST only be granted while the current count for that key is
  strictly less than the route's configured `retry.max`; at or beyond the
  bound, no retry is granted and dispatch falls through to the caller's own
  transition resolution using the outcome's configured `OutcomeRoute`.
- Exhausting the retry bound does not by itself block the instance:
  `InstanceBlocked` is not produced by this component. What happens instead
  depends entirely on the outcome's configured route target — it may
  transition to another Stage, complete, or wait, exactly as it would for an
  outcome kind with no retry configured at all.
- A granted retry MUST append `RetryCounted` (the key's count incremented by
  one) followed by `ActivityRequested` for the same Stage's own configured
  Activity and input, carrying that Stage's `execution` config — a retry
  re-invokes the Stage's own Activity from scratch, not a follow-on or a
  different route.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.retry-counted` | A non-`done` outcome is retried at the same Stage | The Stage-and-outcome-kind retry count has advanced towards its configured maximum. |
| `orchestration.activity-requested` | Immediately following a granted retry | The Stage's own Activity is requested again as a new Activation. |

## Dependencies and system role

- Activation and transition policy (depends on this component) — consults
  it before falling through to its own transition resolution for any
  non-`done` outcome.
- Activities — defines the `RetrySafety` vocabulary and the contract that an
  outcome's data may carry a `retrySafety` hint; this component is the sole
  consumer that acts on `requires-reconciliation`, since Activities itself
  only defines the vocabulary.
- Workflow compiler — supplies the route's `retry.max` bound, validated and
  frozen at compile time; this component never parses raw configuration.

## Decisions, exclusions, and deferred capability

- Retries are counted, not scheduled: there is no backoff, delay, or
  jittering between a retry-counted fact and its immediate re-request.
- `retrySafety: requires-reconciliation` is the only override of a
  configured retry bound; there is no operator-facing command to force or
  suppress a retry independent of this outcome-data hint.
