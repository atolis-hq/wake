# CLI Reference

Every command accepts `--wake-root <path>` (defaults to the current
directory) and, for the runtime commands, `--no-sandbox` to force host
execution even when `docker/Dockerfile` exists. See
[getting-started.md](getting-started.md) for the end-to-end walkthrough.

```
wake init <path>           Scaffold a new Wake home directory
wake sandbox <subcommand>  Build/run/manage the Docker sandbox
wake tick                  Run one control-plane tick
wake start                 Run the resident loop
wake stop                  Stop the sandbox container gracefully
wake smoke                 Smoke-test the configured runner
wake ui                    Run the control-plane UI server
wake correlate             Manually correlate a resource to a work item
wake doctor                Diagnose config/GitHub/Docker/sandbox setup problems
wake --version              Print the installed Wake version
wake --help                 Show this message
```

Run `wake --help` at any time for this list with one-line descriptions.

## `wake init <path>`

Scaffolds a new Wake home at `<path>`: `config.json`, `prompts/`, and
`workspaces/`. Does not create `docker/` — that's written lazily by
`wake sandbox build`.

- `--dev` — force `dev.mode: "source"` (build the sandbox from a local
  checkout rather than installing the published npm package).
- `--packaged` — force `dev.mode: "packaged"`.
- With neither flag, the mode is auto-detected from whether `init` is run
  from inside a Wake source checkout.

## `wake sandbox <subcommand>`

Run with no subcommand, `--help`, `-h`, or `help` to print this list.

| Subcommand | Description |
| --- | --- |
| `build` | Generate `docker/Dockerfile` (if missing) and build the sandbox image. |
| `up` | Start the sandbox container. |
| `update` | Recreate the sandbox container from the current image. |
| `down` | Stop and remove the sandbox container. |
| `stop` | Stop the resident loop gracefully, then the container. |
| `self-update` | Pull the latest tag and rebuild (`dev.mode: "source"` only). |
| `setup` | Run interactive first-time setup inside the container. |
| `exec [-- <command>]` | Run a command inside the sandbox container, or drop into an interactive shell if no command is given. |
| `logs [--tail <n>]` | Print sandbox container logs (default 200 lines). |
| `resume` | Resume a previous agent session inside the sandbox. |

`docker/Dockerfile` is generated once from a template that matches
`config.dev.mode` (`source` copies this checkout in; `packaged` installs
`@atolis-hq/wake` from npm at the pinned version). Once it exists it is
never overwritten — it's yours to edit; rebuild with `sandbox build` after
editing it.

## `wake tick`

Runs one control-plane tick: polls configured sources, folds events into
projections, and applies at most one deterministic policy decision per
work item (launching an agent run if the tick calls for one).

## `wake start`

Runs the resident loop — repeated ticks on `config.scheduler.intervalMs`,
backing off toward `maxIntervalMs` when idle.

## `wake stop`

Signals the resident loop to stop gracefully: waits for any active run to
finish, then stops the container. Accepts `--poll-interval-ms` and
`--timeout-ms` to tune how long it waits before giving up.

## `wake smoke [claude|codex|cursor]`

Runs a minimal smoke prompt against a configured real runner entry to
verify the CLI/session plumbing works, without spending meaningful tokens.
Pass a runner kind to pick a specific configured entry; otherwise the
first real (non-fake) entry in `config.runners` is used.

## `wake ui`

Starts the control-plane UI server (default `127.0.0.1:4317`, configurable
via `config.ui`).

## `wake correlate <workItemKey> <resourceUri> [--role <role>]`

Manually correlates an external resource (e.g. a GitHub issue or PR URI)
to an existing work item, for cases the automatic reverse-index lookup
missed. `--role` defaults to `implementation`.

## `wake doctor`

Diagnoses config, GitHub, Docker, and sandbox setup problems. Run after
`wake init` and `wake sandbox build`. Reports prompt/runner config issues
and GitHub token resolvability as failures (exits non-zero); reports
sandbox-vs-CLI version drift and prompt/Dockerfile customizations that
have drifted from the shipped defaults as notices (does not fail).

Runs on the host only — it never auto-delegates into the sandbox, since
its job is to report on sandbox reachability from the outside.
