# Delivery Outcome Reactor - Component Specification

## Type, purpose, and scope

Policy/process. The Delivery Outcome Reactor processes new `delivery.*` facts
from its checkpoint, then revisits durable resolved delivery facts without
moving that checkpoint. Both paths correlate a resolved delivery back to an
Orchestration outcome for the workflow instance and activation the originating
intent named.

## Responsibilities and boundaries

This component decides, from a `delivery.*` fact alone, whether an
Orchestration outcome should be reported, and reports it exactly once per fact
per reactor pass. It does not decide what the outcome does inside
Orchestration, attempt delivery, or read the Delivery Intent Projection.

## Core policies, invariants, and behaviours

- Events since the reactor checkpoint are processed in journal order and the
  checkpoint advances after every event, whether or not it is a `delivery.*`
  fact.
- After that tail pass, resolved delivery facts are revisited from journal
  history without moving the checkpoint. This catches up a wait persisted
  after its matching delivery fact was already checkpointed.
- A fact present in both passes is considered once per reactor pass. Later
  passes are safe because the delivery fact id remains the idempotent outcome
  command id in Orchestration.
- A resolved fact reports an outcome only when its named workflow instance's
  current pending activation is waiting for `delivery-result` on that exact
  intent event id. Other workflow instances, activations, waits, and intents
  are no-ops.
- `delivery.confirmed` and confirmed `delivery.reconciled` facts report
  `done`, carrying the delivery fact id. `delivery.failed` reports `failed`,
  carrying its code as the reason.
- Attempt-started, ambiguous, escalated, and non-confirmed reconciliation
  facts do not report outcomes; the workflow remains waiting.
- If a delivery fact and its activity wait are appended while a pass is in
  progress, the next pass observes their durable ordering and applies the
  same exact-match reconciliation.

## Event catalogue

| Event | Business meaning |
| --- | --- |
| `delivery.confirmed` | Reports `done` for the intent's waiting activation. |
| `delivery.reconciled` (confirmed) | Reports `done` for the intent's waiting activation. |
| `delivery.failed` | Reports `failed` for the intent's waiting activation. |

## Dependencies and system role

- Eventing supplies the checkpoint store and event journal. Processor-owned
  pending-confirmation recovery uses `ProcessorStateStore`, not `ProjectionStore`.
- Delivery produces the `delivery.*` facts.
- Orchestration supplies the waiting-state read and idempotent
  `acceptOutcome` command.

## Decisions, exclusions, and deferred capability

- The checkpoint name is fixed (`reactor:delivery-outcomes`); one reactor
  instance is expected per Wake home today.
