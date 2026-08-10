# Runner adapters — Component Specification

## Type, purpose, and scope

Adapter. The runner adapters translate a `RunnerRequest` into an invocation
of an external agent CLI, an arbitrary command, or an in-process fake, and
translate whatever that invocation produces back into an `AgentRunnerResult`.
They are the only place Execution reaches outside the process to carry out
an agent-kind Activity.

## Ubiquitous language

See the module specification for Runner and Runner pool. This component
additionally distinguishes the **transport result** a runner reports
(`succeeded` / `failed` / `cancelled` / `ambiguous`, carried in
`AgentRunnerResult.transport`) from the **process exit** that produced it for a
CLI-based runner (exit code, timeout flag) — the mapping between the two is
this component's own translation, not a pass-through of the OS exit code.

## Responsibilities and boundaries

Runner adapters own starting an agent invocation, enforcing its wall-clock
timeout, reporting an external-execution identity where one is available,
and resolving to a final `AgentRunnerResult` once the invocation settles.
They do not decide which runner or pool to use — the Execution service
resolves a runner and invokes it — and they do not interpret the agent's own
output for workflow purposes; translating an `AgentRunnerResult` into an
Activity outcome remains the agent Activity handler's responsibility.
Parsing a runner's raw output into Execution's own `AgentRunResponse` record
is owned by a separate component (Agent run response translation), not by
this one.

## Core policies, invariants, and behaviours

**Shared CLI runner contract** (`claude-cli`, `codex-cli`, `cursor-cli`,
`command`)

- Every CLI-based runner MUST spawn its configured command as a real OS
  process, without a shell, using the request's `workspacePath` as its
  working directory when one is given.
- Every out-of-process invocation MUST be bounded by a wall-clock timeout
  that kills the child process when it is exceeded; production wiring
  always resolves a positive timeout for a configured runner (30 minutes
  unless the operator sets a different value), but the underlying runner
  factory itself accepts an absent timeout and enforces none if constructed
  without one — the guarantee holds because Bootstrap always supplies the
  resolved configuration value, not because the adapter enforces a minimum.
- On a timeout, the runner MUST report transport `failed` with failure kind
  `timeout` and a message naming the configured timeout; this is a
  transport-level failure only — the timeout does not by itself invoke
  Execution's cancellation protocol, and the Run's own transport status
  becomes whatever the Activity handler subsequently returns for it.
- On a clean exit with code zero and no timeout, the runner MUST report
  transport `succeeded` with the process's captured standard output as
  `output`. On any other exit, the runner MUST report transport `failed`
  with failure kind `process-exit` and a message drawn from standard error,
  or the exit code when standard error is empty.
- Aborting the request's signal (from a cancellation request) MUST kill the
  child process. A killed process is still resolved through the same
  succeeded/failed exit-code branching as any other exit — the CLI runner
  contract does not produce a `cancelled` transport result for an aborted
  invocation.
- `RunnerRequest` declares `maxTurns` and `allowedTools`; none of the
  CLI-based runners read or forward either field into the invoked process's
  arguments. The `claude-cli`, `codex-cli`, and `cursor-cli` variants build
  their arguments from the request's `prompt` and, when present, `model`
  (and, for `codex-cli` only, `resumeSessionId`); the `command` variant
  ignores the request entirely and always invokes its configured command
  with its configured static arguments, so it does not forward the
  request's prompt, model, or any other field.
- The external-execution identity reported for a CLI-based runner MUST use
  the request's own `runId` as the identity's `id` — not an OS process id —
  with kind `process`. This is what Recovery's inspector later receives to
  find the real execution again.

**Fake runner**

- The fake runner MAY be constructed with a `FakeScenarioResolver`; when
  none is supplied it defaults to a resolver that never matches anything.
  When the request carries a `context` (runner name, action, and activation
  ordinal), the fake runner MUST look up a scenario keyed by that triple
  before falling back to its legacy sentinel-marker behaviour.
- When a scenario matches, the fake runner MUST wait the scenario's
  resolved delay before resolving, and MUST report the scenario's own
  `outcome` (and, when present, its `displayBody`) as the encoded sentinel
  `status`. A `FAILED` outcome with no scenario-specified `retrySafety`
  still defaults to `retrySafety: 'safe-to-retry'`, matching the legacy
  marker path below.
- A zero-delay resolution (no scenario matched, or a matched scenario whose
  delay is `0`) MUST resolve immediately without observing the abort
  signal, and MUST always report transport `succeeded` — the fake runner
  never itself reports a transport-level failure in this case. With no
  scenario matched, it selects a sentinel `status` of `FAILED`, `BLOCKED`,
  or `DONE` by checking the request's prompt text for the literal markers
  `[fake:failed]` and `[fake:blocked]` (defaulting to `DONE`), and encodes
  that status as its `output`, so sentinel failure/block outcomes are
  exercised without a transport failure.
- A nonzero scenario delay MUST observe the abort signal while waiting: an
  abort during the wait MUST reject the execution's `result` promise
  instead of resolving it, rather than produce a transport-level
  `cancelled` result — no adapter in this component ever reports transport
  `cancelled`.
- The fake runner never reports an external-execution identity, so Recovery
  is never engaged for a fake-runner Run.

**Fake scenario resolution** (`fake-scenarios.ts`)

- Parsing a scenario file MUST validate it against a strict schema
  (`schemaVersion: 1` plus a `rules` list) and MUST reject a file
  containing two rules with the same `name`. A `retrySafety` value MUST be
  rejected on any rule whose `outcome` is not `FAILED`.
- Resolving a match MUST return the first configured rule whose `when`
  matches the given runner name and action exactly, and whose `when.occurrence`
  is either absent or equal to the given activation ordinal; no match
  returns nothing rather than a default scenario.
- A rule's `afterMs` MAY be a fixed positive integer, or a `{min, max,
  seed}` range; a range MUST resolve to a value deterministically derived
  from the seed and the matched runner name, action, and occurrence — the
  same match against the same rule always resolves to the same delay.
- Loading and validating `fake-scenarios.yaml` into this contract is owned
  by Bootstrap, not this component; see its own specification.

**Runner pool resolution**

- Resolving a pool MUST reject when the named pool is not configured.
  Within a configured pool, resolution MUST return the first candidate name
  not present in the caller-supplied ineligible set, and MUST reject when a
  listed candidate name has no registered runner, or when every candidate
  in the pool is ineligible.

## Conceptual schema

**RunnerRequest**

| Field | Type | Description |
| --- | --- | --- |
| `runId` | Run identity | Identifies the invocation; used as the CLI-based runners' external-execution identity. |
| `prompt` | string | The rendered prompt text. |
| `context` | `{runnerName, action, activationOrdinal}`, optional | Supplied by the Execution service when a runner was resolved; read only by the fake runner, to match a scripted scenario rule. No CLI-based runner reads it. |
| `model` | string, optional | Overrides the runner's own default model, when the adapter reads it. |
| `workspacePath` | string, optional | Working directory for a spawned process. |
| `allowedTools` | list of string | Declared but not read by any current CLI-based or fake adapter. |
| `maxTurns` | integer, optional | Declared but not read by any current CLI-based or fake adapter. |
| `resumeSessionId` | string, optional | Read only by the `codex-cli` adapter, to resume a prior session. |

**AgentRunnerResult**

| Field | Type | Description |
| --- | --- | --- |
| `transport` | closed vocabulary: `succeeded` / `failed` / `cancelled` / `ambiguous` | What happened to the invocation. Current adapters only ever report `succeeded` or `failed`; `cancelled` and `ambiguous` are permitted by the contract for a future adapter (for example a remote-session runner able to ask a provider directly) but unreached by any adapter read here. |
| `output` | string | Captured standard output (CLI-based) or the encoded sentinel (fake). |
| `runner` | string | The runner's own name, echoed onto the result. |
| `model` | string, optional | Echoed back when the request specified one. |
| `sessionId` | string, optional | Not populated by any current adapter. |
| `tokenUsage` | Token usage, optional | Not populated by any current adapter. |
| `failure` | `{ kind, message }`, optional | Present on a non-`succeeded` transport; `kind` is an open string (`timeout`, `process-exit`, or provider-specific values such as `provider-quota-exceeded`), not a closed vocabulary. |

**Fake scenario rule** (validated from an operator-supplied scenario file)

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Unique label for the rule within its file; a duplicate name fails validation. |
| `when.runner` | string | Matches the invoking runner's configured name. |
| `when.action` | string | Matches the Activity's action/template name. |
| `when.occurrence` | positive integer, optional | Matches a specific activation ordinal; absent matches any ordinal. |
| `afterMs` | positive integer, or `{min, max, seed}` | Delay before the fake runner resolves; a range resolves deterministically from `seed` plus the matched runner/action/occurrence. |
| `outcome` | closed vocabulary: `DONE` / `REJECTED` / `BLOCKED` / `FAILED` | The sentinel status the fake runner reports. |
| `retrySafety` | closed vocabulary: `safe-to-retry`, optional | Only valid when `outcome` is `FAILED`. |
| `displayBody` | string, optional | Overrides the sentinel envelope's default display text. |

## Dependencies and system role

- `node:child_process` — the external effect boundary every CLI-based
  runner spawns through.
- Execution service (depends on) — resolves a runner from the registry and
  invokes `.start()` exactly once per attempt of an agent-kind Activity,
  translating the returned identity and result into recorded Run facts.
- Bootstrap (depends on) — the only place a named `agentRunners` config
  entry is turned into a concrete runner instance and placed into a
  `RunnerRegistry`, always supplying the configuration-resolved timeout;
  also the only place that loads and validates an optional
  `fake-scenarios.yaml` into a `FakeScenarioResolver` via
  `parseFakeScenarios`, then constructs each `fake`-kind runner with it.
- Recovery (indirectly depends on) — the external-execution identity a
  CLI-based runner reports is what an `ExternalExecutionInspector` is later
  given to find the real process again after a crash.

## Decisions, exclusions, and deferred capability

- `maxTurns` and `allowedTools` are carried on the shared port but not
  consumed by any current adapter; see the module specification's own
  deferred-capability note.
- The `command` runner variant does not forward any part of the request
  (prompt, model, or otherwise) to its invoked process; it is only useful
  for a fixed, request-independent command.
- No adapter streams partial output; the full captured output is only
  available once the underlying process or fake invocation has fully
  settled.
- There is no scenario "consumption": a matched rule can resolve the same
  way for every request that matches its `when` clause; nothing marks a
  rule as already used or advances it to a different outcome after one
  match.
