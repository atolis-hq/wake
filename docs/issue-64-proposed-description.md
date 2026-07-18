# Proposed replacement for issue #64

Suggested title:

Replace hard-coded policy/lifecycle with a declarative workflow definition and interpreter (P15)

Suggested body:

````markdown
**Priority:** 15
**Complexity:** Medium
**Source:** `docs/design-workflows-and-routing.md`, central insight + sections 1.1, 1.2, 1.4, and 1.5

## Reworked scope

Issue #64 should introduce a simple, extensible workflow definition that matches Wake's current model. The stage name is the workflow step identifier; there should not be separate `step` and `stage` ids.

Wake already keeps durable stage state and stores routing data in `config.stages[stage]` (`action`, `tier`, `runner`). This issue should evolve that shape into named workflows while preserving the same naming convention: stage keys associate related prompt templates and stage-specific files. `queue` remains the universal intake stage before any workflow-specific work starts, and `done` remains the universal completed terminal stage.

## Proposed workflow shape

A workflow is an ordered set of named runnable stages. Every workflow starts from an implicit `queue` stage, then enters the first configured stage. `done` is an implicit terminal stage, so workflows do not define a `done` stage.

```jsonc
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

The first implementation should include only the `default` workflow and reproduce today's behavior: `queue -> refine -> implement -> done`, where `queue` and `done` are universal implicit stages. Workflow selectors and intake-time workflow pinning are separate follow-up work.

## Requirements

- Add a zod-validated workflow definition to config.
- Use the stage name as the only step id across config, durable projection state, stage history, and `wake:stage.<name>` labels.
- Keep `queue` as the implicit initial stage for every workflow. Workflow JSON must not define `queue`, set `entryStage: "queue"`, or reference `queue` as a transition target.
- Enter the first configured stage after `queue`; the configured stage order determines the entry stage.
- Keep `done` as the implicit terminal stage. Workflow JSON must not define a `done` stage.
- Keep `action` as the prompt-template name. For example, `action: "refine"` maps to `prompts/refine.md`.
- Optionally allow a runnable stage to omit `action` only when `prompts/<stage>.md` exists; otherwise fail validation early.
- Add `workspace` as a stage-level enum: `none | read-only | branch`.
- Require every configured stage to define `onDone`; `onDone: "done"` completes the workflow.
- Keep `DONE`, `BLOCKED`, `FAILED`, and `AWAITING_APPROVAL` as universal agent result statuses. Workflows must not define custom statuses.
- Treat `BLOCKED` and `FAILED` as universal parked states, not workflow stages. A blocked item resumes the stage that blocked after a human reply.
- Validate the graph at config load: every `onDone` target is either another configured stage or `done`, every configured stage is runnable, no transition targets `queue`, and each workflow can reach `done`.
- If a projection references an unknown workflow or unknown stage after a config change, transition it to blocked with reason `workflow-changed`; do not guess a mapping.
- Derive stage-label parsing and generation from the workflow definition instead of a hardcoded stage list.

## Interpreter surface

Replace the hardcoded policy/lifecycle transition logic with a small workflow interpreter:

```ts
chooseAction(projection, workflow) -> { action, workspace, routing } | null
nextStage(stage, sentinel, workflow) -> stage.onDone | 'blocked' | 'failed'
```

The tick remains deterministic and token-free. `tick-runner.ts` should ask the interpreter for workspace and routing instead of switching on action names.

## Acceptance criteria

- The default workflow is defined in config and preserves the existing `queue -> refine -> implement -> done` behavior without defining `queue` or `done`.
- `policy-engine.ts` and `lifecycle-service.ts` no longer hardcode the default stage progression.
- Config validation catches missing `onDone` values or targets, transitions to `queue`, defined `queue`/`done` stages, missing prompt templates, malformed runnable stages, and workflows with no path to `done`.
- Unknown stage/workflow config drift parks the item as blocked with reason `workflow-changed`.
- Stage labels use the configured workflow stage vocabulary.
- Existing tests continue to pass, with focused tests added for workflow parsing, interpreter transitions, validation failures, and config-drift blocking.
````
