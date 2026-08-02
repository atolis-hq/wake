---
asOf: 570f5327a406b1993562cbe0e6b47e239b8827ee
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
  Wake-home template, reporting an execution runner's quota exhaustion as a
  control-plane fact, and publishing a workflow's status update onto its
  target resource's stream.
- Assembling the CLI and HTTP API surface applications that translate the
  composed graph's state into the response shapes `surfaces` defines, and
  dispatching commands from those surfaces into the composed services.

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
  the tick pipeline's catch-up step and an explicit full rebuild MUST process
  that identical set — a projection reachable by one path and not the other
  would break the rebuild-equals-fold guarantee the wider system depends on.
- A tick MUST run its composed stages in a fixed order: catch up
  projections, poll every configured provider, translate polled provider
  input into facts, react to newly appended facts (watch and
  delivery-outcome reactions), advance the control plane by one bounded
  step, then attempt one outbound delivery. Bootstrap decides what each
  stage does by supplying it a concrete implementation; it does not itself
  decide whether a stage runs.
- When composing the built-in agent activity's prompt renderer, a template's
  `maxTurns` frontmatter value MUST be forwarded to the runner verbatim when
  present and MUST be omitted entirely — never defaulted, never clamped —
  when absent; the same applies to `model` and `allowedTools`: each is
  forwarded only when the template declares it.
- Bootstrap's own read-only diagnostics (health, configuration) MUST NOT
  mutate any durable fact; only the control-plane `advance` command and the
  runner pause/unpause commands exposed through a surface application are
  state-changing.
- Bootstrap MUST NOT leak a concrete adapter type across a module boundary:
  every collaborator handed to a module's service constructor is typed to
  that module's own interface, never to the concrete adapter's own type.

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

**Composition root**

| Field | Type | Description |
| --- | --- | --- |
| `config` | Root configuration | The validated configuration this graph was built from. |
| `paths` | Wake paths | This graph's derived filesystem layout. |
| `journal` / `projections` / `checkpoints` | concrete persistence adapters | The one shared event journal, projection store, and checkpoint store every composed service reads and writes through. |
| `work` / `resources` / `orchestration` / `execution` | module service instances | Each module's own composed service, ready for a surface application or another module's service to call. |
| `runnerControls` | runner pause/unpause command surface | Backs the execution surface application's pause/unpause commands. |
| `advanceOnce` | one bounded control-plane advance step | The unit of forward progress a tick, or an `advance` API command, performs. |
| `projectionRunner` | catch-up/rebuild runner over the registered projection set | Shared by the tick pipeline and the CLI's `validate-state` rebuild command. |
| `providers` | composed provider instances | One per configured/enabled integration; each contributes poll/inbound/delivery behaviour to the tick pipeline. |
| `delivery` | outbound delivery service | Delivers the next eligible delivery intent to its resource's provider on each tick. |
| `pipeline` | the composed tick pipeline | Runs one full tick's fixed stage sequence. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Root configuration](config/root-configuration.spec.md) | adapter | Loading, merging, and validating `config.yaml`/`config.workflows.yaml` into the typed root configuration | Its output is the only configuration the composition root and every downstream component reads. |
| [Fake provider evidence hydration](fake-provider-evidence.spec.md) | adapter | Resolving fixture evidence/effects files for `fake`-shaped integration entries | Runs on the validated root configuration before providers are composed; only fixture entries are affected. |
| [Runner registry composition](runner-registry.spec.md) | adapter | Selecting a concrete agent-runner implementation per configured runner | Supplies execution's runner registry; the composition root does not itself know which runner kinds exist. |
| [Runner quota reporter](runner-quota-reporter.spec.md) | adapter | Translating an execution runner's quota-exhaustion signal into a control-plane fact | Given to execution as a callback; execution never appends control-plane facts itself. |
| [Status-publish built-in activity](status-publish-activity.spec.md) | adapter | The `status.publish` Activity, available to every workflow without operator configuration | Registered into the activity registry the composition root builds; appends to the target resource's own stream. |
| [API surface application](surface-api-applications.spec.md) | surface application | Translating the composed graph's state into the HTTP API's system, control-plane, resources, orchestration, execution, events, and observability responses | The only path the HTTP API and the CLI's own HTTP-hosting commands use to reach the composed graph. |
| [Work detail and list surface application](surface-api-work-applications.spec.md) | surface application | Aggregating Work, Resources, Orchestration, Execution, and Activities state into one work list/detail response | Composed alongside the rest of the API surface application; the only component that reads across that many modules for one response. |
| [CLI surface application](surface-cli-applications.spec.md) | surface application | Tick/start/stop, on-demand HTTP hosting, audit read, correlate, and validate-state commands | The only path the CLI entry point uses to reach the composed graph; hosts the HTTP server the API surface application is served over. |

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
