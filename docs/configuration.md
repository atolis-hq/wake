# Configuration

Wake configuration is strict, versioned YAML. This page documents every
currently supported field in the root configuration and the built-in GitHub
provider. The executable source of truth is
`src/bootstrap/config/root-schema.ts` and the module schemas it composes.

## Files and merging

`wake init <path>` creates a Wake home containing a required `config.yaml` and
an optional `config.workflows.yaml`. Both are resolved directly from the Wake
home; profiles, environment-variable overlays, `config.json`, and additional
`config.*.yaml` files are not configuration inputs.

Wake parses both files as YAML, then deep-merges `config.workflows.yaml` over
`config.yaml`: mappings merge recursively, while arrays and scalars in the
workflows file replace earlier values. The optional workflows file supports
three equivalent shapes:

```yaml
# Explicit root section
orchestration:
  workflows: { ... }

# Orchestration section shorthand
workflows: { ... }

# Bare workflow-name mapping
default: { ... }
```

The first two forms are normalised before merging; the third becomes
`orchestration.workflows`. Wake never writes resolved defaults back to either
file. Unknown root and module fields are rejected, except within a named
integration entry, which is validated by that provider.

Every configuration uses `schemaVersion: 1`.

## Complete root shape

```yaml
schemaVersion: 1
work: {}
resources: {}
activities: {}
artifacts: {}
orchestration: {}
transcripts: {}
execution: {}
controlPlane: {}
integrations: {}
surfaces: {}
host: {}
```

| Field | Type / default | Explanation |
| --- | --- | --- |
| `schemaVersion` | literal `1`; default `1` | Configuration format version. No other value is accepted. |
| `work` | strict empty object; default `{}` | Reserved Work-module configuration. It has no supported child fields yet. |
| `resources` | strict empty object; default `{}` | Reserved Resources-module configuration. It has no supported child fields yet. |
| `activities` | strict empty object; default `{}` | Reserved Activities-module configuration. It has no supported child fields yet. |
| `artifacts` | object; defaults below | Instance-wide limits for Wake-managed work-item artifact storage. |
| `orchestration` | object; defaults below | Workflows, selection, commands, watches, and outcome routing. |
| `transcripts` | object; defaults below | Opt-in raw agent prompt/response capture. |
| `execution` | object; `defaultRunnerPool` required | Runner registry, runner pools, and durable Run recovery settings. |
| `controlPlane` | object; defaults below | Bounded advancement, resident-loop delay, and scheduled workflow starts. |
| `integrations` | mapping; default `{}` | Named provider configurations. |
| `surfaces` | object; defaults below | Local HTTP API and web UI. |
| `host` | object; defaults below | Sandbox, development-installation, and self-update settings. |

## Complete Wake-home example

The following pair is a valid, fully expanded example. It deliberately keeps
the `fake` runner in the selected pools and GitHub disabled, so the configuration
can be validated and exercised without credentials or token spend. Replace the
repository placeholder, enable GitHub, and repoint the runner pools only when
the corresponding CLI and provider credentials are ready.

`config.yaml`:

```yaml
schemaVersion: 1
work: {}
resources: {}
activities: {}

execution:
  agentRunners:
    fake:
      kind: fake
      runnerTimeouts: { idleMs: 600000, hardMs: 7200000, cancellationGraceMs: 30000 }
      args: []
    claude-haiku:
      kind: claude-cli
      command: claude
      model: haiku
      runnerTimeouts: { idleMs: 600000, hardMs: 7200000, cancellationGraceMs: 30000 }
      args: []
    codex-terra:
      kind: codex-cli
      command: codex
      model: gpt-5.6-terra
      effort: high
      runnerTimeouts: { idleMs: 600000, hardMs: 7200000, cancellationGraceMs: 30000 }
      args: []
    cursor-composer:
      kind: cursor-cli
      command: cursor
      model: composer-2.5
      runnerTimeouts: { idleMs: 600000, hardMs: 7200000, cancellationGraceMs: 30000 }
      args: []
  runnerPools:
    light: [fake]
    standard: [fake]
    deep: [fake]
  defaultRunnerPool: standard
  leaseDurationMs: 300000
  leaseRenewalIntervalMs: 60000
  maxAmbiguityReconciliationAttempts: 3
  workspaceHooks:
    prepare:
      command: "npm ls --depth=0 > /dev/null 2>&1 || (rm -rf node_modules && npm ci)"
      timeoutMs: 300000

controlPlane:
  maxDispatches: 1
  maxConcurrentRuns: 1
  resident:
    pollBackoffMs: 1000
    maxPollBackoffMs: 16000
  triggers:
    - id: daily-maintenance
      on:
        cron: "0 2 * * *"
      when:
        capacityAvailable: true
      workflow: default

orchestration:
  default: default
  workflowSelectors:
    - workflow: approval
      match:
        tags: [approval]
        kind: issue
        adapter: github
      matchMode: all

integrations:
  github:
    provider: github
    enabled: false
    # Set token only when normal GitHub credential resolution is unsuitable.
    # token: ghp_example
    repositories:
      - owner: your-organization
        repo: your-repository
    polling:
      maxPerRepo: 25
      maxConcurrent: 4
      commentPageSize: 25
      lookbackMs: 60000
      intervalMs: 30000
    # Optional immediate intake. Requires surfaces.web.publicUrl and wake start.
    webhooks:
      enabled: false
    intake:
      - where:
          kind: issue
          state: [open]
          requiredAssignees: []
          requiredAuthors: []
          labels: [automation]
        matchMode: all
        ignoredLabels: [security]
        tags: [automation]
    publication:
      postStatusComments: true
      replies:
        rules:
          - match: { stage: review, outcome: [blocked, needs-clarification] }
            matchMode: all
            target: pull-request
        default: primary
  fake:
    provider: fake
    enabled: false
    events: []
    deliveryEffects: {}

surfaces:
  api:
    enabled: false
    host: 127.0.0.1
    port: 4317
    conversationMessages:
      # Disabled until Wake can attribute messages to the authenticated operator.
      enabled: false
  web:
    enabled: false
    auth:
      # Authentication is enabled unless this explicit local-development opt-out is true.
      disabled: false
    # Optional stable HTTPS address Wake links from GitHub agent-run reports.
    # publicUrl: https://wake.example.ngrok.app

# `wake ui token` creates a single-use login grant valid for ten minutes and
# prints login links plus QR codes. Redeeming it creates a persistent operator
# session valid for two years; it survives browser and Wake-container restarts
# while `.wake/auth/credentials.json` remains intact. The durable access and
# session keys remain sensitive local state; do not commit or publish that file.

transcripts:
  enabled: false
  retentionMs: 86400000

host:
  sandbox:
    image: wake-sandbox
    imageRepository: wake-sandbox
    containerName: wake-sandbox-example
    wakeMountPath: /wake
    containerHomeMountPath: /home/wake
    start:
      enabled: true
    extraMounts: []
  development:
    mode: packaged
```

`config.workflows.yaml`:

```yaml
workflows:
  default:
    entry: refine
    commands:
      /summarize:
        activity: agent
        with: { template: summarize }
        allowedActors: [human]
    stages:
      refine:
        activity: agent
        with: { template: refine }
        execution: { workspace: read-only, runnerPool: light }
        requiresApproval: false
        on:
          done: { then: implement }
          blocked: { then: await-human }
          failed: { then: await-human }
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          done:
            then: done
            await:
              signal: approved
              from: [human]
              timeoutMs: 86400000 # optional; block after one day
          blocked: { then: await-human }
          failed: { then: await-human }
  approval:
    entry: refine
    stages:
      refine:
        activity: agent
        with: { template: refine }
        execution: { workspace: read-only, runnerPool: light }
        on:
          done:
            then: done
            await:
              signal: approved
              from: [human, auto]
          blocked: { then: await-human }
          failed: { then: await-human }
```

This example references `prompts/refine.md`, `prompts/implement.md`, and
`prompts/summarize.md`. Supply those templates before enabling a real runner
or admitting live work. The workflow syntax and operational trade-offs are
explained in [Workflows](workflows.md).

## `execution`

`wake init` creates named real-runner examples but routes all initial pools to
the deterministic, zero-token `fake` runner. Repoint a pool at an authenticated
CLI before allowing real agent execution.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `execution.agentRunners` | mapping; default `{}` | Maps a non-empty runner name to a runner definition. |
| `execution.runnerPools` | mapping of non-empty runner-name lists; default `{}` | Ordered candidates selected by a workflow stage's `execution.runnerPool`. |
| `execution.defaultRunnerPool` | non-empty string; required | Pool used when the activity execution request omits `runnerPool`. It must name a configured pool when invoked. |
| `execution.leaseDurationMs` | positive integer; optional | Overrides the durable Run lease duration. |
| `execution.leaseRenewalIntervalMs` | positive integer; optional | Overrides how often a local active Run renews its lease. |
| `execution.maxAmbiguityReconciliationAttempts` | positive integer; optional | Limits recovery reconciliation attempts for an ambiguous Run. |
| `execution.workspaceHooks.prepare` | object; optional | Runs an operator-authored shell command on every acquisition of a retained branch or read-only workspace before its runner starts. The hook owns dependency caching and invalidation. |
| `execution.workspaceHooks.prepare.command` | non-empty string; required | Raw shell command or script path to prepare or repair workspace state; it must be safe to run after Wake resets tracked files while preserving ignored files. |
| `execution.workspaceHooks.prepare.timeoutMs` | positive integer; default `300000` | Wall-clock timeout for the prepare command. |

Branch and read-only workspaces remain retained while their WorkItem is open.
Read-only acquisition restores tracked files while preserving ignored dependencies.
The prepare hook runs each time and owns dependency validation. Git checkout
targets come from Repository revisions or known PR head commits; issue-content
fingerprints are never fetched as Git commits. Without a Git target, the checkout
stays pinned to its initial clone revision. Interrupted checkout creation is
rebuilt; failed preparation retains the completed checkout for a later attempt.
Recovery removes validated workspaces once their WorkItem is closed, cancelled,
or deleted and no live process lease or active/ambiguous Run protects them.

Each `execution.agentRunners.<name>` definition has the following shape.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `kind` | `claude-cli`, `codex-cli`, `cursor-cli`, `command`, or `fake`; required | Selects the runner adapter. |
| `command` | non-empty string; required except for `fake` | Executable used by command-backed runners. |
| `model` | non-empty string; optional | Runner's configured model metadata/default. A prompt or Activity may request a different model. |
| `effort` | non-empty string; optional | Runner-specific reasoning-effort setting. |
| `runnerTimeouts` | object; defaults below | Bounds and graceful-cancellation timing for one runner invocation. |
| `runnerTimeouts.idleMs` | positive integer; default `600000` | Maximum time without runner output activity. Claude counts streamed provider/tool events; other process runners count stdout/stderr. |
| `runnerTimeouts.hardMs` | positive integer; default `7200000` | Absolute maximum invocation duration, regardless of output. |
| `runnerTimeouts.cancellationGraceMs` | positive integer; default `30000` | Time to wait after SIGTERM before escalating cancellation to SIGKILL. |
| `args` | list of strings; default `[]` | Additional adapter arguments. Do not include `--output-format` or `--resume`; Wake manages those flags. |

Pools are tried in order, skipping runners currently paused as quota-ineligible
or unable to accept Wake's trusted per-run MCP configuration. A missing runner
named by a pool is an error; Wake does not silently switch to another pool or
run an artifact-capable activity without its Wake tools.

## `artifacts`

Wake exposes `wake_artifacts_list`, `wake_artifacts_read`, `wake_artifacts_write`,
`wake_artifacts_patch`, and `wake_artifacts_delete` with portable underscore names.
When Wake injects its MCP server into a restricted Claude run, it adds
`mcp__wake` to the allowed tools. Other MCP servers receive no automatic permission.
Codex receives the server through per-run MCP configuration.

Planning/refine stages write the canonical shared plan to the `plan.md` artifact
and update it on resume. Responses and comments summarize changes or questions
and reference that plan. Implementation and review stages read upstream artifacts
explicitly; reviewers report feedback for the producer to incorporate. Artifact
content remains untrusted stage output. Legacy plans without an accessible artifact
can still be reviewed from an explicit attached plan or provider record; summaries
are not substitute plans. Each session may read accepted artifacts from any producer on its work item,
including parent and child workflows. The run's readable producer scope is
issued from that work item's existing artifact revisions. Other work items
(except accepted revisions explicitly shared through a trusted trigger
`contextScope` or delegation grant, read-only) and unaccepted output from other runs remain inaccessible; only the producing stage
may write, patch, or delete its own artifacts.

Artifact storage is owned by Wake, outside Git workspaces, and is not a
workflow-step configuration surface. Every agent activation receives a
run-scoped Wake MCP server and a metadata-only manifest of the artifacts it may
read. The producing stage is the only writer; accepted upstream outputs are
readable across workflows on the same work item. Wake publishes staged output only when Orchestration accepts the
producing activation's outcome.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `artifacts.maxWriteBytes` | positive integer; default `26214400` | Maximum bytes in one artifact revision (25 MiB). |
| `artifacts.maxWorkItemBytes` | positive integer; default `262144000` | Maximum retained revision bytes for one work item (250 MiB). Must not be lower than `maxWriteBytes`. |

The work-item Artifacts tab lists accepted current revisions. Each link is an
authorized Wake download; it is not a bearer URL and no artifact index is
written back to a provider issue or comment.

```yaml
execution:
  agentRunners:
    fake: { kind: fake }
    codex:
      kind: codex-cli
      command: codex
      model: gpt-5.6-terra
      runnerTimeouts: { idleMs: 600000, hardMs: 7200000, cancellationGraceMs: 30000 }
  runnerPools:
    light: [fake]
    standard: [codex, fake]
  defaultRunnerPool: standard
  workspaceHooks:
    prepare:
      command: "npm ls --depth=0 > /dev/null 2>&1 || (rm -rf node_modules && npm ci)"
      timeoutMs: 300000
```


Shared artifact manifest entries retain their original `workItemId` and revision ID.
Pass both `revisionId` and optional `workItemId` to `wake_artifacts_read` when
revision IDs collide across local and shared namespaces; an unqualified ambiguous
read is rejected. Referenced immutable bytes remain available after later replacement
or tombstoning of the producer path.

## `controlPlane`

| Field | Type / default | Explanation |
| --- | --- | --- |
| `controlPlane.maxDispatches` | positive integer; default `1` | Per-call burst cap: the maximum number of new Runs a single `advanceOnce` call will start, independent of and bounded by `maxConcurrentRuns`. `advanceOnce` fills open capacity within one call up to this cap rather than dispatching a single Run per call. |
| `controlPlane.maxConcurrentRuns` | positive integer; default `1` | Maximum Runs that may be `started` system-wide. `advanceOnce` stops dispatching, and additional advancement calls return `no-work`, until capacity is available. |
| `controlPlane.triggers` | list; default `[]` | Independent workflow invocations. Each entry is described below. |
| `controlPlane.resident.pollBackoffMs` | positive integer; default `1000` | Exponential backoff base for intake's idle-or-erroring poll cadence and the runner's error-retry cadence — courtesy toward a rate-limited external API. Unrelated to journal consumption, which waits on a change signal instead of polling. |
| `controlPlane.resident.maxPollBackoffMs` | positive integer; optional | Ceiling for that exponential backoff (default: `pollBackoffMs * 16`). |

Activation scheduling is always performed by the durable scheduler
subscription. It reconsiders every durable fact, reconciles on startup and a
bounded fallback, and shares the global scheduler lock with one-shot ticks.

Each `controlPlane.triggers[]` entry requires a unique non-empty `id`, a
configured `workflow`, and a non-empty `on` source object. `on.events` is
an optional non-empty list of canonical event names (for example,
`execution.run-succeeded`); unknown names are rejected. `on.cron` is an
optional five-field UTC cron expression. When both are configured, either
source requests a workflow invocation. Single-flight coordination prevents
overlap; requests during an active invocation coalesce into one pending request.
Event consumption begins
at registration; historical events do not cause startup invocations.

The optional gate is exactly `when: { capacityAvailable: true }`. It checks
current execution headroom under `maxConcurrentRuns`, runtime pause, and
runner eligibility in the workflow entry stage's pool. A false gate consumes
and skips the occurrence when no invocation is active. Coalesced requests are
checked again after the active invocation ends; an ineligible pending request
is consumed rather than deferred. Trigger checks never reserve capacity;
normal execution dispatch still enforces limits and quotas. Becoming eligible
alone never starts an invocation. Dispatch pause prevents all new trigger starts
and consumes explicit occurrences, including cron slots.

Every start creates an ordinary top-level WorkItem with display description
`Trigger <id>: workflow <workflow>` and a named workflow instance. Activity
prompts define the task. Control Plane records the trigger, event ID/type or
cron slot, WorkItem, workflow instance and workflow name in a durable
`control-plane.trigger-invocation-started` event. Artifacts remain
WorkItem-local unless the trigger sets an explicit `contextScope` (see below),
so separate invocations do not share artifacts automatically.

Requests, invocation claims, source identities, starts, results, and trigger
pause/resume facts are durable. Cron watermarks live in processor state. Hosts
sharing a Wake home serialize trigger starts and operator pause/resume/manual-run commands;
recovery uses the claimed WorkItem and workflow IDs to complete an interrupted
start. Cron catch-up consumes at most 64 occurrences per trigger per pass and
coalesces them into one request. There is no cooldown or minimum interval.
Skipped background occurrences advance durable source cursors without adding request facts.
Control Plane retains the latest actual skip diagnostic per trigger in processor
state, bounded to 256 recent trigger identities. Each diagnostic includes the
trigger ID, canonical source identity, observation time, and typed reason
(own-scope suppression, trigger pause, removed definition, dispatch pause,
capacity unavailable, or the pending-source limit). This is operational
explainability, not an occurrence audit log or a rebuildable projection. It does
not change admission or scheduling and does not emit events that could trigger
other jobs. Diagnostics survive restarts but are lost if processor state is
reset; eviction only removes old diagnostics, never invocation history.
Pending requests retain at most 64 representative source identities; additional
occurrences coalesce into that same request and advance their cursors. Operational
projections are stored per coordination scope, while each invocation has its own
history document and stream. Normal coordination reads new journal batches
incrementally rather than repeatedly folding historical requests and invocations.

The public Control Plane trigger service exposes pause/resume/manual-run commands and a
rebuildable invocation-history projection. Pausing clears unstarted pending
work and skips new occurrences; active invocations continue.
Blocked invocations still hold their single-flight slot: operator retry or
clarification can resume the same workflow. Only completion or supersession
releases the slot. Pausing a trigger clears the shared scope's pending request,
including reasons coalesced through sibling triggers.
Pause survives restart and removal/re-add of the same ID. Resume enables future explicit
sources without replaying skipped occurrences or resetting workflow retries.
Events from the trigger's own invocation WorkItems/workflows/Runs are suppressed.
An invocation that blocks or exhausts automatic failure retries pauses its
trigger until an operator resumes it. Removing a definition prevents future
starts while preserving history and independent management of existing work.

Legacy `controlPlane.schedules` and trigger-level `objective`,
`minIntervalMs`, and unknown fields are rejected.

An operator may set `contextScope` on a trigger (letters, digits, `.`, `_`, `:`,
`-`; at most 128 characters). Triggers naming the same scope share read context
and a single-flight coordination key (`context:<name>`); without it, each
trigger ID coordinates its own invocations and artifacts stay isolated. There is
no `artifacts.contextScopes` registry. Membership is issued only from a durable
invocation claim whose coordination key matches the operator binding; an agent
cannot name or join a scope.

Shared context is additive and read-only. Each invocation keeps its own
WorkItem artifact namespace and producer-owned writes, and its manifest also
lists authorized shared references with their original WorkItem, producer, and
revision (`access: shared`). Same-path local and shared artifacts remain distinct
and are read by revision ID. Only selected accepted exports populate the scope.
A producer selects an export per revision with `share: true` on
`wake_artifacts_write`. The run credential supplies the configured scope;
a tool argument cannot select a destination or enroll a run. Selecting an export
without a trusted shared-context credential fails. The selection is staged in
Artifact metadata and published only when the claimed invocation completes
successfully with accepted output. Unmarked revisions stay local; conventional
`memory.md` is selected automatically for successful memory publication.
The `delegation:` prefix is reserved for delegation-grant streams.
When an invocation completes successfully and exactly one producer has an
accepted `memory.md`, the scope's current memory advances to that producer's
latest accepted revision (flagged `currentMemory` in later manifests); missing,
failed, draft, or ambiguous output leaves it unchanged. Updates carry the expected
prior pointer. A stale update leaves memory unchanged and records a durable
`stale-memory-pointer` publication outcome; replay returns the same outcome.
Only the workflow named in the durable trigger claim is reconciled. Publication
errors are isolated per invocation, retried on later passes, and logged without
blocking unrelated trigger admission. A resident host skips reconciled workflows
and caches immutable claim bindings; a restart rebuilds these from durable facts.
Publication is recorded in a single
context-stream event keyed by the workflow instance and reconciled idempotently
on each trigger pass, so crashes between streams are repaired rather than
assumed atomic. Revisions referenced by a scope remain retained. Parent/child
sharing contracts (`ArtifactContextService.registerChild`) grant a child only
selected parent references and let the parent read accepted child artifacts;
siblings receive only explicitly supplied references.

Cron expressions use five whitespace-separated fields: minute, hour,
day-of-month, month, and day-of-week. They are evaluated in UTC. Wake supports
lists, ranges, steps, and the `JAN`-`DEC` and `SUN`-`SAT` aliases.
Expressions with a seconds field, `?`, `H`, `L`, or `#` syntax and
per-trigger time-zone configuration are not supported. When both day-of-month
and day-of-week are restricted, both must match. Cron retains elapsed-slot
checkpoint behavior, including a matching current-minute occurrence on first
evaluation; there is no implicit startup source.

## `orchestration`

`orchestration` defaults to `{ workflows: {}, workflowSelectors: [], default:
default }`. If one or more workflows are configured, `default` and every
selector's `workflow` must name one of them.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `orchestration.workflows` | mapping; default `{}` | Named workflow definitions. |
| `orchestration.workflowSelectors` | list; default `[]` | Ordered rules that choose a workflow for newly admitted resources. |
| `orchestration.default` | non-empty string; default `default` | Fallback workflow name when no selector matches. |

### Workflow definition

Each `orchestration.workflows.<name>` is a strict object.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `entry` | non-empty stage name; optional | Initial stage. If omitted, compilation uses the first configured stage. |
| `stages` | non-empty mapping; required | Stage definitions, described below. |
| `commands` | mapping; optional | Supplemental slash commands, keyed as `/name` (lowercase letter followed by lowercase letters, digits, or hyphens). |
| `watches` | list; optional | Child-workflow triggers, described below. |

Each `stages.<name>` has these fields:

| Field | Type / default | Explanation |
| --- | --- | --- |
| `activity` | non-empty string; required | Registered Activity name. The built-in agent activity is `agent`. |
| `with` | any YAML value; optional | Input validated by the selected Activity. For `agent`, supply exactly one of `template` or `prompt`, with optional `model`, `allowedTools`, and string-valued `vars` with identifier keys. Variables render as `{{vars.name}}` and never enable tools. Delivery oversight uses repository-scoped `gh` command patterns in `allowedTools`; see [the example](../examples/delivery-oversight/config.workflows.yaml). Wake MCP has no GitHub proxy tools or selection receipt. |
| `execution.workspace` | `none`, `read-only`, or `branch`; optional | Workspace mode for this Activation. |
| `execution.runnerPool` | non-empty string; optional | Runner-pool hint for agent execution. |
| `on` | non-empty mapping; required | Outcome name to route definition. |
| `requiresApproval` | boolean; optional | Declares that stage completion requires orchestration approval policy. |

For the built-in deterministic `pr.approve` and `pr.merge` Activities—their
required input, durable delivery lifecycle, outcomes, and safety controls—see
[Workflows](workflows.md#built-in-deterministic-pr-activities).

Every `on.<outcome>` route requires `then`, a non-empty target stage name or
`done`. It may also contain:

| Field | Type | Explanation |
| --- | --- | --- |
| `activities` | list of `{ use, with? }` | Follow-on Activities to execute before the route completes. |
| `repeat` | `{ max: positive integer }` | Bounds repetitions of this route. |
| `retry` | `{ max: positive integer }` | Bounds retries for this route. |
| `await` | `{ signal, from }` | Pauses on a named signal accepted from one or more authorities. `from` entries are `human`, `auto`, or `{ kind: watch, id }`. |
| `watchGates` | list | Requires named watch verdicts. An entry is either a watch id or `{ watch, onReject?: { then } }`. |
| `resourceTransitions` | list | `on.done` only. Each entry is one of `pr.review-accepted`, merged `pr.state-changed`, or failing `pr.checks-changed`; optional `then` inherits the route target. While the route waits, matching facts are reacted to as observed; `orchestration.signal-wait-started` also performs durable-fact catch-up for eligible facts predating that wait. The subject is the WorkItem's correlated primary resource, and a missing or ambiguous subject fails closed. |

Each `commands./name` entry requires `activity` and a non-empty
`allowedActors` list containing `human`, `auto`, or `watch`; it may also carry
Activity input under `with`.

Each `watches[]` entry requires all of the following:

| Field | Type | Explanation |
| --- | --- | --- |
| `id` | non-empty string | Watch identity, referenced by approval and gate configuration. |
| `while.stages` | non-empty stage-name list | Parent stages during which the watch may run. |
| `while.statuses` | non-empty list of `active`, `waiting`, or `blocked` | Parent workflow statuses during which it may run. |
| `on.events` | non-empty canonical event-name list; optional | Events that trigger this watch. |
| `schedule.cron` | non-empty string; optional | Cron trigger for this watch. At least one of `on` or `schedule` is required. |
| `workflow` | non-empty string | Child workflow to start. |
| `maxPerGroup` | positive integer | Maximum child starts for an orchestration group. |

A `workflowSelectors[]` entry requires `workflow` and a non-empty `match`
object. `match.tags`, `match.kind`, and `match.adapter` each accept either one
non-empty string or a non-empty list. `matchMode` is `any` by default, or
`all` to require every declared facet.

## `integrations`

`integrations` is a mapping from a lowercase, hyphenated integration name to a
provider entry. Every entry accepts `provider` (optional lower-case provider
id), `enabled` (boolean, default `true`), and optional `conversation.capabilities`.
Provider-owned fields are allowed at this boundary and are validated when that provider is composed.
The generic conversation setting is removed before provider-specific validation.

### Built-in GitHub provider

Use `provider: github` for the built-in GitHub integration.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `enabled` | boolean; required by GitHub provider | Enables provider composition and polling. |
| `token` | non-empty string; optional | Explicit GitHub token. If absent, the client uses its normal credential resolution. |
| `repositories` | non-empty list; required | Repositories to poll. Each entry is `{ owner, repo }`, both non-empty strings. |
| `polling.maxPerRepo` | positive integer; default `25` | Maximum issues and pull requests read per repository per poll, and the maximum retained result count for each nested PR evidence, review, and comment read. |
| `polling.maxConcurrent` | positive integer; default `4` | Provider-wide concurrent GitHub request limit shared by polling enrichment and Wake-label reconciliation. |
| `polling.commentPageSize` | integer `1..100`; default `25` | Page size for issue and pull-request comments. |
| `polling.lookbackMs` | non-negative integer; default `60000` | Overlap retained when querying since the repository's durable provider-time watermark. The effective overlap is `max(lookbackMs, 300000)` (five minutes). The first poll, or one with no persisted watermark, uses the provider's bounded bootstrap query. After a complete uncapped poll, the watermark advances to the latest valid top-level issue or pull-request `updated_at`; empty, partial, invalid-timestamp, and capped reads retain it. |
| `polling.intervalMs` | positive integer; default `30000` | Minimum time between real GitHub polls. Ticks that land before this interval has elapsed since the last real poll skip the GitHub API call and return no drafts, independent of `controlPlane.resident.pollBackoffMs`, which governs the intake resident loop's own tick cadence, not any one adapter's call rate. |
| `webhooks.enabled` | boolean; default `false` | Opts this adapter into Wake-managed GitHub repository webhooks. `wake start` creates or updates only hooks whose IDs Wake has persisted under `.wake/`; `wake ui` does not provision hooks. A configured `surfaces.web.publicUrl` is required. Verified deliveries trigger a coalesced full poll immediately, bypassing this adapter's normal interval while retaining polling as the source of observations. The token needs GitHub repository **Webhooks: read/write** permission (or the equivalent classic-token repository administration/webhook scope). |
| `intake` | list; default `[]` | Admission/tagging rules. With no rules, every observation is admitted with no added tags. |
| `publication.postStatusComments` | boolean; default `true` | Allows GitHub status-comment publication. |
| `publication.replies` | object; default `{ rules: [], default: primary }` | Routes agent-run reply comments. Rules are evaluated in order and the first match wins. |
| `commands` | string list; default `[]` | Additional command syntax advertised on the web UI's Configuration → Commands tab alongside the adapter's built-in commands (`/approved`, `/accepted`, `/changes`, `/retry`, `/restart`, `/extend`). Purely descriptive: Wake does not recognize these itself, so any behavior they imply must be handled by whatever reads the comment. |

Each `intake[]` rule has `where`, optional `matchMode` (`any` by default or
`all`), optional `ignoredLabels` (default `[]`), and `tags` (default `[]`). An
observation carrying any `ignoredLabels` value is discarded before Wake creates
or correlates work, regardless of whether it otherwise matches an intake rule.
`where.kind` is `issue` or
`pull-request`; `where.state` is an optional list of `open`, `closed`, or
`merged` states, and `where.requiredAssignees`, `where.requiredAuthors`, and
`where.labels` are string lists, each defaulting to `[]`. State restricts
admission only: Wake continues to poll all states so it can reconcile closure
of work it already admitted. Intake tags must not use a Wake-owned marker
family, so Wake cannot ingest and reroute its own markers.

`publication.replies.rules` controls where terminal agent-run reply comments go. Each rule has a
required `target` of `primary`, `issue`, `pull-request`, or `none`; `none` suppresses the comment.

### Conversation command policy

Wake records every conversation entry before interpreting its first trimmed line as a command.
Workflow `commands` are therefore surface-neutral: a configured command is available on every
conversation surface and still enforces its `allowedActors` policy. It takes precedence over a
built-in command with the same spelling, except for an explicit Continue request to the owning
recovery command. Arguments after the command are accepted for syntax
compatibility but are not passed to the Activity.

Built-ins are `/approved`, `/accepted`, `/changes`, `/retry`, `/restart`, and `/extend`. Their
availability is controlled by each named integration instance's capabilities. `review-surface`
and `operator-surface` permit all six; `chat-surface` permits none. The control-plane composer is
an `operator-surface`; the built-in GitHub provider defaults to `review-surface`; and an unknown
provider defaults to no capability. This makes a newly enabled chat integration safe until it is
explicitly granted authority.

```yaml
integrations:
  slack:
    provider: slack
    conversation:
      capabilities: [chat-surface]
```

`integrations.<adapter>.conversation.capabilities` is an optional replacement for that adapter's
provider default and accepts `review-surface`, `chat-surface`, and/or `operator-surface`. It is
adapter-instance configuration: two instances of the same provider may use different capability
sets. Granting `review-surface` or `operator-surface` enables command classes but does not itself
authorize an actor; the adapter must still verify its actor evidence before Wake applies a command.
GitHub obtains collaborator permission evidence for syntactically valid slash commands.
Human actors with repository write, maintain, or admin permission may control work on an issue
they authored. Independent review remains separate: authors cannot approve their own issue or
pull request, even through configured reviewer authority. Work control does not approve or merge
implementation or satisfy revision-bound review evidence.

The authenticated control-plane operator retains human workflow-review authority: /approved and
/accepted approve a matching human wait, while ordinary /changes follows its rejection route.
The Continue action sends /changes with an explicit `continuation: true` message field; this requests
agent-stage reentry rather than a review decision. Revision-bound waits and watch authorities remain
enforced, and operator workflow decisions do not create provider PR approval or merge evidence.
Plain comments can answer clarification or resume eligible blocked outcomes; they do not re-run a
successful stage waiting for review.

Use /changes followed by instructions to continue an eligible blocked agent stage. /retry and
/restart remain failed-stage recovery (restart requests a fresh session); /extend explicitly
extends an exhausted watch-group budget. Continuation does not revive deleted, closed, or frozen
work, bypass watch authority, or reset retry/review budgets. Rejected and inapplicable commands
produce actionable conversation feedback. Verified work-control or review actors also receive a
durable reply to the originating resource when a primary workflow activation exists. Untrusted
command actors cannot cause public bot replies.
A command unavailable to its surface, or issued by an unauthorized actor, remains a durable,
immutable conversation entry and has no workflow effect.
`match.stage` and `match.outcome` are independently optional facets, each accepting one value or a
non-empty list. Outcomes are case-sensitive lowercase-kebab values: `done`, `rejected`, `blocked`,
`failed`, and `needs-clarification`. Facets are combined with `matchMode` (`any` by default, or
`all`), and rules are evaluated in listed order: the first match wins. If no rule matches, `default`
is used and defaults to `primary`. `primary` preserves the existing behavior by selecting the first
primary correlation. `issue` and `pull-request` select the first correlation of that kind; if none
exists, they use the same primary resolution.

### GitHub workflow labels

For each open GitHub-correlated WorkItem with a top-level workflow, Wake
reconciles its own labels on the issue or pull request:

- `wake:status.working`, `wake:status.awaiting-approval`,
  `wake:status.blocked`, `wake:status.completed`, or `wake:status.failed`
- `wake:stage.<current-stage>`
- `wake:workflow.<workflow-name>`
- `wake:watching` while an active child workflow is running for a watch

These are projections of Wake's durable workflow state, not commands or
intake signals. Wake replaces only labels in the `wake:` namespace and
preserves all other GitHub labels. Do not use a `wake:` label in an intake
selector: it can feed Wake's own output back into admission and routing.

### Terminal external resources

When GitHub later observes a closed state for a resource already correlated to
a WorkItem, Wake concludes that WorkItem idempotently. GitHub's `not_planned`
closure maps to Wake's `cancelled` outcome and cancels the WorkItem; every
other GitHub closure maps to `completed` and closes it. WorkItem lifecycles are
final, so reopening the external issue or pull request does not reopen the
concluded WorkItem; admit or create new work for a new lifecycle.

```yaml
integrations:
  github:
    provider: github
    enabled: true
    repositories: [{ owner: atolis-hq, repo: wake }]
    intake:
      - where: { kind: issue, labels: [automation] }
        matchMode: all
        tags: [automation]
```

### Built-in fake provider

Use `provider: fake` only for deterministic local and test environments. It
accepts the following provider-specific fields in addition to `enabled`:

| Field | Type / default | Explanation |
| --- | --- | --- |
| `events` | list; default `[]` | Synthetic inbound observations. Each requires `key` and `title`; optional fields are `kind` (`issue` or `pull-request`), `revision`, `branch`, `baseRevision`, `checks` (`unknown`, `pending`, `passing`, or `failing`), `acceptedReview`, `reviewActorId`, `reviewActorKind` (`human` or `bot`), `reviewerId`, `changedFiles`, `watchEvent: fake.review-requested`, and `eligible`. |
| `deliveryEffects` | string-to-string mapping; default `{}` | Deterministic outbound delivery effects keyed by fixture identity. |
| `effectsFile` | non-empty string; optional | JSON fixture file supplying delivery effects; resolved relative to the Wake home. |
| `connectivityError` | non-empty string; optional | Test hook that makes provider connectivity validation fail with this message. |
| `createError` | non-empty string; optional | Test hook that makes provider composition fail with this message. |

The configuration hydration path also recognizes a fake entry with
`evidenceFile`: its JSON fixture is read relative to the Wake home and supplied
as `events`; an optional `effectsFile` is handled similarly. These fixture
fields are for deterministic testing, not normal operation.

## `surfaces` and `transcripts`

| Field | Type / default | Explanation |
| --- | --- | --- |
| `surfaces.api.enabled` | boolean; default `false` | Enables the local API surface. |
| `surfaces.api.host` | string; default `127.0.0.1` | API bind host. |
| `surfaces.api.port` | positive integer; default `4317` | API bind port. |
| `surfaces.api.conversationMessages.enabled` | boolean; default `false` | Enables the control-plane message composer in a Work Item's Conversation tab, which records a control-plane entry and applies the workflow-resume bridge. Leave disabled until operator identity is available to Wake; conversation timeline reads remain available. |
| `surfaces.web.enabled` | boolean; default `false` | Enables the web surface. It requires `surfaces.api.enabled: true`. |
| `surfaces.web.publicUrl` | HTTPS URL; optional | Stable operator-managed address for the web UI. When set, GitHub agent-run comments link their **Wake** header to this URL. See [Public UI access](public-ui-access.md). |
| `transcripts.enabled` | boolean; default `false` | Enables filesystem-only raw agent prompt/response capture. |
| `transcripts.retentionMs` | non-negative integer; default `86400000` | Transcript retention duration in milliseconds. Raw transcripts are not journal events. |

## `host`

`host` configures the operator environment, not workflow routing.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `host.sandbox.image` | non-empty string; default `wake-sandbox` | Docker image used for the sandbox. |
| `host.sandbox.imageRepository` | non-empty string; default `wake-sandbox` | Repository used when creating versioned self-update images. |
| `host.sandbox.containerName` | non-empty string; default `wake-sandbox` | Docker container name. `wake init` derives a project-specific default. |
| `host.sandbox.wakeMountPath` | non-empty string; default `/wake` | Container mount path for the Wake home. |
| `host.sandbox.containerHomeMountPath` | non-empty string; default `/home/wake` | Container mount path for the sandbox home. |
| `host.sandbox.start.enabled` | boolean; default `true` | Starts the resident Wake loop with the sandbox. |
| `host.sandbox.extraMounts` | list; default `[]` | Explicit additional bind mounts. Each is `{ source, target, readOnly? }`; `source` and `target` are non-empty strings. |
| `host.development.mode` | `source` or `packaged`; optional | Installation mode used for development and self-update routing. |
| `host.development.repoRoot` | non-empty string; optional | Source checkout path. Required when `mode: source`. |
| `host.selfUpdate.drainTimeoutMs` | positive integer; deprecated | Accepted for compatibility but ignored: self-update waits for active Runs to finish. |
| `host.selfUpdate.cancellationTimeoutMs` | positive integer; deprecated | Accepted for compatibility but ignored: self-update never cancels active Runs. |
| `host.selfUpdate.npm.package` | non-empty string; default `@atolis-hq/wake` | npm package to resolve for packaged self-updates. |
| `host.selfUpdate.npm.distTag` | non-empty string; default `latest` | npm dist-tag checked by `wake self-update` and its loop. |
| `host.selfUpdate.npm.registry` | URL; optional | npm registry used to resolve the package version. |

### Temporary runner memory profile

For a resident-memory investigation, set `WAKE_MEMORY_PROFILE=runner` in the
host shell and run `wake-dev sandbox update`. The sandbox receives the flag
only for that container generation and writes three small JSONL records per
runner execution to `.wake/logs/start.log`: before start, after the external
process is returned, and after its result settles. Each record contains only
the run ID, runner name, timestamp, PID, and Node memory counters; it never
includes a prompt, provider payload, command arguments, or runner output.

Unset the variable and run `wake-dev sandbox update` again to remove the
diagnostic mode.

### Credential bind mounts

Use `host.sandbox.extraMounts` to mount individual credential/configuration
files into the persistent sandbox home. Do not bind-mount an entire CLI
configuration directory: plugin caches and bookkeeping can contain
host-specific absolute paths, and a writable whole-directory mount lets the
sandbox overwrite host state.

```yaml
host:
  sandbox:
    extraMounts:
      # Claude: credentials may be read-only; settings stays writable because
      # plugin commands update it.
      - source: C:/Users/alice/.claude/.credentials.json
        target: /home/wake/.claude/.credentials.json
        readOnly: true
      - source: C:/Users/alice/.claude/settings.json
        target: /home/wake/.claude/settings.json
        readOnly: false
      # Codex and Cursor: expose only their portable config/auth files.
      - source: C:/Users/alice/.codex/config.toml
        target: /home/wake/.codex/config.toml
        readOnly: false
      - source: C:/Users/alice/.codex/auth.json
        target: /home/wake/.codex/auth.json
        readOnly: true
      - source: C:/Users/alice/.config/cursor/auth.json
        target: /home/wake/.config/cursor/auth.json
        readOnly: true
```

Use absolute host paths; do not put a literal `~` in YAML. Keep credential
files read-only unless the sandbox must refresh the host credential. The
generated `SETUP.md` in each new Wake home guides runner-specific setup; see
[Getting started](getting-started.md) for sandbox lifecycle and
[Workflows](workflows.md) for workflow-focused examples.

### Operator standing instructions

Triggers with an explicit `contextScope` share one operator-authored Markdown document. Edit it from the Triggers detail UI without changing configuration or restarting. No scope registry or implicit trigger scope is created. A trigger without `contextScope` cannot save instructions.

Operator saves use `artifacts.maxWriteBytes` (25 MiB by default), the existing artifact byte store, and durable `artifact-context.instructions-edited` journal facts. The loaded revision is compared on save; conflicts and oversized documents fail visibly without replacing the current text. Facts record the operator author and time, and current content is rebuilt from the journal’s latest revision. There is no revision-history editor.

At run provisioning, Wake captures the exact operator revision (including absence) and records `execution.run-operator-instructions-captured` on the run. Active and resumed runs retain their snapshot; later runs see edits. The dedicated trusted prompt section takes precedence over task defaults within fixed safety constraints and the configured tool allowlist. Agent artifacts and GitHub text remain untrusted evidence. `wake_context_instructions_read` reads the run snapshot; MCP has no operator write, patch or delete capability. Operator provenance never comes from agent-provided names or paths.

The operator document uses the reserved name `instructions.md`. Agent artifact commands cannot write, share, patch or delete this name (including nested paths and case variants), and legacy agent revisions with this name are excluded from current manifests and artifact listings. Operator provenance still comes from trusted journal facts, not the name.

Creation is lazy: configuring a scope creates no document, and the first operator save creates its document without enrollment or a prior invocation. Triggers sharing a scope share that document. Removing or renaming a scope retains its document as orphaned; the Triggers list displays its current Markdown, author and revision. Reusing the same explicit scope reconnects it for editing and future runs. Agent-drafted suggestions are outside this feature.

Orphan discovery reads a pure, rebuildable latest-revision projection keyed by context scope. Bootstrap registers it with the existing incremental projection processors; polling does not replay the full journal. The save path still reads authoritative context facts freshly and uses compare-and-swap. Inspection reads bytes only for orphaned scopes and preserves metadata with an unavailable-content message if a document cannot be read.

Every configured trigger can also be requested manually through **Run now** or
`POST /api/v1/triggers/:triggerId/commands/run`. Manual sources are not configured
in `on`; they carry the command identifier and requesting operator. They use the
same workflow, single-flight coordination, coalescing, dispatch pause, trigger
pause, capacity gate, and pending-source bounds. Coalesced requests remain pending
for reconsideration after the active invocation. Manual commands never resume a
paused trigger or reset workflow retries. Their original immediate disposition,
including a skipped reason, is journaled for idempotent retries; bounded latest
skip diagnostics remain operational processor state.
