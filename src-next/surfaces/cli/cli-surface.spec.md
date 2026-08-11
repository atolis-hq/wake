# CLI Surface — Component Specification

---
asOf: 725a0bc
---

## Type, purpose, and scope

Surface application. The CLI surface is the single, minimal entry point that
parses process arguments into a typed command and dispatches it against a
Bootstrap-composed application facade, writing newline-delimited JSON to a
given output sink. It also hosts a set of standalone command primitives —
small, dependency-injected functions performing one CLI action each — that a
caller can compose independently of the parsed argument surface.

## Ubiquitous language

- **WakeCommand** — the parsed, typed shape of one CLI invocation.
- **Resident command** — `tick`, `start`, or `stop`; the only commands that
  accept `--wake-root`.
- **Host command** — `api` or `ui`; accepts `--wake-root`, `--host`, and
  `--port`.
- **Command primitive** — a small function under `cli/commands/` (e.g.
  `init`, `sandbox`, `doctor`, `self-update`, `smoke`, `sandbox-entrypoint`,
  and the ones wired into `WakeCommand`) performing exactly one CLI action
  against a narrow interface, independent of `parseWakeCommand`'s argument
  grammar.

## Responsibilities and boundaries

Owns:

- Parsing process arguments into a `WakeCommand`, and the validation errors
  that parsing can raise.
- Dispatching a parsed command to the matching member of the application
  facade.
- Shaping output as newline-delimited JSON.
- The standalone command primitives' own narrow behavioural contracts: home
  directory scaffolding, sandbox build/up/down passthrough, resident-process
  supervision inside the container, interactive credential setup, doctor
  diagnostics ordering, self-update idempotency, audit journal reads,
  resource correlation, and smoke passthrough.
- Redacting secret-shaped fields from process log text before it is written
  or displayed.
- Streaming, serialising, rotating, and closing target-owned process logs for
  detached sandbox-start output.

Does not own:

- What a domain application does once a command is dispatched (for example,
  what `tick` actually advances) — that is the composed application's
  behaviour.
- Docker's actual CLI invocation semantics — the Docker CLI primitive only
  wraps an injected `invoke` function; it does not itself shell out.
- Wiring `init`, `sandbox`, `doctor`, `self-update`, or `smoke` into the
  parsed command surface — none is currently reachable from
  `parseWakeCommand`.
- Deciding whether to auto-exec into a sandboxed process. `WakeCliApplications`
  optionally carries a `sandboxRuntime` capability (`hasDockerfile`/`exec`),
  but neither `parseWakeCommand` nor `runWakeCommand` ever reads it; that
  decision belongs to the process entrypoint that composes this facade,
  before `runWakeCommand` is called.

## Core policies, invariants, and behaviours

- Parsing an unrecognized command name for the parsed surface (anything
  other than `tick`, `start`, `stop`, `api`, `ui`, `audit`, `correlate`, or
  `validate-state`) MUST throw before any application is invoked.
- `audit` MUST require exactly one positional argument (the work item id);
  `correlate` MUST require exactly two (resource, then work item id).
  Neither accepts `--wake-root` or any other flag.
- `validate-state` MUST accept only an optional literal `--rebuild-
  projections` flag and no other argument; when present, projections MUST
  be rebuilt before health is read, never after.
- Only resident commands (`tick`/`start`/`stop`) and host commands
  (`api`/`ui`) accept `--wake-root`; only host commands additionally accept
  `--host` and `--port`. A flag not recognized for the command being
  parsed, or a flag missing its value, MUST throw before dispatch.
- `--port` MUST parse to a positive integer no greater than 65535; any other
  value MUST throw.
- `tick` and `start` MUST run under the same default execution budget
  (bounded advances, bounded runs, bounded wall-clock duration); the parsed
  surface does not expose a way to override it.
- `tick`, `correlate`, and `validate-state` MUST each write exactly one JSON
  line summarizing their result; `start` MUST write exactly one JSON line
  when it returns; `audit` MUST write one JSON line per audit record, in the
  order the journal returns them; `stop`, `api`, and `ui` write nothing
  themselves — their applications own any output. `sandbox-entrypoint` also
  writes nothing and, unlike every other operational command, MUST NOT
  return under normal operation.
- `sandbox-entrypoint` MUST keep its container process alive indefinitely
  regardless of whether the resident `wake start` process can run, and, when
  supervision is enabled, MUST restart `wake start` after every exit (any
  exit code), recording the new process's pid to a pid file before waiting
  on its exit and pausing a fixed delay before the next restart.
- `sandbox-setup` MUST unconditionally prepare the Codex home directory and
  ensure an SSH key exists before prompting, then interactively ask, in a
  fixed order (GitHub, then Claude, then Codex, then Cursor), whether to
  configure each provider's auth, skipping any provider the operator
  declines.
- Sandbox image build MUST choose its build context and Dockerfile from
  `host.development.mode`: source mode builds `development.repoRoot` with
  `docker/Dockerfile`; packaged mode builds the wake root with
  `docker/Dockerfile.packaged`. When a build-version resolver is supplied,
  the build MUST pass it as a `WAKE_BUILD_TAG` (source) or `WAKE_VERSION`
  (packaged) build argument.
- Sandbox `setup` and `resume` exec MUST run with the container's working
  directory set to the mounted wake root. Sandbox `up`/container creation MAY
  publish a `127.0.0.1:<port>:<port>` host port mapping when a published
  port is configured.
- Sandbox UI/tunnel environment injection and ngrok forwarding are not
  sandbox capabilities: `WAKE_UI_ENABLED`, `WAKE_UI_PORT`, `WAKE_UI_TOKEN`,
  `WAKE_UI_TUNNEL_ENABLED`, and `NGROK_AUTHTOKEN` MUST NOT be read or passed
  through this Surface. Target API/web configuration is the operator-facing
  replacement; a remote/tunnel feature requires a separately approved design.
- The Docker CLI primitive's resident-liveness check (used to confirm a
  self-update container swap actually came up) MUST poll, up to a bounded
  attempt count with a fixed interval between attempts, for the resident
  process's pid file, a live pid, and the pid's expected cmdline fragment
  all being true inside the container, and MUST throw once attempts are
  exhausted without all three holding.
- `init` MUST refuse to scaffold into a non-empty target directory, and MUST
  create the fixed runtime directory set (`events`, `projections`,
  `checkpoints`, `locks`, `transcripts` under `.wake/`, plus `workspaces`)
  and every supplied asset file before returning.
- `self-update` MUST be idempotent on its own ledger: given the same target
  tag as the last recorded update and no explicit force, it MUST perform no
  update and report no change; a different tag, or an explicit force, MUST
  update and then record the new tag.
- `doctor`, when asked to rebuild projections, MUST do so before running
  diagnostics and reading projection health, so the reported health reflects
  the rebuilt state.
- `audit` MUST read from the canonical event journal, not a projection, and
  MUST select every event whose stream id equals the supplied id, regardless
  of stream kind.
- Process log text MUST have any `token=`, `secret=`, `password=`, or
  `key=`-prefixed value replaced with a fixed redaction marker before being
  written or displayed.
- A process-log sink MUST serialise chunk writes, tee the same scrubbed text
  to its caller and durable target-owned file, and, when configured with a
  byte bound, rotate the existing non-empty file to one `.1` generation before
  appending a chunk that would exceed that bound. A failed write must reject
  its own caller yet leave the queue usable by a later write.
- Detached child output MUST remain attached until Node reports `close` (not
  merely `exit`), then drain queued writes and close the sink. A sink/reporting
  failure is reported but never left as an unhandled rejected drain promise.

## Conceptual schema

**WakeCommand**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `tick` / `start` / `stop` / `api` / `ui` / `audit` / `correlate` / `validate-state` | Which application this invocation dispatches to. |
| `wakeRoot` | path, optional | Visible Wake home root; resident and host commands only. |
| `host` | string, optional | Bind address; host commands only. |
| `port` | integer, 1-65535, optional | Bind port; host commands only. |
| `workItemId` | Wake work item identity | `audit` only. |
| `resource` | resource locator | `correlate` only. |
| `rebuildProjections` | boolean | `validate-state` only; whether to rebuild before reporting health. |

**Audit record**

| Field | Type | Description |
| --- | --- | --- |
| `eventId` | event identity | The journal event's own identity. |
| `eventType` | closed vocabulary | The event's type, as recorded. |
| `occurredAt` | UTC instant | When the event was recorded. |
| `stream` | stream identity | The stream (work item) the event belongs to. |
| `causationId` | causation identity | The command or event that caused this one. |
| `correlationId` | correlation identity | The correlation this event belongs to. |

## Dependencies and system role

- `WakeCliApplications` facade (Bootstrap-composed) — every dispatched
  command's actual behaviour; this component only parses and routes to it.
- Control-plane — the `HostBudget`/`HostResult` shapes `tick` and `start`
  share with this component.
- Kernel — the `EventEnvelope`/`CommandContext` shapes the `audit` and
  `correlate` primitives read and construct.
- Resources — the `ResourceCorrelationRole` vocabulary the `correlate`
  primitive uses to fix the role it requests.
- [HTTP transport](../api/http-transport.spec.md) (depended on indirectly)
  — the `api` and `ui` commands start that same HTTP surface, just with
  differently composed applications and assets.

## Decisions, exclusions, and deferred capability

- `init`, `doctor`, `sandbox`, `sandbox-setup`, `sandbox-entrypoint`,
  `self-update`, and `smoke` are parsed and routed through the operational
  Surface port. `init` executes before composition because it creates the
  root; `doctor`, `sandbox`, `sandbox-entrypoint`, and `smoke` are
  Bootstrap-composed target applications. `self-update` remains a Surface
  command with an injected update boundary.
- `correlate`'s primitive always requests the `Primary` correlation role;
  there is no way to request `Secondary` from the parsed command surface.
- There is no `--no-sandbox` flag or automatic re-exec into a sandboxed
  process at this layer.
- There is no zero-argument interactive sandbox resume picker. `sandbox
  resume` requires an explicit session id, working directory, and runner
  kind; normal agent-session continuation is Execution's generic runner
  request concern rather than a manual sandbox-history UI.
