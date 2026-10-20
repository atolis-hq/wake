# Workflows

Workflows are Wake's deterministic control-plane policy. They live under
`orchestration.workflows` (normally in `config.workflows.yaml`), are compiled
before use, and are persisted as durable WorkflowInstances. An agent executes
an Activity; Orchestration alone decides what that result means and what runs
next. Prompt text cannot select a runner, advance a stage, or grant provider
authority. A configured Activity may receive specific provider capabilities.

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
          rejected: { then: await-human }
          failed: { then: await-human }
          done: { then: implement }
          blocked: { then: await-human }
      implement:
        activity: agent
        with: { template: implement }
        execution: { workspace: branch, runnerPool: standard }
        on:
          rejected: { then: await-human }
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
| `with` | No | Activity input, validated against the selected Activity before the workflow compiles. For `agent`, provide exactly one of `template` or `prompt`, with optional `model` and `allowedTools` overrides and string-valued `vars` prompt input. |
| `execution.workspace` | No | `none`, `read-only`, or `branch`. It controls whether Execution acquires a workspace for this Activation. |
| `execution.runnerPool` | No | Ordered runner candidates from `execution.runnerPools`. If omitted, Execution uses `defaultRunnerPool`. |
| `requiresApproval` | No | Completion policy for ordinary `done` outcomes. The important default is explained below. |
| `on` | Yes | Non-empty mapping from Activity outcome kind to its route. Only outcomes declared by the Activity are accepted. |

For Codex CLI runners, `allowedTools` is advisory: Codex ignores the list,
and Wake does not enforce or proxy it. It is not a security boundary, including
for repository-scoped `gh` patterns. `wake doctor` emits a non-fatal notice for
each Codex runner in an agent stage's resolved pool when its effective
`allowedTools` list is non-empty. The stage input overrides template frontmatter,
including an explicit empty list. Unreadable templates produce a doctor failure
instead of a tool-list notice. An omitted stage pool uses
`execution.defaultRunnerPool`.

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
  waiting: { then: await-human }
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
  waiting: { then: await-human }
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
  waiting: { then: await-human }
  done: { then: publish-release-notes }
  blocked: { then: await-human }
```

## Outcome routes and their evaluation order

Every `on.<outcome>` route requires `then`: another stage, `done`,
`await-human`, or the resource-transition-only `wait`. Its additional fields are:

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
trusted native PR approvals, an externally merged primary PR, opted-in
failing checks, and bounded explicit conflict repair during merge waits. `then` inherits the enclosing route when omitted.

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

A `resourceTransitions` entry that routes back to the same stage is not
bounded by `repeat` — that option applies only to an ordinary route
transition, not to a resource-transition resume. If failing checks can route
back into the stage that produced them, as above, verify the target
Activity's own behavior bounds retries (for example, a repair template that
gives up after N attempts), or route to a distinct stage instead of looping.

To wait solely for a durable resource fact after an Activity completes, set the
route target to `wait`. This is not the named-signal and authority mechanism
`await`; it records a resource-transition wait without entering another stage
or requesting the Activity again. `wait` is valid only on a `done` route with
at least one `resourceTransitions` entry. Every entry must declare its own
final `then` target, which cannot be `wait`:

```yaml
merge:
  activity: pr.merge
  with:
    target: primary
    method: squash
    requireApproval: false
    requireChecks: true
    autoMerge: true
  on:
    waiting: { then: await-human }
    done:
      then: wait
      resourceTransitions:
        - events: [pr.state-changed]
          where: { state: merged }
          then: complete-issue
    blocked:
      then: await-human
      retry:
        max: 3
        reasons: [checks-could-not-be-read, checks-pending]
        delaysMs: [60000, 300000, 900000]
    failed: { then: await-human }
  requiresApproval: false
```

For the dark-factory merge stage, use the selective blocked retry policy above.
It permits three retries after the initial denial, delayed by 1, 5, and 15
minutes from the preceding outcome. Retry counts and activation `notBefore`
times are journaled and survive restart. The control plane skips dispatch until
the deadline, then evaluates current PR evidence on its next pass. Passing
checks proceed automatically; failing checks and other denials take their
configured route immediately. Exhaustion follows `then`; the last outcome
retains `checks-could-not-be-read` for unknown evidence or `checks-pending` for
pending checks. Unknown never passes required-check authority; pending remains
allowed for provider-managed `autoMerge`.

Existing `retry: { max: N }` policies still retry immediately without filtering.
Optional `reasons` selects check-denial codes, and optional `delaysMs` must have
exactly `max` positive integer delays. This policy belongs in the configured
workflow; it does not retry runners.

This is useful for native auto-merge: delivery confirmation means the provider
accepted the enablement request, not that the pull request merged. Wake stays
waiting until the matching merged-PR fact arrives, including through the
existing catch-up path for a fact observed before the wait was recorded.

Merge delivery also reconciles an already-merged primary PR as confirmed when its
observed head revision matches the intent's requested revision. GitHub reads typed
PR state before delivery and again after a failed attempt; error text is never
used as evidence. Durable merged facts can satisfy the exact activation's
`delivery-result` wait, including facts recorded before the wait starts. The
maintenance lane records `delivery.reconciled` with a confirmed result and the
normal outcome reactor resumes configured workflow routing. Missing or different
revision evidence, closed-unmerged PRs, and historical failed deliveries do not
qualify. Existing failed journal facts are never rewritten.

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

An explicit `await` can set a positive integer `timeoutMs`. Wake measures it
from the durable wait-start event and blocks the instance with
`await.timeout-exceeded` at or beyond that bound. Without `timeoutMs`, the
wait remains indefinite. Timeouts do not apply to implicit approval defaults,
activity-provided waits, watch gates, or resource-transition waits.

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
      rejected: { then: await-human }
      failed: { then: await-human }
      blocked: { then: await-human }
      done:
        then: implement
        await:
          signal: approved
          from: [human, auto]
```

Unrouted declared Activity outcomes produce non-fatal warnings when workflows
compile during configuration startup, and appear in `wake doctor` notices.
Each warning names the workflow, stage, and outcome. Routes with retry, await,
or watch gates count as configured. Add an explicit `then: await-human` route
to acknowledge an outcome that requires human intervention.

An unrouted non-`waiting` outcome is recorded and blocks the instance; warnings
do not change this fail-closed behavior. Warnings also cover `waiting`, but the
interpreter handles that outcome before route lookup, so a missing `waiting`
route does not itself block the instance. An explicit
`waiting: { then: await-human }` acknowledges that declared outcome and
silences its warning without changing the durable delivery wait behavior; the
interpreter still handles `waiting` before following any route.

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
      failed: { then: await-human }
      blocked: { then: await-human }
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
          rejected: { then: await-human }
          failed: { then: await-human }
          blocked: { then: await-human }
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
          rejected: { then: await-human }
          failed: { then: await-human }
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
          rejected: { then: await-human }
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
returns to the gated stage. A completed child with a `blocked`, `failed`, or
missing outcome is normalized to `rejected`, so the gate always resolves. A
human may satisfy that gate as an override.

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

### Recovery after a policy-blocked manual merge

A primary workflow waiting on the merge stage's `blocked: { then: await-human }`
route can recover automatically when its correlated primary PR is manually
merged. Normal tick/resident advancement checks durable PR history, including
facts recorded before the wait or before a restart. It requires a protected-path,
file-count, or unavailable-changed-files denial from that exact merge activation
on the same PR. Unrelated PRs and human waits do not release the workflow.

The destination is the single merged-PR transition on the merge stage's `done`
route in the workflow's pinned definition. Configure it to route to the completion
stage, as in the native auto-merge example above. No new declaration on `blocked`
is required; already-persisted eligible waits recover without another approval,
comment, or projection edit. Missing definitions, ambiguous PR correlations, or
missing/ambiguous merged-PR destinations fail closed.

Approving the PR or commenting does not override automatic merge restrictions;
it can only retry the same policy check. Review the correlated PR and merge it
manually when appropriate. Work details explain the applicable restriction,
matched protected paths when available, the PR link, and the next action. Once
merged, the details show recovery pending while advancement resumes completion.

After deploying this behavior, run normal `wake tick` advancement (or let the
resident loop run) against the affected Wake home. For the incident work item
`work-01m4n8r1vr4tzehgv6afeeh1be`, verify its primary workflow leaves the merge
wait, requests `complete-issue`, and completes, and confirm issue #868 closes.
Check the journal for the accepted merged-PR evidence and a single issue-completion
intent; do not edit projection files. This requires deployment access to that
Wake home and provider polling/delivery credentials.

## Independent workflow triggers

Use `controlPlane.triggers` to invoke a named workflow independently from
a canonical event and/or five-field UTC cron occurrence. Each invocation has
its own top-level WorkItem and WorkItem-local artifacts. The workflow's
activity prompts define its task; Wake derives display metadata from the
trigger ID and workflow name. Unlike parent-scoped watches, these triggers
do not create synthetic parent WorkItems. An optional
`when.capacityAvailable: true` gate skips occurrences without current
execution headroom or an eligible runner. See [configuration](configuration.md#controlplane)
for the strict schema and cron behavior.

Trigger requests received during an invocation coalesce into one pending
request. Once the active workflow ends, current eligibility is checked again.
Pause clears pending requests and skips future sources while allowing active
work to continue; resume does not reset workflow retry counters. Exhausted
automatic failures pause the originating trigger, and events from its own
invocations cannot recursively request another invocation. Starts and results
remain inspectable after the trigger definition is removed.
Blocked invocations retain their coordination slot through operator retry or
clarification; only completion or supersession releases it. Pending reasons
are bounded to 64 representative source identities. Invocation history is
stored separately from current scope state.

## Triggered delivery oversight

The [delivery oversight example](../examples/delivery-oversight/config.workflows.yaml)
uses an ordinary `agent` stage with the editable `triage-assign` prompt and
operator-supplied `vars.focus` text and a narrow `gh` command allowlist. Merge its
workflow and
[trigger/integration configuration](../examples/delivery-oversight/config.yaml)
into the Wake home, copy the prompt, configure an authenticated MCP-capable
runner in `standard`, and set intake's required assignee to the identity used
by `gh`. Keep the ordinary delivery workflow as the default; oversight is
started by its explicit named trigger, not by intake selection.

Event/UTC cron sources request evaluation; the current capacity gate, normal
runner/pause eligibility, single-flight execution, and active-run coalescing
apply. Trigger inputs contain neither task objectives nor minimum intervals.
The gate checks execution headroom without reserving a slot. Own invocation
completion events are suppressed. Cron supplies a fallback for idle systems;
cron-only configuration is useful when completion events would cause excessive
assessment frequency. Exhausted retries pause the trigger.

The triage-assign stage is the sole `memory.md` producer. A successful assessment
assigns at most one useful verified-ready issue or records a reasoned no-op.
Assignment requests delivery via normal GitHub polling/intake; it does not
create a delivery WorkItem directly or guarantee dispatch. See
[Delivery oversight prompt inputs and authority](prompts.md#delivery-oversight)
for prompt-level single-selection recovery, dependency evidence, active delivery judgment, and local/shared
artifact behavior.

While a primary workflow waits in `pr.merge`, Wake reconciles the selected
primary PR's durable state. A PR closed without merging blocks with
`merge.pr-closed-unmerged`. Explicit provider conflict evidence either uses a
single bounded repair transition in the pinned definition or blocks with
`merge.pr-conflicting`. Missing or ambiguous primary correlation and unknown
mergeability leave the wait unchanged. Merged observations retain the normal
configured completion route, including policy-denied manual-merge recovery.

Configure conflict repair on the merge stage's `done.resourceTransitions`:

```yaml
- events: [pr.state-changed]
  where: { mergeability: conflicting }
  then: revise
  retry: { max: 2 }
```

The destination must be another `agent` stage. Its prompt should rebase/revise
the existing primary PR and return through the configured review path. Every
ordinary route that closes that cycle still needs its existing `repeat.max`.
Conflict `retry.max` must be one or two; it counts repair opportunities across
the instance's lifetime and survives restarts. An ambiguous, missing, or unsafe
repair destination blocks; exhausted repair blocks with
`merge.conflict-retry-exhausted`. Wake does not invent repair stages or use a
changed current definition in place of the pinned policy.

Merge-stage hints follow the wait's actual signal and are posted to the
configured reply target when the merge stage starts waiting. A
resource-transition wait or a policy-denied manual-merge wait directs operators
to resolve and merge the PR in the provider and advertises no commands. A
default `approved` wait at the merge stage advertises only `/approved` for
authorized independent reviewers. Waits gated by a watch keep the generic
agent-review hint. Those commands retain their eligibility rules for agent
review and conversation stages.

## Delegated delivery controls

A named workflow can opt into independent child WorkItems:

~~~yaml
delegation:
  workflows: [investigation-child, implementation-child]
  maxDepth: 2
  maxDescendants: 8
  maxConcurrentRuns: 2
~~~

Omission disables agent delegation. The Run-scoped tools
wake_delegation_submit and wake_delegation_inspect submit and inspect work
through the current agent Run.

When a required child fails, is cancelled, exhausts its retries, consumes a
changed input or asks for assignment clarification while siblings are still
running, Wake resumes the delegating stage once with an attention activation
(the same activity, with a fresh session). `wake_delegation_inspect` returns
`attention`: the revision and the coalesced blockers, each with a blockerId and
kind (`failed` or `assignment-context`). End the activity normally to leave
the cohort waiting; attention never satisfies the join and does not reset the
root or workflow limits. Use `wake_delegation_respond` with childWorkItemId,
blockerId, expectedRevision and exact accepted artifact revisions to answer an
`assignment-context` blocker; only that child resumes. Terminal failures need
replacement work in a new cohort, and review, consent or approval gates cannot
be answered through this channel. To hand human questions over, batch them all
into one structured `blocked` or needs-clarification result: Wake publishes it to a
human through the ordinary route while the cohort stays tracked, so independent
children keep running and nothing is cancelled or joined early. A human reply on the
parent issue is delivered to each child still blocked on that question and resumes it
through the ordinary reply path. A deliberate `FAILED` result is escalated the same way.
A failed run of the assessment itself (runner failure, authentication, ambiguous or
invalid result, unverified completion) never touches the cohort and is re-raised up to
three times; after the third an operator diagnostic asks for inspection. Wake refuses
wake_delegation_submit while an assessment is open (`attention-open`); submit
replacement work once the cohort settles and the stage is resumed.
Wake adds the blockers to the activation's prompt. Each blocker is assessed once, and a delegating
activity that is not an agent records one operator diagnostic instead. Submission accepts a stable cohortId and
assignments with assignmentId, objective, criteria, workflowName, exact
artifact context references and named outputs (name and path). Wake pins each
current workflow definition. Caller, Run, activation and reservation limits
are server-owned; agents cannot supply them.

Optional repositoryResourceIds narrow the invoking assignment's permitted scope;
for a root this scope comes from correlated Repository Resources. When a root has none,
its first delegation request (or `wake_delegation_inspect`) binds the repository the
provider observed its primary Issue in: Wake finds or creates that Repository Resource
and correlates it to the root as `secondary` with `provider-observed` provenance.
A Repository Resource already correlated to the root through the Resources port
suppresses that default. There is no operator command to correlate additional
repositories yet; `wake correlate` records a primary correlation and is not suitable. `wake_delegation_inspect` lists the Repository Resource IDs an explicit
selection may name. Agent arguments and issue prose never establish repository
authority, and only Issue roots from a provider with a repository identity (GitHub)
are bound. Omission
inherits the validated scope, persisted on the child reservation for nested
requests. An explicit repository.resourceId must belong to that scope. Omitting
repository selects no checkout and links none; the permitted set never selects
a checkout target.
Workflow-level delegation.repositories, on both the parent and the root, when
present, narrows the permitted set further. It never grants every configured
repository. Artifact-only work needs no repository. Child workflows need their own policy only if they delegate again.
Nested workflow choices must also be permitted by the root policy. This
capability does not grant operator consent or independent review authority.

After submission, the agent finishes its current activity with its ordinary
outcome. Wake holds the parent until every required child produces its named
accepted artifacts and the submitting Run ends, then starts a fresh continuation.
Depth and descendant reservations serialize on the root workflow stream;
the first reservation fixes the root limits across recovery.

A delivery root occupies one open-work slot while required workflows remain
live. Every actual Run, including watch/review Runs, consumes global and root
Run capacity. Waiting parents consume no Run slot. Frozen or cancelled ancestry
blocks new reservations, dispatch and continuation, including late outcomes.
Trigger descendants suppress their root's self-source events without inheriting
named shared context or operator instructions. Work detail shows delivery
parent/root links, child workflows, status, resources and blockers; existing
freeze controls stop dispatch for the selected subtree.

### Named child outputs

An assignment may mix artifact outputs (name and path) with several change outputs
(name and kind: change). Every output is required unless required: false is explicit.
A workflow may declare an outputs map keyed by name, with kind: artifact or change
and optional required (default true). Assignments must include each configured required
output with the same kind, and may strengthen optional requirements.

For multiple change outputs, Wake leases a separate branch workspace per name and
includes every path, branch and source revision in the agent prompt. An output may
supply repository with resourceId, sourceRef, optional sourceRevision and pullRequestBase
to choose its own pinned source and logical base within the assignment repository.
Otherwise it inherits the assignment repository pin. Reports use reportedArtifacts
entries with name, kind: pull-request and externalKey (or a named PR URL in a
wake-artifacts fence). Wake verifies each PR against its own recorded workspace HEAD,
branch, repository and base; a claim alone cannot register another branch's PR.
Review and checks apply to each explicit Resource. Missing or stale evidence for one
required output prevents qualification without affecting another output's prerequisites.
Ordinary single-output assignments retain their existing branch and report behavior.

### Parent QA and bounded repair

After the delegating stage resumes with joined results, the parent agent assesses and
verifies the combined work with three Run-bound tools; `wake_delegation_inspect` returns the
state as `delivery` (selection revision, required outputs, stale results, current candidate,
QA verdict, repair state and completion). Configure `delegation.qa.stage` to name a
read-only agent stage and optionally `delegation.qa.recipe` for its environment/test recipe.
The coordinating stage selects and records the candidate before routing to that QA stage.
The QA stage cannot select its own candidate or submit child work. Its Run always starts a
fresh session. Wake acquires every authorized repository checkout in repository-ID order,
checks exact revisions, and releases all acquired leases if any checkout or environment
preparation fails. The prompt includes criteria, contributing output/context revisions,
recipe, and repository paths. Workspace prepare hooks apply to each checkout.

- `wake_delivery_select` records the complete current selection: for every required output of every
  original assignment, the child output that covers it. A replacement names the output it
  replaces. Omitting a requirement, selecting an unqualified output or replacing something
  other than the current choice is rejected, and `expectedRevision` must be the current
  `selectionRevision`.
- `wake_delivery_candidate` records the exact combined candidate: one entry per repository
  with selected changes. Use `{ kind: "output", tip }` for a single change or an intentional
  stack (list the other members in `includes`), or `{ kind: "retained-ref", ref, revision,
  contributions }` for a commit the agent assembled. Retained refs live under
  `refs/wake/delivery/<root WorkItem>/<candidateId>/` and are retained, never deleted. Wake
  fetches the commit from the authorized repository before recording, during QA preparation,
  and before a pass. Retained refs must still resolve to the recorded commit during execution
  preparation; deleting the assembly workspace does not affect reconstruction.
- `wake_delivery_qa` records `pass`, `fail` (with findings) or `blocked` for a candidate. The
  revisions named must equal the candidate's repository set exactly. An unavailable
  environment must be `blocked`, and a pass must follow the configured `recipe`. Only the
  configured QA activation's active Run, durably prepared for that candidate and exact
  revision set, may record the verdict; the coordinating Run cannot approve its own work.

Repair uses a new child: submit an assignment with `replaces: { cohortId, assignmentId }`
naming the original. It must keep every original criterion, repository and output; if the
original change is unmerged it must start from that contribution and keep the original
pull request base. Only a completed or superseded child can be replaced; correcting a running
child is not supported (`replacement-unsupported`). New children count against the same root
`maxDescendants` and workflow repeat/retry limits. When a failing QA verdict is recorded with
no root-wide descendant capacity or no configured QA failure-repeat capacity left, it is
marked `exhausted` and the findings stay visible for a
human. A replaced output makes its consumers stale until they are replaced too.

`delegation.completion` is optional: `qa-approved` (default) lets the parent finish once the
current candidate has a passing QA verdict without any merge; `merge-required` keeps the
parent incomplete until every selected change is provider-observed merged at its selected revision. These configured final gates apply to all
completion paths, including accepted signals and resource transitions: missing, failing,
blocked, historical-only or stale QA cannot complete the parent. Previously configured
direct workflows without `delegation.qa` or explicit `delegation.completion` keep their
existing routes. Work detail API and web views show candidate revisions, staleness, QA
findings, exhaustion and the completion blocker. A final delivery gate block is eligible for
operator retry: it starts the latest cohort's recorded delegating stage in a fresh activation,
retaining the selection, QA history and existing workflow/root budgets. The agent can repair the candidate
or rerun QA once the environment is available. Completion source checks distinguish a missing
or moved ref from an operational fetch failure; a transport failure preserves the QA verdict
and holds completion until the source can be verified again.

### Queued prerequisites and Git stacks

Assignments may declare `prerequisites`. Each entry selects an `assignmentId`,
its named `output`, and a `condition`. Omit `cohortId` for another assignment in
the submitted batch, or name an earlier cohort in the same delivery for
incremental work. These declarations do not edit earlier assignments. Inspection
returns `planRevision`; pass it as `expectedPlanRevision` to reject a submission
based on an outdated plan. Replaying the same committed cohort returns its
original child identities and pins.

The conditions are:

- `accepted-output`: an exact accepted named artifact, usable before the
  upstream workflow completes. Cross-repository handoffs use this condition.
- `pushed-change`: a named PR with provider-verified repository, branch, head,
  logical base and original child ownership. Review and checks are not required
  by this condition; the upstream's own output requirements still govern its
  eventual delivery-ready result.
- `delivery-ready`: successful configured workflow completion and the named
  output's acceptance, including required review/check authority for changes.
- `merged-change`: actual provider-observed merge at the verified upstream
  head. Issue closure and workflow completion never substitute for merge.

For example, an assignment can declare:

```yaml
prerequisites:
  - assignmentId: api
    output: change
    condition: pushed-change
    useAsBase: true
  - assignmentId: contract
    output: schema
    condition: accepted-output
```

`useAsBase` selects at most one same-repository change. Before starting the
child, Wake verifies the pushed source and records its repository, branch and
commit; the child PR's logical base is that upstream branch. Agents create and
maintain the PRs and perform all Git operations. Cross-repository Git bases are
rejected; cross-repository contracts use selected accepted artifact revisions.

Independent children start while dependencies remain queued. Selected inputs are
immutable journal receipts; accepted artifact inputs receive explicit read-only
grants. Inspection exposes `consumedInputs`, `prerequisiteBlocker` and a terminal
cohort's `failureReason`; work detail displays each child's blocker.

Readiness is checked after restart, before dispatch, when accepting outcomes and
before joining. A changed consumed output or upstream head makes affected
assignments ineligible. Failed upstream children and their dependents retain
durable blockers while unrelated siblings finish. Once that work finishes and
the reserving Run ends, Wake records a terminal failed cohort and resumes the
parent stage for assessment, without reporting a successful join. Unfinished
affected workflows are superseded; late Run outcomes cannot qualify them.
Batches without prerequisites retain their existing terminal-failure behavior.
Transient verification failures remain retryable and use bounded diagnostics.

The parent agent inspects the failure and explicitly submits replacement work
under a new cohort and assignment identity, using the current plan revision.
Normal Run authority, workflow/repository policy and delivery limits still
apply. Replacement assignments pin current verified inputs and require fresh
outputs; old receipts, results and grants remain in the journal. Wake never
chooses a rebase, replacement stack or semantic repair. Attention while
independent work is still running is outside this slice.

Successful joins are historical consumption boundaries, not permanent holds on
the parent's later merge phase. Agents can merge a joined stack bottom-up and
delete its branches. Reuse of an upstream output by new work still verifies its
current evidence. Only the upstream head and selected branch matter to the
consumed Git base; unrelated movement of that PR's own target branch does not
invalidate downstream evidence. A provider-confirmed merge at the consumed head
preserves an existing receipt even if the source branch is deleted.

Self-dependencies, missing targets/outputs, explicit cycles and implicit join
cycles are rejected with typed conflicts. A child cannot await its ancestor's
future result; previously accepted ancestor context remains usable through
`context`. A merge prerequisite cannot wait on a child whose parent must first
join the same cohort to perform that merge. Use an upstream workflow with its
own configured `pr.merge` lane, or consume already merged work incrementally.

### Governed child integration and stack maintenance

A merge-required parent uses `pr.approve` or `pr.merge` with
`scope: { delivery: next }`. If a child contributes several selected PRs, name the
exact target with `scope: { delivery: next, output: { childWorkItemId: "work-…", outputName: "api" } }`;
omitting it is rejected as ambiguous. The childWorkItemId may be omitted when outputName
resolves uniquely across the selection, so a configured stage can name a stable output key. Wake derives the next target from the current selected outputs,
current passing candidate QA, repository and stack ordering. The activity outcome stays on the
parent; the terminal child's workflow and PR primary ownership stay intact. Direct PR activities
keep their primary-resource selection. A scoped action cannot name an arbitrary foreign PR.
The target's consent, exact revision, review/check requirements and unavailable ancestors still
apply. `integrated` means all selected changes have merged; route it to the final stage.
A blocked merge can route to an agent maintenance stage, then back to candidate assembly and QA.

Configure `delegation.maintenance.stage` to name an agent stage with workspace `none`.
Wake supplies leased target branch workspaces in the prompt. The agent chooses the retarget,
rebase or conflict repair and publishes it, then calls `wake_delivery_maintenance` with a unique
maintenanceId, target (childWorkItemId/outputName), kind (rebase, retarget or resolve-conflicts),
expectedRevision, resulting revision and pullRequestBase. The provider must confirm the exact
repository, branch, head and base; the reporting Run must hold the prepared target lease.
An unresolved earlier writer blocks another writer until reconciled.

Maintenance records a new immutable subject and the actual producing Run. Earlier output, review,
check and QA facts remain historical. Affected candidate evidence must be refreshed before another
merge; unrelated outputs keep their evidence. Planned merges do not consume failed QA rounds.
A base matching the provider-reported merge commit of a selected sibling is planned progress,
including squash, merge and rebase integration. It still requires agent maintenance and fresh
evidence for the changed base subject. A different base is unrelated movement; a merged sibling
by itself never proves progress. Squash merges and stack retargets require explicit maintenance and refreshed QA.
Existing durable delivery intents/results retain partial progress across restart; integration
across repositories does not provide atomic rollback. Work detail API/web expose target states,
maintenance reasons, affected evidence and maintenance history.

Maintained PRs with required checks need provider execution evidence for the exact head/base
subject, with every reported check or status started after the new maintenance subject was recorded. A retained
`passing` value, re-polling an older execution, missing timestamps or incomplete provider evidence
cannot satisfy this gate. Check evidence is journaled even when the aggregate state remains
`passing`, and the same subject and execution-time rules apply after restart.

GitHub joins head-SHA checks to successful Actions `pull_request` runs by check suite.
Linked PR metadata is mutable and is not execution provenance. For each successful job,
Wake reads the full checkout commit from its Actions log and verifies that commit's
ordered parents against the selected base and head. Skipped and neutral jobs retain their
normal passing semantics. Missing, ambiguous, expired or unreadable checkout evidence
cannot qualify. The current PR test-merge SHA is not used, so lazy recomputation cannot
block base-only maintenance followed by a qualifying execution. Completed job logs and
Git objects are cached; mutable workflow-run attempts are conditionally revalidated.

### Delivery inspection and reporting

Work detail for a delegated delivery shows, from journal-derived facts, every cohort and
whether its join has settled (with a terminal failure reason), the open parent attention
assessment (which child blockers it covers and whether a reply was accepted), and for each
child: workflow and current stage, repository and pull request base, declared prerequisites
as links (with the waiting reason only while one is actually blocking), the original assignment
a corrective child replaces, status and block reason, and each named output with its
required, selected and stale state and its own repository and base when it declares one. Candidate QA lists stale selected outputs with the reason
(they were built on an output that has since been replaced), together with partial integration
progress and maintenance history. Nothing is stored for the view; it is identical after restart
or projection rebuild, and original ownership, historical joins and descriptive links are not
reinterpreted.

The `delivery-activity` report and the `acceptedChildResults` / `correctiveActivations` summary
fields keep three populations separate; see [analytics](analytics-api.md). A delegated child's
primary completion is a child result and never a delivered root.
