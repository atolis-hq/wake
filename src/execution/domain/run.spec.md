# Run — Component Specification

## Type, purpose, and scope

Aggregate. Run is the stream-owning aggregate for a single, numbered attempt
at one Activation. It is the source of the attempt's creation and terminal
outcome facts, and the pure fold that derives its current `RunView` from the
full history of its own stream — including the liveness, cancellation, and
recovery facts that sibling components record onto the same stream.

## Ubiquitous language

See the module specification for Run, Attempt, and Transport status. This
component additionally treats **active** as `starting` or `started`, and
**terminal** as `succeeded`, `failed`, `cancelled`, or `ambiguous`.

## Responsibilities and boundaries

Run owns the `RunPreparationStarted`, `RunStarted`, `RunSucceeded`, and `RunFailed` facts and the
fold that turns the whole Run stream into a `RunView`. It does not decide
*whether* a new attempt is warranted, resolve a runner or workspace, or
manage the activation-claim single-flight guard — that is the Execution
service's responsibility. It does not itself record lease, cancellation, or
recovery facts, but its fold applies them, since they share its stream.

## Core policies, invariants, and behaviours

**Creation**

- Starting a Run MUST append `RunPreparationStarted` as the first event on a
  fresh `RunId`'s stream (at sequence 0). The event records the Activation,
  activity, optional originating Stage provenance, workflow correlation ids,
  a positive attempt number, whole-attempt `startedAt`, and optionally a
  selected runner descriptor. Its fold is `starting`.
- `RunStarted` is the later runner-execution boundary. It is valid only for a
  `starting` Run, carries `executionStartedAt` and an optional acquired
  workspace reference, and moves that same Run to `started`. Historical
  streams whose first fact is `RunStarted` remain valid and fold as started
  attempts with their `startedAt` also serving as `executionStartedAt`.
- Starting a Run MUST also append its initial lease claim for the starting owner
  in the same sequence-0 batch (see the liveness component); a Run is never left
  without an owner between creation and its first lease fact.

**Fold**

- The fold MUST return `null` when neither `RunPreparationStarted` nor a
  historical first `RunStarted` fact is present for the stream.
- The fold MUST derive every field from the stream's events in append
  order; it MUST NOT accept out-of-order or partial event sets as a
  substitute for replaying the full stream.
- Once folded state reaches a terminal status, the fold MUST ignore every
  subsequent event for that stream rather than let a later fact overwrite
  terminal state.

**Terminal recording**

- Recording success MUST append `RunSucceeded`, carrying the Activity's
  outcome and a finish time, only when the Run's current status is
  `started`.
- Recording success MUST be a silent no-op — no event appended, no error
  raised — when the Run is already terminal.
- Recording failure MUST append `RunFailed`, carrying an `ExecutionFailure`
  and a finish time, when the Run's current status is `starting` or `started`.
- Recording failure MUST be a silent no-op when the Run is already
  terminal.
- Recording failure MUST NOT append an event against a Run identity that
  has no prior `RunPreparationStarted` (or historical first `RunStarted`)
  fact; in that case the triggering error MUST
  propagate to the caller unchanged instead.
- Every recorded failure's `kind` MUST be the single closed value
  `unexpected-execution-failure`; the underlying cause is preserved
  underneath it. When the underlying cause is a native error, its `name`
  and `message` populate `details.sourceKind`/`message`; for any other
  thrown value, Run derives a best-effort kind and message rather than
  requiring the source to already be a structured error.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `execution.run-preparation-started` | This aggregate starts a new attempt | This `RunId` now denotes a real, active `starting` attempt at the named Activation. |
| `execution.run-started` | Workspace preparation finishes and the runner begins | The same Run is now `started`, with its runner-execution boundary recorded. |
| `execution.run-succeeded` | This aggregate records a successful attempt | The attempt finished; its Activity outcome is now attached. |
| `execution.run-failed` | This aggregate records a failed attempt, or Recovery cannot establish success | The attempt did not complete; an `ExecutionFailure` explains why. |
| `execution.run-lease-claimed` / `execution.run-lease-renewed` | Recorded by the liveness component or Recovery | Folded into `lease`; see the liveness and recovery specifications. |
| `execution.run-external-execution-reported` | Recorded by the Execution service once a runner reports an identity | Folded into `externalExecution`. |
| `execution.run-runner-result-reported` | Recorded by the Execution service once a runner's invocation settles | Folded into `agent`, when the reported result carries one. |
| `execution.workspace-cleanup-failed` | Recorded by the Execution service when releasing an acquired workspace after the attempt has concluded throws | Not folded into any `RunView` field; a diagnostic-only fact. |
| `execution.run-cancellation-requested` / `execution.run-cancellation-confirmed` / `execution.run-cancelled` | Recorded by the liveness component | Folded into `cancellation` and, on confirmation, the terminal `cancelled` status. |
| `execution.run-recovered` | Recorded by Recovery once the external execution is found complete | Folded into the terminal status implied by the recovered result. |
| `execution.run-ambiguous` | Recorded by Recovery when the external execution's state cannot be determined | Folded into the terminal `ambiguous` status. |

## Conceptual schema

Run state is the fold of its own stream, keyed by `runId`. See the module
specification's RunView table for the full field list. The fields this
aggregate itself is authoritative for:

| Field | Type | Description |
| --- | --- | --- |
| `runId` | Run identity | The stream's identity; every fact in the stream belongs to it. |
| `activationId`, `activity`, `stage`, `workflowInstanceId`, `orchestrationGroupId`, `attempt` | see module schema | Set once, by `RunPreparationStarted` or a historical first `RunStarted`; `stage` is optional; none are revised. |
| `status` | closed vocabulary: `starting` / `started` / `succeeded` / `failed` / `cancelled` / `ambiguous` | Starts `starting`; `RunStarted` moves it to `started`; then it moves to a terminal value at most once. |
| `startedAt` / `executionStartedAt` / `finishedAt` | timestamp | Whole-attempt start, runner start, and terminal time respectively. Historical first-`RunStarted` streams use their start time for both start fields. |
| `duration` | derived milliseconds | `finishedAt - startedAt`, covering preparation and runner execution end to end. |
| `runner` | Runner descriptor | Set by preparation when an agent runner is selected; a later start must not contradict it. |
| `workspace` | Workspace reference | Set by `RunStarted` after a workspace was acquired for this attempt. |
| `outcome` | Activity outcome | Set by `RunSucceeded`. |
| `failure` | Execution failure | Set by `RunFailed`, and by Recovery's failed/ambiguous outcomes. |

## Dependencies and system role

- Eventing — event envelope and stream-append conventions, including the
  optimistic-concurrency sequence this aggregate's commands rely on.
- Run projection (depends on Run) — reuses this aggregate's fold verbatim to
  build the queryable read model; Run does not depend back on it.
- Run liveness and cancellation, and Recovery (co-own the Run stream) —
  append the lease, cancellation, and recovery facts this aggregate's fold
  applies; neither depends on the other's internals, only on the shared
  stream and fold.
- Execution service (depends on Run) — the only caller that decides a new
  attempt is warranted and then drives this aggregate's creation and
  terminal-recording behaviour.
- Activities (Run depends on it for the Activity outcome shape carried in
  `RunSucceeded`) — Run stores this value opaquely and does not interpret
  it.

## Decisions, exclusions, and deferred capability

- There is no compensating command that retracts a recorded terminal fact.
  The only way past a terminal Run is a new attempt with a new `RunId`.
- The fold treats `ambiguous` as terminal (further events are ignored), but
  nothing in Execution currently moves an `ambiguous` Run onward; see the
  Recovery specification's deferred-capability note.
