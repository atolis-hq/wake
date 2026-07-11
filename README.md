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

Current runner capability differences are documented in
[docs/runner-comparison.md](docs/runner-comparison.md).

## Getting Started

Wake does not have a paved install path yet. The intended getting-started flow
will be based on published packages and a simpler setup path than this source
checkout currently provides.

Until that exists, use the local development guide:

- [docs/development.md](docs/development.md)

Recommended local practices for the current development flow:

- Use a separate git identity for Wake-managed agent work so automated commits
  and human commits are easy to distinguish.
- Prefer the prebuilt sandbox flow when running real agent work locally.
- Treat the default Dockerfile as a starting point. It includes common tooling
  such as Node, but it is expected to be edited for the repositories and agents
  you want Wake to operate on.

## Development

Local setup, commands, sandbox operation, auth setup, UI notes, and GitHub
polling details are documented in [docs/development.md](docs/development.md).
