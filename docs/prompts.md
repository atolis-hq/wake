# Prompt Files

Wake prompt files define the runner instructions used by workflow stages. A
workflow stage chooses a prompt by setting `action`; if `action` is omitted,
Wake uses the stage name as the prompt name.

For workflow structure and stage selection, see [Workflows](workflows.md).

## Location

Prompt templates live under `paths.promptsRoot`, normally `<wakeRoot>/prompts`.
The prompt name maps directly to a Markdown file:

```text
prompts/<action>.md
```

For a stage with `action: "verify"`, Wake loads:

```text
prompts/verify.md
```

For a stage named `triage` that omits `action`, Wake loads:

```text
prompts/triage.md
```

## Template Format

Prompt files are Handlebars Markdown files with frontmatter. Wake renders the
template with work item and stage context, then passes the rendered prompt to the
runner selected by the workflow stage.

Wake passes common context values such as:

- `mode`
- `isStart`
- `isResume`
- `stage`
- `workItemKey`
- `repo`
- `issueNumber`
- `branch` for branch workspaces

Every prompt template must include a positive integer `maxTurns` frontmatter
value so Wake can cap runner execution.

Other frontmatter such as `allowedTools`, `permissionMode`, `extraArgs`, and
`skipApproval` is consumed by runner adapters and the Wake harness.

Example:

```markdown
---
maxTurns: 20
allowedTools: Bash, Read
permissionMode: acceptEdits
---

{{#if isResume}}
Resume verification for {{repo}}#{{issueNumber}}.
{{else}}
Verify the implementation for {{repo}}#{{issueNumber}}.
{{/if}}
```
