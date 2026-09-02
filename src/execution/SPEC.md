---
asOf: 5371460dc51a9d9579d5be8485eec965d9eb4ff5
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
  from its `RunPreparationStarted` fact through to a terminal transport status.
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

## Event publishing boundary

Execution owns its event types, payload map, run and activation stream
references, selectors/decoders, and `createExecutionEventData` factory. It
creates immutable event data and appends non-empty batches with expected
sequence; it does not construct envelope metadata or a processor host.

## Ubiquitous language

- **Run** — a single, numbered attempt at one Activation, identified by a
  fresh `RunId`, with its own append-only event history and transport
  status.
- **Attempt** — the 1-based ordinal of a Run among all Runs recorded for the
  same Activation. A new attempt is only created when no completed,
  ambiguous, or currently-leased Run already exists for that Activation.
- **Transport status** — `starting` / `started` / `succeeded` / `failed` /
  `cancelled` / `ambiguous`: what happened to the attempt at the execution-mechanics
  level. This is distinct from an Activity's own outcome (done, blocked,
  rejected, failed), which is opaque data Execution carries but does not
  interpret.
- **Agent run response** — a structured `{outcome, displayBody, artifacts,
  metadata}` record Execution itself derives from an agent-kind runner's raw
  output once its invocation settles, attached to the Run as `agent`. Its
  `outcome` uses the `DONE`/`REJECTED`/`BLOCKED`/`NEEDS_CLARIFICATION`/`FAILED` vocabulary,
  but is Execution's own independent parse of the
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
- **Transcript group** — a filesystem-only conversation for one WorkItem.
  A safe `run` group contains a single run when no agent session is returned;
  a safe `session` group joins turns that share a returned session ID and
  records the CLI identity without using the raw session ID as a path segment.

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
- A `starting` Run has the same active, capacity-consuming, cancellation,
  quiescence, and lease semantics as a `started` Run. A recovery pass whose
  lease finds a `starting` Run expired records its failure without inspecting
  an external execution, because no runner has started yet.
- A failure while releasing an acquired workspace after an attempt has
  already concluded MUST NOT alter the Run's already-recorded terminal
  outcome; it MUST be recorded as a `RunWorkspaceCleanupFailed` diagnostic
  fact instead.
- Before a Git workspace is cloned, its adapter MUST persist a managed
  ownership marker containing the Run ID, WorkItem ID, repository Resource
  ID, workspace mode, workspace ID, and absolute path. This bridges the
  crash window before a workspace is acquired; the Run is already durable as
  `starting` during that work.
- During the existing pre-dispatch recovery pass, a workspace adapter may
  reclaim only a valid marker-owned path below its managed workspace root
  when its owner Run is terminal or absent. Starting, Started, and
  ambiguous owners, unmarked directories, malformed markers, and paths that
  are outside or resolve outside that root MUST be retained for inspection.
- Workspace crash recovery is pause-aware: the existing dispatch pause stops
  the sweep between independent reclaims, so maintenance performs no
  tick-driven deletion. It has no resident reaper, age threshold, or new
  user configuration; repeated recovery is idempotent.
- When transcript capture is enabled, the agent Activity records the exact
  runner prompt before invocation and the raw runner response after it
  settles. These are operational filesystem artifacts, never event,
  projection, or journal content; capture failures are diagnostics and never
  alter a Run outcome.
- Only when pre-dispatch workspace recovery reclaims an owned workspace for a
  closed WorkItem, transcript retention either removes its directory
  immediately when configured as zero, or writes a filesystem-only cleanup
  marker. Later control-plane ticks sweep marked, expired directories;
  recovery, marking, and sweeping are skipped while dispatch is paused, and
  failed filesystem operations are logged and retried by later ticks.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `execution.run-preparation-started` | A new attempt begins | A fresh Run now exists in `starting` status, with its whole-attempt start time and selected runner identity, before workspace preparation. |
| `execution.run-started` | Workspace preparation completes and runner invocation begins | The same Run crosses to `started`, records `executionStartedAt`, and may add its acquired workspace reference. |
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
| `stage` | Stage name, optional | Originating Stage provenance, when the Activation was requested for a Stage. |
| `workflowInstanceId` | Workflow instance identity (owned by Orchestration) | Correlates the Run back to its workflow, opaque to Execution. |
| `orchestrationGroupId` | Orchestration group identity (owned by Orchestration) | Correlation id used on every event this Run produces. |
| `attempt` | positive integer | This Run's 1-based ordinal among Runs for the same Activation. |
| `status` | closed vocabulary: `starting` / `started` / `succeeded` / `failed` / `cancelled` / `ambiguous` | Transport status; terminal once it is neither `starting` nor `started`. |
| `startedAt` | timestamp | When this whole attempt, including workspace preparation, began. |
| `executionStartedAt` | timestamp, optional | When the runner invocation began; absent while `starting` and on a preparation failure. |
| `finishedAt` | timestamp | Set once the Run reaches a terminal status. |
| `duration` | derived milliseconds | `finishedAt - startedAt`, so it covers workspace preparation and execution end to end. |
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
| `outcome` | closed vocabulary: `DONE` / `REJECTED` / `BLOCKED` / `NEEDS_CLARIFICATION` / `FAILED` | Execution's own parse of the runner's raw output; independent of the Activity outcome. |
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
| `stage` | Stage name, optional | Originating Stage provenance, when the Activation was requested for a Stage. |
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
| `awaitImmediateCompletion` | boolean, optional | Gives a deterministic attempt one event-loop turn to observe immediate completion before returning; agent- and script-kind attempts always return after durable preparation. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Run](domain/run.spec.md) | aggregate | The Run stream: creation, terminal recording, and the pure fold that derives `RunView` | Produces the `execution.run-*` facts every other Run-stream component folds or appends alongside. |
| [Run projection](application/execution-projection.spec.md) | projection | The queryable `RunView` per Run, registered for production replay | Rebuilds by reusing the Run aggregate's own fold; callers read it instead of replaying a stream themselves. |
| [Activation claim](application/activation-claim.spec.md) | aggregate | The single-flight claim on the activation-claim stream | Blocks a second concurrent attempt at the same Activation; released when the claiming Run finishes. |
| [Run liveness and cancellation](application/run-liveness-service.spec.md) | policy/process | Lease claim/renewal and the cancellation request/confirm protocol | Keeps a Run's ownership current and lets an operator, Control-plane, or shutdown stop an active Run. |
| [Recovery](application/recovery-service.spec.md) | policy/process | Reconciling an expired-lease Run with its real external execution | Runs before new work is dispatched so a crashed owner's Runs are resolved before they are touched again. |
| [Execution service](application/execution-service.spec.md) | surface application | The `attempt`/`list`/`claim`/cancellation/`shutdown` entry points; runner resolution, resource validation, workspace acquisition, local-execution ownership, and activation-claim orchestration around one attempt | The only path by which Orchestration or Control-plane reaches Execution's behaviour. |
| [Runner adapters](infrastructure/runners/runners.spec.md) | adapter | Translating a `RunnerRequest` into an invoked CLI/process/fake and back into an `AgentRunnerResult` | Invoked by the Execution service once per attempt of an agent-kind Activity; enforces the wall-clock timeout. |
| [Agent run response translation](infrastructure/agent-runner-adapter.spec.md) | adapter | Parsing an agent-kind runner's raw `AgentRunnerResult` output into the structured `AgentRunResponse` attached to `RunRunnerResultReported` | Invoked by the Execution service immediately before recording a runner's result onto the Run; downstream consumers (for example the API surface and Integrations) read `RunView.agent` rather than re-parsing raw output themselves. |
| [Workspace adapters](infrastructure/workspace/workspace.spec.md) | adapter | Preparing and releasing an isolated working directory for a Run | Invoked by the Execution service when a workspace mode other than `none` is requested. |
| [Prompt templates and transcripts](infrastructure/prompt-templates.spec.md) | adapter | Rendering a wake-root prompt template and storing grouped raw prompt/response artifacts | Bootstrap wires the store into the agent Activity when opt-in capture is enabled; API/UI readers use the store through Bootstrap applications. |

## Dependencies and system role

- Eventing — public event journal, envelope, processor, and command-context
  contracts; Execution uses it to read and append its own streams without
  constructing a host or filesystem adapter.
- Kernel — closed-vocabulary and branded-identity helpers.
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

- A further `attempt` call keeps returning the same ambiguous Run unchanged.
  The loopback operator API may explicitly resolve an escalated ambiguity as
  failed with an operator-provided reason; it records a normal terminal
  failure and hands the owning workflow to its existing retry policy. It does
  not replay a Run automatically or accept provider-comment text as authority.
- Runner pool failover only moves within the same pool: when the resolved
  runner is quota-ineligible, Execution tries the next candidate in that
  pool and never crosses to a different pool.
- `RunnerRequest` declares `maxTurns` and `allowedTools` fields shared with
  Activities' agent-runner port. The Claude CLI adapter forwards both fields
  when invoking its underlying process; the Codex and Cursor CLI adapters do
  not read or forward either field. See the Runner adapters specification.
- Transcript capture is opt-in operational storage. Its run/session groups
  and raw prompt/response text are intentionally outside Execution's event
  history; the standard API/UI presentation maps them to CLI-neutral `input`
  and `agent` conversation entries.
- Workspace ownership markers support only the narrow crash-orphan recovery
  policy above. They do not make it safe to delete an active or ambiguous
  Run's workspace, infer ownership from a directory name, or clean up by age.

## Task 27B synchronization (2026-08-02)

Unknown recovery inspection is recorded as a countable ambiguity observation while a Run remains recoverable. At the configured bound, the Run becomes escalated/ambiguous and its owning workflow is blocked. Only an operator may resolve an escalated Run, by appending the normal succeeded or failed result with operator provenance; concurrent resolution is first-write-wins. A branch workspace lease records its branch when available so provider verification can compare agent artifacts to the actual execution branch. Claude CLI forwarding includes configured `maxTurns` and non-empty `allowedTools`.

## Task 27 synchronization (2026-08-10)

Execution passes the durable Run identity to an Activity context. Runner-result
reporting appends idempotently: if a concurrent append advances the stream,
the reporter reloads its sequence and retries the same deterministic event.
