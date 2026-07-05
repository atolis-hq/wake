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
- explicit durable schemas for state-of-record files
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

The durable filesystem is not just persistence glue. It is one of the control
plane's primary operating surfaces. State files must therefore have explicit,
validated shapes that deterministic scripts can rely on, while still leaving
room for agent-readable supplemental data bundled alongside the canonical fields.

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
  - durable schema definitions and versioned record shapes
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
- synced GitHub issue snapshot fields needed for deterministic routing
- synced comments in a stable, parseable structure
- an extensible metadata payload for agent-readable supplemental context

The work item state file is the durable local mirror of the GitHub issue and its
relevant comments. Wake is responsible for synchronizing GitHub issue data into
this file shape. Deterministic control-plane code should depend only on the
canonical top-level fields and documented nested structures, while agents may
read additional bundled metadata without the control plane depending on it.

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

### Schema and validation rules

Durable files that represent state-of-record must have both:

- static TypeScript types for in-process use
- runtime schemas for read/write validation

The first pass should use versioned schemas for:

- `config.json`
- `ledger.json`
- per-issue state files
- run record files

The purpose is not heavy framework machinery. The purpose is to ensure the tick
really is a deterministic function of durable inputs, and that future migrations
can evolve file shapes without silent corruption or ambiguous reads.

## Durable filesystem layout

The code should model a Wake home layout compatible with the docs:

```text
.wake/
  config.json
  ledger.json
  state/<repo>/<issue>.json
  runs/<run-id>.json
  events/<date>.jsonl
  logs/<date>.log
  PAUSE
  workspaces/<repo>/<issue>/
```

For local development and tests, the root path should be configurable. The
default can be a repo-local `.wake/` path for now. The code must treat the state
store as the source of truth and keep workspace contents separate from central
state.

### State file structure expectations

Per-issue state files should separate canonical control-plane fields from
extensible supplemental data. The shape should be explicit enough that scripts
can deterministically consume it without guessing. At a minimum, the state file
should contain sections equivalent to:

- `schemaVersion`
- `issue`
  - repo, number, title, body, labels, assignees, state, timestamps, url
- `comments`
  - ordered comment snapshots with stable ids, body, author metadata, created
    and updated timestamps, and a derived `isWakeAuthored` flag
- `wake`
  - current stage, attempts, last run id, session refs, workspace refs, stage
    history, pause/block metadata, sync timestamps
- `context`
  - optional bundled agent-readable supplemental information that deterministic
    scripts must not require for correctness

This separation keeps the deterministic control-plane contract stable while
allowing future agent-facing context to grow without rewriting the core scripts.

### Event audits

Wake should write append-only event audits as a first-class durable artifact.
These are not just logs. They are structured records of the decisions and state
transitions that drive the control plane and support replay, diagnostics, and
future deterministic jobs.

Event records should capture things like:

- issue sync completed
- stage transition decided
- run claimed
- runner completed with sentinel
- pause gate blocked execution
- human comment detected on a blocked item

The initial format can be JSON Lines under `events/<date>.jsonl`, with each
record containing a timestamp, event type, repo/issue identity where relevant,
and a compact payload. Logs remain human-oriented text; events are structured
audit data for automation.

## Fake adapters

### Fake GitHub work source

The fake work source should allow tests and local runs to exercise the lifecycle
without network access. It can read work items from local JSON fixtures or from
state-store-backed seed data and should support:

- listing candidate items
- syncing canonical issue and comment snapshots into per-issue state files
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
- Keep state-of-record schemas explicit and versioned.
- Separate canonical deterministic fields from extensible agent-readable
  context.
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
   - fake issue sync populates canonical issue/comment state files
   - a fake queued item can move through one skeleton stage action
   - lock acquisition prevents overlapping ticks
   - pause file blocks execution cleanly
5. Event audit generation
   - syncs and transitions emit structured event records
   - event payloads are parseable and tied to issue/run identifiers
6. Resident loop smoke behavior
   - `start` can invoke repeated ticks with fake dependencies and stop cleanly

Tests should use temp directories and real filesystem IO where practical. The
goal is to validate the actual file-backed control-plane behavior, not a mocked
fantasy version of it.

## Implementation sequencing

The implementation should proceed in this order:

1. bootstrap Node + TypeScript project and test runner
2. define domain types and lifecycle primitives
3. define versioned durable schemas for config, ledger, issue state, run record,
   and event records
4. build config/path/state-store foundations
5. add issue-sync and event-audit writing support
6. add locking, logging, and sentinel parsing utilities
7. add fake adapters
8. implement tick runner and control plane
9. add CLI entrypoints for `tick` and `start`
10. add architecture documentation and contributor conventions
11. finish with tests covering the core contracts

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
- issue and comment data are synchronized into explicit per-issue state files
- `wake start` can run a resident loop with the same tick path
- run records are written before fake execution begins
- structured event audits are emitted for sync and lifecycle decisions
- sentinel parsing and Wake-comment ownership rules are covered by tests
- the repo contains a concise architecture/conventions document for future work
- the code boundaries make it straightforward to swap fake adapters for real
  ones later without rewriting the control-plane core
