# Workflows

Wake workflows define the stages a work item moves through and which prompt file is
used to run each stage. They are deterministic control-plane configuration:
Wake chooses the stage, workspace mode, and runner route; the agent only
executes the selected action and reports a result.

## Where workflows live

Workflows are configured in the `workflows` section of Wake config —
`config.workflows.yaml` at the root of the Wake home `--wake-root` (or the
current directory, by default) resolves to. All config uses `schemaVersion: 1`.

If no workflow is configured, Wake uses this built-in default:

```json
{
  "workflows": {
    "default": {
      "stages": {
        "refine": {
          "action": "refine",
          "workspace": "read-only",
          "tier": "light",
          "onDone": "implement"
        },
        "implement": {
          "action": "implement",
          "workspace": "branch",
          "tier": "standard",
          "onDone": "done"
        }
      }
    }
  }
}
```

That means queued work first runs the `refine` action with a read-only
workspace. When the agent reports `DONE`, Wake moves the work item to
`implement`. When `implement` reports `DONE`, Wake moves the work item to
`done`.

## Workflow fields

A workflow has an optional `entryStage` and a required `stages` object:

```json
{
  "workflows": {
    "bugfix": {
      "entryStage": "triage",
      "stages": {
        "triage": {
          "action": "refine",
          "workspace": "read-only",
          "tier": "light",
          "onDone": "patch"
        },
        "patch": {
          "action": "implement",
          "workspace": "branch",
          "tier": "standard",
          "onDone": "verify"
        },
        "verify": {
          "action": "verify",
          "workspace": "branch",
          "runner": "codex-flagship",
          "onDone": "done"
        }
      }
    }
  }
}
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
- `tier`: optional runner tier to route this stage through.
- `runner`: optional concrete runner name. A runner pin takes precedence over a
  tier.

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

```json
{
  "stages": {
    "verify": {
      "action": "verify",
      "workspace": "branch",
      "onDone": "done"
    }
  }
}
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

```json
{
  "workflowSelectors": [
    {
      "workflow": "bug",
      "match": {
        "kind": "issue",
        "repo": "atolis-hq/wake",
        "requiredLabels": ["bug"],
        "ignoredLabels": ["wontfix"]
      }
    },
    {
      "workflow": "pr-review",
      "match": {
        "kind": "pr",
        "requiredAuthors": ["trusted-human"]
      }
    }
  ]
}
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

When a runner reports `DONE`, Wake follows the stage's `onDone` transition. If
the runner reports `BLOCKED`, `FAILED`, or `AWAITING_APPROVAL`, Wake does not
take the `onDone` transition automatically.

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

## Checklist for a custom workflow

1. Add every action prompt to `paths.promptsRoot`.
2. Give each prompt a `maxTurns` frontmatter value.
3. Add a workflow with runnable stage names under `workflows`.
4. Set each stage's `workspace` and `onDone`.
5. Add `action` when the prompt name differs from the stage name.
6. Add `tier` or `runner` when a stage needs specific routing.
7. Confirm the entry stage can reach `done`.
