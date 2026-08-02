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
- A `delivery.confirmed` fact, or a `delivery.reconciled` fact whose result
  is `confirmed`, MUST report a `done` outcome, carrying the delivery
  fact's own event id, to the workflow instance and activation the
  originating intent named.
- A `delivery.failed` fact MUST report a `failed` outcome, carrying the
  failure's own code as the reason, to the same workflow instance and
  activation.
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
- Orchestration (this component depends on it) — `acceptOutcome` is called
  to report the resolved `done`/`failed` outcome.

## Decisions, exclusions, and deferred capability

- The reactor's checkpoint name is fixed (`reactor:delivery-outcomes`); only
  one reactor instance is expected to run per Wake home today, not a
  configurable identity per adapter or per workflow.
