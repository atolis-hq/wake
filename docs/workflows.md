?# Workflows

Wake workflows define the stages a work item moves through and which prompt file is
used to run each stage. They are deterministic control-plane configuration:
Wake chooses the stage, workspace mode, and runner route; the agent only
executes the selected action and reports a result.

## Where workflows live

Workflows are configured in the `workflows` section of Wake config —
`config.workflows.yaml` at the root of the Wake home `--wake-root` (or the
current directory, by default) resolves to. All config uses `schemaVersion: 1`.

If no workflow is configured, Wake uses this built-in default:

```yaml
workflows:
  default:
    stages:
      refine:
        action: refine
        workspace: read-only
        runnerPool: light
        onDone: implement
      implement:
        action: implement
        workspace: branch
        runnerPool: standard
        onDone: done
```

That means queued work first runs the `refine` action with a read-only
workspace. When the agent reports `DONE`, Wake moves the work item to
`implement`. When `implement` reports `DONE`, Wake moves the work item to
`done`.

## Workflow fields

A workflow has an optional `entryStage` and a required `stages` object:

```yaml
workflows:
  bugfix:
    entryStage: triage
    stages:
      triage:
        action: refine
        workspace: read-only
        runnerPool: light
        onDone: patch
      patch:
        action: implement
        workspace: branch
        runnerPool: standard
        onDone: verify
      verify:
        action: verify
        workspace: branch
        runner: codex-flagship
        onDone: done
```

`entryStage` is the first configured stage to run after the universal `queue`
stage. If omitted, Wake uses the first key in `stages`.

`stages` contains the runnable stages for the workflow. Do not define `queue`
or `done` here; they are universal implicit stages.

Each stage has:

- `workspace`: one of `none`, `read-only`, or `branch`.
- `onDone`: the next stage name, or `done`.
- `action`: optional prompt-template name. If omitted, Wake uses the stage name
  as the action.
- `runnerPool`: optional runner runnerPool to route this stage through.
- `runner`: optional concrete runner name. A runner pin takes precedence over a
  runnerPool.

Wake validates the workflow at config load. It rejects empty workflows,
`entryStage: "queue"`, unknown `entryStage` values, transitions to unknown
stages, transitions back to `queue`, and workflows whose entry stage cannot
reach `done`.

## Prompt files

A stage's `action` is the prompt-template name. If a stage omits `action`,
Wake looks for a prompt named after the stage.

See [Prompt Templates](prompts.md) for prompt template location, frontmatter, and
Handlebars context details.

For example:

```yaml
stages:
  verify:
    action: verify
    workspace: branch
    onDone: done
```

requires a `verify` prompt template under `paths.promptsRoot`, normally
`<wakeRoot>/prompts`:

```text
prompts/verify.md
```

## How Wake determines the workflow

Wake stores work item state in an issue projection. The workflow name is
determined from that projection:

1. If `projection.context.workflow` is a string, Wake uses that workflow name.
2. Otherwise, when `workflowSelectors` is configured, Wake selects the first
   matching workflow when the item first qualifies for intake and records a
   `wake.workflow.selected` event.
3. Otherwise, Wake uses the first workflow configured in `config.workflows`.

Selectors match source-level facts, so the same config can classify issues, PRs,
or future event sources:

```yaml
workflowSelectors:
  - workflow: bug
    match:
      kind: issue
      repo: atolis-hq/wake
      requiredLabels: [bug]
      ignoredLabels: [wontfix]
  - workflow: pr-review
    match:
      kind: pr
      requiredAuthors: [trusted-human]
```

Wake then looks up that workflow in config. If the named workflow no longer
exists, or if the work item's current stage is not known to that workflow, Wake
does not guess a replacement. It blocks the work item with the
`workflow-changed` reason so a human can choose how to repair or requeue it.

Workflow selection is therefore a durable property of the work item once stored
in projection context. Changing labels or reordering config does not safely
move already-pinned in-flight items to a different workflow.

## How Wake chooses the next action

Wake treats `queue` and `done` as universal stages around every configured
workflow:

- `queue` dispatches the workflow entry stage.
- Configured stages dispatch their `action`.
- `done` is terminal and dispatches nothing.

For a queued work item, Wake runs the workflow entry stage. For any other known
stage, Wake reads that stage definition and dispatches:

- the resolved action name,
- the requested workspace mode,
- the stage's runner routing hints.

When a runner reports `DONE`, Wake follows the stage's `onDone` transition —
unless the stage is configured with `skipApproval: false`, in which case Wake
holds the transition for human approval instead of advancing immediately. If
the runner reports `BLOCKED`, `FAILED`, or `REJECTED`, Wake does not take the
`onDone` transition automatically.

## Operator retry for a failed stage

When a primary workflow is blocked because its current ordinary stage produced
an unconfigured `failed` outcome, the work-detail UI offers **Retry**. The
command creates a new activation using that stage's existing compiled activity,
input, and execution configuration; it does not alter the failed activation or
its Run. Wake displays the control only when this recovery is currently safe.

This is fixed-parameter recovery, not a way to retry an arbitrary Run. Changing
the action, input, runner, model, timeout, or other execution parameters remains
routing policy owned by workflow configuration.

## Stage watchers

A stage can attach watcher workflows that run while the parent work item is in a
specific status. For example, an implementation stage can dispatch an
independent `pr-review` workflow while it is `awaiting-approval`:

```yaml
workflows:
  default:
    stages:
      implement:
        action: implement
        workspace: branch
        onDone: done
        watch:
          - while: { status: [awaiting-approval] }
            on: { event: [wake.run.completed] }
            schedule: { cron: "*/10 * * * *" }
            workflow: pr-review
            onSuccess:
              merge:
                approve: true
                autoMerge: true
                maxFilesChanged: 10
                blockedPaths:
                  - src/core/contracts.ts
                  - docker/*
                blockedLabels:
                  - security
```

A watcher's `onSuccess` block declares what Wake does when the child workflow
run completes `DONE` or `REJECTED` — the sentinel is the child's verdict, so a
`BLOCKED` or `FAILED` child (the reviewer couldn't render a verdict at all)
never triggers it.

`onSuccess.approve: true` lets the child workflow approve the watched parent
stage directly. When the child completes `DONE` and no correlated PR carries
the verdict (for example a `plan-review` workflow reviewing a refine plan on
the issue thread), Wake resolves the parent's pending approval through the
same transition a human `/approved` comment takes: the child's review body is
posted to the issue, an approval run-completed event with reason
`watcher:approved` is appended, an `approval.watcher-resolved` decision is
audited, and the parent stage advances. A child `REJECTED` verdict posts the
review body as feedback and moves the parent to `changes-requested` instead of
approving; a `BLOCKED` or `FAILED` child leaves the parent's pending approval
untouched.

### `pr.merge`

`pr.merge` is a deterministic activity that acts on the correlated primary PR.
It accepts `target`, `method` (`merge`, `squash`, or `rebase`),
`requireChecks`, `requireApproval`, `autoMerge`, `maxFilesChanged`, and
`blockedPaths`.

`requireApproval` defaults to `true`; direct merges always require a current
trusted GitHub review. Set it to `false` only with `autoMerge: true`, after an
independent review watch gate has passed. `requireChecks: true` requires
currently passing checks for a direct merge. For native auto-merge it permits
pending checks but rejects unknown or failing checks, leaving GitHub branch
protection to hold the merge until required checks pass.

With `autoMerge: true`, Wake enables GitHub native auto-merge using `method`.
If GitHub reports that the PR is already in clean status, Wake falls back to a
direct merge with the same method. Other provider errors do not fall back.
Enable repository auto-merge and configure GitHub required-check protection
before using this route.

## Labels

Wake's stage labels use the workflow vocabulary:

```text
wake:stage.queue
wake:stage.<configured-stage>
wake:stage.done
```

For the `bugfix` example above, the known labels are:

```text
wake:stage.queue
wake:stage.triage
wake:stage.patch
wake:stage.verify
wake:stage.done
```

These labels mirror the control-plane state. They do not define prompt
behavior by themselves; the workflow configuration and prompt files do that.

### Live Run status

A started Run is durable and is shown as `wake:status.working` while its runner
executes. Terminal status labels remain derived from the Run outcome, rather
than from the runner starting. After a restart, Wake recovers durable active
Runs and continues that same outcome-based reconciliation. A live local runner
renews its lease and is not mistaken for a crashed process during recovery.
Runner comments are unchanged.

## Ticket closure

When the ticket backing a work item closes on its source tracker, Wake
concludes the work item to match: closed as completed closes the work
item, closed as not planned (or its provider's equivalent) cancels it.
Either way, Wake cancels any active Run and blocks any active workflow for
that work item — closing the ticket stops the work.

Wake's own generated PR bodies reference the issue (`Refs #<number>`)
rather than using a closing keyword (`Closes #<number>`), so merging a PR
never auto-closes the issue on GitHub. This keeps "the PR merged" and "the
ticket closed" independent signals: a workflow with stages after merge
(review, verify) keeps running until it reaches `done` on its own, and the
ticket only closes when a human closes it or Wake does so as the workflow's
final step.

Reopening the ticket does not currently reopen the work item — closing or
cancelling a work item is a one-way move.

## Checklist for a custom workflow

1. Add every action prompt to `paths.promptsRoot`.
2. Give each prompt a `maxTurns` frontmatter value.
3. Add a workflow with runnable stage names under `workflows`.
4. Set each stage's `workspace` and `onDone`.
5. Add `action` when the prompt name differs from the stage name.
6. Add `runnerPool` or `runner` when a stage needs specific routing.
7. Confirm the entry stage can reach `done`.
