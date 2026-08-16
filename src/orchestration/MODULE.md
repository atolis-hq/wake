# orchestration

## Purpose

Configured workflow interpretation and durable instances.

## Owns

Definitions, compilation, instances, activations, waits, child workflows, watches, outcomes, and retry policy.

## Does not own

Agent invocation, workspaces, provider polling, delivery, or global selection.

## Invariants

Interpretation is deterministic; each WorkItem has one active primary workflow and children remain linked to its group.
Compiled strings stop at the compiler. Domain decisions consume typed state and input and return owned Orchestration event drafts. Persisted events are decoded before they enter the WorkflowInstance fold.

## Public contracts

`index.ts` is the only public entry. `OrchestrationService` is a compatibility and composition facade: it delegates to focused use cases and contains no policy.

## Application policy

Use cases own I/O sequencing through the Orchestration repository, coordination claims, and group-budget recorder. Domain files do not import journals, clocks, adapters, or execution infrastructure.

## Decision policy

Activation, retry, signal, supplemental, and child/group decisions remain independent pure policies. The interpreter only dispatches between those policies and transitions.

## Configuration

Owns `orchestration`.

## Relations and events

Owns `orchestration.` events and `workflow.` relations.

## Failure and recovery

Accepted outcomes are current, typed, and replayable.

## Extension rules

No graph mutation, parallel positions, snapshots, or version entities.

## Scenarios

E2E-ORCH-001, E2E-ORCH-RETRY-001, E2E-ORCH-WAIT-001,
E2E-ORCH-COMMAND-001, E2E-ORCH-CHILD-001, E2E-ORCH-WATCH-RECOVERY-001,
E2E-ORCH-LOOP-001.
