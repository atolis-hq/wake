# orchestration

## Purpose

Configured workflow interpretation and durable instances.

## Owns

Definitions, compilation, instances, activations, waits, child workflows,
watches, outcomes, retry policy, orchestration-owned processor handlers, and
live work-completion metrics derived from primary workflow facts.

## Does not own

Agent invocation, workspaces, provider polling, delivery, global selection,
Eventing host construction, or concrete serialisation.

## Invariants

Interpretation is deterministic; each WorkItem has one active primary workflow
and children remain linked to its group. Persisted events are decoded before
folding. Watch and resource-transition processors use stable consumers and
idempotent handlers; watch recovery remains a separate reconciler with its own
checkpoint.

`listPendingActivations` attaches a dispatch priority to each pending
activation: remaining agent steps (minimum agent-running stages on a route to a
terminal stage, from the compiled graph and activity `executionKind`; stages
that cannot finish rank last), `watchDriven` (the typed `watchDriven` flag on
the activation, set when a watch verdict or resource transition resumed the
stage), and `retried` (the stage has a retry count above zero). Orchestration
reports these; Control Plane orders by them. Historical definitions without
compiled costs count removed activities conservatively as agent steps.
Resource-transition origin remains explicit even on a watch-verdict channel;
quota re-requests preserve that activation origin without counting a retry.

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
