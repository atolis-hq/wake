---
asOf: 15f550dbd4142dbcf86aa5409d13d0291fc43fec
---

# Bootstrap — Module Specification

## Purpose and scope

Bootstrap composes every other module's concrete adapters into one running
application graph, loads and validates the operator-supplied root
configuration that shapes that graph, and exposes the CLI and HTTP entry
points through which the rest of the system is reached. It is the only place
in the target architecture where a concrete adapter for another module is
selected; every other module depends only on the interfaces it is given.

## Responsibilities and boundaries

Bootstrap owns:

- Deriving every on-disk path (`wakeRoot`, the `.wake/` data root, and the
  events/projections/checkpoints/locks/transcripts/workspaces locations under
  it) from a single supplied `wakeRoot` value.
- Loading, merging, and validating the operator's root configuration
  (`config.yaml` plus an optional `config.workflows.yaml`) into one typed
  configuration composed from every module's own configuration schema.
- Selecting and constructing every module's concrete runtime adapter (event
  journal, projection store, checkpoint store, agent runners, providers) and
  assembling them into a single composed application graph.
- Registering the fixed, complete set of projections production composition
  depends on, so a catch-up run and a full rebuild always process the same
  set.
- A small number of built-in cross-module behaviours that only make sense
  once the graph exists: rendering an agent activity's prompt from a
  Wake-home template (with a GitHub-sourced work item title/body/comment
  history available to that render), reporting an execution runner's quota
  exhaustion as a control-plane fact, publishing a workflow's status update
  onto its target resource's stream, and resolving a correlated resource's
  adapter-formatted key to a human-followable external URL when that
  adapter's link resolver supports it.
- Composing capability-dispatched resource-transition evidence policies. This
  is the only layer that can inspect a WorkItem's primary resource
  correlations and capabilities while supplying Orchestration with a
  resource-agnostic evidence port.
- Assembling the CLI and HTTP API surface applications that translate the
  composed graph's state into the response shapes `surfaces` defines, and
  dispatching commands from those surfaces into the composed services.
- Publishing the embedded build version through Bootstrap's public entry so
  the outer process entry point need not import a Bootstrap internal.
- Scaffolding a brand-new Wake home (`wake init`): default `config.yaml`/
  `config.workflows.yaml`, prompt templates, `SETUP.md`, and the sandbox
  Dockerfiles — independently of and before any composition root exists.

Bootstrap does not own:

- Any domain policy: what a WorkItem's lifecycle allows, when a workflow
  advances, when a run is eligible — Bootstrap only wires the modules that
  decide these things together.
- The shape of a provider payload or the semantics of translating one into a
  fact — that is each provider's own adapter, defined in `integrations`.
- Persistence semantics (append-only ordering, projection rebuild
  correctness, checkpoint durability) — Bootstrap selects `persistence`'s
  concrete stores but does not implement storage behaviour itself.
- The public response/request contracts CLI and HTTP callers see — those
  types belong to `surfaces`; Bootstrap only produces and consumes them.

## Ubiquitous language

- **Wake root** — the single directory path (`wakeRoot`) every other
  Bootstrap-derived path is computed from; the one required input to
  composing an application graph.
- **Root configuration** — the fully merged, validated, typed configuration
  for the whole application graph, composed from every module's own
  configuration schema under one strict top-level object.
- **Composition root** — the assembled application graph itself: one instance
  of every module's service, backed by concrete adapters, ready to run a
  tick or serve a request.
- **Surface application** — a module-spanning object exposing the operations
  one entry point (the CLI, or the HTTP API) can perform, built once against
  a composition root.
- **Runner pool** — a named list of runner identities, drawn from
  configuration, that execution/control-plane select eligible agent runners
  from.
- **Built-in activity** — an Activity definition Bootstrap itself supplies to
  the activity registry, rather than one contributed by a module, because it
  needs direct access to Wake-home files or another module's stream to do
  its job.

## Core policies, invariants, and behaviours

- Every path Bootstrap derives (`.wake/` and its subdirectories,
  `workspaces/`) MUST be computed from the single supplied `wakeRoot` value;
  no other Bootstrap component may independently compute a Wake-home path.
- Configuration MUST be loaded and validated once, before the application
  graph is assembled, and the graph MUST NOT be assembled from a partially
  validated or unvalidated configuration value.
- The set of projections registered for production composition MUST be
  exactly the union of every composed module's own projection definitions;
  every pipeline's catch-up step and an explicit full rebuild MUST process
  that identical set — a projection reachable by one path and not the other
  would break the rebuild-equals-fold guarantee the wider system depends on.
- Bootstrap composes a tick as two independently invokable pipelines rather
  than one fixed sequence: an intake pipeline (catch up projections, poll
  every configured provider, translate polled provider input into facts)
  and a runner pipeline (catch up projections, run configured schedules,
  react to newly appended facts, publish agent runs, then catch up projections
  and attempt one outbound delivery). The one-shot adapter runs this
  non-scheduling pipeline and, at its pre-delivery boundary, pokes the required
  shared activation-scheduler subscriber after schedule and reactor facts have
  been produced and before delivery. Delivery errors still reject the tick
  after that scheduler pass has completed. The resident adapter runs the same
  non-scheduling pipeline while the independently supervised subscriber keeps
  scheduling. The reaction stage runs Watch first, then resource
  transitions, artifact registration, delivery outcomes, and provider
  maintenance; it runs again after delivery.
  Only the intake pipeline touches an externally rate-limited API, which is
  why it is kept separate: a caller that only needs runner-side progress
  (the HTTP API's `tick` command, a resident runner loop) never pays for
  a poll. Bootstrap decides what each stage does by supplying it a concrete
  implementation; it does not itself decide whether a stage runs.
- The composed resource-transition reactor tails its evidence triggers with
  its own checkpoint. It processes both a matching fact arriving while an
  instance waits and `orchestration.signal-wait-started`, whose evidence
  policy recalls durable facts that predate the wait. Bootstrap dispatches
  that policy from the WorkItem's correlated primary resource capabilities;
  no primary resource, an ambiguous primary subject, or no matching policy
  produces no transition. The built-in pull-request policy is registered for
  `mergeable`, `reviewable`, and `approvable` capabilities.
- Bootstrap owns one re-entrant ordering coordinator backed in production by
  a distinct cross-process file lock. A trigger-aware journal decorator routes
  every append containing a frozen evidence trigger through it. The same
  coordinator covers each reactor checkpoint lifecycle and the combined
  reactor drain plus signal-acceptance operation, so a later signal cannot
  leapfrog earlier eligible resource evidence for the same wait.
- The composition root retains root-scoped configuration, paths, services,
  execution/recovery, and control-plane setup. Dedicated Bootstrap
  composition components select/decorate persistence, register built-in
  activities, compose integration runtime (providers, reactors, projection
  subscriptions, delivery, and the two pipelines), and provide transcript retention.
- Both pipelines MUST check the composed control-plane's pause state before
  operational work; a paused pipeline invocation MUST not poll, schedule,
  react, advance, execute, recover, reconcile, or deliver. Projection
  catch-up remains enabled so read models fold pause and resume facts.
- Each composed runtime projection has its own durable subscription consumer
  and checkpoint. One-shot catch-up, resident tails, and rebuilds share
  consumer-keyed serialisation, so a live pass and rebuild for one projection
  cannot interleave while sibling projections may progress independently.
- When composing execution's git workspace provider, resolving a workflow's
  clone locator MUST derive it from the WorkItem's correlated resource
  external key, in the form `<owner>/<repo>#<number>`, into a
  `https://github.com/<owner>/<repo>.git` clone URL; a resource whose
  external key does not match that shape MUST fail workspace preparation
  rather than clone an unrelated repository.
- When composing the built-in agent activity's prompt renderer, a template's
  `maxTurns` frontmatter value MUST be forwarded to the runner verbatim when
  present and MUST be omitted entirely — never defaulted, never clamped —
  when absent; the same applies to `model` and `allowedTools`: each is
  forwarded only when the template declares it.
- Bootstrap's own read-only diagnostics (health, configuration) MUST NOT
  mutate any durable fact; only the public control-plane `tick` command and the
  runner pause/unpause commands exposed through a surface application are
  state-changing.
- Bootstrap MUST NOT leak a concrete adapter type across a module boundary:
  every collaborator handed to a module's service constructor is typed to
  that module's own interface, never to the concrete adapter's own type.
- Bootstrap adapts Persistence's keyed file serialiser to Control Plane's
  scheduler-serialiser port. The shared key encloses an entire activation
  scheduler pass, protecting recovery, capacity allocation, activation claim,
  workspace acquisition, and durable Run creation across runtime processes.
  A subscriber pass supplies its own lifecycle signal to this lock acquisition,
  so stopping a subscriber cancels waiting for another process's lock without
  interrupting a pass that already entered the scheduler.
- `wake init` MUST scaffold both a source-mode `docker/Dockerfile` and a
  packaged-mode `docker/Dockerfile.packaged`, regardless of the detected
  `dev.mode`, so `wake sandbox build` can pick the one its configured mode
  calls for without the operator re-running init after a mode change.
- A source-mode self-update MUST acquire its durable maintenance lease before
  inspecting active Runs or checking out source. While any lease exists, the
  one composed pause supplier makes intake and runner/tick operational work,
  recovery, reconciliation, and delivery complete no-ops, while projections
  continue catching up so read models reflect maintenance and its resolution.
- Maintenance state is operational JSON under `.wake`, with unique attempt
  id, target tag, start time, failure, and closed phases `quiescing`,
  `updating`, `rolling-back`, or `failed`. State mutation is atomic. A
  separate full-attempt lock checks recorded local PID liveness before stale
  reclaim, so a live slow updater is not taken over while a crashed one is.
- Only a healthy update/recovery clears maintenance and resumes normal
  runtime work. A failed attempt stays visible and paused; a distinct new
  candidate may replace it atomically, while the same bad tag is skipped
  unless forced.
- Bootstrap composes its Git workspace provider into Control Plane's existing
  pre-dispatch recovery pass. It supplies no workspace-cleanup setting or
  independent host: valid marker-owned terminal/never-started workspaces are
  reclaimed by Execution, while the shared pause state prevents maintenance
  from starting tick-driven recovery work.

## Conceptual schema

**Wake paths**

| Field | Type | Description |
| --- | --- | --- |
| `wakeRoot` | filesystem path | The supplied root; every other field is derived from it. |
| `dataRoot` | filesystem path | The hidden `.wake/` directory under `wakeRoot`. |
| `eventsRoot` | filesystem path | Event journal storage location. |
| `projectionsRoot` | filesystem path | Projection store location. |
| `checkpointsRoot` | filesystem path | Checkpoint store location. |
| `locksRoot` | filesystem path | Coordination lock file location. |
| `transcriptsRoot` | filesystem path | Run transcript storage location. |
| `workspacesRoot` | filesystem path | Working-directory root for execution, outside `.wake/`. |

**Root configuration**

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | literal `1` | Root configuration format version; defaults to `1`. |
| `work` | Work's own configuration | Currently accepts no settings. |
| `resources` | Resources' own configuration | Currently accepts no settings. |
| `activities` | Activities' own configuration | Currently accepts no settings. |
| `orchestration` | workflow definitions, selectors, and a default workflow name | Governs which workflow a WorkItem is routed to; may be entirely empty. |
| `execution` | Execution's own configuration | Agent runners, runner pools, and the default runner pool; runner pools and agent runners default to empty, but a default runner pool name is required. |
| `controlPlane` | Control-plane's own configuration | Dispatch limits, schedules, resident idle backoff. |
| `integrations` | map of provider name to provider entry | Which providers are active and, for fixture providers, where their evidence lives. |
| `surfaces` | Surfaces' own configuration | Whether the HTTP API/web surface is enabled, and where it listens. |
| `host.selfUpdate` | Bootstrap self-update configuration | Positive drain and cancellation timeouts; each defaults to 30 seconds. |

**Composition root**

| Field | Type | Description |
| --- | --- | --- |
| `config` | Root configuration | The validated configuration this graph was built from. |
| `fakeScenarios` | fixture scenario resolver | Resolves a `fake`-kind runner's scripted-by-name behaviour from an optional `fake-scenarios.yaml`; empty when the file is absent. |
| `paths` | Wake paths | This graph's derived filesystem layout. |
| `journal` / `projections` / `checkpoints` | concrete persistence adapters | The one shared event journal, projection store, and checkpoint store every composed service reads and writes through. |
| `work` / `resources` / `orchestration` / `execution` | module service instances | Each module's own composed service, ready for a surface application or another module's service to call. |
| `runnerControls` | runner pause/unpause command surface | Backs the execution surface application's pause/unpause commands. |
| `controlPlane` | control-plane service | Backs both pipelines' pause gate and the API surface application's `pause`/`resume` commands. |
| `maintenance` | durable self-update maintenance lease | Shared pause source and exclusive ownership state for one source update. |
| `activationScheduler` | bounded activation scheduler | The shared serialized scheduler used by subscriber reconciliation and the diagnostic compatibility facade. |
| `activationSchedulerSubscriber` | durable activation-scheduler host | Always composed; checkpoints every-fact scheduling and supplies startup/fallback reconciliation. |
| `advanceOnce` | one bounded control-plane advance step | A diagnostic/test compatibility facade over the shared scheduler. |
| `projectionSubscriptions` | independently durable runtime projection subscriptions | Supports targeted or all-definition catch-up, resident tails, health, and per-definition rebuilds. |
| `providers` | composed provider instances | One per configured/enabled integration; each contributes poll/inbound/delivery behaviour to the intake and runner pipelines. |
| `providerFailures` | list of provider composition failures | Providers that failed to construct; surfaced by `doctor` without blocking the providers that did construct successfully. |
| `delivery` | outbound delivery service | Delivers the next eligible delivery intent to its resource's provider on each runner-pipeline pass. |
| `intakePipeline` / `runnerPipeline` | the composed intake and runner pipelines | The externally-rate-limited half and the internal half of a tick, each independently invokable. |
| `resolveResourceLink` | resource external-link resolver | Resolves a correlated resource's adapter/key pair to a human-followable URL, per adapter, when supported. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Root configuration](config/root-configuration.spec.md) | adapter | Loading, merging, and validating `config.yaml`/`config.workflows.yaml` into the typed root configuration | Its output is the only configuration the composition root and every downstream component reads. |
| [Fake provider evidence hydration](fake-provider-evidence.spec.md) | adapter | Resolving fixture evidence/effects files for `fake`-shaped integration entries | Runs on the validated root configuration before providers are composed; only fixture entries are affected. |
| [Runner registry composition](runner-registry.spec.md) | adapter | Selecting a concrete agent-runner implementation per configured runner | Supplies execution's runner registry; the composition root does not itself know which runner kinds exist. |
| [Fake scenario resolution](fake-scenarios.spec.md) | adapter | Loading an optional `fake-scenarios.yaml` into the resolver a `fake`-kind runner scripts its responses from | Given to runner registry composition so a fixture can script a specific fake runner by its configured name. |
| [Runner quota reporter](runner-quota-reporter.spec.md) | adapter | Translating an execution runner's quota-exhaustion signal into a control-plane fact | Given to execution as a callback; execution never appends control-plane facts itself. |
| Activation scheduler serialiser | adapter | Adapting Persistence's keyed file lock to Control Plane's complete scheduler-pass port | Given to the shared activation scheduler by the composition root; Control Plane has no filesystem-lock dependency. |
| [Status-publish built-in activity](status-publish-activity.spec.md) | adapter | The `status.publish` Activity, available to every workflow without operator configuration | Registered into the activity registry the composition root builds; appends to the target resource's own stream. |
| Capability resource-transition evidence | adapter | Resolving the correlated primary resource's capabilities to an evidence policy | Composed into Orchestration's generic reactor. The built-in policy recognises pull-request evidence for mergeable, reviewable, and approvable resources; missing or ambiguous primary subjects fail closed. |
| Integration runtime composition | composition | Provider registry, projection subscriptions, intake/runner pipelines, delivery, and ordered reactors | Receives already-composed module services from the root. It composes the resource-transition reactor and installs its full drain before Orchestration accepts any signal. |
| [Board projection](board-projection.spec.md) | projection | Folding Work, Orchestration, and Execution events into one per-WorkItem operator-board card | Read by the API surface application's board and status responses; subscribed for production catch-up and rebuild alongside every other module's own projections. |
| [Self-update](self-update.spec.md) | policy/process | The maintenance-lease, drain/cancel, update-verify-rollback sequence this installation's source checkout (and, when sandboxed, Docker container) advances through | Invoked by the CLI surface application's `self-update` command with concrete git/Docker collaborators; its failure log is read directly by the API surface application's `system.health` check. |
| [API surface application](surface-api-applications.spec.md) | surface application | Translating the composed graph's state into the HTTP API's system, control-plane, board, resources, orchestration, execution, events, and observability responses | The only path the HTTP API and the CLI's own HTTP-hosting commands use to reach the composed graph. |
| [Work detail and list surface application](surface-api-work-applications.spec.md) | surface application | Aggregating Work, Resources, Orchestration, Execution, and Activities state into one work list/detail response, and issuing Work's freeze/unfreeze/delete commands | Composed alongside the rest of the API surface application; the only component that reads across that many modules for one response. |
| [CLI surface application](surface-cli-applications.spec.md) | surface application | Tick/start/stop, on-demand HTTP hosting, audit read, correlate, validate-state, and the sandbox/self-update/doctor operational commands | The only path the CLI entry point uses to reach the composed graph; hosts the HTTP server the API surface application is served over. |

## Dependencies and system role

- Kernel — event/stream/id/clock conventions every composed adapter and
  Bootstrap's own built-in behaviours are built on.
- Persistence — the concrete event journal, projection store, and checkpoint
  store Bootstrap selects and hands to every module.
- Work, Resources, Activities, Orchestration, Execution, Control-plane,
  Integrations — every one of these modules' services is composed here;
  Bootstrap depends on each module's own public entry and configuration
  schema, never on its internals.
- Surfaces (depends on Bootstrap) — defines the CLI/HTTP contract types and
  presentation helpers Bootstrap's surface applications produce values for;
  Bootstrap depends on Surfaces' contracts, and the CLI/HTTP hosts Surfaces
  exposes depend on Bootstrap's assembled applications to have something to
  serve.
- Nothing in domain code may depend on Bootstrap — dependency flows one way,
  from Bootstrap down into every module it composes.

## Decisions, exclusions, and deferred capability

- Bootstrap defines no event types, relation kinds, or stream namespaces of
  its own; where a Bootstrap-composed behaviour appends a fact
  (runner-quota pause, status-publish), the fact's type and schema belong to
  the module that owns that event namespace, not to Bootstrap.
- `work`, `resources`, and `activities` currently accept no configuration of
  their own (each schema validates only an empty object); the root
  configuration reserves a key for each so a future setting has a defined
  place to live without a root-schema shape change.
- One composition root is built per `wakeRoot` per process invocation;
  Bootstrap does not support composing two independent application graphs
  against the same Wake home within one process.

## Task 27 synchronization (2026-08-10)

Composition options may decorate persistence ports, delivery adapters, and
configured runners at the Bootstrap boundary. An optional fake delivery
adapter and schedule checkpoint store provide deterministic composed-runtime
evidence without adding hooks to domain modules. Provider types are consumed
through the Integrations public entry point; Bootstrap does not import a
provider implementation file.
