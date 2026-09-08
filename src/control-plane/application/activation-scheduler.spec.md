# Activation Scheduler — Component Specification

## Type, purpose, and scope

Policy/process. `ActivationScheduler` separates an explicit maintenance phase
from dispatch. Maintenance performs the pause gates, workspace recovery
(including reclaimed-work transcript cleanup), active-run recovery, transcript
maintenance, and child reconciliation. Dispatch performs terminal-run
reconciliation and fair, capacity-aware selection. `runOnce` composes exactly
one maintenance phase and one dispatch phase; `createAdvanceOnce` is a
compatibility facade over that same scheduler.

## Core policies and invariants

- Each scheduler operation is enclosed by an injected `ActivationSchedulerSerialiser`.
  The critical section includes recovery, capacity reads, activation validation
  and claim, and the durable `RunPreparationStarted` capacity fact. Agent and
  script workspace acquisition and `RunStarted` happen in Execution's detached
  local worker, scheduled for a later event-loop turn only after `attempt`
  returns and the critical section can be released. The durable `starting` Run
  prevents competing runtime processes from jointly exceeding global capacity,
  while the activation claim prevents duplicate activation work.
- The Control Plane depends only on the serialiser port. Bootstrap selects the
  file-backed implementation; the Control Plane does not import persistence or
  filesystem locking.
- If no serialiser is supplied, one scheduler instance still serializes its own
  callers in process, preserving the former `createAdvanceOnce` behaviour for
  direct callers and deterministic tests.
- `runOnce` accepts an optional lifecycle signal. A serialiser uses it while
  waiting to enter its critical section; once the scheduler operation has
  started, that signal does not cancel domain recovery, reconciliation, or
  dispatch. Direct callers may omit it and use the default live signal.
- A loop-capable host calls `maintain` once per bounded control-plane pass,
  then calls `dispatch` for each attempt. Subscriber startup, event, and
  fallback reconciliation use `runOnce`, so each remains one complete pass.
- Subscriber scheduling is composed outside this component. Startup, durable
  event, and fallback passes pass their subscriber lifecycle signal through to
  this boundary, while Tick, resident, and API callers remain compatibility
  callers of the shared scheduler.

## Dependencies and system role

The scheduler receives Orchestration, Execution, Resources, Work, pause,
workspace-recovery, transcript-retention, runner-eligibility, clock, and ID
ports. It owns their required ordering but no domain state, persistence
mechanism, workflow-transition policy, or workspace implementation.
