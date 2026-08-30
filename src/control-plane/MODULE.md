# control-plane

## Purpose

System-level bounded coordination through the activation scheduler and its
`advanceOnce` compatibility facade.

## Owns

Signals, eligibility, selection, budgets, dispatch coordination, schedule
policy, and host-facing pipeline contracts.

## Does not own

Work, workflow, execution, provider policy, processor hosting, or concrete
serialisation.

## Invariants

The activation scheduler is an Eventing processor definition owned by Control
Plane and composed by Bootstrap. Each delivered batch is a reconsideration;
the processor host owns cursor advancement, while the scheduler owns bounded
selection and durable effects. Its separate reconciler and schedule/poll
watermarks remain explicit one-shot or periodic lanes.

## Public contracts

`index.ts` is the only public entry.

## Configuration

Owns `controlPlane` dispatch limits, schedules, and resident-loop backoff.

## Relations and events

Owns `control-plane.` events and defines no domain relation semantics.

## Failure and recovery

Selection, caps, pauses, retries, and scheduler serialisation remain explicit
and bounded. Processor failure is surfaced through Eventing health; startup
and fallback reconciliation retain their own diagnostics.

## Extension rules

Define processor selectors and handlers here when they are Control Plane
policy, but leave host construction, concrete adapters, and full registry
composition to Bootstrap.

## Scenarios

E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003, E2E-CONTROL-004.
