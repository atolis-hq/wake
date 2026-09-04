# orchestration

## Purpose

Configured workflow interpretation and durable instances.

## Owns

Definitions, compilation, instances, activations, waits, child workflows,
watches, outcomes, retry policy, and orchestration-owned processor handlers.

## Does not own

Agent invocation, workspaces, provider polling, delivery, global selection,
Eventing host construction, or concrete serialisation.

## Invariants

Interpretation is deterministic; each WorkItem has one active primary workflow
and children remain linked to its group. Persisted events are decoded before
folding. Watch and resource-transition processors use stable consumers and
idempotent handlers; watch recovery remains a separate reconciler with its own
checkpoint.

## Public contracts

`index.ts` is the only public entry. `OrchestrationService` is a compatibility
and composition facade containing no policy.

## Application policy

Use cases own I/O sequencing through repositories and coordination claims.
Domain files do not import journals, clocks, adapters, or execution
infrastructure except through public contracts.

## Configuration

Owns `orchestration`.

## Relations and events

Owns `orchestration.` events and `workflow.` relations.

## Failure and recovery

Accepted outcomes are typed and replayable. Processor failures retain their
Eventing checkpoint; the watch reconciler is an explicit recovery lane.

## Extension rules

Define processors and handlers in Orchestration, but let Bootstrap compose the
runtime and let Eventing own checkpoint and retry mechanics.

## Scenarios

E2E-ORCH-001, E2E-ORCH-RETRY-001, E2E-ORCH-RETRY-003, E2E-ORCH-WAIT-001,
E2E-ORCH-COMMAND-001, E2E-ORCH-CHILD-001, E2E-ORCH-WATCH-RECOVERY-001,
E2E-ORCH-WATCH-CLOSED-WORK-001, E2E-ORCH-LOOP-001.
