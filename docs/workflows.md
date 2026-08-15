# Workflows

Workflows are Wake's deterministic control-plane policy. They live under
`orchestration.workflows` (normally in `config.workflows.yaml`), are compiled
before use, and are persisted as durable WorkflowInstances. An agent executes
an Activity; Orchestration alone decides what that result means and what runs
next. Prompt text cannot select a runner, advance a stage, or change provider
state.

Use this page with [Configuration](configuration.md) and
[Agent prompt templates](prompts.md) to author a complete configuration.

## A minimal, safe workflow

```yaml
workflows:
  default:
    entry: refine
    stages:
      refine:
        activity: agent
        with: { template: refine }
        execution: { workspace: read-only, runnerPool: light }
        requiresApproval: false
        on:
          done: { then: implement }
          blocked: { then: await-human }
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          done: { then: done }
          blocked: { then: await-human }
          failed: { then: implement, retry: { max: 2 } }
```

Every workflow has a non-empty `stages` map. `entry` is optional; if omitted,
Wake uses the first declared stage. Stage names cannot be `done` or
`await-human`. The compiler validates that the entry can reach completion,
every route names a real stage or terminal target, every referenced Activity
and its input are valid, and every graph cycle is bounded.

`done` completes the WorkflowInstance. `await-human` is a terminal route
shorthand that waits for a signal whose name is the current outcome kind.

## Stages: work, input, and execution policy

Each stage says what to run and how to run it.

| Field | Required | Meaning |
| --- | --- | --- |
| `activity` | Yes | A registered Activity name. The built-in `agent` Activity invokes a local agent runner; PR activities provide deterministic review/merge operations. |
| `with` | No | Activity input, validated against the selected Activity before the workflow compiles. For `agent`, provide exactly one of `template` or `prompt`, with optional `model` and `allowedTools` overrides. |
| `execution.workspace` | No | `none`, `read-only`, or `branch`. It controls whether Execution acquires a workspace for this Activation. |
| `execution.runnerPool` | No | Ordered runner candidates from `execution.runnerPools`. If omitted, Execution uses `defaultRunnerPool`. |
| `requiresApproval` | No | Completion policy for ordinary `done` outcomes. The important default is explained below. |
| `on` | Yes | Non-empty mapping from Activity outcome kind to its route. Only outcomes declared by the Activity are accepted. |

`execution` is routing policy, not agent input. Keep stable operational choices
(workspace isolation and runner capability) in the stage; put task-specific
instructions in a prompt template.

### Built-in deterministic PR activities

`pr.approve` and `pr.merge` are registered Activities for provider-backed pull
request decisions. They are deterministic: they evaluate durable resource,
revision, review, check, and change-policy facts before asking an Integration
to deliver the provider action. They do not invoke an agent runner.

Both take `target`, either `primary` (the default) or
`{ resourceId: "..." }`. The selected target must resolve to exactly one
pull-request resource correlated as primary to the WorkItem; a missing or
ambiguous target blocks the Activity rather than guessing.

`pr.approve` takes an optional `body`:

```yaml
activity: pr.approve
with:
  target: primary
  body: "Approved after deterministic validation."
on:
  done: { then: done }
  blocked: { then: await-human }
  failed: { then: await-human }
```

`pr.merge` requires `method` (`merge`, `squash`, or `rebase`) and
`requireChecks`. It also accepts the following guardrails:

| Field | Default | Meaning |
| --- | --- | --- |
| `requireApproval` | `true` | Requires a current accepted review for the PR revision. It may be `false` only when `autoMerge` is `true`. |
| `autoMerge` | `false` | Requests native provider auto-merge. Pending checks are permitted; unknown or failing checks are not. |
| `maxFilesChanged` | unset | Blocks when the provider reports more changed files than this positive limit. |
| `blockedPaths` | `[]` | Blocks when a changed path exactly equals one of these protected paths. |

```yaml
activity: pr.merge
with:
  target: primary
  method: squash
  requireChecks: true
  requireApproval: true
  maxFilesChanged: 20
  blockedPaths: [".github/workflows/release.yml", "infra/production.yml"]
on:
  done: { then: done }
  blocked: { then: await-human }
  failed: { then: await-human }
```

Both Activities first return `waiting` after recording a durable delivery
intent. Orchestration treats that as a durable wait for the delivery result,
rather than following an ordinary `on.waiting` route. The resolved outcome is
`done` after provider delivery is confirmed, `blocked` when deterministic
authority checks fail, or `failed` when Wake cannot durably record the intent.
Route those resolved outcomes explicitly.

### Completing a linked issue

`issue.complete` is an opt-in deterministic Activity for the WorkItem's primary
issue Resource. Its only input is `target: primary` (the default). It records
an idempotent delivery request and waits for confirmation; GitHub closes the
issue. It returns `blocked` when the primary resource is not an issue or does
not advertise the `completable` capability. Place it at any stage: a confirmed
completion does not end the workflow, so later configured stages still run.

```yaml
activity: issue.complete
with: { target: primary }
on:
  done: { then: publish-release-notes }
  blocked: { then: await-human }
```

## Outcome routes and their evaluation order

Every `on.<outcome>` route requires `then`: another stage, `done`, or
`await-human`. Its additional fields are:

| Field | Use |
| --- | --- |
| `activities` | Serial follow-on Activities to run before the route continues. Each is `{ use, with? }`. |
| `repeat` | `{ max: positive integer }`; bounds traversals of this route when it changes stage. |
| `retry` | `{ max: positive integer }`; retries the current stage for this outcome. |
| `await` | `{ signal, from }`; waits for a named signal from declared authorities before `then`. |
| `watchGates` | One named watch, optionally with `onReject: { then }`; waits for a child-workflow verdict. |
| `resourceTransitions` | On `done` only, primary-PR facts that may advance the route instead of its watch gate. |

Wake first records every non-waiting Activity outcome. If the stage does not
declare a route for it, the instance blocks with `unconfigured outcome <kind>`;
Wake never guesses a transition. Design a route for every outcome that should
be recoverable.

For `done`, Wake first drains queued supplemental commands, then runs route
`activities` in order, then applies the route policy. Follow-on Activities are
separate Activations and do not inherit the stage's workspace or runner-pool
settings. A follow-on outcome other than `done` blocks the instance.

For another outcome, Wake retries only when the route has `retry` capacity and
the Activity did not mark the outcome as requiring reconciliation. Otherwise
it applies the route directly.

`done` routes may additionally declare `resourceTransitions`. They are an OR
alternative to the configured single `watchGates` verdict and only support
trusted native PR approvals, an externally merged primary PR, and opted-in
failing checks. `then` inherits the enclosing route when omitted.

```yaml
on:
  done:
    then: merge
    watchGates: [pr-review]
    resourceTransitions:
      - events: [pr.review-accepted]
      - events: [pr.state-changed]
        where: { state: merged }
        then: done
      - events: [pr.checks-changed]
        where: { checks: failing }
        then: implement
```

Wake processes `resourceTransitions` through two durable reactor paths. A
matching resource fact observed while the route is waiting is evaluated as it
arrives. When `orchestration.signal-wait-started` is recorded, the reactor also
asks for a durable-fact catch-up, so an eligible fact that predates the wait
can satisfy it. The subject is the WorkItem's correlated primary resource;
missing or ambiguous primary subjects fail closed. An approval must be a
trusted provider review for the current revision; issue-comment commands do
not satisfy it.

```yaml
on:
  done:
    activities:
      - use: pr.merge
        with: { method: squash }
    then: done
  failed:
    then: implement
    retry: { max: 2 }
```

## Approval and signals

An ordinary `done` route waits for a human `approved` signal by default. This
is true when it declares neither `await` nor `watchGates`. Set
`requiresApproval: false` to opt a stage into immediate advancement after
`done`; use it deliberately for deterministic or low-risk stages.

Use `await` to make the policy explicit or to wait for a different signal.
`from` is an authority policy, not a provider identity:

- `human` accepts a provider-relayed authorized human decision.
- `auto` accepts only a deterministic automatic decision and only when the
  WorkItem has durable operator consent; an integration event alone never
  grants automatic authority.
- `{ kind: watch, id: review }` accepts the verdict from that named watch.

Accepted signals must match the current signal name, resource, and revision;
they are idempotent by provider-event identity. A rejected signal normally
restarts the current stage. A watch gate can instead declare `onReject.then`
to route to a correction stage.

```yaml
stages:
  plan:
    activity: agent
    with: { template: refine }
    execution: { workspace: read-only, runnerPool: light }
    on:
      done:
        then: implement
        await:
          signal: approved
          from: [human, auto]
```

## Retry, repeat, and loop safety

`retry` runs the current stage's primary Activity again. Its counter is scoped
to `<stage>:<outcome>`, so it is appropriate for an explicitly tolerated,
transient failure. It must not be used to repeat an outcome that requires
external reconciliation.

`repeat` bounds a particular route as it transitions to another stage. Use it
for intentional review/revision loops. Once `max` is exceeded, Wake blocks the
instance rather than cycling forever. The compiler rejects an unbounded cycle.

```yaml
stages:
  review:
    activity: agent
    with: { template: review }
    on:
      rejected:
        then: implement
        repeat: { max: 3 }
      done: { then: done }
```

## Workflow selection

`orchestration.workflowSelectors` selects a workflow once for a newly admitted
resource; the selected workflow is then durable instance state. Rules are
evaluated in declared order, with `orchestration.default` used if none match.

Each selector has a `workflow`, one or more `match` facets, and optional
`matchMode`:

- `match.tags`, `match.kind`, and `match.adapter` accept one value or a list.
- `matchMode: any` is the default; `all` requires every declared facet to
  match.
- The selector's workflow and the default must name configured workflows.

```yaml
orchestration:
  workflowSelectors:
    - workflow: approval
      match: { tags: [approval], kind: issue, adapter: github }
      matchMode: all
  default: default
```

Integration intake rules add the tags that selectors inspect. Configure intake
first, then select workflows from those provider-neutral tags rather than from
agent prompt text.

## Supplemental commands

`commands` attaches authorized slash commands to one workflow. A command is
not a stage transition: it queues a supplemental Activity while the instance
is active and has a pending Activation. When the current Activity completes,
the queued supplemental work runs before the normal stage continues.

```yaml
workflows:
  default:
    commands:
      /summarize:
        activity: agent
        with: { template: summarize }
        allowedActors: [human]
```

Command keys must match `/[a-z][a-z0-9-]*`. `allowedActors` is authority
policy: `human`, `auto`, or `watch`. An integration carrying a human's command
is treated as human authority; automatic authority is never inferred from the
transport. A supplemental Activity that returns anything other than `done`
blocks the workflow, so use a dedicated template that can reliably complete or
ask to be retried through the normal workflow policy.

## Watches and watch gates

A watch starts a child workflow in the same WorkItem and orchestration group
when its parent is at a selected stage/status and an event or schedule fires.
Use it for asynchronous review, monitoring, or a bounded second opinion—not
as a replacement for a stage whose work must happen synchronously.

```yaml
workflows:
  default:
    stages:
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          done:
            then: done
            watchGates:
              - pr-review
    watches:
      - id: pr-review
        while:
          stages: [implement]
          statuses: [waiting]
        on: { events: [orchestration.signal-wait-started] }
        workflow: review
        maxPerGroup: 1
```

Use `orchestration.signal-wait-started` as the trigger whenever a watch's
`while.statuses` includes `waiting` and the watch exists to gate a
`watchGates` wait — that event is written atomically with the state
transition it represents, so the watch can never observe a stage/status
match that hasn't actually happened yet. Reserve a raw domain fact (like
`execution.run-succeeded` or `pr.checks-changed`) for a watch whose
`while.statuses` includes `active` and that is reacting to something
genuinely external to this instance's own advancement — see the failing-CI
example below, which watches `pr.checks-changed` while the stage is still
`active`, not waiting on a gate at all.

### Repair a newly failing CI check

This pattern starts a bounded, branch-based repair workflow when Wake observes
a `pr.checks-changed` event whose checks are `failing` while the parent
implementation stage is active:

```yaml
workflows:
  default:
    stages:
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          done: { then: done }
          blocked: { then: await-human }
    watches:
      - id: repair-failing-ci
        while:
          stages: [implement]
          statuses: [active]
        on: { events: [pr.checks-changed] }
        where: { checks: failing }
        workflow: ci-fix
        maxPerGroup: 1

  ci-fix:
    stages:
      repair:
        activity: agent
        with: { template: ci-fix }
        execution: { workspace: branch, runnerPool: standard }
        requiresApproval: false
        on:
          done: { then: done }
          blocked: { then: await-human }
          failed: { then: await-human }
```

`pr.checks-changed` is emitted only when Wake observes a changed check state.
With `where: { checks: failing }`, this watch starts only for that observed
change to failing; it does not trigger from arbitrary event data or CI logs.
The dedicated `ci-fix` template receives the current pull request's bounded
check-run and status diagnostics in its untrusted structured context, so it
can target the repair without treating provider data as instructions. Keep
`maxPerGroup` small to prevent repeated CI updates from starting unbounded
repair runs.

A watch has:

| Field | Meaning |
| --- | --- |
| `id` | Unique identity used by `watchGates` and watch-based approval authority. |
| `while.stages` | Non-empty parent-stage list where the watch is eligible. |
| `while.statuses` | Non-empty list drawn from `active`, `waiting`, and `blocked`. |
| `on.events` | Optional non-empty list of canonical event-name strings. |
| `where` | Optional failure-only predicate: `{ checks: failing }`, valid only when `on.events` contains only `pr.checks-changed`. |
| `schedule.cron` | Optional cron trigger. At least one of `on` or `schedule` is required. |
| `workflow` | Existing workflow to start as the child. |
| `maxPerGroup` | Positive upper bound on child starts for the group and this watch. |

The watch reactor checkpoints its journal position, so event-triggered watches
survive process restart. It gives every child deterministic parent, watch,
trigger, and causal-cycle provenance. A repeated causal trigger is rejected
and blocks the parent instead of recursively spawning children. `maxPerGroup`
is an additional durable circuit breaker.

A route may declare exactly one `watchGates` entry. On its `done` outcome,
Wake waits for the named child workflow's verdict; a `done` verdict follows
the route's `then`, while a `rejected` verdict follows `onReject.then` or
returns to the gated stage. A human may satisfy that gate as an override.

## Authoring checklist

1. Define every named runner and pool in `config.yaml`; keep a safe `fake`
   pool for deterministic local verification.
2. Define one prompt for every `agent` template reference and keep execution
   routing out of prompt text.
3. Give each stage an Activity, validated input, workspace mode, and runner
   pool appropriate to its actual work.
4. Declare routes for all expected Activity outcomes; do not rely on an
   unconfigured outcome to mean "blocked".
5. Choose approval intentionally: accept the default human gate, make an
   explicit `await`, use a watch gate, or set `requiresApproval: false`.
6. Bound every retry and workflow loop; use retries only for safe outcomes.
7. Use selectors over provider-neutral intake tags and set a valid fallback.
8. Give every watch a narrow stage/status trigger and a small `maxPerGroup`.

The exact machine-validated schema is in
`src/orchestration/contracts/config.ts`.
