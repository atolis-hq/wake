# Execution Invariants

This page documents Wake's current execution guarantees. These are properties of the scheduler and runner handoff as implemented today, not future design promises.

## Current Guarantees

- **Single active run per work item.** Wake dispatches runner work through the runner lock and the durable run-record capacity check. With the current scheduler, dispatch is strictly serial: a second runner tick does not start while another runner tick owns the runner lock, and an active running record prevents new dispatch.
- **Durable claim before launch.** A run record is written, a `wake.run.claimed` event is appended, and the projection is rebuilt from that claim before Wake prepares the workspace and invokes the runner.
- **Reconciliation before dispatch.** Each intake tick and runner tick reconciles stale or incomplete running records before selecting new work. Startup-era claims without a run record are recovered into a terminal completion event before new runner work begins.
- **Eligibility is rechecked immediately before launch.** Wake refreshes the candidate's source state before claiming. If the source no longer exists, the refresh fails, or the refreshed projection is no longer policy-eligible, Wake leaves the tick idle and does not start a run.
- **Launched processes are identifiable and cancellable.** Run records carry the work item key, repository and issue snapshot, action, routing runner, start time, worker process identity, lease owner, lease id, and workspace metadata when a workspace is prepared. Runners that report their child process identity persist the agent PID and process start time on the same run record. The active lease and process identities are the cancellation/recovery path used by reconciliation.
- **Runs finish once.** A completed attempt is recorded by moving its run record to lifecycle `TERMINAL` with one terminal status/sentinel/outcome and by appending one `wake.run.completed` event for that run id. Reconciliation uses the same terminal event shape for recovered stale runs.
- **Workspace state is reconciled on startup.** Because startup enters the same tick path, Wake validates state health and reconciles stale running records or missing run-record claims before dispatching any new runner work.
- **Dispatch order is deterministic.** When multiple projections are eligible, Wake reads projections from durable state in sorted work-item-key order and dispatches the first eligible item. Current execution is serial, so there is no parallel tie-breaker beyond that order.

## Test Coverage

The executable coverage for these guarantees lives in `test/core/tick-runner.invariants.test.ts` under `explicit scheduler/execution invariants`. The tests exercise durable state and fake adapters (`createFakeRunner`, `createFileBackedFakeTicketingSystem`, `createFakeWorkspaceManager`) rather than mocked scheduler internals, and they run as part of the normal `npm run verify` suite.
