# Activation Scheduler — Component Specification

## Type, purpose, and scope

Policy/process. `ActivationScheduler.runOnce` is the single bounded scheduling
operation for a control-plane activation pass. It preserves the former
Advancement sequence: pause gate; workspace recovery (including reclaimed-work
transcript cleanup); active-run recovery; transcript maintenance; child
reconciliation; terminal-run reconciliation; then fair, capacity-aware
dispatch. `createAdvanceOnce` is a compatibility facade over this same
scheduler; it does not provide a second dispatch implementation.

## Core policies and invariants

- One scheduler pass is enclosed by an injected `ActivationSchedulerSerialiser`.
  The critical section includes recovery, capacity reads, activation validation
  and claim, workspace acquisition inside Execution, and durable `RunStarted`.
  This prevents competing runtime processes from jointly exceeding global
  capacity or creating duplicate activation work.
- The Control Plane depends only on the serialiser port. Bootstrap selects the
  file-backed implementation; the Control Plane does not import persistence or
  filesystem locking.
- If no serialiser is supplied, one scheduler instance still serializes its own
  callers in process, preserving the former `createAdvanceOnce` behaviour for
  direct callers and deterministic tests.
- No durable subscription or scheduling-mode configuration is part of this
  component yet. Tick, resident, and API callers remain compatibility callers
  of the shared scheduler.

## Dependencies and system role

The scheduler receives Orchestration, Execution, Resources, Work, pause,
workspace-recovery, transcript-retention, runner-eligibility, clock, and ID
ports. It owns their required ordering but no domain state, persistence
mechanism, workflow-transition policy, or workspace implementation.
