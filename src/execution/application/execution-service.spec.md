# Execution service — Component Specification

---
asOf: 2fd4c4f2149f50cc802266489b7686b4ef8be8dd
---

## Type, purpose, and scope

Surface application. The Execution service is the only entry point through
which a caller reaches Execution's behaviour: attempting an Activation,
listing Runs, and driving the lease, cancellation, and cascading-cancellation
operations exposed by its sibling components. It resolves a runner and an
optional workspace for an attempt, validates resource requirements, and
orchestrates the activation claim and Run lifecycle around one attempt from
end to end.

## Ubiquitous language

See the module specification for Run, Attempt, Runner pool, and Workspace.
This component additionally distinguishes a Run's **transport status**
(whether the attempt itself completed) from the **Activity outcome**
carried inside a `succeeded` Run: a runner that fails, times out, or
produces an unrecognized result still yields a `succeeded` Run transport
status whenever the Activity handler translates that into a `failed` or
`blocked` outcome and returns normally rather than throwing — Execution
records whatever the handler returns without inspecting it.

## Responsibilities and boundaries

The Execution service owns the `attempt` orchestration: activity/input/
resource validation, runner resolution within a pool, workspace acquisition,
activation-claim coordination, Run creation, invoking the Activity handler,
and terminal recording — plus thin delegation of `list`, `claim`,
`renewLease`, `requestCancellation`, `confirmCancellation`, and
`cancelActive` to the Run repository and the liveness/cancellation
component. It does not decide whether an Activation is minted or when it
should be attempted (that is Orchestration's decision to call `attempt`),
does not interpret an Activity's outcome, and does not implement runner or
workspace mechanics itself — it only resolves and invokes them.

## Core policies, invariants, and behaviours

**Validation and resolution**

- An attempt MUST validate the Activation's input against the Activity's
  own schema and MUST validate the supplied resources against the
  Activity's declared resource requirements before any Run is created;
  either failing MUST reject the attempt with no Run stream created.
- Resource validation MUST reject when an `exactly-one` requirement's
  capability is not matched by precisely one resource, when a
  `one-or-more` requirement matches none, or when a `zero-or-one`
  requirement matches more than one.
- Runner pool resolution MUST use the Activation's own requested pool when
  present, falling back to the configured default pool, and MUST reject
  the attempt if the resolved pool name is not configured at all. Pool
  resolution happens even for a non-agent-kind Activity, which then simply
  resolves no runner.
- A runner's `model`/`effort`/`cli` recorded onto the Run (`RunView.runner`)
  is sourced from the resolved runner's own configuration entry
  (`agentRunners[name]`), and `pool` records the resolved runner pool's own
  name — independent of whatever `model` the Activity handler actually
  requests from the runner at invocation time (for the built-in agent
  Activity, that comes from the invocation input or its prompt template).
  The two `model` values are not guaranteed to agree; the recorded field is
  descriptive of which configured runner was selected, not a guarantee of
  what was passed to it.

**Existing-attempt semantics**

- `starting` and `started` are both active Run states. Existing-attempt
  checks, capacity, cancellation, quiescence, and Run leases apply to both;
  recovery fails an expired `starting` Run without inspecting an external
  execution because the runner has not started yet.

- An attempt for an Activation that already has a `succeeded` Run MUST
  return that Run unchanged; the same applies to an `ambiguous` Run. Neither
  case creates a new Run or touches the activation claim.
- An attempt for an Activation whose most recently listed Run is active
  (`starting` or `started`)
  MUST reject with an error when that Run's lease is unexpired and held by
  a different owner. When the active Run's lease is unexpired and held
  by the same owner, or is absent, or has expired, the attempt MUST return
  that same active Run unchanged rather than create a new one — a new
  attempt is never created while any Run for the Activation is active,
  regardless of that Run's lease state. Moving a stale active Run out of
  that status (via Recovery) is a precondition for a genuinely new attempt.
- Only when no `succeeded`, `ambiguous`, `starting`, or `started` Run exists for the
  Activation does an attempt proceed to claim the Activation and create a
  fresh Run, with attempt number one greater than the count of Runs already
  recorded for it.
- Before starting a genuinely fresh agent attempt, Execution MAY select one
  opaque prior session from terminal Runs whose recorded runner `cli` equals
  the newly selected adapter kind. A `resume-stage` attempt selects only Runs
  for its own workflow instance and stage; a `fresh` attempt never selects a
  prior session. If no policy is supplied, the legacy same-Activation lookup
  applies. It chooses the newest terminal result with a non-empty generic
  session id, ordered by finish time, attempt, then Run id. It forwards that
  id unchanged to the Activity with the current prompt/context; different
  adapter kinds, started or ambiguous Runs, and missing ids start fresh.

**Claim, workspace, and Run creation**

- Claiming the Activation for the fresh `RunId` happens before any Run
  event is appended; if the claim is rejected (a concurrent attempt won the
  race), the attempt MUST fail with no Run stream created at all.
- After a successful claim, `RunPreparationStarted` and the initial Run lease are
  appended atomically in one sequence-0 batch before workspace acquisition. That creates the durable `starting`
  Run and its whole-attempt `startedAt` before any workspace operation. For an
  agent- or script-kind Activity, `attempt` returns this durable `starting` view
  immediately and schedules a detached local worker for a later event-loop
  turn. No workspace-provider acquisition code runs before that return; the
  detached worker owns the remaining lifecycle.
- After durable preparation, Execution MUST register an `AbortController` for
  every execution kind before workspace acquisition. The same signal MUST
  cover workspace acquisition and the Activity handler so cancellation has no
  gap between those phases. Agent/script detached workers and deterministic
  handler completions MUST both be registered as service-owned before their
  caller can outlive them.
- Once claimed, a workspace MUST be acquired when the Activation requests
  `read-only` or `branch` mode, and MUST NOT be acquired for `none`
  (including when no mode is specified). Acquiring for a non-`none` mode
  without a configured workspace provider MUST reject the attempt.
  Resolving the resource a workspace is acquired from prefers a
  `Repository`-kind resource among the attempt's resources; when none is
  present, an `Issue`- or `PullRequest`-kind resource is used as a fallback
  clone source instead. Acquiring for a non-`none` mode with none of the
  three kinds present among the attempt's resources MUST reject the
  attempt.
- `RunStarted` MUST be appended after workspace preparation and immediately
  before the Activity handler is invoked. It updates the preparation-created
  Run with `executionStartedAt` and any acquired workspace; it does not mint
  another Run or lease.

**Execution and reporting**

- Workspace acquisition and Activity invocation MUST share the tracked
  `AbortController` for the Run's id, so a cancellation request can signal
  either phase while it is still running in this process.
- From `RunPreparationStarted` until terminal cleanup, Execution MUST renew the
  Run lease and keep a process-local attempt ownership marker that excludes the
  Run from local recovery, including while workspace preparation is blocked. The same rule
  continues while the local handler is running, while the workspace is released,
  and while any workspace-cleanup diagnostic is persisted. The marker is removed
  only when the detached worker actually finishes; a fresh process has no
  tracked worker and therefore remains responsible for reconciling an expired
  durable Run after restart.
- Stopping lease renewal MUST be an unconditional local-lifecycle finalization action.
  A repository read failing while recovery tries to settle an attempt MUST NOT
  leave its renewal timer running.
- If a cancellation request is observed before `RunStarted`, Execution MUST
  confirm it itself before cleanup, whether preparation subsequently completes
  or throws; request-only cancellation therefore reaches the same terminal
  `cancelled` Run rather than being recorded as a workspace failure.
- The handler's reported external-execution identity and final runner
  result MUST each be appended to the Run stream as they arrive,
  independent of the Run's current status — these facts are appended even
  if the Run has already reached a terminal status through a concurrent
  cancellation; the Run aggregate's fold, not this component, is what makes
  a late-arriving fact after termination inert.
- A reported runner result MUST be translated into a structured
  `AgentRunResponse` (see the Agent run response translation specification)
  before it is appended as `RunRunnerResultReported`; a newly-recorded fact
  never carries the runner's raw output directly.
- A runner result reporting failure kind `provider-quota-exceeded` for a
  named runner MUST invoke the configured runner-quota callback, naming
  that runner; Execution does not itself decide what happens to a
  quota-ineligible runner beyond reporting the signal.
- An agent- or script-kind attempt MUST return its durable `starting` Run before
  workspace acquisition completes. Its detached local worker acquires the
  workspace, appends `RunStarted`, invokes the Activity, records success or
  failure, and performs cleanup. A deterministic attempt preserves the inline
  preparation path: it normally yields one event-loop turn before returning;
  only a caller that explicitly requests immediate completion waits for that
  deterministic completion opportunity.
- When the Activity handler returns normally, its outcome MUST ordinarily be
  recorded via `RunSucceeded` regardless of what outcome kind it reports —
  Execution does not distinguish a `done` outcome from a `failed` or `blocked`
  one at the transport level. A concurrent shutdown cancellation that was
  durably persisted wins instead and MUST suppress `RunSucceeded`.
- When workspace preparation or the Activity handler throws after
  `RunPreparationStarted` was appended, the error MUST be recorded via
  `RunFailed` unless a concurrent durable cancellation request is observed
  first; in that case Execution confirms and terminalizes the cancellation
  instead. Only validation, claim, or another error before preparation creates
  the Run propagates unchanged to the caller.
- Whether the attempt succeeds, fails, or the Run was already moved to a
  terminal status by a concurrent cancellation, cleanup MUST release the
  Activation claim, remove any tracked `AbortController`, release any acquired
  workspace lease, and best-effort persist a workspace-cleanup diagnostic, in
  that order as applicable. A deterministic completion removes its local-attempt
  marker at the end of that cleanup. An agent- or script-kind worker preserves
  the marker through cleanup and its final Run reload; only the outer scheduled
  worker promise's `finally` removes it. A workspace lease's
  `release()` failing MUST NOT propagate from `attempt`: it MUST instead be
  recorded as a `RunWorkspaceCleanupFailed` diagnostic fact on the Run, and
  recording that diagnostic is itself best-effort — a failure while
  recording it is swallowed rather than raised.
- `attempt` only rejects (propagates an error to its caller) for upfront
  validation failures, an unexpired different-owner lease, a lost
  activation-claim race, or an error before `RunPreparationStarted` was appended. Every
  other failure during deterministic execution surfaces as a normally returned
  `RunView` with status `failed`; for an agent- or script-kind attempt, the
  detached worker records the same durable failed status for later observation.
- `shutdown` MUST be idempotent and reject later `attempt` calls predictably.
  It MUST own deterministic and agent/script work uniformly: start a durable
  cancellation request with reason `shutdown`, abort each locally tracked
  controller without waiting for that journal operation, and await all
  attempt-establishment, cancellation, and completion promises. Every terminal
  settlement caused by that abort MUST await the same Run's keyed shutdown
  cancellation promise before deciding between `cancelled` and the Activity's
  actual outcome, so a successful cancellation append wins even when an
  abort-aware handler throws or returns normally immediately. A rejected
  cancellation append MUST instead preserve normal failure or success
  settlement. The keyed promise remains observable until recovery/cleanup or
  worker finalization completes. Shutdown MUST repeat this snapshot/drain
  boundary until none remain, so ownership created by an in-flight attempt
  cannot escape between snapshots. Resident shutdown invokes this drain before
  closing server resources that terminal cleanup may still need.

## Conceptual schema

See the module specification's `ExecutionActivation` and
`ExecutionAttemptContext` tables for the attempt request shape, and its
`RunView` table for the result. This component adds no durable schema of
its own beyond what it reads and writes through the Run repository.

## Dependencies and system role

- Kernel — the `Clock` and `IdGenerator` used to stamp and mint a fresh
  `RunId` per attempt.
- Run, and Run liveness and cancellation (both depend on) — this component
  is the only caller that decides a new attempt is warranted and then
  drives the Run aggregate's creation and terminal-recording behaviour, and
  the only caller that claims a Run's own lease as part of starting it.
- Activation claim (depends on) — claims before creating a Run and releases
  unconditionally once the attempt concludes.
- Activities (depends on) — `describe`, `validateInput`, and `execute` an
  Activation's Activity, supplying an `ActivityExecutionContext` bound to
  the resolved runner and the reporting callbacks this component appends
  from.
- Resources (depends on) — the `ResourceView`s an attempt validates its
  Activity's requirements against, and the repository resource a workspace
  is acquired from.
- Runner adapters, and Workspace adapters (both depend on) — resolved and
  invoked once per attempt when the Activity is agent-kind or a workspace
  mode other than `none` is requested, respectively.
- Agent run response translation (depends on) — invoked to parse a reported
  runner result into the `AgentRunResponse` this component appends onto
  `RunRunnerResultReported`.
- A Run repository (depends on, internal) — loads and appends Run streams
  directly by folding each stream's events on every call, rather than
  reading through the registered Run projection; `list()` reads the whole
  journal from the beginning on every call to find every Run stream, so its
  cost scales with total journal size rather than with Runs for one
  Activation.
- Orchestration and Control-plane (both depend on this component) — the
  only path by which either reaches Execution's behaviour, per the module
  specification's dependency list.

## Decisions, exclusions, and deferred capability

- There is no partial rollback of a workspace or activation claim on a
  failed attempt short of the unconditional release in the `finally` path.
  A workspace release failure no longer masks the attempt's outcome: it is
  caught, recorded as a `RunWorkspaceCleanupFailed` diagnostic fact (itself
  best-effort), and `attempt` still returns the Run's already-recorded
  outcome normally.
- Runner pool failover only moves within the pool resolved for one attempt;
  see the module specification's own exclusion.
