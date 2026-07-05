# Wake Skeleton Design

## Goal

Build the first Wake implementation as a TypeScript Node control-plane skeleton.
It should exercise the core loop end to end with durable file-backed state and
fake adapters, without depending on real GitHub or coding-agent execution.

## Scope

This design covers the first implementation pass only:

- a Node + TypeScript application skeleton
- a CLI with `start` and `tick` commands
- a resident control-plane loop and single-tick execution path
- a file-backed state store shaped around the documented Wake home
- explicit lifecycle and transition primitives
- fake adapters for GitHub, workspace preparation, and agent execution
- tests for the control-plane contract and critical parsing behavior
- architecture and code-consistency documentation for future contributors

This design explicitly excludes:

- real `gh` integration
- real `claude` or other agent CLI invocation
- Docker packaging
- usage-limit handling beyond placeholder extension seams
- repository-specific implementation logic
- Part 2 workflow/plugin generalization

## Design Summary

Wake will be implemented as a modular Node application where the control plane
depends on narrow interfaces rather than concrete shell commands. The first pass
will prove the architecture with a deterministic fake lifecycle: load config,
evaluate gates, acquire a tick lock, list candidate work, choose one stage
action, write a `running` run record, execute through a fake runner, parse the
sentinel from the JSON result, persist the outcome, and release the lock.

The skeleton should feel like the real system in structure, but not in
integration depth. It should be easy to replace fake adapters with real ones
later without changing the core loop or state model.

## Architecture

### Module boundaries

The repository will be organized around clear responsibilities:

- `src/cli/`
  - command entrypoints and argument parsing
  - `start` runs the resident interval loop
  - `tick` executes one control-plane tick and exits
- `src/core/`
  - control-plane orchestration
  - tick runner
  - policy evaluation
  - lifecycle coordination
- `src/domain/`
  - pure types and lifecycle/state definitions
  - stage transition helpers
  - run result and sentinel models
- `src/config/`
  - config schema, defaults, and config loading
- `src/adapters/`
  - filesystem-backed implementations and fake adapters
  - fake GitHub work source
  - fake agent runner
  - workspace manager skeleton
- `src/lib/`
  - focused shared utilities such as paths, logging, locking, clock, JSON IO,
    and sentinel parsing
- `test/`
  - unit and integration-style tests using temp directories and fake adapters

### Core control-plane objects

The skeleton should establish these main responsibilities:

- `ControlPlane`
  - owns startup wiring and resident execution
  - constructs dependencies and invokes a tick runner
- `TickRunner`
  - executes one complete tick
  - enforces lock acquisition and release
  - persists run records before side effects
  - returns a structured tick outcome
- `PolicyEngine`
  - evaluates pause file, quiet hours, and simple eligibility gates
  - chooses the next action deterministically
- `LifecycleService`
  - maps issue state + runner result into explicit stage transitions
- `StateStore`
  - owns reads and writes for config, ledger, per-issue state, runs, and logs
- `WorkSource`
  - interface for listing items and posting state/comment changes
- `AgentRunner`
  - interface for stage execution returning JSON result payloads
- `WorkspaceManager`
  - interface for preparing and cleaning ephemeral code workspaces

No core module should call shell tools directly. Shell execution belongs behind
adapter seams added later.

## Domain model

### Lifecycle stages

The skeleton should model the documented stage set now:

- `queue`
- `refined`
- `active`
- `blocked`
- `done`
- `failed`

The fake lifecycle does not need full refine/implement prompts yet, but the
types and transitions should assume those stages are real and durable.

### Work item state

Each work item record should support at least:

- repository identifier
- issue number and title
- current stage
- attempt count
- last run id
- optional workspace path
- optional current or last session id
- timestamps for creation and last update
- small history of stage transitions

### Run record

Each invocation should create a run record containing at least:

- run id
- repo and issue identity
- chosen stage action
- status: `running`, `completed`, `blocked`, `failed`
- started and finished timestamps
- runner metadata
- captured `session_id` when present
- parsed sentinel
- summary result text or failure reason

The run record must be written with status `running` before invoking the runner.
That preserves the crash-recovery contract from the design docs.

## Durable filesystem layout

The code should model a Wake home layout compatible with the docs:

```text
.wake/
  config.json
  ledger.json
  state/<repo>/<issue>.json
  runs/<run-id>.json
  logs/<date>.log
  PAUSE
  workspaces/<repo>/<issue>/
```

For local development and tests, the root path should be configurable. The
default can be a repo-local `.wake/` path for now. The code must treat the state
store as the source of truth and keep workspace contents separate from central
state.

## Fake adapters

### Fake GitHub work source

The fake work source should allow tests and local runs to exercise the lifecycle
without network access. It can read work items from local JSON fixtures or from
state-store-backed seed data and should support:

- listing candidate items
- recording label/state changes
- recording comments
- detecting whether the latest comment is Wake-authored via `<!-- wake -->`

### Fake runner

The fake runner is a permanent test harness, not throwaway scaffolding. It
should return a structured object matching the future real contract:

- JSON result payload
- `result` string containing free text plus a sentinel
- optional `session_id`
- optional raw metadata for diagnostics

Sentinel parsing must inspect the JSON `result` string and choose the last
occurrence of `DONE`, `BLOCKED`, or `FAILED`. If no sentinel is found, treat the
run as `FAILED`.

### Workspace manager skeleton

The workspace manager should initially create and clean local directories only.
Its purpose in the skeleton is to establish where workspace preparation belongs,
not to perform real clone/install work yet.

## CLI behavior

### `wake tick`

Runs one control-plane tick and exits. Intended for tests, local development,
and future schedulers or supervisors. It should emit a concise summary to stdout
and structured logs to the state store.

### `wake start`

Runs the resident loop using configured interval timing. It should:

- load config once at startup
- repeatedly invoke the tick runner
- catch and log tick-level failures
- sleep between ticks
- terminate cleanly on process signals

The resident loop must remain thin. Most behavior belongs in the tick path so it
is testable without a long-running process.

## Code consistency rules

The skeleton should document and follow these conventions from the start:

- Keep domain modules pure and free of filesystem or process dependencies.
- Keep adapters narrow and replaceable; core code depends on interfaces.
- Prefer small files with one clear responsibility.
- Put pure decision logic into functions that can be tested without mocks.
- Persist durable state before and after side effects; avoid hidden in-memory
  state.
- Avoid framework-heavy abstractions until real integration pressure exists.
- Use explicit result objects instead of throwing for expected routing outcomes.
- Make fake adapters production-shaped enough that replacing them does not
  require rewriting tests.

## Testing strategy

The first implementation pass should prove the non-negotiable contracts:

1. Sentinel parsing
   - parses the last sentinel occurrence from JSON `result`
   - fails closed when no sentinel exists
2. Wake comment ownership
   - latest comment containing `<!-- wake -->` counts as Wake-authored
   - latest comment without the marker counts as human-authored
3. Crash-safe run persistence
   - run record is written as `running` before runner execution
4. Tick orchestration
   - a fake queued item can move through one skeleton stage action
   - lock acquisition prevents overlapping ticks
   - pause file blocks execution cleanly
5. Resident loop smoke behavior
   - `start` can invoke repeated ticks with fake dependencies and stop cleanly

Tests should use temp directories and real filesystem IO where practical. The
goal is to validate the actual file-backed control-plane behavior, not a mocked
fantasy version of it.

## Implementation sequencing

The implementation should proceed in this order:

1. bootstrap Node + TypeScript project and test runner
2. define domain types and lifecycle primitives
3. build config/path/state-store foundations
4. add locking, logging, and sentinel parsing utilities
5. add fake adapters
6. implement tick runner and control plane
7. add CLI entrypoints for `tick` and `start`
8. add architecture documentation and contributor conventions
9. finish with tests covering the core contracts

## Risks and guardrails

- Do not let fake adapters leak ad hoc behaviors into the core interfaces.
- Do not collapse orchestration into the CLI layer.
- Do not let workspace directories become the source of truth for task state.
- Do not hard-code future real runner assumptions into the core loop.
- Do not add Part 2 plugin/workflow systems yet; explicit lifecycle support is
  enough for the skeleton.

## Acceptance criteria

The skeleton is complete when:

- the repo contains a working TypeScript Node application
- `wake tick` can run against fake adapters and produce durable state changes
- `wake start` can run a resident loop with the same tick path
- run records are written before fake execution begins
- sentinel parsing and Wake-comment ownership rules are covered by tests
- the repo contains a concise architecture/conventions document for future work
- the code boundaries make it straightforward to swap fake adapters for real
  ones later without rewriting the control-plane core
