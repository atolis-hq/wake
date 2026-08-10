# CLI surface application — Component Specification

## Type, purpose, and scope

Surface application. The CLI surface application is the only path the CLI
entry point uses to reach the composed graph: running a tick or the resident
loop, starting/stopping the HTTP host the API surface application is served
over, reading a stream's audit trail, correlating a resource to a WorkItem,
and validating durable state.

## Responsibilities and boundaries

This component owns the CLI-specific commands (tick/start/stop, on-demand
HTTP hosting, audit, correlate, validate-state), the sandbox lifecycle
commands (`doctor`, `sandbox`, `sandbox-setup`, `sandbox-entrypoint`,
`self-update`, `smoke`, and the `sandboxRuntime` helpers a sandboxed
container's own entry commands use), and owns deciding, from configuration,
whether `start` also stands up an HTTP server. It does not own tick or
resident-loop semantics themselves (control-plane owns the intake/runner
pipelines and resident host), does not own HTTP request handling (Surfaces
owns the dispatcher and server), does not own the self-update
update-then-verify-then-rollback sequence itself (see
[Self-update](self-update.spec.md), which this component only invokes with
concrete Docker/git collaborators), and does not own the API surface
application's own responses — it only decides when to serve them.

## Core policies, invariants, and behaviours

- `tick` MUST run one intake pass followed by the runner pipeline drained
  to its own budget, mirroring a single one-shot pass of what `start`'s two
  resident loops do continuously.
- `start` MUST run two independently scheduled resident loops for as long
  as it is not stopped or its budget is exhausted: an intake loop (catch up
  projections, poll every configured provider, translate polled input into
  facts) and a runner loop (catch up projections, run schedules, react to
  newly appended facts, advance the control plane by one bounded step,
  attempt one outbound delivery). Only the intake loop backs off
  exponentially while idle, since only it touches a rate-limited external
  API; the runner loop instead backs off only on a run of consecutive tick
  *errors*, staying on a fast fixed cadence while merely idle. `start` MUST
  also run a fixed-interval projection-catch-up pump alongside both loops,
  independent of either one's own cadence, so a run's projected state (e.g.
  the board's active-run card) reflects progress made mid-run rather than
  only its state before and after.
- Both pipelines MUST no-op entirely — including skipping their own
  projection catch-up — while the composed control plane reports itself
  paused; `tick`, `start`'s two resident loops, and the API surface
  application's own `advance` command all observe this same pause state.
- `start` MUST start an HTTP server before entering its resident loops
  whenever either the web surface or the API surface is enabled in
  configuration: enabling the web surface MUST start the combined
  API+UI server; enabling only the API surface MUST start the API-only
  server; enabling neither MUST run the resident loops with no HTTP server
  at all.
- Whatever HTTP server `start` opened MUST be closed once its resident
  loops stop, whether they stopped normally or by error.
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
  MUST cover exactly the same set of projections the intake and runner
  pipelines themselves catch up on — no projection is rebuildable-only or
  catch-up-only.
- `doctor` MUST report every configured provider that failed to construct
  during composition as a failure, in addition to actively probing every
  successfully-constructed provider's own connectivity check; a Docker
  sandbox image/container that is simply absent or stopped MUST be reported
  as an informational notice, never a failure, since a deployment need not
  use the Docker sandbox at all.
- `self-update` MUST require `host.development.mode: source` with a
  configured `host.development.repoRoot`, and MUST delegate the actual
  update sequence to [Self-update](self-update.spec.md); when this
  installation runs a sandbox container, `self-update` MUST additionally
  wait for every active execution run to finish before rebuilding and
  swapping the container, and MUST confirm the resident `wake start`
  process actually came back up under the new tag before considering that
  deploy (or a rollback) complete.
- `sandbox-setup` MUST prepare this host's container-mounted home directory
  (SSH key, Codex credentials) interactively, and MUST accept no
  arguments. `sandbox-entrypoint` MUST supervise the container's own `wake
  start` process as PID 1 — restarting it after a crash and keeping the
  container reachable for `sandbox exec` even while `start` itself keeps
  failing — and MUST only launch `start` at all when the container was
  built with start enabled.
- `sandboxRuntime.exec` MUST invoke the composed CLI inside the sandbox
  container using the invocation this deployment's `host.development.mode`
  implies (a direct `node`/build-output invocation for `source` mode, the
  installed `wake` binary for `packaged` mode); `sandboxRuntime.hasDockerfile`
  MUST report whether `docker/Dockerfile` exists under this Wake root,
  without itself building or inspecting an image.
- `smoke` MUST resolve the default runner pool through the same runner
  registry composition (including the composed fake-scenario resolver) that
  production execution uses, so a fake-runner smoke test can be scripted
  identically to how a fake runner behaves in a real tick.

## Dependencies and system role

- Control-plane — owns the intake/runner pipelines and resident-loop hosts
  this component wraps for `tick`/`start`.
- Surfaces — owns the HTTP dispatcher, server, and packaged web asset
  source this component starts on demand, owns the Docker CLI/sandbox
  primitives and sandbox-entrypoint supervision this component composes
  concrete dependencies for, and owns the CLI's public command contract
  this component implements.
- [Self-update](self-update.spec.md) (depends on) — `self-update` composes
  this policy with a git-backed source port and, for a sandboxed
  installation, a Docker rollout port; this component owns none of that
  policy's own update/rollback rules.
- [Runner registry composition](runner-registry.spec.md) (depends on) —
  `doctor` and `smoke` both compose a runner registry the same way
  production execution does, to validate/exercise it outside a real tick.
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
