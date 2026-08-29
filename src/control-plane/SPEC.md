---
asOf: 31cb84460b6099ea50edc17a70d3ec679ba08cc5
---

# Control Plane — Module Specification

## Purpose and scope

Control Plane provides the one bounded, repeatable operation — Advancement —
through which Wake makes cross-module progress: taking ready units of work
from Orchestration, dispatching each to Execution with the resources
Resources resolves, and recording the outcome back into Orchestration, up to
the open capacity within one call. It also owns the
signals that make Advancement selective (runner and global dispatch pauses),
the budgets that bound how many times a host may call it in one cycle, and the
hosts (`tick`, resident) that repeat it. It coordinates a cross-module Work
conclusion (close or cancel) cascade and cron-derived schedule slots as
further bounded applications of the same coordination role.

## Responsibilities and boundaries

Control Plane owns:

- Advancement: one bounded call that recovers interrupted state, reconciles
  completions, then fills open dispatch capacity by selecting, dispatching,
  and recording the outcome of pending orchestration work one candidate at a
  time until capacity, the per-call burst cap, or eligible candidates are
  exhausted.
- Runner-level and global dispatch pause/resume signals, and the read model
  that derives current runner eligibility from them.
- Host budgets (`HostBudget`) and the two bounded execution surfaces (`tick`,
  resident) that repeat Advancement under those budgets.
- The cross-module cascade a Work conclusion (close or cancel) triggers
  across Orchestration and Execution.
- Recognising which cron-configured schedule slots have elapsed and turning
  each into a WorkItem and a started WorkflowInstance.

Control Plane does not own:

- Whether a WorkItem, WorkflowInstance, or Activity is itself eligible to
  proceed — that is Work's, Orchestration's, and Execution's own domain
  policy. Control Plane reads their state; it does not redefine it.
- How an activity actually executes, or provider/runner mechanics — that is
  Execution's responsibility.
- Correlating a resource to a WorkItem — that is Resources' responsibility;
  Control Plane only reads already-correlated resources.

## Ubiquitous language

- **Advancement** — one bounded, side-effecting call that fills open dispatch
  capacity within itself: zero or more accepted outcomes (batched into one
  `progressed` result), or a definitive no-work/waiting/blocked result when
  nothing was dispatched.
- **Dispatch loop** — the per-call iteration inside Advancement that
  reselects and dispatches candidates one at a time, rechecking capacity
  after every dispatch, until `maxConcurrentRuns`, the per-call
  `maxDispatches` burst cap, or eligible candidates are exhausted.
- **Pending activation** — a unit of orchestration work ready to run next, as
  reported by Orchestration; Control Plane selects among these but does not
  define readiness.
- **Runner pause** — a specific named runner excluded from selection, caused
  by an operator (`manual`) or a provider-reported capacity condition
  (`quota`), recorded as `control-plane.runner-paused` /
  `control-plane.runner-resumed`.
- **Global dispatch pause** — a system-wide halt on Advancement selection,
  distinct from any single runner's pause, recorded as
  `control-plane.dispatch-paused` / `control-plane.dispatch-resumed`.
- **Ineligible runners** — the set of runner names currently excluded from
  selection, derived from recorded runner pauses as of a given instant.
- **Host** — a bounded execution surface (`tick`, resident) that repeats
  Advancement under a budget until a stop condition is reached.
- **Budget** — the caps (`maxAdvances`, `maxRuns`, `maxDurationMs`) bounding
  one host cycle.
- **Schedule** — an operator-configured recurring rule (id, five-field cron
  expression, target workflow, objective) that Schedule Policy evaluates into
  elapsed slots.
- **Slot** — one elapsed minute matching a schedule's cron expression,
  identified stably as `schedule:<id>:<slot-timestamp>`.
- **Cascade** — the ordered cross-module effects one Work conclusion (close
  or cancel) triggers: cancelling active Runs and blocking affected
  WorkflowInstances.

## Core policies, invariants, and behaviours

- All of this module's durable facts live on one global stream
  (`control-plane:global`); Control Plane does not own per-WorkItem streams.
- Within one scheduler pass, the dispatch loop MUST dispatch at most
  `controlPlane.maxDispatches` new Runs, and MUST NOT dispatch past the
  `controlPlane.maxConcurrentRuns` ceiling — rechecked after every dispatch,
  not computed once and spent — even when more ready work remains. A host
  wanting more progress than one call's capacity allows MUST call Advancement
  again. With the shared default of `1` for both fields, the loop dispatches
  at most one Run per call, unchanged from single-dispatch behaviour.
- A host's stop reason MUST be one of the closed `idle` / `waiting` /
  `blocked` / `budget` / `paused` / `shutdown` values; nothing outside that
  vocabulary is ever reported.
- Runner and global dispatch pause state MUST be recorded as durable events
  on the control-plane stream, not cached only in process memory, so it
  survives a restart.
- Before reconciliation or selection, Advancement invokes Execution's
  crash-workspace recovery capability when Bootstrap supplies it. The same
  dispatch-pause gate is sampled before and between safe reclaims: a paused
  tick performs no recovery deletion, and recovery never becomes a resident
  or age-based Control Plane service.
- The scheduler serialisation port encloses the full pass, from the initial
  pause gate through recovery, capacity checks, activation claim, Execution's
  workspace acquisition, and durable Run creation. Bootstrap selects the
  cross-process lock adapter; this module never imports that filesystem detail.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `control-plane.dispatch-paused` | Global dispatch capacity is exhausted and a pause deadline is recorded | Advancement selection is intended to halt system-wide until `resumeAt`. |
| `control-plane.dispatch-resumed` | A recorded global dispatch pause is lifted | Advancement selection may proceed again. |
| `control-plane.runner-paused` | An operator pauses a named runner, or a runner reports a provider-side quota condition | The named runner MUST NOT be selected for execution until resumed (`manual`) or until `resumeAt` elapses (`quota`). |
| `control-plane.runner-resumed` | An operator resumes a paused runner | The named runner is eligible for selection again, overriding any remaining quota deadline. |

## Conceptual schema

**Control Plane view**

| Field | Type | Description |
| --- | --- | --- |
| `pausedUntil` | timestamp or null | The current global dispatch pause deadline, if any. |
| `reason` | string, optional | Why the current global dispatch pause was recorded. |
| `runnerPauses` | map of runner name to Runner pause entry | Currently paused runners, keyed by name. |

**Runner pause entry** (child entity)

| Field | Type | Description |
| --- | --- | --- |
| `cause` | closed vocabulary: `manual` / `quota` | Who or what caused the pause. |
| `reason` | string | Human-readable explanation. |
| `resumeAt` | timestamp, optional | Required for `quota`; a `manual` pause has none and lasts until explicitly resumed. |

**Host budget and result**

| Field | Type | Description |
| --- | --- | --- |
| `maxAdvances` | integer | Maximum accepted outcomes in one bounded cycle. |
| `maxRuns` | integer | Maximum Runs started in one bounded cycle. |
| `maxDurationMs` | integer | Wall-clock cap for one bounded cycle. |
| `advances` / `runs` | integer | Counts actually reached in the cycle. |
| `stoppedBecause` | closed vocabulary: `idle` / `waiting` / `blocked` / `budget` / `paused` / `shutdown` | Why the cycle (or resident run) ended. |

**Schedule**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Stable schedule identity, unique per configured entry. |
| `workflow` | Orchestration workflow name | Which workflow a slot's WorkflowInstance runs. |
| `cron` | five-field cron expression, UTC | When slots occur. |
| `objective` | string | Objective text given to each slot's WorkItem. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Activation Scheduler](application/activation-scheduler.spec.md) | policy/process | Recovery, reconciliation, selection, and dispatch for one bounded unit of progress | Reads Orchestration/Execution/Resources ports directly and uses an injected serialiser; `advanceOnce` remains the hosts' and API's compatibility facade over this same scheduler. |
| [Control Plane view](application/control-plane-projection.spec.md) | projection | The current dispatch/runner pause read model and derived runner eligibility | Folds this module's own events; read by Advancement and by the execution runner-status surface. |
| [Runner Pause and Resume](application/runner-control-service.spec.md) | policy/process | Operator pause/unpause command handling and quota resume-deadline derivation | Appends the `runner-paused`/`runner-resumed` facts the Control Plane view folds; the only composed command path to a manual runner pause. |
| [Global Dispatch Pause and Resume](application/control-plane-service.spec.md) | policy/process | Operator pause/resume command handling for global dispatch, and the `isPaused` read | Appends the `dispatch-paused`/`dispatch-resumed` facts the Control Plane view also folds (independently); its `isPaused` is Advancement's `isDispatchPaused` gate. |
| [Dispatch Policy](domain/dispatch-policy.spec.md) | policy/process | Pure fairness-ordered dispatch selection and dispatch-quota pause/resume decisions | Designed to feed Advancement's selection and to drive global dispatch pause events; not currently invoked by any composed caller. |
| [Schedule Policy and Service](domain/schedule-policy.spec.md) | policy/process | Elapsed-slot computation and the create-WorkItem/start-WorkflowInstance/checkpoint sequence per slot | Calls Work's create command and Orchestration's start command; not currently invoked by any composed host. |
| [Work Conclusion Policy](application/work-cancellation-policy.spec.md) | policy/process | The ordered cross-module close/cancel cascade for one WorkItem | Calls Work's close or cancel command, then Execution's cancel-active contract, then Orchestration's block command; reachable today via the GitHub provider's `WorkConclusion` port. |
| [Tick, Intake, and Resident Hosts](infrastructure/tick-host.spec.md) | surface application | Pipeline stage ordering, budget-bounded cycles, and resident repetition, split across a fast internal `TickHost`/`RunnerPipeline` and a backed-off `IntakeHost`/`IntakePipeline` | The composed entry point CLI `tick`/`start` use to repeat Advancement and intake; wraps each pipeline with no knowledge of its internals. |

## Dependencies and system role

- Kernel — event journal, projections, checkpoints, clock, id generation, and
  command-context conventions; Control Plane's foundational dependency for
  its own stream and for every command it issues to other modules.
- Work (depends on and is depended on by) — Work Conclusion Policy and
  Schedule Service call Work's own commands; Advancement reads a WorkItem's
  `frozen`/`deleted` state to exclude it from pending-activation
  consideration; Control Plane never writes `work.*` facts directly.
- Orchestration (dependency) — Advancement reads pending/waiting workflow
  state and accepts outcomes; Work Conclusion Policy blocks workflows;
  Schedule Service starts workflow instances.
- Execution (dependency) — Advancement dispatches to and recovers active
  Runs; Work Conclusion Policy cancels active Runs; the runner-quota path
  (composed outside this module, in bootstrap) reports quota conditions that
  this module's resume-deadline derivation resolves into a pause.
- Resources (dependency) — Advancement resolves a selected WorkItem's
  correlated resources before dispatching to Execution.
- Bootstrap composition root (dependent) — the only place that wires this
  module's application services into concrete adapters and CLI/API surfaces;
  Control Plane itself never selects a concrete adapter.
- CLI/API surfaces (dependents) — invoke the Tick, Intake, and Resident
  Hosts, the runner and global dispatch pause/resume commands, and the
  control-plane status/advance API command.

## Decisions, exclusions, and deferred capability

- Dispatch fairness ordering is composed into Advancement's per-candidate
  selection. `controlPlane.maxDispatches` is a live per-call burst cap:
  the maximum number of new Runs one Advancement call's dispatch loop will
  start, independent of and bounded by `controlPlane.maxConcurrentRuns`.
  `controlPlane.maxConcurrentRuns` is a separate, serialized global capacity
  gate: once that many Runs are `started`, the dispatch loop stops and
  Advancement returns `no-work` (or `progressed` with whatever it already
  dispatched earlier in the same call) until a terminal Run frees capacity.
  Count-based quota pausing remains uncomposed. A manual, operator-triggered
  global dispatch pause/resume is composed and live (Global Dispatch Pause and
  Resume), but the count-based, quota-driven pause/resume Dispatch Policy
  computes is not.
- Schedule Service is implemented but not invoked by any composed host;
  `controlPlane.schedules` is validated configuration with no consumer today.
- Work Conclusion Policy is composed and reachable via the GitHub provider's
  external-close reactor; no direct operator-facing "cancel work" or "close
  work" command exists yet.
- `HostStopReason.Paused` is defined and part of `HostResult`'s type, but no
  code path currently produces it: Advancement does consult and act on the
  global dispatch pause, but `TickHost` maps a `paused` `AdvanceResult` to
  `HostStopReason.Budget`, not `Paused` (see `advance-once.spec.md`).
- The resident host's inter-cycle sleep is caller-supplied. Production
  composition runs two independently-scheduled resident hosts (see
  `infrastructure/tick-host.spec.md`): intake backs off exponentially when
  idle using `controlPlane.resident.pollBackoffMs`/`maxPollBackoffMs`
  (only intake polls the rate-limited GitHub API); the runner loop waits on
  the journal's change signal when idle (falling back to a fixed,
  non-configurable safety-net interval if nothing signals) and not at all
  when the prior cycle progressed.
- Composing Dispatch Policy's fairness ordering and quota-driven pause into
  the live Advancement/host path, and exposing Work conclusion as a direct
  operator command, are deferred capabilities, not rejected ones.

## Task 27B synchronization (2026-08-02)

`advanceOnce` is the global dispatch choke point: it checks global pause and applies DispatchPolicy selection. The tick is split across two independently-scheduled pipelines: IntakePipeline runs poll and inbound translation (backed off when idle, since it is the only half that hits the rate-limited GitHub API), and RunnerPipeline runs schedule reconciliation, reactions, bounded advancement, delivery, and final projection/reaction passes (fast, un-backed-off cadence). Schedule slots first look up their deterministic workflow identity before minting Work, preventing a crash before checkpoint persistence from leaking a second WorkItem. The API operation is `tick` and invokes that same RunnerPipeline. Runner unpause is durable and rejects a runner that is not currently paused.
