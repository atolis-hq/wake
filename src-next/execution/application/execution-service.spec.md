# Execution service — Component Specification

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

- An attempt for an Activation that already has a `succeeded` Run MUST
  return that Run unchanged; the same applies to an `ambiguous` Run. Neither
  case creates a new Run or touches the activation claim.
- An attempt for an Activation whose most recently listed Run is `started`
  MUST reject with an error when that Run's lease is unexpired and held by
  a different owner. When the `started` Run's lease is unexpired and held
  by the same owner, or is absent, or has expired, the attempt MUST return
  that same `started` Run unchanged rather than create a new one — a new
  attempt is never created while any Run for the Activation is `started`,
  regardless of that Run's lease state. Moving a stale `started` Run out of
  that status (via Recovery) is a precondition for a genuinely new attempt.
- Only when no `succeeded`, `ambiguous`, or `started` Run exists for the
  Activation does an attempt proceed to claim the Activation and create a
  fresh Run, with attempt number one greater than the count of Runs already
  recorded for it.

**Claim, workspace, and Run creation**

- Claiming the Activation for the fresh `RunId` happens before any Run
  event is appended; if the claim is rejected (a concurrent attempt won the
  race), the attempt MUST fail with no Run stream created at all.
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
- `RunStarted` MUST be appended before the Activity handler is invoked, and
  the Run's own lease MUST be claimed for the requesting owner (defaulting
  to `"execution"` when none is supplied) as part of the same creation step.

**Execution and reporting**

- Invoking the Activity handler MUST track an `AbortController` for the
  Run's id for the duration of the call, so a cancellation request against
  this Run can signal it while it is still running in this process.
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
- When the Activity handler returns normally, its outcome MUST be recorded
  via `RunSucceeded` regardless of what outcome kind it reports — Execution
  does not distinguish a `done` outcome from a `failed` or `blocked` one at
  the transport level.
- When the Activity handler throws, the thrown error MUST be recorded via
  `RunFailed` when the Run's `RunStarted` fact was already appended;
  MUST propagate unchanged to the attempt's caller when it was not (an
  error before Run creation is a hard failure of the attempt, not a
  recorded Run failure).
- Whether the attempt succeeds, fails, or the Run was already moved to a
  terminal status by a concurrent cancellation, the Activation claim MUST
  be released, the tracked `AbortController` MUST be removed, and any
  acquired workspace lease MUST be released — in that order — before the
  attempt call returns or its error propagates. A workspace lease's
  `release()` failing MUST NOT propagate from `attempt`: it MUST instead be
  recorded as a `RunWorkspaceCleanupFailed` diagnostic fact on the Run, and
  recording that diagnostic is itself best-effort — a failure while
  recording it is swallowed rather than raised.
- `attempt` only rejects (propagates an error to its caller) for upfront
  validation failures, an unexpired different-owner lease, a lost
  activation-claim race, or an error before `RunStarted` was appended. Every
  other failure during execution surfaces as a `RunView` with status
  `failed`, returned normally.

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
