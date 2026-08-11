---
asOf: 03d77755a82091cbe78985c6bf156475bca531f2
---

# Execution — Module Specification

## Purpose and scope

Execution runs a single attempt at an Activity and owns everything that
attempt needs while it is live: the Run's own event history, its lease and
cancellation protocol, the optional workspace it executes in, the runner that
carries it out, and how it is reconciled after a crash. Execution decides
none of the workflow: it is handed an already-identified Activation and
returns a transport-level result: it does not decide what to run next.

## Responsibilities and boundaries

Execution owns:

- Minting and running a `Run`: a single numbered attempt at one Activation,
  from its `RunStarted` fact through to a terminal transport status.
- The lease and cancellation protocol that keeps a Run's ownership current
  and lets an operator or a cascading Work cancellation stop it.
- Resolving a runner from a configured runner pool and invoking it, bounded
  by a wall-clock timeout.
- Acquiring an optional workspace (none, read-only, or branch) for a Run.
- Reconciling a Run whose lease has expired with the real state of its
  external execution (recovery).
- The single-flight guard that prevents two Runs from concurrently
  attempting the same Activation.

Execution does not own:

- Deciding when to dispatch an Activation, what workflow it belongs to, or
  what happens after a Run finishes. That is Orchestration's responsibility;
  Execution only reports a terminal `RunView` back to its caller.
- Interpreting an Activity's `ActivityOutcome` (done, blocked, rejected,
  failed). Execution carries whatever outcome the Activity handler returns
  on a successful Run without inspecting its meaning.
- Selecting a runner pool for an Activation, or deciding a runner is
  globally out of quota. Execution resolves within a pool it is given and
  reports a runner-quota signal; Control-plane decides pause/resume policy.
- Correlating a Run to a provider-side identity, or minting a `WorkItemId`.
  Execution only receives resource views and a `WorkItemId` already minted
  by Work.

## Ubiquitous language

- **Run** — a single, numbered attempt at one Activation, identified by a
  fresh `RunId`, with its own append-only event history and transport
  status.
- **Attempt** — the 1-based ordinal of a Run among all Runs recorded for the
  same Activation. A new attempt is only created when no completed,
  ambiguous, or currently-leased Run already exists for that Activation.
- **Transport status** — `started` / `succeeded` / `failed` / `cancelled` /
  `ambiguous`: what happened to the attempt at the execution-mechanics
  level. This is distinct from an Activity's own outcome (done, blocked,
  rejected, failed), which is opaque data Execution carries but does not
  interpret.
- **Agent run response** — a structured `{outcome, displayBody, artifacts,
  metadata}` record Execution itself derives from an agent-kind runner's raw
  output once its invocation settles, attached to the Run as `agent`. Its
  `outcome` uses the same `DONE`/`REJECTED`/`BLOCKED`/`FAILED` vocabulary as
  an Activity's own outcome, but is Execution's own independent parse of the
  runner's raw text — it is not derived from, and does not substitute for,
  the Activity outcome recorded via `RunSucceeded`.
- **Lease** — a time-bounded ownership claim (`owner`, `acquiredAt`,
  `expiresAt`) over a Run, held by whichever process is currently driving
  it. A Run's lease is distinct from the Activation claim below.
- **Activation claim** — a single-flight guard, keyed by `ActivationId` on
  its own stream, recording which Run currently owns the right to attempt
  that Activation. Prevents two Runs from concurrently attempting the same
  Activation even though Run identity and Activation identity are minted
  independently.
- **Recovery** — reconciling a Run whose lease has expired with the real
  state of its external execution (still running, completed, absent, or
  unknown), producing whichever Run event that reconciliation implies.
- **External execution reference** — an identifier (a process id or a
  remote session id) plus its start time, reported once a runner's
  invocation is under way, that Recovery uses to find the real execution
  again after a crash.
- **Runner** — a pluggable adapter that carries out an Agent-kind Activity
  by invoking an external CLI, process, or remote session, and reports back
  a transport result.
- **Runner pool** — a named, ordered list of runner names; Execution
  resolves the first candidate not currently marked quota-ineligible.
- **Workspace** — an optional isolated working directory (`none`,
  `read-only`, or `branch`) prepared for a Run via a `WorkspaceProvider`.

## Core policies, invariants, and behaviours

- Workspaces are optional: a Run with workspace mode `none` MUST NOT acquire
  one, and Execution MUST NOT require a `WorkspaceProvider` to be configured
  unless a Run actually requests `read-only` or `branch`.
- Attempts never decide workflow state: a Run's terminal status is reported
  back to its caller as data; Execution MUST NOT write any fact owned by
  Orchestration or Work.
- Run events MUST be tied to a Run stream and activation-claim events MUST
  be tied to an activation-claim stream; the two identity kinds are never
  mixed on one stream.
- Every out-of-process runner invocation MUST be bounded by a wall-clock
  timeout that kills the underlying process when exceeded; Execution's
  configuration always resolves a positive timeout (30 minutes unless the
  operator sets otherwise).
- A Run's identity MUST be freshly minted for every genuinely new attempt;
  Execution MUST NOT reuse a `RunId` across attempts at the same Activation.
- Once a Run reaches a terminal transport status (`succeeded`, `failed`,
  `cancelled`, or `ambiguous`), MUST NOT record a further terminal or
  liveness fact for it; a duplicate terminal-recording call MUST be a
  silent no-op rather than an error.
- A further attempt at an Activation that already has a `succeeded` or
  `ambiguous` Run MUST return that existing Run unchanged rather than
  starting a new one.
- A further attempt at an Activation whose most recent Run is `started` and
  currently held under an unexpired lease owned by a different owner MUST
  be rejected.
- A failure while releasing an acquired workspace after an attempt has
  already concluded MUST NOT alter the Run's already-recorded terminal
  outcome; it MUST be recorded as a `RunWorkspaceCleanupFailed` diagnostic
  fact instead.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `execution.run-started` | A new attempt begins | A fresh Run now exists for this Activation, at this attempt number, optionally bound to a runner and workspace. |
| `execution.run-succeeded` | The Activity handler returns without throwing | The attempt finished; its Activity outcome is now attached to the Run. |
| `execution.run-failed` | The attempt throws, or recovery cannot establish a successful outcome | The attempt did not complete; an `ExecutionFailure` describes why. |
| `execution.run-lease-claimed` | An owner first claims a Run | That owner is now responsible for driving this Run to completion. |
| `execution.run-lease-renewed` | The owning process, or recovery, extends the claim | The lease's expiry has moved forward; the Run is still being actively driven. |
| `execution.run-external-execution-reported` | The runner reports an identity for the real process/session it started | Recovery now has something to inspect if this Run's lease later expires. |
| `execution.run-runner-result-reported` | The runner's invocation settles | The transport result, together with Execution's own parsed `agent` run response (outcome, display text, and diagnostic metadata including token usage), is now attached to the Run, independent of whether it ultimately succeeds or fails. |
| `execution.workspace-cleanup-failed` | Releasing an acquired workspace after an attempt has already concluded throws | A diagnostic fact recording why cleanup failed; the Run's already-recorded terminal outcome is unaffected. |
| `execution.run-cancellation-requested` | A cancellation is requested (operator, Work cancellation, or shutdown) | The Run is now marked for cancellation and its in-process execution is signalled to abort. |
| `execution.run-cancellation-confirmed` | The requested cancellation is confirmed | The cancellation request now has a confirmation time. |
| `execution.run-cancelled` | Immediately following confirmation | The Run has reached its terminal `cancelled` status. |
| `execution.run-recovered` | Recovery finds the external execution already completed | The Run's terminal status is derived from the recovered runner result. |
| `execution.run-ambiguous` | Recovery cannot determine what happened to the external execution | The Run is terminal but its real outcome is unknown and requires attention outside Execution. |
| `execution.activation-claimed` | A Run claims the single-flight right to attempt an Activation | No other Run may attempt this Activation while the claim is unexpired. |
| `execution.activation-released` | The claiming Run finishes (success, failure, or cancellation) | The Activation is free for a future attempt to claim again. |

## Conceptual schema

**RunView**

| Field | Type | Description |
| --- | --- | --- |
| `runId` | Run identity | Freshly minted per attempt; never reused. |
| `activationId` | Activation identity (owned by Activities) | The Activation this Run is attempting. |
| `activity` | Activity name (owned by Activities) | Which Activity definition is being run. |
| `workflowInstanceId` | Workflow instance identity (owned by Orchestration) | Correlates the Run back to its workflow, opaque to Execution. |
| `orchestrationGroupId` | Orchestration group identity (owned by Orchestration) | Correlation id used on every event this Run produces. |
| `attempt` | positive integer | This Run's 1-based ordinal among Runs for the same Activation. |
| `status` | closed vocabulary: `started` / `succeeded` / `failed` / `cancelled` / `ambiguous` | Transport status; terminal once anything but `started`. |
| `startedAt` | timestamp | When this attempt began. |
| `finishedAt` | timestamp | Set once the Run reaches a terminal status. |
| `runner` | Runner descriptor | Which runner (and model/effort/pool/cli) this Run is bound to, if the Activity is agent-kind. |
| `workspace` | Workspace reference | The acquired workspace's mode and path, if one was requested. |
| `outcome` | Activity outcome (owned by Activities) | Carried opaquely on `succeeded`; Execution does not interpret it. |
| `failure` | Execution failure | Carried on `failed` and `ambiguous`. |
| `lease` | Lease | Current ownership claim over this Run; see the liveness component. |
| `externalExecution` | External execution reference | What Recovery inspects if the lease expires. |
| `agent` | Agent run response | Execution's own parsed record of an agent-kind runner's raw output, once reported; see below. Absent on a Run recorded before this field existed, and never set by Recovery's recorded-result path. |
| `cancellation` | Cancellation | Present once a cancellation has been requested for this Run. |

**Agent run response**

| Field | Type | Description |
| --- | --- | --- |
| `outcome` | closed vocabulary: `DONE` / `REJECTED` / `BLOCKED` / `FAILED` | Execution's own parse of the runner's raw output; shares its vocabulary with, but is independent of, an Activity's own outcome. |
| `displayBody` | string | Human-readable text extracted from the runner's raw output, for display outside Execution. |
| `artifacts` | list of `{kind, externalKey}`, optional | Reserved for artifacts the agent reported inline in its output; not currently populated by Execution's own parse. |
| `metadata` | open map of string to scalar | Diagnostic values carried from the runner's result (runner name, model, session id, and token/cost counters when available); `agentTokenUsage()` recovers a token-usage summary from it. |

**Execution failure**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `unexpected-execution-failure` | Execution has exactly one failure kind; the failing cause is preserved underneath. |
| `message` | string | Human-readable description of the failure. |
| `details.sourceKind` | string | The underlying error's own kind/name, captured best-effort. |
| `details.sourceDetails` | open value | Any additional structured detail the underlying error carried. |

**ExecutionActivation** (the attempt request)

| Field | Type | Description |
| --- | --- | --- |
| `activationId` | Activation identity | Identity of the Activation being attempted. |
| `ordinal` | integer | The Activation's position, as assigned by Orchestration. |
| `activity` | Activity name | Which Activity definition to run. |
| `input` | open value | The Activity's input, validated by Activities before execution. |
| `execution.workspace` | closed vocabulary: `none` / `read-only` / `branch`, optional | Requested workspace mode; absent means `none`. |
| `execution.runnerPool` | string, optional | Requested runner pool; absent means the configured default pool. |

**ExecutionAttemptContext** (the attempt context)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity (owned by Work) | Used to key a workspace path and template context; never mutated. |
| `workflowInstanceId` | Workflow instance identity | Recorded onto the Run for correlation. |
| `orchestrationGroupId` | Orchestration group identity | Recorded onto the Run for correlation. |
| `resources` | list of Resource view | Resources available to validate the Activity's requirements against and to acquire a workspace from. |
| `owner` | string, optional | Lease owner identity for this attempt; defaults to `"execution"`. |
| `ineligibleRunners` | set of string, optional | Runner names currently quota-paused, supplied by Control-plane. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Run](domain/run.spec.md) | aggregate | The Run stream: creation, terminal recording, and the pure fold that derives `RunView` | Produces the `execution.run-*` facts every other Run-stream component folds or appends alongside. |
| [Run projection](application/execution-projection.spec.md) | projection | The queryable `RunView` per Run, registered for production replay | Rebuilds by reusing the Run aggregate's own fold; callers read it instead of replaying a stream themselves. |
| [Activation claim](application/activation-claim.spec.md) | aggregate | The single-flight claim on the activation-claim stream | Blocks a second concurrent attempt at the same Activation; released when the claiming Run finishes. |
| [Run liveness and cancellation](application/run-liveness-service.spec.md) | policy/process | Lease claim/renewal and the cancellation request/confirm protocol | Keeps a Run's ownership current and lets an operator, Control-plane, or shutdown stop an active Run. |
| [Recovery](application/recovery-service.spec.md) | policy/process | Reconciling an expired-lease Run with its real external execution | Runs before new work is dispatched so a crashed owner's Runs are resolved before they are touched again. |
| [Execution service](application/execution-service.spec.md) | surface application | The `attempt`/`list`/`claim`/cancellation entry points; runner resolution, resource validation, workspace acquisition, and activation-claim orchestration around one attempt | The only path by which Orchestration or Control-plane reaches Execution's behaviour. |
| [Runner adapters](infrastructure/runners/runners.spec.md) | adapter | Translating a `RunnerRequest` into an invoked CLI/process/fake and back into an `AgentRunnerResult` | Invoked by the Execution service once per attempt of an agent-kind Activity; enforces the wall-clock timeout. |
| [Agent run response translation](infrastructure/agent-runner-adapter.spec.md) | adapter | Parsing an agent-kind runner's raw `AgentRunnerResult` output into the structured `AgentRunResponse` attached to `RunRunnerResultReported` | Invoked by the Execution service immediately before recording a runner's result onto the Run; downstream consumers (for example the API surface and Integrations) read `RunView.agent` rather than re-parsing raw output themselves. |
| [Workspace adapters](infrastructure/workspace/workspace.spec.md) | adapter | Preparing and releasing an isolated working directory for a Run | Invoked by the Execution service when a workspace mode other than `none` is requested. |
| [Prompt templates and transcripts](infrastructure/prompt-templates.spec.md) | adapter | Rendering a wake-root prompt template into a prompt string, and persisting prompt/response text | Used by the agent Activity handler (via Bootstrap wiring) to build the prompt a runner receives. |

## Dependencies and system role

- Kernel — event journal, envelope, projection registration, closed
  vocabulary and branded-identity helpers, and command context conventions;
  Execution's foundation for reading and appending its own streams.
- Activities (Execution depends on) — the `ActivityRegistry` that validates
  an Activation's input and resources and executes its handler; Execution
  supplies that handler an `ActivityExecutionContext` bound to a resolved
  runner.
- Resources (Execution depends on) — supplies the `ResourceView`s an attempt
  validates its Activity's resource requirements against, and the
  repository resource a workspace is acquired from.
- Work (Execution depends on) — supplies the `WorkItemId` an attempt is
  scoped to; Execution never mutates Work state.
- Orchestration (depends on Execution) — calls `attempt`, `list`, and
  `recoverActive` to run and track the Activities a workflow dispatches;
  Execution never calls back into Orchestration.
- Control-plane (depends on Execution) — calls `cancelActive` to cascade a
  Work cancellation into every active Run of the affected workflows, and
  receives a runner-quota signal that it turns into a runner-pause fact.
- Bootstrap (depends on Execution) — the only place concrete Runner and
  Workspace adapters, prompt templates, and the runner-quota callback are
  composed into a working `ExecutionDependencies`.

## Decisions, exclusions, and deferred capability

- There is no command to resolve or retry an `ambiguous` Run from within
  Execution. Recovery only records the ambiguity; a further `attempt` call
  keeps returning the same ambiguous Run unchanged.
- Runner pool failover only moves within the same pool: when the resolved
  runner is quota-ineligible, Execution tries the next candidate in that
  pool and never crosses to a different pool.
- `RunnerRequest` declares `maxTurns` and `allowedTools` fields shared with
  Activities' agent-runner port, but the current CLI-based runner adapters
  do not read or forward either field when invoking their underlying
  process; see the Runner adapters specification.
- Transcript persistence (prompt/response text per Run) exists as
  infrastructure but is not yet wired into the production attempt flow.

## Task 27B synchronization (2026-08-02)

Unknown recovery inspection is recorded as a countable ambiguity observation while a Run remains recoverable. At the configured bound, the Run becomes escalated/ambiguous and its owning workflow is blocked. Only an operator may resolve an escalated Run, by appending the normal succeeded or failed result with operator provenance; concurrent resolution is first-write-wins. A branch workspace lease records its branch when available so provider verification can compare agent artifacts to the actual execution branch. Claude CLI forwarding includes configured `maxTurns` and non-empty `allowedTools`.

## Task 27 synchronization (2026-08-10)

Execution passes the durable Run identity to an Activity context. Runner-result
reporting appends idempotently: if a concurrent append advances the stream,
the reporter reloads its sequence and retries the same deterministic event.
