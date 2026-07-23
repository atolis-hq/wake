<div align="center">


  <img src="https://raw.githubusercontent.com/atolis-hq/wake/refs/heads/main/assets/wake-logo.svg" alt="logo" width="200" height="auto" />
  <h1>Wake</h1>
  
  <p>
    Autonomous software engineering control plane
  </p>
  
  
<!-- Badges -->
<p>
  <a href="https://github.com/atolis-hq/wake/commits/main">
    <img src="https://img.shields.io/github/last-commit/atolis-hq/wake" alt="last update" />
  </a>
  <a href="https://github.com/atolis-hq/wake/actions/workflows/ci-cd.yml">
    <img src="https://github.com/atolis-hq/wake/actions/workflows/ci-cd.yml/badge.svg" alt="CI/CD status" />
  </a>
  <!-- <a href="https://github.com/atolis-hq/wake/network/members">
    <img src="https://img.shields.io/github/forks/atolis-hq/wake" alt="forks" />
  </a>
  <a href="https://github.com/atolis-hq/wake/stargazers">
    <img src="https://img.shields.io/github/stars/atolis-hq/wake" alt="stars" />
  </a> -->
  <a href="https://github.com/atolis-hq/wake/issues/">
    <img src="https://img.shields.io/github/issues/atolis-hq/wake" alt="open issues" />
  </a>
  <a href="https://github.com/atolis-hq/wake/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/atolis-hq/wake.svg" alt="license" />
  </a>
  <a href="https://github.com/atolis-hq/wake/tags">
    <img src="https://img.shields.io/github/v/tag/atolis-hq/wake" alt="latest tag" />
  </a>
  <a href="https://www.npmjs.com/package/@atolis-hq/wake">
    <img src="https://img.shields.io/npm/v/%40atolis-hq%2Fwake" alt="npm version" />
  </a>
  <a href="docker/Dockerfile">
    <img src="https://img.shields.io/badge/sandbox-docker-2496ED?logo=docker&logoColor=white" alt="runs in docker" />
  </a>
</p>
</div>

<br />


Wake is a control plane for autonomous software engineering. It watches the
channels your team already uses, coordinates agent activity and involves humans
when needed, and keeps the durable record attached to the work instead of the
terminal session that happened to run it.

Create an issue, assign Wake, and keep doing your own work. Wake investigates,
asks for input when human judgment matters, proposes a plan, launches local
coding-agent CLIs to implement changes, opens pull requests, and carries the
conversation forward wherever the work is already happening.


## Table of Contents

- [The Problem](#the-problem)
- [Vision](#vision)
- [Feature Overview](#feature-overview)
- [Where the Work Happens](#where-the-work-happens)
- [Supported Agent CLIs](#supported-agent-clis)
- [Getting Started](#getting-started)
- [Documentation](#documentation)
- [Issues & Feature Requests](#issues--feature-requests)
- [License](#license)


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

Wake should make reliable, resumable, token-aware autonomous engineering
practical. The default operating model is asynchronous and channel-driven: work
enters through durable external systems, Wake keeps humans in the loop at useful
decision points, and execution happens locally in an inspectable workspace or
sandbox.

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
- **Local and inspectable.** Everything lives in a plain-file Wake home
  directory: `config.json`, `prompts/`, and `workspaces/` at the top level for
  what you edit or browse day-to-day, with durable/internal state (events,
  projections, runs, logs, sandbox auth) nested under a hidden `.wake/`.
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

## Where the Work Happens

Wake has no chat UI you need to check for status. Your ticketing system is the
interface: Wake posts progress updates, asks clarifying questions, and reports
results as comments on the ticket, and reflects stage and status as labels on
it. When it's ready, it opens a pull request against your repo the normal way.
Reviewing, approving, and merging happen exactly where they already do today —
nothing new to learn, no separate dashboard to babysit.

A local control-plane UI exists for operators who want to watch runs, inspect
events, or resume a session directly, but it's a window into the same state —
not a required part of the workflow.

## Supported Agent CLIs

Wake wraps existing coding-agent CLIs rather than replacing them. Runner
adapters currently exist for:

- **[Claude Code](https://claude.com/claude-code)**
- **[Codex](https://openai.com/codex/)**
- **[Cursor](https://cursor.com/cli)**

Each runner sits behind the same `AgentRunner` contract, so Wake's routing,
lifecycle, and sandbox behavior stay the same regardless of which CLI executes
a given step. A fake runner adapter also exists for zero-token testing of the
control plane itself. See [docs/runner-comparison.md](docs/runner-comparison.md)
for capability differences between runners.

## Getting Started

```sh
npm install -g @atolis-hq/wake
cd ~/
wake init ./wake-home
cd ./wake-home
wake sandbox build
wake sandbox up
wake sandbox setup
wake start
```

Full setup instructions are in
[docs/getting-started.md](docs/getting-started.md). Run `wake --help` at
any time for the full command list.

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — packaged-install setup, sandbox lifecycle, `wake doctor`.
- [docs/vision.md](docs/vision.md) — the rationale and long-term direction for Wake.
- [docs/architecture.md](docs/architecture.md) — module boundaries and the event-sourced core.
- [docs/workflows.md](docs/workflows.md) — how stages, prompts, and runner routes are configured.
- [docs/prompts.md](docs/prompts.md) — how prompt templates map to workflow stages.
- [docs/configuration.md](docs/configuration.md) — `config.json` options and the operator correlation escape hatch.
- [docs/development.md](docs/development.md) — source-checkout dev setup (`wake-dev`), npm scripts, formatting, self-update, GitHub polling.
- [docs/runner-comparison.md](docs/runner-comparison.md) — capability differences between supported runners.

## Issues & Feature Requests

Found a bug or have an idea for Wake? [Open an issue](https://github.com/atolis-hq/wake/issues/new) —
bug reports and feature requests are both welcome.

## License

Wake is licensed under the [Apache License 2.0](LICENSE).
