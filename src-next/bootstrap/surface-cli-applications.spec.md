# CLI surface application — Component Specification

## Type, purpose, and scope

Surface application. The CLI surface application is the only path the CLI
entry point uses to reach the composed graph: running a tick or the resident
loop, starting/stopping the HTTP host the API surface application is served
over, reading a stream's audit trail, correlating a resource to a WorkItem,
and validating durable state.

## Responsibilities and boundaries

This component owns the CLI-specific commands (tick/start/stop, on-demand
HTTP hosting, audit, correlate, validate-state) and owns deciding, from
configuration, whether `start` also stands up an HTTP server. It does not
own tick or resident-loop semantics themselves (control-plane owns the tick
pipeline and resident host), does not own HTTP request handling (Surfaces
owns the dispatcher and server), and does not own the API surface
application's own responses — it only decides when to serve them.

## Core policies, invariants, and behaviours

- `tick` MUST run exactly one pass of the composed tick pipeline; `start`
  MUST run the resident loop (repeated ticks with idle backoff) until
  stopped or its budget is exhausted.
- `start` MUST start an HTTP server before entering the resident loop
  whenever either the web surface or the API surface is enabled in
  configuration: enabling the web surface MUST start the combined
  API+UI server; enabling only the API surface MUST start the API-only
  server; enabling neither MUST run the resident loop with no HTTP server
  at all.
- Whatever HTTP server `start` opened MUST be closed once the resident loop
  stops, whether it stopped normally or by error.
- `api` and `ui` MUST be independently startable at any time, not only as
  part of `start`, using the composed configuration's host/port unless the
  caller overrides either.
- Starting `ui` MUST fail before opening a listening socket if the packaged
  web asset bundle is missing its entry document — this component MUST NOT
  silently fall back to serving an API-only server under the UI command.
- `stop` MUST close every HTTP server this CLI surface application itself
  started and MUST NOT affect a server or resident loop running in a
  different process.
- `audit.read(id)` MUST return every event in the entire journal whose
  stream id matches the given id, across every stream kind — it is a raw
  per-id scan, not scoped to WorkItem ids or to a single stream kind.
- `correlate` MUST issue an operator-actor correlate command establishing
  the given resource as the WorkItem's primary correlation, with a command
  identity derived deterministically from the resource and WorkItem pair, so
  a repeated identical call addresses the same command identity.
- `validateState.health` MUST actively read from the journal, the work
  projection, and a named checkpoint, and MUST fail outright if any of those
  reads fails — unlike the API surface application's own `system.health`,
  this command has no partial or degraded report; it is all-or-nothing.
- `validateState.rebuildProjections` MUST rebuild every projection
  registered for production composition, from the full event journal, and
  MUST cover exactly the same set of projections the tick pipeline itself
  catches up on — no projection is rebuildable-only or catch-up-only.

## Dependencies and system role

- Control-plane — owns the tick pipeline and resident-loop hosts this
  component wraps for `tick`/`start`.
- Surfaces — owns the HTTP dispatcher, server, and packaged web asset
  source this component starts on demand, and owns the CLI's public
  command contract this component implements.
- API surface application (depends on, indirectly) — the HTTP server this
  component starts serves exactly that component's responses.
- Composition root (depends on) — every command here reads or writes
  through the same composed graph the API surface application uses; the two
  surfaces are never given separate graphs.

## Decisions, exclusions, and deferred capability

- This component tracks only the HTTP servers it itself opened, in-process;
  it has no mechanism to discover or stop a server started by another Wake
  process against the same Wake home.
- `correlate` always establishes a `Primary` correlation role; this
  component does not expose any other correlation role from the CLI.
