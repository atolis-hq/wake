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

Wake already keeps durable stage state (`queue`, `implement`, `done`) and stores routing data in `config.stages[stage]` (`action`, `tier`, `runner`). This issue should evolve that shape into named workflows while preserving the same naming convention: stage keys associate related prompt templates and stage-specific files.

## Proposed workflow shape

A workflow is a set of named stages. Each stage either dispatches an agent action or is terminal.

```jsonc
{
  "workflows": {
    "default": {
      "entryStage": "queue",
      "stages": {
        "queue": {
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
        },
        "done": { "terminal": true }
      }
    }
  }
}
```

The first implementation should include only the `default` workflow and reproduce today's behavior: `queue -> implement -> done`. Workflow selectors and intake-time workflow pinning are separate follow-up work.

## Requirements

- Add a zod-validated workflow definition to config.
- Use the stage name as the only step id across config, durable projection state, stage history, and `wake:stage.<name>` labels.
- Keep `action` as the prompt-template name. For example, `action: "refine"` maps to `prompts/refine.md`.
- Optionally allow a runnable stage to omit `action` only when `prompts/<stage>.md` exists; otherwise fail validation early. Terminal stages do not need prompt templates.
- Add `workspace` as a stage-level enum: `none | read-only | branch`.
- Add `onDone` as the only workflow-defined transition.
- Keep `DONE`, `BLOCKED`, `FAILED`, and `AWAITING_APPROVAL` as universal agent result statuses. Workflows must not define custom statuses.
- Treat `BLOCKED` and `FAILED` as universal parked states, not workflow stages. A blocked item resumes the stage that blocked after a human reply.
- Validate the graph at config load: every `onDone` target exists, non-terminal stages are runnable, and each workflow can reach a terminal stage.
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

- The default workflow is defined in config and preserves the existing `queue -> implement -> done` behavior.
- `policy-engine.ts` and `lifecycle-service.ts` no longer hardcode the default stage progression.
- Config validation catches missing `onDone` targets, missing prompt templates, malformed terminal/runnable stages, and workflows with no terminal path.
- Unknown stage/workflow config drift parks the item as blocked with reason `workflow-changed`.
- Stage labels use the configured workflow stage vocabulary.
- Existing tests continue to pass, with focused tests added for workflow parsing, interpreter transitions, validation failures, and config-drift blocking.
````
