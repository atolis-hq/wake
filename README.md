# Wake

Wake is an autonomous agent control plane for software development.

The core idea is to coordinate local agent execution through a control plane that can:

- take work from external channels such as issue trackers
- decide the next lifecycle step for that work
- choose the appropriate CLI, model, and execution mode using deterministic rules
- run deterministic control-plane tasks without spending tokens when possible
- launch or resume local agent sessions when agentic execution is needed
- let a human jump directly into a local session when asynchronous coordination is not enough

Wake is intended to start simple. The first justified version is a small loop that can pick work, decide what to do next, execute it locally, persist state, and resume later. More advanced routing, lifecycle control, and self-improvement should only be added once that simple version proves useful.

## Status

This repository is currently focused on product definition and early direction.

- Vision document: [docs/vision.md](docs/vision.md)
- Implementation guide (MVP + longer-term shape): [docs/implementation.md](docs/implementation.md)
- Early-thinking inputs (not the accepted plan): [docs/vision-inputs/](docs/vision-inputs/)

## Concepts

- `Wake` is the control plane and decision-maker.
- `Eddy` is the thin local execution identity or wrapper that Wake launches and manages.

## Direction

Wake is intended to integrate with existing local agent CLIs such as Claude Code and Codex rather than replace them. It should run work locally, likely in a reusable isolated development environment, and use external workflow systems as the default coordination surface.
