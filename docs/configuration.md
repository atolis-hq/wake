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
  activationScheduler:
    mode: inline
  resident:
    pollBackoffMs: 1000
    maxPollBackoffMs: 16000
  schedules:
    - id: daily-maintenance
      workflow: default
      cron: "0 2 * * *"
      objective: "Perform the configured daily maintenance review."

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
    intake:
      - where:
          kind: issue
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
  selfUpdate:
    drainTimeoutMs: 30000
    cancellationTimeoutMs: 30000
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
| `execution.workspaceHooks.prepare` | object; optional | Runs an operator-authored shell command in every acquired branch or read-only workspace before its runner starts. |
| `execution.workspaceHooks.prepare.command` | non-empty string; required | Raw shell command or script path to prepare or repair workspace state. |
| `execution.workspaceHooks.prepare.timeoutMs` | positive integer; default `300000` | Wall-clock timeout for the prepare command. |

Each `execution.agentRunners.<name>` definition has the following shape.

| Field | Type / default | Explanation |
| --- | --- | --- |
| `kind` | `claude-cli`, `codex-cli`, `cursor-cli`, `command`, or `fake`; required | Selects the runner adapter. |
| `command` | non-empty string; required except for `fake` | Executable used by command-backed runners. |
| `model` | non-empty string; optional | Runner's configured model metadata/default. A prompt or Activity may request a different model. |
| `effort` | non-empty string; optional | Runner-specific reasoning-effort setting. |
| `runnerTimeouts` | object; defaults below | Bounds and graceful-cancellation timing for one runner invocation. |
| `runnerTimeouts.idleMs` | positive integer; default `600000` | Maximum time without stdout or stderr activity. |
| `runnerTimeouts.hardMs` | positive integer; default `7200000` | Absolute maximum invocation duration, regardless of output. |
| `runnerTimeouts.cancellationGraceMs` | positive integer; default `30000` | Time to wait after SIGTERM before escalating cancellation to SIGKILL. |
| `args` | list of strings; default `[]` | Additional adapter arguments. Do not include `--output-format` or `--resume`; Wake manages those flags. |

Pools are tried in order, skipping only runners currently paused as
quota-ineligible. A missing runner named by a pool is an error; Wake does not
silently switch to another pool.

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

## `controlPlane`

| Field | Type / default | Explanation |
| --- | --- | --- |
| `controlPlane.maxDispatches` | positive integer; default `1` | Per-call burst cap: the maximum number of new Runs a single `advanceOnce` call will start, independent of and bounded by `maxConcurrentRuns`. `advanceOnce` fills open capacity within one call up to this cap rather than dispatching a single Run per call. |
| `controlPlane.maxConcurrentRuns` | positive integer; default `1` | Maximum Runs that may be `started` system-wide. `advanceOnce` stops dispatching, and additional advancement calls return `no-work`, until capacity is available. |
| `controlPlane.activationScheduler.mode` | `inline` (default) or `subscriber` | `inline` keeps activation scheduling in the runner pipeline. `subscriber` starts the one shared scheduler as an independently checkpointed durable subscription when `wake start` runs, so slow reactor or delivery work cannot delay activation scheduling. It checks every new journal fact, reconciles on startup and bounded fallback, and uses the same global scheduler lock as one-shot ticks. Rollback to `inline` is configuration-only. |
| `controlPlane.schedules` | list; default `[]` | Scheduled workflow starts. Each entry is described below. |
| `controlPlane.resident.pollBackoffMs` | positive integer; default `1000` | Exponential backoff base for intake's idle-or-erroring poll cadence and the runner's error-retry cadence — courtesy toward a rate-limited external API. Unrelated to journal consumption, which waits on a change signal instead of polling. |
| `controlPlane.resident.maxPollBackoffMs` | positive integer; optional | Ceiling for that exponential backoff (default: `pollBackoffMs * 16`). |

Each `controlPlane.schedules[]` entry requires `id`, `workflow`, `cron`, and
`objective`, all non-empty strings. `id` identifies the schedule,
`workflow` names a configured workflow, `cron` is its schedule expression, and
`objective` becomes the new scheduled work item's objective.

Schedule expressions use five whitespace-separated cron fields: minute, hour,
day-of-month, month, and day-of-week. They are evaluated in UTC. Wake supports
lists, ranges, steps, and the `JAN`-`DEC` and `SUN`-`SAT` aliases. Expressions
with a seconds field, `?`, `H`, `L`, or `#` syntax and per-schedule time-zone
configuration are not supported. When both day-of-month and day-of-week are
restricted, both must match.

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
| `with` | any YAML value; optional | Input validated by the selected Activity. For `agent`, supply exactly one of `template` or `prompt`, with optional `model` and `allowedTools`. |
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
id) and `enabled` (boolean, default `true`). Provider-owned fields are allowed
at this boundary and are validated when that provider is composed.

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
| `polling.lookbackMs` | non-negative integer; default `60000` | Overlap retained when querying since the repository's durable last-successful-poll watermark. The first poll, or one with no persisted watermark, uses the provider's bounded bootstrap query. |
| `polling.intervalMs` | positive integer; default `30000` | Minimum time between real GitHub polls. Ticks that land before this interval has elapsed since the last real poll skip the GitHub API call and return no drafts, independent of `controlPlane.resident.pollBackoffMs`, which governs the intake resident loop's own tick cadence, not any one adapter's call rate. |
| `intake` | list; default `[]` | Admission/tagging rules. With no rules, every observation is admitted with no added tags. |
| `publication.postStatusComments` | boolean; default `true` | Allows GitHub status-comment publication. |
| `publication.replies` | object; default `{ rules: [], default: primary }` | Routes agent-run reply comments. Rules are evaluated in order and the first match wins. |
| `commands` | string list; default `[]` | Additional command syntax advertised on the web UI's Configuration → Commands tab alongside the adapter's built-in commands (`/approved`, `/accepted`, `/changes`, `/retry`, `/restart`, `/extend`). Purely descriptive: Wake does not recognize these itself, so any behavior they imply must be handled by whatever reads the comment. |

Each `intake[]` rule has `where`, optional `matchMode` (`any` by default or
`all`), optional `ignoredLabels` (default `[]`), and `tags` (default `[]`). An
observation carrying any `ignoredLabels` value is discarded before Wake creates
or correlates work, regardless of whether it otherwise matches an intake rule.
`where.kind` is `issue` or
`pull-request`; `where.requiredAssignees`, `where.requiredAuthors`, and
`where.labels` are string lists, each defaulting to `[]`. Intake tags must not
use a Wake-owned marker family, so Wake cannot ingest and reroute its own
markers.

`publication.replies.rules` controls where terminal agent-run reply comments go. Each rule has a
required `target` of `primary`, `issue`, `pull-request`, or `none`; `none` suppresses the comment.
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
| `host.selfUpdate.drainTimeoutMs` | positive integer; default `30000` | Maximum wait for a controlled update drain. |
| `host.selfUpdate.cancellationTimeoutMs` | positive integer; default `30000` | Maximum wait for cancellation during controlled self-update. |

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
