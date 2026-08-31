---
asOf: 5031f5b26b684460a94bb1b97599813cc14c5926
---

# Control Plane - Module Specification

## Purpose and scope

Control Plane provides bounded Advancement: recover interrupted work, select
eligible activations, dispatch within capacity, and record outcomes. It also
owns pause signals, host budgets, schedule policy, and cross-module work
conclusion coordination.

## Responsibilities and boundaries

Control Plane owns activation scheduling, selection, capacity and pause
policies, tick/intake/resident pipeline contracts, and schedule slots. It does
not own Work, Orchestration, Execution, provider policy, Eventing host
construction, or concrete serialisation.

Control Plane owns its event types, payload map, stream references, selector
and decoder, and `createControlPlaneEventData` factory. Its services create
immutable event data and append it to their own streams with expected sequence;
they do not construct envelopes or durable-subscription hosts.

## Activation processor

The activation scheduler is a named Eventing processor definition owned by
Control Plane and composed by Bootstrap. Its handler treats every delivered
batch as a reconsideration and invokes one serialized bounded scheduler pass.
Eventing owns the processor cursor, retry, cancellation, and health. The
`advanceOnce` API remains a compatibility facade for tests and diagnostics;
production advancement is delivered through the processor.

The scheduler serialiser encloses the full pass: pause gate, recovery,
capacity check, activation claim, workspace acquisition, and durable Run
creation. Control Plane receives this as a port and never selects a filesystem
lock implementation.

## Pipelines and recovery

Runner hosts execute non-scheduling pipeline work. Intake polls and translates
provider evidence and backs off when idle; runner work reacts, publishes,
delivers, and evaluates schedules. One-shot ticks explicitly catch up required
processors and poke activation scheduling at the documented boundary.

Schedule watermarks, provider poll watermarks, and startup/fallback
reconciliation checkpoints are separate operational state. They are not
substitutes for Eventing processor checkpoints, and reconciliation remains a
bounded explicit recovery lane.

## Policies and invariants

One scheduler pass dispatches no more than `maxDispatches` and never exceeds
`maxConcurrentRuns`; capacity is rechecked after every dispatch. Durable pause
facts survive restart. Host stop reasons are the closed `idle`, `waiting`,
`blocked`, `budget`, `paused`, and `shutdown` values. All Control Plane facts
use the `control-plane` stream.

## Public composition contract

`index.ts` is the only public entry. Control Plane may define processor
selectors and handlers but cannot construct `EventProcessorHost` or concrete
processor serialisers. Bootstrap registers the complete processor set.

## Configuration and scenarios

Owns `controlPlane`, including dispatch limits, schedules, and resident-loop
backoff.

E2E-CONTROL-001, E2E-CONTROL-002, E2E-CONTROL-003, E2E-CONTROL-004.
