# CLI reference

`--wake-root <path>` selects a Wake home and defaults to the current directory.
After `wake sandbox build` creates `<wake-root>/docker/Dockerfile`, runtime
commands automatically execute in the sandbox; pass `--no-sandbox` to run them
on the host. See [Getting started](getting-started.md) for an operational
walkthrough and [Configuration](configuration.md) for Wake-home settings.

## Commands

| Command | Purpose |
| --- | --- |
| `wake init <path>` | Scaffolds an empty Wake home with configuration, prompts, setup guide, workspace directory, Dockerfiles, and empty durable-state directories. To use a source checkout, set `host.development.mode: source` and `host.development.repoRoot` in `config.yaml` after initialization. |
| `wake tick` | Runs one bounded control-plane advancement pass. |
| `wake start` | Runs the resident advancement loop. |
| `wake stop` | Waits for active runs to finish before stopping the resident flow. |
| `wake ui` | Starts the web UI surface; its API host and port come from `surfaces.api`. |
| `wake api` | Starts the target API surface. |
| `wake smoke` | Starts a smoke invocation using the configured default runner pool. |
| `wake doctor` | Diagnoses configuration, provider, Docker, and sandbox setup. It runs on the host. |
| `wake validate-state` | Validates control-plane state health under `.wake/`. |
| `wake audit` | Shows durable autonomous-decision audit history. |
| `wake correlate` | Manually correlates a resource with a WorkItem through the public control-plane surface. |
| `wake run resolve <run-id> --succeeded (--outcome <json> \| --outcome-file <path>)` | Records an operator-confirmed, Activity-schema-validated success for an escalated ambiguous Run. |
| `wake run resolve <run-id> --failed --reason <message>` | Records an operator-confirmed failure for an escalated ambiguous Run. |
| `wake self-update` | Safely updates a source installation. |
| `wake --help` / `wake --version` | Shows the authoritative command summary / installed version. |

## Sandbox commands

| Command | Purpose |
| --- | --- |
| `wake sandbox build` | Generates `docker/Dockerfile` if it is missing and builds the configured image. Wake does not overwrite an existing Dockerfile. |
| `wake sandbox up` / `down` / `update` | Starts, stops/removes, or recreates the sandbox container. |
| `wake sandbox exec [-- <command>]` | Runs a command inside the container; omitting a command opens the configured interactive execution path. |
| `wake sandbox logs [--tail <positive integer>]` | Reads container logs; the default tail length is 200 lines. |
| `wake sandbox setup` | Runs interactive sandbox-owned authentication and git setup. |
| `wake sandbox resume <sessionId> --cwd <path> --cli <claude|codex|cursor>` | Manually resumes a known CLI session for debugging. Normal workflow dispatch handles compatible session resumption itself. |

The Dockerfile template is selected from `host.development.mode`: source mode
uses the configured `host.development.repoRoot`; packaged mode uses the
installed package. `host.development.repoRoot` is required for source mode.

## Operational model

`tick`, `start`, `ui`, `smoke`, `audit`, `correlate`, and `validate-state` are
runtime commands. They operate on the same durable journal, projections, and
configuration selected by `--wake-root`; a tick is not a separate legacy
scheduler. Use `wake doctor` after initialization and sandbox build, and use
`wake smoke` only after selecting a real runner in an execution pool.

## Arguments and recovery

- `wake audit <workItemId>` reads canonical journal facts for that WorkItem,
  rather than relying on a projection, so it remains useful while views are
  rebuilt.
- `wake correlate <resource> <workItemId>` records a manual resource
  correlation in that order. Use it only when normal integration correlation
  cannot establish the intended link.
- `wake run resolve` requires exactly one resolution mode. Success accepts
  exactly one JSON outcome source; failure requires a non-empty reason. The
  Run's Activity validates a successful outcome before Wake records it.
- `wake validate-state [--rebuild-projections]` checks durable state health.
  The optional flag rebuilds projections from the authoritative journal; it
  does not replace or discard journal facts.
- `wake stop` waits for active runs to finish before it stops the resident
  flow. `wake doctor` is the host-side diagnostic to run after initialization
  and after a sandbox build.
