# Wake Target Architecture and Rewrite Design

**Date:** 2026-07-30  
**Status:** Approved
**Scope:** Long-term architecture, deterministic guardrails, and the method for
replacing the current implementation

## 1. Executive decision

Wake will be a local-first, event-driven SDLC orchestration engine. Its
long-term model can coordinate work beyond software changes, but the initial
rewrite remains focused on Wake's current SDLC capabilities.

The replacement will be a domain-modular monolith with explicit bounded
contexts:

- `kernel`
- `persistence`
- `work`
- `resources`
- `orchestration`
- `activities`
- `execution`
- `control-plane`
- `integrations`
- `surfaces`
- `bootstrap`

Wake will own a deliberately small workflow interpreter. It will be a pure,
deterministic state machine over configured workflow definitions and durable
workflow-instance state. It will not own persistence, scheduling, agent
execution, workspaces, or integrations. This seam keeps the interpreter
replaceable without forcing the rest of Wake to adopt a third-party engine's
model or infrastructure.

The append-only event journal remains the durable source of truth. Domain
events represent meaningful accepted transitions. Projections are replaceable
views; operational checkpoints are mutable, rebuildable indexes; external
effects use an opt-in durable delivery mechanism derived from the journal.

The current implementation will not be incrementally reorganised in place.
The target will be built alongside it on one branch, with no compatibility,
dual-write, data-migration, or production-transition layer. The legacy system
is evidence of functional intent, edge cases, and hard-earned operational
lessons. It is not authoritative for target models, events, module boundaries,
or behaviour known to be incorrect.

The rewrite's preservation gate is:

> No valid capability or learned constraint may be silently lost.

It is not:

> Reproduce every observable legacy behaviour.

## 2. Product and architecture goals

### 2.1 Product position

Wake's core strength is software-delivery orchestration, but its model must not
assume that every piece of work is an issue, pull request, repository change,
or even an engineering task.

Most work is expected to be made visible as a ticket or comparable work item.
Some work will originate from conversations, documents, schedules, signals, or
operator actions. Wake must be able to coordinate all of these without
weakening its specialist understanding of software delivery.

This is long-term product direction, not initial Activity scope. The rewrite
does not implement specialist communication/conversation or document
Activities. Existing provider messages used for status, questions, reviews,
approvals, and effect confirmation remain Integration responsibilities.

Wake should ultimately behave like another colleague:

- it accepts and discovers work;
- understands the current state and relevant resources;
- follows configured workflows and policies;
- delegates activities to agents, scripts, deterministic code, or humans;
- waits safely for external developments;
- records why transitions and external actions occurred;
- recovers after interruption without repeating unsafe effects.

### 2.2 Architecture goals

The target architecture must:

1. Make each important concept and policy have one obvious owner.
2. Keep module contracts smaller than their implementations and understandable
   without reading internals.
3. Keep provider-specific concepts outside the core.
4. Preserve specialist SDLC concepts where they add safety or capability.
5. Make important transitions replayable and auditable without producing an
   event for every internal operation.
6. Separate workflow decisions from execution attempts.
7. Support tick-driven, resident, and scheduled operation through the same
   control-plane capabilities.
8. Make failure, cancellation, duplicate delivery, ambiguous external effects,
   and recovery part of normal design.
9. Permit future workflow transfer, concurrent activities, dynamic decisions,
   and versioned definitions without implementing them prematurely.
10. Be easy for humans and coding agents to navigate, change, and test.

### 2.3 Non-goals for the rewrite

The rewrite will not initially implement:

- migration of existing installations or durable state;
- backward-compatible configuration or event schemas;
- dual running or dual writes between legacy and target systems;
- snapshots or an event-upcasting framework;
- versioned historical workflow definitions;
- arbitrary user-defined graph nodes and edges;
- general work dependency or priority semantics;
- more than one primary workflow position per instance;
- transferring an active work item between workflows;
- free-form agent-authored workflow graphs;
- a universal plugin or capability platform;
- specialist communication/conversation or document Activities;
- exact legacy output or internal-event parity.
- a database-backed persistence adapter.

These are deliberate exclusions, not unresolved architecture decisions. The
target model must leave credible seams for them, but no speculative machinery
is required.

## 3. Architectural principles

### 3.1 Domain structure over technical layers

Code is grouped primarily by the concept that owns it, not by whether it is a
type, service, schema, or adapter. Each domain keeps its contracts, domain
logic, application services, and infrastructure together.

Configuration and APIs should mirror the same ownership. A global schema may
compose module schemas, but it must not redefine them or pass a global
`WakeConfig` object throughout the system.

### 3.2 Events are facts, not an integration bus vocabulary

Commands express requested intent. Events express facts accepted by the
owning domain. Telemetry describes implementation operation and remains
separate.

Events are append-only and meaningful. An event should normally correspond to
a transition that matters for audit, replay, reaction, or operator
understanding. Function entry, polling attempts, cache hits, and similar
diagnostics are telemetry rather than domain events.

### 3.3 Domain ownership is stronger than reuse

Shared code belongs in `kernel` only if it is genuinely universal and stable.
An enum, state, or policy used heavily by one domain remains in that domain's
public contracts even if another domain consumes it.

Reuse does not justify a dependency that reverses ownership.

### 3.4 Pure decisions, explicit effects

Workflow interpretation, policy evaluation, projection, and relation
resolution should be pure whenever practical. Effects enter through narrow
ports and are performed by application services or adapters.

An object that projects state must not append an event, dispatch work, update a
second store, or invoke an integration.

### 3.5 Determinism surrounds agent judgment

Agents may perform judgment-rich activities. Wake deterministically controls:

- what context and authority an activity receives;
- which work and resources it may affect;
- how its result is parsed and validated;
- whether a result is current and trusted;
- which transition or follow-on activity a result permits;
- whether a destructive external action is authorised;
- retry, cancellation, budgets, and recovery.

### 3.6 Build the smallest coherent mechanism

When several legacy features are manifestations of the same underlying
mechanic, the target should implement that mechanic once. The rewrite should
prefer fewer concepts with stronger invariants over preserving multiple
historical paths.

## 4. Legacy evidence and its authority

The current code demonstrates useful foundations:

- a local-first append-only journal;
- stable Wake-owned work identifiers;
- resource correlation;
- fake adapters and deterministic tests;
- runner and workspace abstractions;
- operational experience with ticks, watches, schedules, recovery, and
  outbound delivery.

It also demonstrates why a replacement is needed. Responsibilities are spread
across technical folders and heavily concentrated in a few files. In
particular, `src/core/tick-runner.ts` coordinates intake, selection, workflow
progression, execution, workspaces, approvals, merging, watchers, recovery,
artifact registration, publication, and completion. Provider concepts leak
into core contracts and durable shapes. `StateStore` presents many unrelated
storage capabilities as one dependency. Projection code can perform effects.

The target must therefore use the legacy implementation in only three ways:

1. **Intent evidence:** what an operator or external consumer expects Wake to
   be able to do.
2. **Failure evidence:** bugs, crash windows, ambiguity, trust boundaries, and
   edge cases a simpler design must still address.
3. **Reusable technical evidence:** isolated clients or low-level utilities
   that can be moved behind target ports and proven independently.

Legacy names, models, state shapes, and control flow have no default authority.
Copying a type or service requires a target-domain justification.

When sources disagree, authority is:

1. this target architecture;
2. the owning target module's `MODULE.md` and public contracts;
3. approved target event-model scenarios;
4. target implementation;
5. the functional decision catalogue as traceability;
6. legacy code, tests, documentation, and issues as evidence.

The catalogue cannot override the target model. It must instead record why a
legacy capability was preserved, corrected, consolidated, removed, or
deferred.

## 5. Foundational model

The target uses specialist models joined by typed relationships. It is not a
generic graph database in which every fact is an arbitrary node.

| Concept | Meaning | Owning module |
| --- | --- | --- |
| `WorkItem` | Durable identity and description of an objective Wake is coordinating | `work` |
| `Resource` | An external or internal thing relevant to work, such as a ticket, pull request, repository, URL, or workspace artifact | `resources` |
| `Relation` | A typed, provenance-bearing link between entity references | `kernel` primitives; relation semantics owned by a domain |
| `WorkflowDefinition` | Validated configured description of stages, activities, outcomes, and transitions | `orchestration` |
| `WorkflowInstance` | Durable enactment of a workflow for a WorkItem, including current position, waits, outcomes, and next requested activity | `orchestration` |
| `Activity` | Named specialist capability Wake knows how to invoke and interpret | `activities` |
| `ActivityActivation` | Durable request to progress one configured Activity in a particular workflow context | `orchestration` |
| `Run` | One concrete attempt by Execution to perform an ActivityActivation | `execution` |
| `Signal` | Validated information that may unblock or affect work, such as a human decision or external change | Owning specialist domain |

### 5.1 WorkItem

A WorkItem owns:

- its Wake-minted identity;
- concise objective and descriptive intent;
- lifecycle facts that are intrinsic to the work itself;
- typed links to related WorkItems;
- references to linked Resources;
- references to workflow history.

A WorkItem does not own:

- the current workflow stage;
- execution-attempt state;
- provider-specific issue or pull-request fields;
- priority or dependency semantics in the initial rewrite.

The work lifecycle is not the workflow. A workflow is one chosen process for
progressing the work and may be replaced or supplemented in the future.

### 5.2 WorkflowInstance

A WorkflowInstance is attached to exactly one WorkItem. Initially, a WorkItem
has at most one **primary** active WorkflowInstance and each instance has one
primary current stage. A primary instance may have subordinate child instances
in the same orchestration group; those children do not become the WorkItem's
active-workflow reference and cannot create another independent primary
position.

The model must not make the current stage a field on WorkItem. That separation
allows a future workflow change to:

1. supersede the old WorkflowInstance;
2. create a linked new WorkflowInstance at a selected entry stage;
3. relink the WorkItem's active-workflow reference.

The initial rewrite does not expose this operation.

### 5.3 ActivityActivation and Run

An ActivityActivation says that orchestration wants a particular Activity
progressed with specific typed input and provenance. A Run records one attempt
to perform that request.

This distinction prevents retry policy from becoming execution policy:

- Orchestration decides whether an outcome warrants another Run or a workflow
  transition.
- Execution may perform narrowly safe, low-level retries such as reconnecting
  an idempotent read.
- A new agent invocation, script execution, or potentially effectful attempt is
  a new Run.

The current broad run record should not be copied wholesale. The target Run is
limited to execution concerns: invocation, lease, runner/workspace selection,
timestamps, result envelope, cancellation, failure, and recovery evidence.

### 5.4 Typed relation spine

`kernel` supplies:

- typed entity references;
- relation identity and provenance;
- relation-event primitives;
- a relation catalogue;
- replayable indexing and traversal interfaces.

Domains define which relations are valid and own the events that create or
retire them. There is no unrestricted `addEdge(source, target, name)` available
to arbitrary callers.

Examples include:

- WorkItem relates to WorkItem;
- WorkflowInstance belongs to WorkItem;
- Run attempts an ActivityActivation;
- Resource represents or supports WorkItem;
- pull request implements WorkItem;
- workspace artifact records an outcome of WorkItem.

Domain entities remain authoritative. The graph is an index of explicit typed
relationships, not the domain model itself.

## 6. Bounded contexts and dependency direction

### 6.1 Target source layout

During the replacement:

```text
src/                         # legacy implementation, unchanged except essential fixes
test/                        # legacy tests
src-next/
  kernel/
  persistence/
  work/
  resources/
  orchestration/
  activities/
  execution/
  control-plane/
  integrations/
  surfaces/
  bootstrap/
test-next/
```

After the final switch, `src-next` and `test-next` are mechanically renamed to
`src` and `test`.

Each domain module follows this shape as needed:

```text
<module>/
  MODULE.md
  module.json
  index.ts
  contracts/
    commands.ts
    events.ts
    config.ts
    views.ts
  domain/
  application/
  infrastructure/
```

Contracts remain inside their domain. For example, work events live under
`work/contracts/events`, not a global `contracts/work` hierarchy.

Folders are added only when they contain something. Empty ceremonial layers are
not required.

### 6.2 Module responsibilities

#### `kernel`

Owns the minimal shared language:

- event envelope metadata;
- universal identifiers and entity references;
- typed relation primitives;
- storage ports for the event journal, derived projections, and consumer
  checkpoints;
- clock and identifier ports where universally required;
- small result/value types with no domain policy.

It imports no domain module and contains no workflow, execution, provider, or
SDLC policy. It contains no filesystem implementation.

#### `persistence`

Owns replaceable implementations of the Kernel storage ports. The initial and
only rewrite implementation is the local filesystem adapter:

- append-only JSONL event journal;
- atomic derived-projection files;
- atomic projector/reactor/outbox checkpoint files;
- filesystem locks and corruption diagnostics.

It depends only on `kernel`, contains no domain projectors or business policy,
and is selected by `bootstrap`. Domain modules depend on Kernel ports and never
import `persistence` or filesystem paths.

#### `work`

Owns WorkItems, work-item lifecycle facts, work-to-work relation semantics, and
commands/views for creating and describing work.

It does not decide workflow transitions or perform work.

#### `resources`

Owns specialist Resource records, canonical resource identity, resource
capabilities, correlation policy, and resource relationship projections.

It does not encode GitHub as the canonical model. A GitHub pull request and a
GitLab merge request may both map to a canonical pull-request capability while
retaining adapter-owned payloads.

#### `orchestration`

Owns workflow configuration contracts, compilation, WorkflowInstances,
ActivityActivations, waits, outcome transitions, group/cycle identity, and
workflow-level retry policy.

It does not invoke agents, manage workspaces, poll providers, append through
integration adapters, or select the next WorkItem globally.

#### `activities`

Owns the common Activity contract and Wake's specialist capabilities.

Initial concrete areas may remain together until their dependencies are
understood:

```text
activities/
  MODULE.md
  contracts/
  agent/
  pr/
    approve/
    merge/
  review/
```

An Activity is named for a concrete subject and intent, such as `pr.merge`,
`pr.approve`, or `review.request`. Unqualified names such as `implement`
represent a configured agent-prompt Activity.

This module is not a dumping ground for workflow callbacks. An Activity must
have a typed input, declared resource requirements, typed outcomes, and a clear
effect or result.

#### `execution`

Owns Runs, activity dispatch, runners, leases, workspaces, low-level
supervision, cancellation, result envelopes, and active-run recovery.

Workspace management is an optional execution capability. An Activity that
does not require a workspace must not receive one.

Execution does not decide which workflow transition follows a Run.

#### `control-plane`

Owns system-level coordination:

- discover or receive eligible work signals;
- select one eligible activation according to control-plane policy;
- ask Orchestration what is ready;
- ask Execution to attempt it;
- record the result through the owning applications;
- initiate another bounded advance when the host policy permits.

Its core operation is an `advanceOnce`-style application capability. A CLI
tick, resident process, or scheduled host composes this same operation; none is
a separate workflow engine.

The control plane contains coordination, not the domain policies it calls.

#### `integrations`

Owns provider adapters, provider payload contracts, translation, formatting,
external queries, and delivery/reconciliation.

Inbound and outbound directions are explicit:

```text
external input
  -> adapter-owned event
  -> translator
  -> canonical command
  -> owning domain validates
  -> canonical event

canonical outbound intent
  -> delivery projection
  -> provider adapter
  -> provider result
  -> canonical delivery result
```

Core modules never import provider payloads or concrete adapters.

#### `surfaces`

Owns CLI, API, and UI presentation. Surfaces call application contracts and
read domain views. They do not reach directly into stores or adapter clients.

APIs preserve domain structure. When a response combines concerns, it nests
them rather than flattening collisions:

```json
{
  "work": {},
  "orchestration": {},
  "execution": {},
  "resources": {},
  "activities": {}
}
```

#### `bootstrap`

Owns configuration loading, dependency composition, process startup, and
concrete adapter selection. It is the only place expected to know the complete
application graph.

### 6.3 Dependency rules

The following are architectural invariants:

- `kernel` imports nothing from another Wake module.
- `persistence` imports only `kernel`.
- A module may import another module only through its public `index.ts` and
  declared contracts.
- Domain and application code never import `integrations` or `surfaces`.
- `orchestration` does not import Execution implementations.
- `execution` does not import orchestration internals.
- `activities` do not receive the global application graph.
- Projectors do not import command handlers, journals, adapters, or clocks.
- No target module imports legacy `src/core`, `src/domain`, or `src/config`.
- Concrete adapters are referenced only from `bootstrap` and their own tests.
- Filesystem paths outside `persistence`, workspace/transcript implementations,
  and bootstrap path resolution are prohibited.
- Cycles between top-level modules are prohibited.

Cross-module communication uses a public command/application contract, a
public query/view contract, or a canonical event. Events are not used merely
to avoid a direct call when an immediate request/response is the clearer
contract.

## 7. Workflow orchestration

### 7.1 Wake-owned interpreter

Wake will build its own workflow interpreter because the required engine is
small, state-machine-like, and event-persisted. A third-party engine would
either add infrastructure requirements or constrain Wake's models without
removing the difficult domain work.

The interpreter is a pure operation conceptually equivalent to:

```text
interpret(definition, instanceState, acceptedSignal)
  -> transition decision
```

Its output describes events or requested activations for the Orchestration
application service to validate and append. The interpreter performs no I/O.

The interpreter owns:

- entry-stage selection;
- valid outcome matching;
- transition decisions;
- waits and resumptions;
- completion;
- bounded repeat/cycle rules;
- creation of follow-on ActivityActivations.

It does not own:

- the event journal;
- projection persistence;
- WorkItem selection;
- timers or process residency;
- agent or script invocation;
- workspaces;
- provider effects.

The purity and narrow model provide the replacement seam. Replacing the
interpreter later would affect Orchestration internals, not Work, Execution,
Integrations, or Surfaces.

### 7.2 Workflow configuration

Each module defines its portion of configuration. The root loader composes and
validates those contracts.

A stage is shaped by domain ownership:

```yaml
workflows:
  default:
    stages:
      implement:
        activity: implement
        with:
          prompt: implement
        execution:
          workspace: branch
          tier: standard
        on:
          done:
            activities:
              - use: pr.approve
              - use: pr.merge
                with:
                  target: primary
                  method: squash
            then: done
          blocked:
            then: await-human
```

- `activity` selects an Activity.
- `with` is validated and owned by that Activity.
- `execution` is validated and owned by Execution.
- `on` is validated and owned by Orchestration.

The exact configuration loaded at startup is authoritative for newly evaluated
transitions. The initial rewrite does not persist historical definitions or
implement upcasting. A definition fingerprint may be recorded as audit
metadata without turning definitions into versioned entities.

The initial interpreter supports one primary current stage. Its event and
instance model must avoid language such as "the WorkItem's stage" that would
prevent future concurrent activations or dynamic next-action selection.

### 7.3 Policies

Policies live with the module that owns the decision:

- workflow transitions and Run retry decisions: `orchestration`;
- global eligibility, fairness, and dispatch budgets: `control-plane`;
- runner, workspace, and low-level retry selection: `execution`;
- resource trust and correlation: `resources`;
- pull-request approval and merge safety: specialist `activities`;
- provider parsing and delivery: `integrations`.

There is no central policy engine containing unrelated rules.

### 7.4 Parent-child and cycle safety

Parent and child workflows are not special nested control loops. They are
linked WorkflowInstances and activations with explicit causation.

Every activation carries:

- stable activation identity;
- parent activation, where applicable;
- originating WorkflowInstance and stage;
- trigger or accepted-signal identity;
- orchestration group identity;
- causal-cycle identity.

The following invariants prevent successful parent and child workflows from
looping forever:

1. The same activation request is idempotent.
2. A child completion is consumed by its parent at most once.
3. Dispatch and repeat budgets belong to the orchestration group/cycle, not an
   individual child Run.
4. A successful child does not reset its group's budget.
5. Static unbounded cycles are rejected unless expressed as an explicit,
   bounded repeat.
6. Runtime repetition of the same causal activation is blocked and recorded.
7. A global per-advance dispatch cap remains the final safety backstop.

## 8. Activities and specialist SDLC behaviour

### 8.1 Activity contract

An Activity receives a minimal typed invocation:

- ActivityActivation identity and causation;
- WorkItem reference;
- declared Resource references or resource query;
- Activity-owned `with` input;
- relevant accepted signals;
- execution-independent provenance.

It does not receive:

- a full global projection;
- the complete Run record;
- `WakeConfig`;
- concrete GitHub or runner clients;
- unrestricted graph or journal access.

An Activity declares:

- input schema;
- required resource kinds/capabilities and cardinality;
- possible typed outcomes;
- whether an external intent may be produced;
- whether Execution capabilities such as agent, script, or workspace are
  required.

### 8.2 Follow-on activities

Activities configured under an outcome are durable ActivityActivations, not
hidden in-process callbacks on Run completion. Each is journalled, retriable
under policy, independently auditable, and part of the same causal group.

This makes configurations such as "when implementation is done, approve and
merge the primary pull request" explicit without blurring those actions into
the agent Run or workflow interpreter.

### 8.3 Pull-request activities

`pr.approve` and `pr.merge` are separate activities.

`pr.merge`:

1. resolves the configured canonical pull-request Resource;
2. rejects missing or ambiguous cardinality;
3. verifies that correlation and provenance meet policy;
4. evaluates revision-bound approval and other configured gates;
5. emits a provider-neutral merge intent;
6. lets an integration adapter attempt the external effect;
7. consumes a confirmed, failed, or ambiguous delivery result.

It never treats a successful agent sentinel as direct permission to merge.

Approval evidence is bound to the exact pull-request revision it assessed.
A revision change invalidates stale approval. Destructive provider actions
must not be exposed to an agent tool merely because the agent judged the
change acceptable.

### 8.4 Human and provider signals

A provider convention such as a GitHub comment containing `/accepted` is not a
canonical approval event.

The flow is:

1. the GitHub integration verifies and parses a provider comment;
2. it emits adapter evidence and proposes a provider-neutral command;
3. the owning Review or Approval capability checks actor authority, resource
   correlation, current revision, expected state, and idempotency;
4. only that domain may emit a canonical accepted signal;
5. Orchestration consumes the typed signal if the WorkflowInstance is waiting
   for it.

Other providers may use buttons, review states, messages, or entirely
different mechanics without changing the canonical decision.

## 9. Execution

Execution turns an ActivityActivation into one or more explicitly authorised
Run attempts. It provides a uniform boundary over agent runners, scripts, and
deterministic executors without pretending they have identical operational
needs.

### 9.1 Run result

A Run result envelope records:

- typed outcome or validated failure;
- start and finish evidence;
- runner/executor identity;
- lease and workspace references where applicable;
- reported Resource candidates;
- structured output needed by the Activity;
- cancellation or timeout evidence;
- recovery/reconciliation status.

Raw agent output is evidence, not an accepted workflow transition. Execution
parses transport-level results; the Activity and owning domain validate their
meaning.

### 9.2 Retry and recovery

Execution may retry only operations known to be safe at the transport level.
Potentially effectful re-execution creates a new Run after an Orchestration
policy decision.

On restart, active Runs are reconciled through runner and workspace ports.
Recovery distinguishes:

- definitely not started;
- still running;
- completed with recoverable result;
- definitely failed;
- externally ambiguous.

Ambiguity is recorded and routed to reconciliation or human handling. Wake
must not convert uncertainty into assumed failure and repeat an unsafe action.

### 9.3 Cancellation

Cancellation is a durable request followed by an observed outcome. WorkItem
closure, operator cancellation, workflow supersession, timeout, and shutdown
may request cancellation through separate policies, but Execution owns the
mechanics of signalling, observing, and recording the Run result.

## 10. Events, persistence, projections, and delivery

### 10.1 Common envelope

All canonical domain events use a small common envelope containing:

- `eventId`;
- `eventType`;
- `schemaVersion`;
- `occurredAt` and `recordedAt`;
- logical stream/entity reference and sequence;
- `correlationId`;
- `causationId`;
- actor and source metadata;
- typed domain-owned payload.

Adapter evidence may use the same envelope but keeps an adapter-owned,
namespaced payload. Core domains cannot import that payload type.

`schemaVersion` starts at one. The rewrite avoids incompatible changes while
the system is pre-release; it does not build an upcaster framework.

Event type, payload, and logical stream are one domain-owned contract. Domain
code uses exported event catalogues, mapped payload unions, typed stream
constructors, and strict runtime decoders; it does not reconstruct persisted
payloads with string/number coercion or repeat event and stream names as
literals. The generic journal remains intentionally unaware of domains.

Closed Wake-owned vocabularies use `as const` catalogues and derived types.
Open extension names use branded strings and an owning registry, external
vocabulary is translated at its adapter boundary, and only human-authored text
remains an unconstrained domain string. The complete rules and refactor
boundary are specified in
[`2026-07-31-wake-strong-contracts-design.md`](./2026-07-31-wake-strong-contracts-design.md).

### 10.2 Journal and repositories

One physical append-only journal may contain many logical streams. The
infrastructure exposes a narrow `EventJournal` port supporting atomic append
with expected sequence, ordered read, and global-position subscription/read.

Domains use repositories over that port. There is no all-purpose `StateStore`
interface that combines journal, WorkItems, Runs, schedules, resources,
workspaces, and delivery state.

No snapshots are implemented initially. They may be added behind repositories
only if replay performance is measured to be a problem.

### 10.3 Filesystem persistence contract

The configured Wake root keeps human-authored configuration and assets at its
visible top level. The filesystem adapter stores target runtime state beneath
the existing hidden `.wake` directory:

```text
<wakeRoot>/
  workspaces/                   # execution-owned scratch, visible as today
  .wake/
    events/                     # append-only canonical JSONL journal
      YYYY-MM-DD.jsonl
    projections/                # disposable materialized domain views
      work/
      resources/
      orchestration/
      execution/
      delivery/
    checkpoints/                # mutable consumer global positions
    locks/                      # filesystem adapter coordination
    transcripts/                # execution-owned operational artifacts
```

The exact projection filenames are adapter concerns, but projection namespace
and key are supplied by the owning domain. Projection files contain the last
applied global event position with the derived view so replaying an event after
a crash is idempotent.

Persistence order is:

1. append the accepted domain event to the journal;
2. a projector/reactor reads from its last durable global-position checkpoint;
3. a pure domain projector computes a new view;
4. the filesystem projection adapter atomically replaces the derived file;
5. the filesystem checkpoint adapter advances the consumer position.

A crash after step 1 leaves the event available for replay. A crash after step
4 but before step 5 replays the event; the projection's recorded global
position prevents double application. Events are never reconstructed from
projection files.

The filesystem adapter is the default and required implementation for the
rewrite. Replacing it later changes `bootstrap` wiring, not domain modules.

### 10.4 Projectors and reactors

A projector is pure:

```text
project(previousView, event) -> nextView
```

It cannot append events, invoke commands, update unrelated indexes, read the
clock, or call an adapter.

A reactor converts accepted facts into requested intent:

```text
react(event, currentPublicViews) -> command candidate(s)
```

Reactors are checkpointed and idempotent. Command handlers remain responsible
for validation and event production.

Mutable projection and reactor checkpoints are operational accelerators. They
are rebuildable from the journal and never become the source of business
truth.

### 10.5 Durable outbound delivery

Reliable external delivery is a shared opt-in application capability used by
integrations that need it. It is not a second authoritative queue.

The canonical journal contains the outbound intent and delivery-result facts.
An outbox projection indexes unresolved intent event IDs/global positions. An
adapter claims delivery using a stable idempotency key and records confirmed,
failed, or ambiguous results.

Wake explicitly represents the crash window where a provider accepted an
effect but Wake did not record confirmation. Reconciliation must query or
retry according to provider idempotency semantics rather than blindly issuing
the effect again.

## 11. Control-plane hosts

The system does not assume either a single tick or a continuously running
process.

The shared unit is:

```text
advanceOnce(scope, budget)
  -> no-work | progressed | waiting | blocked | exhausted
```

A host chooses when and how often to call it:

- `wake tick` performs a bounded amount of progress and exits;
- resident mode repeats it using durable state, wake signals, and backoff;
- a scheduler creates or signals work for elapsed durable schedule slots;
- tests drive it deterministically with fake time and explicit budgets.

Hosts contain timing and process-lifecycle mechanics. Eligibility, fairness,
single-flight rules, and budgets belong to the control-plane application
policy and are tested identically across hosts.

A schedule is a source of a durable command/signal, not a special workflow
execution path. Its slot identity provides idempotency across restarts.

## 12. Configuration and API ownership

Each module exports a configuration schema and resolved configuration view.
The bootstrap loader:

1. loads files and environment inputs;
2. delegates validation/defaulting to owning modules;
3. reports errors using domain-qualified paths;
4. passes each module only its resolved portion.

The shape of configuration is treated as an architecture diagnostic. A setting
placed under `execution`, `activity.with`, or `orchestration.on` should be
owned by that corresponding module in code.

The same heuristic applies to APIs and UI read models. Cross-domain summary
views may compose public child views, but must preserve their domain grouping
and provenance.

## 13. Module specifications

Every top-level target module contains a concise `MODULE.md`. It is an
authoritative charter, not generated API documentation and not a copy of the
functional decision catalogue.

Each `MODULE.md` contains:

1. Purpose.
2. Responsibilities owned.
3. Responsibilities explicitly not owned.
4. Domain vocabulary and invariants.
5. Public commands, events, views, and configuration.
6. Owned relation types.
7. Dependency rationale, with `module.json` as the enforced list.
8. Failure, idempotency, and recovery semantics.
9. Extension rules.
10. Links to authoritative E2E scenarios and relevant functional decisions.

The specification must be short enough to read before changing the module.
Detailed examples and historical analysis belong elsewhere.

A small machine-readable `module.json` manifest accompanies each `MODULE.md`
so the architectural checker does not need to parse prose. It declares:

- module name and kind;
- permitted Wake module dependencies;
- public entry points;
- event, configuration, and relation namespaces.

For example:

```json
{
  "name": "work",
  "kind": "domain",
  "dependencies": ["kernel"],
  "publicEntry": "./index.ts",
  "namespaces": {
    "events": ["work."],
    "config": ["work"],
    "relations": ["work."]
  }
}
```

`module.json` is authoritative for machine-enforced structure. `MODULE.md`
explains the reasons and invariants and links to the manifest rather than
maintaining a second dependency list that can drift.

## 14. Deterministic architecture guardrails

### 14.1 Tools

The rewrite should use only free, open-source tooling:

- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) as the
  authoritative import-boundary and cycle checker;
- existing ESLint and typescript-eslint rules for local code constraints;
- [Knip](https://github.com/webpro-nl/knip) for unused files, exports, and
  dependencies once target modules begin moving;
- `jscpd` only as optional duplication reporting, not a blocking metric until
  a useful baseline exists.

A Sonar service is not required. Complexity and maintainability rules must run
locally and in ordinary CI without a paid service.

### 14.2 Enforced rules

CI rejects:

- imports across a module's internal folders;
- undeclared top-level module dependencies;
- cycles between top-level modules;
- `kernel` importing a domain;
- domain code importing `persistence` or filesystem APIs;
- core domains importing provider integrations;
- projectors importing effectful services;
- passing or importing global `WakeConfig` outside bootstrap;
- raw event-type strings outside owning event-contract definitions;
- raw logical-stream kinds or low-level stream construction outside owning
  stream-contract definitions;
- erased generic events and unchecked persisted-payload coercion inside
  domain/application code;
- raw closed-vocabulary values where an owning public catalogue exists;
- provider vocabulary outside its integration decoder;
- unrestricted graph mutation;
- concrete adapters outside bootstrap;
- target imports from legacy core/domain/config;
- new files or functions that breach initially generous, ratcheted size and
  complexity limits.

Size limits are signals rather than architectural substitutes. They should be
tight enough to stop another tick runner from emerging but introduced with
clear exceptions for generated/static assets.

### 14.3 Architectural tests

In addition to import checks, small executable architecture tests assert:

- all event namespaces have one declared owner;
- all logical stream kinds have one declared owner;
- all configured Activities are registered and their `with` input validates;
- all configured Activity outcome routes name outcomes declared by that
  Activity;
- relation types are registered by an owner;
- module manifests match public entry points;
- projectors are deterministic for the same input sequence;
- bootstrap is the only composition root.
- all configured projection consumers can delete and rebuild their filesystem
  views from the event journal.

## 15. Testing strategy

### 15.1 E2E scenarios are the primary executable specification

The most important tests exercise real target modules together with fakes only
at system boundaries:

- journal/storage;
- clock and identifier generation;
- agent/script runners;
- workspaces;
- schedulers;
- external providers such as GitHub;
- outbound delivery;
- injected crash/fault points.

These tests drive public commands, `advanceOnce`, and external inputs. They
assert canonical events, public domain views, and observable external effects.
They do not assemble internal classes or duplicate policy in a large test
fixture.

### 15.2 Event-model notation

Event modelling is canonical. Light Given/When/Then prose improves readability
without introducing a Gherkin framework:

```text
Scenario: a new revision invalidates approval before merge

Given pr.discovered revision A
  And pr.approved revision A
When  pr.revision-changed revision B
  And activity.requested pr.merge
Then  pr.merge-denied stale-approval
  And workflow.blocked
  And not pr.merge-requested
```

The implementation immediately below the description uses a thin world DSL.
Failure output prints the causal event/effect trace.

### 15.3 Required scenario families

The suite covers:

- every Activity outcome and workflow transition;
- waits and valid, invalid, duplicate, stale, or unauthorised human signals;
- absent, stale, ambiguous, conflicting, and untrusted Resources;
- revision changes around approval and merge;
- parent-child completion, causal cycles, and group-wide budgets;
- cancellation, closure, timeout, restart, and active-Run recovery;
- scheduled slots, resident operation, tick operation, fairness, and
  single-flight rules;
- duplicate inbound events and commands;
- crashes before and after journal append;
- crashes around external-effect acknowledgement;
- outbox reconciliation and echo suppression;
- success, expected failure, unsafe ambiguity, and human escalation.

Module unit and contract tests remain valuable for pure state machines,
schemas, policies, and adapters. They supplement rather than replace the
cross-module scenarios.

## 16. Functional decision catalogue

The rewrite begins with a
`docs/architecture/functional-decision-catalogue.md`. It is a rewrite-control
artifact, not the target architecture and not a `MODULE.md`.

Each entry has a stable identifier and records:

- user/operator intent or capability;
- evidence in code, tests, configuration, documentation, issues, or observed
  behaviour;
- known bugs, ambiguity, duplication, or accidental complexity;
- the underlying mechanic or invariant that matters;
- simplified target behaviour;
- owning target module and `MODULE.md`;
- disposition: preserve, correct, consolidate, remove, or defer;
- target E2E scenario identifiers;
- whether comparison with the legacy implementation is meaningful.

The catalogue is complete when every externally relevant legacy capability and
every material learned constraint has an explicit disposition. Several legacy
paths may map to one target mechanic and one set of scenarios.

Differential tests against legacy are used only where the catalogue marks the
legacy behaviour as accepted and comparison is cheap. A target scenario is
authoritative where current behaviour is buggy, unsafe, inconsistent, or
unnecessarily complex.

## 17. Replacement method

### 17.1 Chosen approach

The target is built beside the legacy implementation in the same repository
and branch. This keeps evidence and reusable low-level code close while
preserving a stable reference system.

Two alternatives were rejected:

- **In-place rewrite:** makes the baseline continuously ambiguous and makes
  omissions hard to detect.
- **Separate repository rewrite:** creates needless friction when examining
  tests, edge cases, provider adapters, and low-level utilities.

Target code must not import legacy domain or orchestration code. Reuse happens
by moving or adapting an isolated component behind a target port, accompanied
by target contract tests.

Likely candidates for selective reuse include:

- provider API clients;
- agent runner transports;
- low-level workspace and process operations;
- cron, lock, clock, identifier, and filesystem primitives;
- well-isolated correlation algorithms;
- deterministic fakes.

The following are rewritten rather than extracted as architecture:

- the tick runner;
- projection updater;
- `StateStore` facade;
- central policy engine;
- issue-shaped canonical projections;
- watcher and child-workflow coordination.

### 17.2 Target-first vertical slices

After a short skeleton, implementation proceeds in vertical capability slices,
not by completing every technical layer before exercising the system.

#### Slice 0: decision baseline

- Create the functional decision catalogue.
- Cluster legacy capabilities around underlying mechanics.
- Record known-invalid and deliberately changed behaviour.
- Establish stable scenario identifiers and coverage tracking.

#### Slice 1: architectural skeleton and golden path

- Create module `MODULE.md` files and manifests.
- Install dependency and architecture checks.
- Implement Kernel storage ports and the filesystem persistence adapter.
- Implement minimal journal, WorkItem, Resource link, WorkflowInstance,
  ActivityActivation, Run, control-plane `advanceOnce`, and fake executor.
- Prove one event-model scenario from work creation to workflow completion.

This is a deliberately thin end-to-end path. It validates every major seam
before any module becomes elaborate.

#### Slice 2: intake, work, and resource identity

- Translate one external source into canonical work commands.
- Implement resource correlation and typed relation projection.
- Cover duplicate intake, closure, conflicting correlation, and work that
  survives loss or closure of one external representation.

#### Slice 3: orchestration semantics

- Complete configured outcome routing, waits, resumptions, follow-on
  activities, linked child instances, idempotent completions, and loop
  budgets.
- Keep one primary stage per WorkflowInstance.

#### Slice 4: execution reliability

- Add real agent/script runner ports, workspace modes, leases, cancellation,
  timeout, result validation, recovery, and Run retry boundaries.
- Port runner transports only after their contract tests pass.

#### Slice 5: specialist pull-request and review activities

- Implement revision-bound approval, `pr.approve`, `pr.merge`, human-signal
  validation, provider-neutral outbound intents, and durable delivery.
- Exercise missing, ambiguous, conflicting, stale, untrusted, duplicate, and
  externally ambiguous paths before enabling merge.

#### Slice 6: schedules and resident coordination

- Implement durable schedule-slot signals, tick and resident hosts, fairness,
  single-flight behaviour, backoff, and bounded progress.
- Reuse the same `advanceOnce` scenarios across hosts.

#### Slice 7: remaining activities, integrations, and surfaces

- Work through remaining catalogue clusters by value and risk.
- Keep Activity implementations limited to the agent, review, approval, and
  pull-request capabilities explicitly covered by the catalogue.
- Build CLI, API, and UI over public domain views.

#### Slice 8: audit and switch

- Confirm every catalogue entry has its required disposition and scenarios.
- Run the complete target verification suite and selected differential checks.
- Switch package entry points to the target.
- Remove legacy implementation and legacy-only tests.
- Mechanically rename `src-next`/`test-next`.
- Update operator documentation to describe only the target system.

There is no intermediate production migration phase.

### 17.3 Slice quality gate

A slice is complete only when:

- every relevant catalogue entry has an explicit disposition;
- target `MODULE.md` files and contracts describe the chosen model without
  legacy leakage;
- normal, failure, recovery, and policy scenarios are readable and passing;
- architectural dependency checks pass;
- the target imports no forbidden legacy code;
- any intentional behaviour change is recorded;
- public events and views are sufficient to understand the outcome.

## 18. Immediate priorities

The rewrite should address the following early because they combine
architectural leverage with correctness or safety risk:

1. **Break up tick-runner ownership structurally.** Establish Orchestration,
   Execution, Control Plane, Activities, and Integration boundaries in the
   golden path rather than first patching the existing runner.
2. **Remove provider identity from core contracts.** WorkItem, Run, workspace,
   and scheduling models must not require repository or issue fields.
3. **Make projection pure and persistence narrow.** Replace effectful
   projection and the `StateStore` mega-interface before multiplying new
   read/write paths.
4. **Model Run outcomes and recovery explicitly.** Avoid sentinel, workflow,
   process, and provider results being collapsed into one status.
5. **Secure correlation, approval, and merge.** Bind authority to verified
   resource identity and exact revision, and represent external-effect
   ambiguity.
6. **Eliminate parent-child/watch loops by construction.** Stable activation
   identity, once-only completion consumption, and group-wide budgets belong
   in initial orchestration semantics.
7. **Unify tick, resident, and scheduled progress.** All hosts must use the
   same bounded control-plane operation.
8. **Make architectural drift fail in CI.** Boundary checks and module
   specifications begin with the skeleton, not after the rewrite.
9. **Build the E2E world before broad capability work.** Tricky policies and
   crash boundaries must be cheap to express and understand.

## 19. Relationship to existing issues and advisory material

The architecture absorbs concerns from current issues without treating each
issue's proposed implementation as binding:

| Issue | Target architectural response |
| --- | --- |
| #456 tick-runner responsibility concentration | Separate bounded contexts and thin `advanceOnce` coordinator |
| #457 and #431 adapter/GitHub leakage | Directional integrations, canonical commands/events, resource capabilities |
| #461 intake and #462 work surviving ticket closure | Work-owned identity separate from external Resources |
| #459 result envelope | Activity outcome separated from Execution Run result |
| #360 and #407 timeout/cancellation | Durable requests, Run recovery, explicit ambiguity |
| #406 schedules/single flight and #413 watcher fairness | Shared control-plane activation policy and durable schedule slots |
| #361 merge identity/safety | Revision-bound specialist `pr.merge` Activity and provider-neutral intent |
| #499 work dependencies | Typed WorkItem links now; dependency policy deliberately deferred |
| #513 interactive sessions | Future Execution/Activity capability, not a workflow-engine concern |
| #122 parallel activity | Activation model leaves room for concurrency; initial interpreter remains single-position |
| #63 prompt injection | Adapter evidence is untrusted until an owning domain validates authority and state |

The advisory architecture documents were treated as inputs rather than
instructions. Their useful recommendations retained here include bounded
contexts, explicit ports, process coordination, revision-bound merge
authority, correlation trust, causal watcher budgets, and checkpointed
reactions. Broad plugin platforms, universal capability systems, and
infrastructure-heavy workflow engines are excluded because they do not solve
Wake's immediate core problem.

## 20. Success criteria

The rewrite is successful when:

- a contributor can identify the owner of a concept or policy from the
  top-level layout and `MODULE.md`;
- the main coordination path is understandable without reading a multi-purpose
  runner;
- workflow interpretation can be tested as a pure state machine;
- Execution can be replaced or extended without changing workflow policy;
- a provider integration can be replaced without changing core domain types;
- journal replay rebuilds domain views and delivery indexes;
- all target events, projections, and consumer checkpoints are stored beneath
  `<wakeRoot>/.wake` by the filesystem adapter;
- destructive actions are tied to trusted, current evidence;
- tick, resident, and schedule hosts exhibit the same workflow semantics;
- architecture violations fail deterministically in local verification and CI;
- E2E scenarios make success, failure, recovery, and nuanced policy behaviour
  visible;
- every valid legacy capability or learned constraint has an explicit
  functional-decision disposition;
- the final target contains no compatibility architecture whose only purpose
  was the rewrite.
