# Wake Architecture

Wake is an event-driven control plane for autonomous software work. It keeps
workflow decisions, execution attempts, external observations, and operator
actions durable and replayable; an agent runner performs an activity but never
decides the workflow itself.

## Architectural principles

The following principles guide both changes to the current system and future
extensions. They are intentionally independent of a particular provider, CLI,
or workflow shape.

- **Wake is a control plane, not a long-lived agent session.** The control
  plane chooses and records work deterministically; an agent is an interruptible
  external executor of one Activity. Process memory must not be the only place
  a decision, claim, or result exists.
- **Facts are immutable; views are disposable.** The append-only journal is
  the durable record. A projection, checkpoint, board, API response, or UI
  model is a rebuildable interpretation of facts, never an alternate source of
  truth.
- **A bounded module owns its vocabulary.** Event names, payloads, stream
  references, closed status/outcome vocabularies, decoders, and draft factories
  belong to one module. Consumers use its public contract rather than copying
  strings or reconstructing envelopes.
- **Policy is deterministic and separate from execution.** Orchestration
  interprets compiled workflow policy; Execution runs an Activity; Integrations
  translate provider interaction. An agent response is an input to policy, not
  permission to change policy.
- **Open input becomes typed internal fact at the boundary.** Provider payloads
  and agent-readable context are untrusted external data. Validate them at the
  integration or Activity boundary, then translate them to typed Wake contracts
  before domain logic or a projection consumes them.
- **Wake owns channel routing and delivery.** Activities express outcomes and
  artifacts through Wake-owned contracts. Integrations turn durable delivery
  work into provider-specific API calls, so a workflow and agent prompt do not
  need to know a particular issue tracker, chat system, or pull-request API.
- **Recovery and idempotency are normal paths.** Leases, activation claims,
  durable result facts, checkpoints, and delivery reconciliation make restarts
  and duplicate observations explicit cases to handle rather than exceptional
  conditions to hide.
- **Fakes are first-class seams.** Fake providers and runners are durable test
  harnesses for composed, zero-token scenarios. New real integrations should
  meet the same public contracts rather than bypass them with special-case
  control-plane logic.

## Module boundaries

`src/` is organised as bounded modules. Each module exposes only its
`index.ts`; Bootstrap is the sole composition root.

| Module | Owns |
| --- | --- |
| `kernel` | Event envelopes, identifiers, relations, clocks, and persistence contracts. |
| `persistence` | Filesystem and in-memory event journals, checkpoints, projections, and locks. |
| `work` | Work-item facts, lifecycle controls, and work projections. |
| `resources` | External-resource facts and their correlation to work items. |
| `activities` | Activity definitions and pull-request/review activities. |
| `orchestration` | Compiled workflow definitions, durable workflow instances, activations, waits, watches, and retry policy. |
| `execution` | Runs, runner adapters, workspaces, leases, cancellation, recovery, and transcripts. |
| `control-plane` | Bounded advancement, intake, selection, scheduling, quotas, and resident/tick hosts. |
| `integrations` | Provider polling, inbound translation, artifact registration, and outbound delivery. |
| `surfaces` | CLI, HTTP API, and web presentation. |
| `bootstrap` | Root configuration, paths, concrete adapter selection, projections, and composition. |

No domain module imports a provider client, filesystem implementation, or
surface. Surfaces call public applications and views; they do not write facts
directly. Bootstrap selects concrete infrastructure and connects the complete
application graph.

## Durable model

The append-only journal is authoritative. Events have a globally ordered
envelope with an event type, stream reference, payload, and occurrence time.
Every owning module supplies strict event decoders; a decoder returns `null`
for another namespace and rejects malformed events in its own namespace.

Projections are derived read models. The filesystem implementation stores the
journal and projection/checkpoint data below the Wake home's `.wake/`
directory, but consumers must treat the journal—not a projection file—as the
source of truth. The production projection runtime rebuilds and updates the
board, analytics, resource lookup, and module projections from that journal.

Work-item identities are minted by Wake. Resources are separate durable facts
and are correlated to work items through `resources`; provider locators do not
become Wake identifiers or filesystem path components.

Events serve multiple architectural roles at once: they trigger deterministic
advancement, form the replayable audit trail, preserve the inputs needed to
rebuild operational views, and carry integration/delivery work across module
boundaries. Wake does not ask an agent to scan an unbounded journal by default;
Activity composition supplies the bounded task context required for its current
Activation.

## Advancement flow

1. An integration polls an external provider and appends typed observation
   events.
2. Inbound translation admits work, creates or updates resources, and records
   correlations and signals.
3. The control plane performs one bounded `advanceOnce` pass: it applies
   eligibility, quotas, schedules, and coordination claims.
4. Orchestration interprets the compiled workflow instance and requests an
   activity when a position is ready.
5. Execution claims and runs an activity, recording lifecycle, lease, runner,
   and result facts on the appropriate streams.
6. Orchestration accepts the activity outcome and deterministically advances,
   waits, retries, blocks, or completes the workflow.
7. Integration reactors translate publication and artifact facts to the
   configured external provider. Surface projections expose the same durable
   state to the CLI, API, and UI.

The tick, resident loop, and scheduled host all use the same control-plane
advancement capability. Recovery is explicit: execution leases and result
envelopes make incomplete attempts visible after restart rather than relying on
process memory.

## Designing for extension

New capability should extend a bounded seam rather than introduce a parallel
path around it:

- A **provider** validates its own configuration and external payloads,
  translates observations through Integrations, and implements delivery without
  leaking provider types into Work, Orchestration, or Execution.
- An **Activity** declares its input and outcome contracts. It may invoke
  infrastructure through Execution, but it does not decide the next workflow
  transition.
- A **runner** implements Execution's runner contract and is selected by
  configuration through a named pool; it never becomes a workflow router.
- A **surface** calls public applications and presents projections. It does not
  append another module's facts directly or infer lifecycle from UI state.

This keeps additions testable with durable fakes, makes production reachability
provable through Bootstrap, and ensures a new transport or CLI does not change
the meaning of existing workflow facts.

## Configuration and extension

The root schema is composed in
`src/bootstrap/config/root-schema.ts`. Its top-level sections are `work`,
`resources`, `activities`, `orchestration`, `execution`, `controlPlane`,
`integrations`, `surfaces`, `transcripts`, and `host`. `wake init` writes the
current `config.yaml` and `config.workflows.yaml` scaffold.

To add a provider, activity, runner, or surface, keep provider and process
details in the relevant infrastructure module, expose a typed public contract,
and register the concrete implementation in Bootstrap. Do not bypass event
ownership by emitting another module's event type or reconstructing event
envelopes in a view.
