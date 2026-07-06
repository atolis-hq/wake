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

## Concepts

- `Wake` is the control plane and decision-maker.
- `Eddy` is the thin local execution identity or wrapper that Wake launches and manages.

## Direction

Wake is intended to integrate with existing local agent CLIs such as Claude Code and Codex rather than replace them. It should run work locally, likely in a reusable isolated development environment, and use external workflow systems as the default coordination surface.

## Development

```bash
npm install
npm test
npm run tick
```

Useful commands:

- `npm run tick` runs one control-plane tick using fake ticketing-system data from `.wake/fixtures/issues.json` when present
- `npm run start` runs the resident loop
- `npm run smoke:claude` runs a minimal Claude Haiku smoke test
- `npm run smoke:claude -- --remote-control` starts a minimal remote-control Claude smoke session

### Configuration

Wake's behavior can be customized through a configuration file at `.wake/configuration.json`. See [docs/configuration.md](docs/configuration.md) for a complete reference of all configurable properties, including paths, scheduler timing, execution mode, Claude CLI settings, and GitHub integration options.

## GitHub Issues Polling

Wake can poll configured GitHub repositories when `sources.github.enabled` is
set to `true`. Authentication is resolved from the current GitHub CLI session
via `gh auth token`, and Wake uses a fixed runner mode of either `fake` or
`claude`.

GitHub Issues sync runs inside the normal tick path. Each tick polls GitHub,
translates provider payloads into canonical ticket events, appends those
events, rebuilds local projections, decides whether work is needed, and only
then invokes Eddy.

The default Claude smoke prompt is intentionally tiny:

```text
This is Eddy, reply with "hi Eddy only"
```
