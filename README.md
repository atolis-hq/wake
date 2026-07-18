# Wake

Wake is a local autonomous agent control plane for software development. It
watches the work channels your team already uses, such as GitHub Issues,
decides each item's next lifecycle step with deterministic rules, and launches
local coding-agent CLIs only when agentic execution is actually needed.

Wake is the control plane and decision-maker. Eddy is the execution identity
Wake launches and manages for a unit of local agentic work.

## The Problem

Modern coding agents are powerful, but sustained development work still needs a
lot of manual orchestration. Agents are usually started by hand, tied to one CLI
surface, and optimized for interactive sessions instead of managed execution
over time.

That leaves hard operational gaps: deciding what should happen next, choosing
the right tool and model for each step, preserving state across interruptions,
running deterministic housekeeping outside the LLM path, and letting a human
resume the exact local session when direct intervention is fastest.

Wake exists to close that gap. It wraps existing agent CLIs in a local control
plane that can apply scripted routing rules, move work through explicit
lifecycle steps, resume or hand off sessions, and keep deterministic processes
out of the token-burning path wherever possible.

## Vision

Wake should make reliable, resumable, token-aware local agent execution
practical. The default operating model is asynchronous and channel-driven: work
enters and progresses through durable external systems, while execution happens
locally in an inspectable workspace or sandbox.

Wake is not trying to replace coding agents, issue trackers, or source control.
It coordinates across them. Over time it should become the layer that picks
work, decides the next step, invokes the right local tool or deterministic
process, persists state, and resumes later without losing context.

For more detail, see [docs/vision.md](docs/vision.md) and
[docs/architecture.md](docs/architecture.md).

## Feature Overview

- **Wake decides, the agent runs.** Choosing the CLI, model, and lifecycle
  transition is a control-plane decision; agents do the work and report an
  outcome.
- **Issue-driven by default.** Wake currently integrates with GitHub Issues and
  reports questions, approvals, progress, and results back through the ticket.
- **Explicit lifecycle stages.** Work can move through configurable stages such
  as refinement and implementation instead of disappearing into one opaque
  session.
- **Event-sourced and restart-safe.** The durable record is an append-only event
  log; projections can be rebuilt, and the loop can crash and resume without
  losing its place.
- **Local and inspectable.** Config, events, state, runs, workspaces, and prompts
  live in a plain-file Wake home directory.
- **Sandbox-oriented execution.** Wake can run from a persistent Docker sandbox
  with durable auth state and mounted Wake home data.
- **Runner agnostic.** Claude Code, Codex, Cursor, and fake runners sit behind
  runner adapters so Wake owns policy and routing rather than depending on one
  provider.
- **Human resumption.** A human can pick up the exact local agent session when a
  direct terminal intervention is the best way forward.
- **Operator correlation escape hatch.** `wake correlate <workItemKey>
  <resourceUri>` lets an operator hand-declare that a resource (a PR, a Slack
  thread, etc.) belongs to an existing work item when nothing detected the
  link automatically. See [docs/configuration.md](docs/configuration.md).

Current runner capability differences are documented in
[docs/runner-comparison.md](docs/runner-comparison.md).

## Getting Started

Wake is distributed as the `@atolis-hq/wake` npm package. You can run the CLI
with `npx` or install it globally:

```sh
npx @atolis-hq/wake init ./wake-home
```

```sh
npm install -g @atolis-hq/wake
wake init ./wake-home
```

`wake init` creates a Wake home directory with `config.json`, prompt templates,
Docker sandbox assets, runtime directories, and shell launchers:

- `wake.sh` for bash, Git Bash, WSL, and similar shells.
- `wake.ps1` for PowerShell.

Use the generated launcher from the Wake home for day-to-day operation. The
launcher runs host setup commands locally and forwards runtime commands into the
sandbox with the correct Wake home mounted at `/wake`.

```sh
cd ./wake-home
./wake.sh sandbox build
./wake.sh sandbox up
./wake.sh sandbox setup
./wake.sh tick
./wake.sh start
```

The default sandbox image includes Node, Git, GitHub CLI, Claude Code, Codex,
Cursor, and the Wake runtime. Treat the generated `docker/Dockerfile` as a
starting point for your own environment: add the tools your repositories need,
then rebuild with `./wake.sh sandbox build`. Wake writes the package location to
`config.json` as `dev.repoRoot` so sandbox rebuilds use the same bundled assets;
editing your generated Dockerfile or prompts is expected and future package
upgrades should not overwrite that Wake home.

Common commands:

```sh
./wake.sh ui
./wake.sh tick
./wake.sh start
./wake.sh stop
./wake.sh sandbox resume <session-id> --cwd "/wake/workspaces/<workId>"
```

For a source checkout development workflow, use:

- [docs/development.md](docs/development.md)

Recommended local practices:

- Use a separate git identity for Wake-managed agent work so automated commits
  and human commits are easy to distinguish.
- Prefer the prebuilt sandbox flow when running real agent work locally.
- Treat the default Dockerfile as a starting point. It includes common tooling
  such as Node, but it is expected to be edited for the repositories and agents
  you want Wake to operate on.

## Development

Local setup, commands, sandbox operation, auth setup, UI notes, and GitHub
polling details are documented in [docs/development.md](docs/development.md).
