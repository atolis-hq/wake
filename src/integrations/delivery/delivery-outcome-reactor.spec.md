# Delivery Outcome Reactor — Component Specification

## Type, purpose, and scope

Policy/process. The Delivery Outcome Reactor replays `delivery.*` facts
once each, checkpointed, and correlates a resolved delivery back to an
Orchestration outcome for the workflow instance and activation the
originating intent named.

## Responsibilities and boundaries

This component owns deciding, from a `delivery.*` fact alone, whether an
Orchestration outcome should be reported, and reporting it exactly once per
fact. It does not decide what the outcome does inside Orchestration, does
not attempt delivery, and does not read the Delivery Intent Projection —
it reads `delivery.*` facts directly from the journal.

## Core policies, invariants, and behaviours

- Events since the reactor's own checkpoint MUST be processed in the order
  the journal returns them, and the checkpoint MUST advance to each event's
  own journal position after it is handled, whether or not that event
  carried a `delivery.*` fact — so a processed batch is never replayed.
- A resolved fact MUST only report an outcome when the named workflow
  instance's own pending activation is currently waiting, with signal kind
  `delivery-result`, on that same intent's own event id; any other
  case — the activation already resolved, waiting on an unrelated signal,
  or not pending at all — MUST report no outcome, so a delivery resolving
  after its activation moved on for an unrelated reason (e.g. a technical
  failure with no configured route) never misattributes its result.
- A `delivery.confirmed` fact, or a `delivery.reconciled` fact whose result
  is `confirmed`, MUST report a `done` outcome, carrying the delivery
  fact's own event id, to the workflow instance and activation the
  originating intent named — subject to the awaiting check above.
- A `delivery.failed` fact MUST report a `failed` outcome, carrying the
  failure's own code as the reason, to the same workflow instance and
  activation — subject to the same awaiting check.
- `delivery.attempt-started`, `delivery.ambiguous`, and a
  `delivery.reconciled` fact whose result is not `confirmed` MUST NOT
  report any outcome; the workflow remains waiting.
- The reported outcome's command id MUST be the delivery fact's own event
  id, so replaying the reactor over the same fact reports the same outcome
  idempotently from Orchestration's point of view.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `delivery.confirmed` | Read since the last checkpoint | Reports a `done` outcome for the intent's activation. |
| `delivery.reconciled` (result `confirmed`) | Read since the last checkpoint | Reports a `done` outcome for the intent's activation. |
| `delivery.failed` | Read since the last checkpoint | Reports a `failed` outcome for the intent's activation. |

## Dependencies and system role

- Kernel — checkpoint store and event journal; this component's only
  dependency for reading delivery facts.
- Delivery aggregate (this component depends on it) — the sole producer of
  the `delivery.*` facts this component reacts to.
- Orchestration (this component depends on it) — `acceptOutcome` reports
  the resolved `done`/`failed` outcome; `get` reads the workflow instance's
  own pending activation and waiting state to check it is still awaiting
  this exact delivery before reporting.

## Decisions, exclusions, and deferred capability

- The reactor's checkpoint name is fixed (`reactor:delivery-outcomes`); only
  one reactor instance is expected to run per Wake home today, not a
  configurable identity per adapter or per workflow.
