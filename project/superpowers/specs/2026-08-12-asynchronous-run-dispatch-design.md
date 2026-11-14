# Asynchronous Run Dispatch and Live Status Design

## Goal

Decouple agent execution from one synchronous runner tick so Wake records a
Run as started, publishes its GitHub working status promptly, and continues
processing other durable work while the agent process runs.

## Current limitation

`AdvanceOnce` calls `execution.attempt`, which writes `execution.run-started`
and then waits for the runner to finish. The runner pipeline cannot return to
its projection, integration-reactor, delivery, or provider-maintenance stages
until that wait completes. GitHub labels therefore remain at the prior terminal
status while the new Run is active, even though the durable workflow state is
already active.

## Architecture

Split execution into durable dispatch and asynchronous completion.

1. `AdvanceOnce` claims and starts a Run, then returns `progressed` as soon as
   `execution.run-started` is durable. It no longer waits for runner execution.
2. The Execution service owns an in-process worker registry. It begins the
   runner asynchronously after the RunStarted append and records the existing
   terminal Run facts using the current lifecycle behavior.
3. Worker ownership remains guarded by the existing durable activation claim
   and Run lease. On restart, normal active-run recovery remains authoritative;
   a restarted process does not assume an old agent process stopped or write a
   second terminal result.
4. The runner pipeline's post-advance projection/reactor/maintenance pass can
   now observe RunStarted immediately. The existing GitHub Wake label
   reconciler sees the primary WorkflowInstance as active and publishes
   `wake:status.working` plus the current stage/workflow labels before the
   runner completes.
5. Terminal outcome handling is unchanged: the worker writes existing Run
   terminal facts, normal orchestration accepts outcomes on a later tick, and
   the existing label reconciler moves the issue to its resulting terminal or
   waiting state.

## Safety and future cancellation

The dispatch boundary is durable: only a persisted RunStarted creates a worker
candidate, and process-local worker state is never the source of truth. A
failed worker writes the existing RunFailed result and always releases the
activation claim and workspace lease. A process crash leaves the durable Run
active for existing recovery logic.

This isolates a future cancellation action cleanly: it can durably request
cancellation against a started Run, while the worker registry observes that
request and aborts the local process. No cancellation event is introduced in
this change.

## Status-label behavior

No GitHub comment publication is added or changed. GitHub working status is
the existing label reconciler's responsibility. Because the pipeline regains
control after dispatch, its existing maintenance stage reconciles the new
working label in the same tick. A transient GitHub failure does not block the
agent Run; the next maintenance cycle converges labels from durable state.

## Tests

Focused tests prove dispatch returns after RunStarted while the controlled
runner remains in flight; the runner pipeline invokes provider maintenance
after dispatch; and GitHub state sync changes an old failed label to working
for an active primary workflow. Existing execution, recovery, runner-pipeline,
and GitHub label tests remain green.
