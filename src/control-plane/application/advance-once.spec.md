# Advancement — Component Specification

## Type, purpose, and scope

Policy/process. Advancement is the single bounded, side-effecting call that
makes cross-module progress: it recovers interrupted Execution state,
reconciles Orchestration outcomes that were never accepted, then runs a
dispatch loop that selects, dispatches, and records the outcome of pending
orchestration work one candidate at a time — rechecking capacity after each
dispatch — until the global `maxConcurrentRuns` ceiling, the per-call
`maxDispatches` burst cap, or eligible candidates are exhausted. This component also
owns the Runner pipeline: the fixed stage sequence that wraps one Advancement
call with the surrounding schedule/react/deliver stages of the internal half
of one Wake tick, producing the composed callback the Tick and Resident Hosts
repeat. The externally rate-limited half (poll, translate inbound) is a
separate `IntakePipeline`, not owned by this component.

## Ubiquitous language

- **Recovery** — the `recoverActive` call Advancement makes to Execution
  before anything else, so interrupted Runs owned by the control-plane host
  are reconciled before new selection.
- **Reconciliation** — finding a pending activation whose Execution Run
  already succeeded with an outcome that Orchestration has not yet accepted,
  and accepting it, in preference to starting new dispatch.
- **Selection** — choosing which pending activation to dispatch next when no
  reconciliation candidate exists.
- **Dispatch loop** — the per-call iteration that repeats selection and
  dispatch, rechecking `maxConcurrentRuns` against the current `started` Run
  count after every dispatch (never spending a capacity count computed once
  up front), excluding activations already dispatched earlier in the same
  call from later selection, and stopping at the first of: the
  `maxConcurrentRuns` ceiling, the per-call `maxDispatches` burst cap, or no
  further eligible candidate.
- **Runner pipeline** — the fixed ordered stage sequence
  (`runSchedules` → `react` → agent-run publication → `deliver` → `react`)
  that one call to `RunnerPipeline.run` performs. It never advances the
  activation scheduler or catches every projection. `poll` and `translateInbound` — the externally
  rate-limited half of a tick — run on a separate `IntakePipeline` instead,
  not embedded in this sequence; see control-plane's `tick-host.spec.md`
  for why the two are split across independently scheduled hosts.

## Responsibilities and boundaries

Advancement owns the recovery → reconciliation → dispatch-loop
(selection → dispatch → outcome-acceptance, repeated until capacity or
candidates are exhausted) sequence for one scheduler pass. The Runner pipeline
owns the ordering of the non-scheduling IO stages for the internal half of one
tick. It does not define what makes an activation pending or a workflow
waiting — it reads Orchestration's own readiness reports. The Runner pipeline
does not implement `runSchedules`, `react`, or `deliver` — those stages are
supplied by the caller (bootstrap composition) and only sequenced here; `poll`
and `translateInbound` are not sequenced by this component at all, since they
run on the separate `IntakePipeline`. Advancement does not decide runner
eligibility itself — it calls an injected `runnerIneligibility` supplier and
passes the result through to Execution unchanged. It does not decide whether a
WorkItem is frozen or deleted — it calls an injected `work.get` lookup per
candidate and excludes one whose WorkItem is currently frozen or deleted, but
Work's own aggregate remains the source of that state.

## Core policies, invariants, and behaviours

- When `maxProgress < 1`, Advancement MUST return `{ kind: 'exhausted',
  progressCount: 0 }` immediately, performing no recovery, reconciliation,
  selection, or dispatch.
- Otherwise Advancement MUST call Execution's `recoverActive` (when
  supplied) for the control-plane owner, then Orchestration's
  `reconcileChildCompletions`, before reading any pending activation.
  `reconcileChildCompletions` runs unscoped, regardless of any `workItemId`
  option.
- `maxProgress` bounds only whether Advancement proceeds at all (`< 1`
  short-circuits to `exhausted`); it does not bound how many candidates the
  dispatch loop may dispatch within one call — that is governed solely by
  `maxConcurrentRuns` and `maxDispatches`. A caller wanting more progress
  than one call's capacity allows MUST call Advancement again.
- Listing pending activations MUST be scoped to `options.workItemId` when
  given, and MUST cover all WorkItems otherwise.
- When a `work` lookup is supplied, every listed pending activation MUST be
  checked against its owning WorkItem before reconciliation or selection
  considers it; a candidate whose WorkItem is currently `frozen` or `deleted`
  MUST be excluded from both. When no `work` lookup is supplied, no candidate
  is excluded on this basis.
- Reconciliation MUST take priority over new selection: Advancement scans
  active pending activations in the order Orchestration returned them and accepts
  the first one whose Execution Run already succeeded with a defined outcome
  not yet present in that workflow's accepted outcomes, returning
  `progressed` for it without attempting new dispatch.
- A terminal failed, cancelled, or ambiguous Run is resolved to a durable
  blocked workflow when first discovered. Blocked workflows are not revisited
  by reconciliation on later calls, so their already-surfaced terminal Run
  cannot prevent independently ready work from advancing; explicit operator
  retry remains the recovery path. The exception is a blocked workflow whose
  Run later succeeds with an unaccepted outcome after external operator
  resolution: that succeeded outcome is reconciled and accepted.
- When no reconciliation candidate exists, Advancement runs its dispatch
  loop: while dispatched-this-call is below `maxDispatches`, it counts all
  `started` Runs and, when that count has reached `maxConcurrentRuns`, stops
  dispatching (returning `no-work`, or `progressed` with whatever was already
  dispatched earlier in the same call). Otherwise it applies Dispatch
  Policy's fairness-ordered selection over the pending candidates, excluding
  any activation already dispatched earlier in the same call (its `RunStarted`
  event is not guaranteed visible through `execution.list()` yet, so this
  exclusion is tracked locally, not derived from re-listing Runs). Each
  dispatched candidate is appended to the call's result and the loop rechecks
  capacity before selecting the next one — capacity is never computed once
  and spent without rechecking. Calls to one created Advancement function are
  serialized through this loop and Run creation, so concurrent callers cannot
  jointly over-dispatch past `maxConcurrentRuns`.
- With the default configuration (`maxConcurrentRuns: 1`, `maxDispatches: 1`),
  the dispatch loop runs at most one iteration, so a single call dispatches
  at most one Run — identical to the pre-loop, single-dispatch behaviour.
- When there is no pending activation at all, Advancement checks
  Orchestration's waiting workflows: it reports the first waiting instance
  found (`kind: Waiting`) or `no-work` if none are waiting.
- The global dispatch pause check (`isDispatchPaused`, described below) is
  the only pause signal Advancement consults before proceeding; runner-level
  pause is applied differently — only the injected `runnerIneligibility`
  result (default: empty set) feeds it, and only into the Execution
  `attempt` call, by including `ineligibleRunners` in the attempt context
  solely when that set is non-empty.
- Bootstrap safe self-update supplies the existing `isDispatchPaused` check.
  A present maintenance lease therefore returns `paused` before recovery,
  reconciliation, selection, dispatch, or outcome acceptance; it is a full
  tick pause, not merely a prohibition on new Run dispatch. Clearing a
  healthy lease resumes this same ordinary path without another scheduler.
- Selecting a candidate MUST mark its activation started in Orchestration
  before the Execution attempt is made, regardless of whether that attempt
  later succeeds or fails.
- Before dispatch, Advancement resolves the selected WorkItem's correlated
  Resources and passes only the ones that currently resolve (a missing
  correlation target is silently dropped from the attempt context, not
  treated as an error).
- When an Execution attempt succeeds with a defined outcome, Advancement
  accepts that outcome into Orchestration and continues the dispatch loop
  (the attempt started but not yet succeeded also continues the loop, as an
  in-flight Run). When an attempt terminates without succeeding or starting,
  Advancement resolves the execution failure durably then stops the loop; it
  does not itself record a block or failure fact beyond that resolution —
  Execution's own run-failure event is the durable record of what happened.
  The call's result still reports `progressed` with whatever it already
  dispatched earlier in the same call when the loop stopped this way; it
  reports `Blocked` (with the workflow instance id and the run's failure
  message, defaulting to `'execution failed'`) only when nothing was
  dispatched yet in this call. A workflow blocked this way is picked up by
  reconciliation or Advancement's `no-work` waiting check on a later call,
  not surfaced again by this one.
- The Runner pipeline MUST run its ordered stages in the fixed order given
  above, awaiting each stage fully before starting the next, exactly once
  per `run` call, and MUST return only its operational `no-work` or `paused`
  status: it never reports scheduler progress. `react` runs twice: once after
  schedule facts are produced and once for delivery outcomes after `deliver`.
  The one-shot adapter owns all-projection barriers before pipeline work,
  before its scheduler poke/delivery boundary, and while unwinding; the
  resident runtime uses independently supervised subscriptions. Delivery is
  the explicit resident freshness barrier because it reads its outbox from a
  projection.
- `RunnerPipeline.run`'s `signal` parameter defaults to a fresh,
  never-aborted `AbortController`'s signal when the caller omits one.
- Bootstrap always composes an independently supervised, checkpointed
  activation-scheduler subscriber. It reconsiders every durable fact,
  reconciles on startup and bounded fallback, and shares the scheduler
  serialiser. One-shot ticks run the non-scheduling pipeline to produce
  schedule and reactor facts, then its ordered pre-delivery hook pokes that
  required subscriber before outbound delivery. A later delivery error still
  rejects the tick, but cannot undo or postpone that completed scheduler pass;
  resident publication, delivery, or reactor latency cannot hold subscriber
  dispatch.
- When the shared pause is already active at the start of a Runner or Intake
  pipeline call, the pipeline MUST return its paused/no-progress result
  without invoking any operational
  stage (`runSchedules`, reactors, publication, delivery, poll,
  or inbound translation). This makes durable pause/resume facts visible
  without allowing paused operational work to proceed.

## Conceptual schema

**AdvanceOptions** (per-call input; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity, optional | Scopes pending-activation listing to one WorkItem; omitted means all. |
| `maxProgress` | integer | Gate only: `< 1` short-circuits to `exhausted`; otherwise unused. |

**AdvanceResult** (per-call output; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `no-work` / `progressed` / `waiting` / `blocked` / `exhausted` | What this call accomplished. |
| `dispatched` | list of `DispatchedRun` (progressed only) | Every activation/Run pair the dispatch loop started and (where succeeded) accepted this call, in dispatch order; length is between 1 and `maxDispatches`. |
| `workflowInstanceId` | identity (waiting/blocked only) | The workflow instance reported waiting or blocked. |
| `reason` | string (blocked only) | The Execution failure message, or a default. |
| `progressCount` | integer (exhausted only) | Always `0`; no internal loop ever increments it. |

**DispatchedRun** (element of `AdvanceResult.dispatched`; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `activationId` | Orchestration activation identity | The dispatched activation. |
| `runId` | Execution Run identity | The Run started for it. |

## Dependencies and system role

- Orchestration — supplies pending/waiting readiness, accepts outcomes,
  marks activations started, and reconciles child completions; Advancement
  never redefines this readiness itself.
- Execution — recovers interrupted Runs, executes the selected activation,
  and lists Runs for reconciliation.
- Resources — resolves the selected WorkItem's correlated Resources before
  dispatch.
- Control Plane view (indirect) — the composed `runnerIneligibility`
  supplier reads the projection and calls `ineligibleRunners`; Advancement
  itself depends only on the injected async function, not the projection.
- Work (indirect) — the composed `work` lookup reads WorkItem `frozen`/
  `deleted` state; Advancement itself depends only on the injected async
  function, not Work's own service.
- Kernel — Clock, IdGenerator, and command-context/correlation conventions
  for every downstream command Advancement issues.
- Tick and Resident Hosts (dependent) — in production composition, use
  separate runner adapters: the one-shot adapter runs the non-scheduling
  pipeline and pokes the required scheduler subscriber at its pre-delivery
  boundary, while the resident adapter runs only the pipeline.
- The API `tick` command (dependent) — invokes that one-shot adapter, so it
  runs schedule reconciliation, reactions, publication, and the ordered
  subscriber poke before delivery. It does not poll or translate inbound;
  those operations belong to the separate Intake pipeline.

## Decisions, exclusions, and deferred capability

- Dispatch Policy's fairness-ordered `select` is composed here, called once
  per dispatch-loop iteration against the still-pending, not-yet-dispatched-
  this-call candidates. The global `maxConcurrentRuns` gate is intentionally
  limited to a single system-wide ceiling; runner, repository, and WorkItem
  dimensions remain deferred (tracked by #122). No `WAITING_FOR_CAPACITY`
  state is introduced for the burst cap or ceiling; both exhaust to `no-work`
  (or a `progressed` result reporting whatever was already dispatched).
- Advancement does consult the injected `isDispatchPaused` supplier (default:
  always `false`) and returns `{ kind: 'paused' }` immediately when it
  resolves `true`, before recovery or reconciliation; in production this
  supplier is Control Plane Service's `isPaused` (see
  `control-plane-service.spec.md`), not a direct read of the Control Plane
  view projection. `HostStopReason.Paused` is still never produced by any
  path reachable through Advancement even so, because `TickHost` maps every
  non-`progressed`/`no-work`/`waiting`/`blocked` `AdvanceResult.kind`
  (including `paused`) to `HostStopReason.Budget`, not `Paused`.
