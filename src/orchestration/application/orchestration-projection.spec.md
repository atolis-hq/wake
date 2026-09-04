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
belong to and storing the current `WorkflowInstanceView | null` directly. It
advances that view one decoded event at a time through the WorkflowInstance
domain continuation operation. It does not own transition rules — those
belong to WorkflowInstance — and it does not decide anything: it is a pure
re-application of already-accepted facts, never a source of new events.

## Core policies, invariants, and behaviours

- An event MUST be decoded through Orchestration's own event decoder and
  filtered to the workflow-instance stream kind before this projection
  considers it; a primary or group-budget claim event, or an event owned by
  another module, is not selected and does not affect any key.
- The projection's key MUST be the workflow-instance stream's own id;
  events for different WorkflowInstances never affect each other's value.
- Each key's value MUST be only the current `WorkflowInstanceView | null`;
  this projection MUST NOT persist an event list or another wrapper around
  that view.
- The initial value MUST be `null`. A decoded event MUST advance the prior
  value through WorkflowInstance's domain continuation operation, which uses
  the aggregate's own transition policy rather than this component maintaining
  independent state-transition logic.
- Rebuilding this projection from the full event journal MUST reproduce the
  same `WorkflowInstanceView` per WorkflowInstance as continuous incremental
  application, since both paths apply the same ordered facts through the same
  WorkflowInstance policy — this projection carries no state that is not
  derivable from `orchestration.*` facts alone.
- This projection-shape upgrade is not backward-compatible with the retired
  `{ events, view }` values. When upgrading an existing Wake home, operators
  MUST obtain exclusive offline access before running a rebuild. For a sandbox,
  operators MUST run `wake sandbox down`, then
  `wake validate-state --rebuild-projections --no-sandbox`, then `wake sandbox
  up`. For a host/service resident, operators MUST stop and restart it through
  its supervisor and run the rebuild host-side (with `--no-sandbox` when
  `docker/Dockerfile` exists). `wake doctor --rebuild-projections` has the
  same stopped-resident requirement. The rebuild replaces projection and
  checkpoint data from the authoritative journal without modifying journal
  records.

## Dependencies and system role

- WorkflowInstance (depended on) — supplies initial folding and the
  single-event continuation policy this projection re-applies; this component
  defines no transition rules of its own.
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
