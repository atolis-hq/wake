# Orchestration projection — Component Specification

## Type, purpose, and scope

Projection. This component maintains a checkpointed, per-WorkflowInstance
`WorkflowInstanceView`, rebuilt purely from `orchestration.*` facts recorded
on workflow-instance streams. It exists so other modules' surfaces can read
current WorkflowInstance state without replaying a stream themselves;
Orchestration's own command handling does not read this projection — it
reloads state directly from the stream before every command (see the
Orchestration repository).

## Responsibilities and boundaries

This component owns keying incoming events to the WorkflowInstance they
belong to, accumulating each instance's own event list, and re-deriving its
`WorkflowInstanceView` by the same fold the WorkflowInstance aggregate
defines. It does not own the fold's rules — those belong to WorkflowInstance
— and it does not decide anything: it is a pure re-application of already-
accepted facts, never a source of new events.

## Core policies, invariants, and behaviours

- An event MUST be decoded through Orchestration's own event decoder and
  filtered to the workflow-instance stream kind before this projection
  considers it; a primary or group-budget claim event, or an event owned by
  another module, is not selected and does not affect any key.
- The projection's key MUST be the workflow-instance stream's own id;
  events for different WorkflowInstances never affect each other's value.
- Each key's value MUST be the full ordered list of that instance's own
  decoded events plus the view folded from them; the value is not a partial
  or incremental summary independent of that list.
- The folded view MUST be re-derived by applying the WorkflowInstance
  aggregate's own fold to the accumulated event list on every update, not by
  this component maintaining independent state-transition logic.
- Rebuilding this projection from the full event journal MUST reproduce the
  same `WorkflowInstanceView` per WorkflowInstance as continuous incremental
  application, since both paths are the same fold applied to the same
  ordered facts — this projection carries no state that is not derivable
  from `orchestration.*` facts alone.

## Dependencies and system role

- WorkflowInstance (depended on) — supplies the fold this projection
  re-applies; this component defines no folding rules of its own.
- Eventing — the projection definition contract (`select`/`initial`/`project`)
  this component implements, and the checkpointed projection store/runner
  that persists and rebuilds its value per key.
- Orchestration's own event decoder and stream-kind guard — the boundary
  that keeps a malformed or foreign event from ever reaching this
  component's fold.
- Other modules' surfaces (control-plane, API, board) (depend on this
  component) — read `WorkflowInstanceView` here for tick and read-model
  purposes; Orchestration's own command handling bypasses this projection
  and reloads from the stream directly, so a lagging checkpoint never
  affects command correctness, only how current other modules' reads are.

## Decisions, exclusions, and deferred capability

- This projection is read-only infrastructure for callers outside
  Orchestration's own command path; it is never consulted to decide the
  next Orchestration event, only to answer external queries about current
  state.
- There is no separate projection for a primary claim or a group budget
  claim; those remain readable only by rereading their own claim streams
  directly (see OrchestrationGroup), not through this projection.
