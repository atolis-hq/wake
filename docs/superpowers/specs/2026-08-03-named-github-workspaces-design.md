# Named GitHub integrations and workspace bindings

## Goal

Allow Wake to poll issues from one GitHub repository while executing work in another repository, including when those repositories require different GitHub identities.

## Configuration

GitHub integrations are named. Each owns its credential resolution and may enable or disable intake independently.

```yaml
integrations:
  github:
    issue-tracker:
      credential: sandbox-gh
      intake:
        repositories:
          - owner: atolis-hq
            repo: wake-test
    code:
      credential: code-repo-token
      intake:
        enabled: false

workspaces:
  default:
    integration: github.code
    repository: atolis-hq/wake
    ref: main
```

A workspace binding selects the code repository and the named integration used for Git authentication. `credential: sandbox-gh` resolves through the sandbox-local `gh auth token`; any other credential name resolves through the existing secret-backed configuration mechanism introduced for named credentials.

## Workflow execution

A workspace binding and workspace mode are separate:

```yaml
orchestration:
  workflows:
    default:
      execution:
        workspace: default
      stages:
        refine:
          execution:
            mode: read-only
        implement:
          execution:
            mode: branch
        notify:
          execution:
            mode: none
```

Workflow-level workspace bindings are inherited by stages. A stage may override the binding. `mode: none` always acquires no repository; `read-only` and `branch` require a resolved binding.

## Runtime behavior

The Git workspace provider resolves the binding before each acquisition. It uses the bound integration's identity to clone/fetch the configured repository at `ref`. Read-only workspaces are isolated checkouts; branch workspaces are isolated worktrees/branches. The intake repository is only the source of issue resources and is never inferred as the workspace when an explicit binding is present.

## Validation and observability

Configuration validation rejects unknown integration references, non-GitHub workspace integrations, invalid repository coordinates, and a non-`none` mode with no resolved workspace binding. Operator-visible execution failures identify the workspace binding and integration name without exposing credentials.

## Tests

Cover configuration parsing and inheritance, distinct intake/workspace integrations, credential selection, repository/ref resolution, read-only and branch acquisition, and invalid references. Preserve the existing one-integration sandbox behavior as a compatible shorthand.