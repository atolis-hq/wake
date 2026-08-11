# Safe self-update design

**Status:** Proposed for review

## Decision

Self-update will use a persisted maintenance lease. It prevents new dispatch,
drains active Runs for a bounded interval, requests durable cancellation for
any Runs that remain, and updates only after the system is quiescent.

## Scope

This closes granular-review gap G-M6 for source-mode self-update. It covers
active agent Runs, outbound delivery, interruption, health failure, rollback,
and restart. It does not add a packaged-install self-update path.

## Maintenance lease

Bootstrap owns an operational JSON record beneath `.wake/`. It contains a
stable update attempt ID, requested tag, phase, timestamps, and the prior
healthy tag when known. Its phases are `quiescing`, `updating`, `rolling-back`,
and `failed`.

Starting an update atomically creates the lease before source checkout. A
second self-update observes the existing lease and resumes its phase; it does
not begin a competing update.

## Quiesce protocol

1. Create or resume the maintenance lease in `quiescing`.
2. Control Plane rejects new Run dispatch while the lease is active. Intake,
   projections, recovery, and delivery reconciliation continue.
3. Wait for active Runs through a configured bounded grace interval.
4. For Runs still active, issue durable cancellation requests with reason
   `maintenance`; wait through a configured cancellation interval.
5. If any Run remains active or ambiguous after that interval, mark the lease
   `failed`, retain it for the operator, and do not update or stop the sandbox.
6. Once no active Runs remain, continue with the existing pending-ledger,
   checkout, optional rollout, health-check, and rollback sequence.

Delivery reconciliation continues during quiescing, but no new potentially
effectful delivery is initiated after the update phase begins. An ambiguous
external effect remains an explicit escalation; self-update never repeats it.

## Recovery and rollback

On process restart, a pending maintenance lease is resumed before accepting a
new update. `quiescing` repeats only idempotent observation/cancellation;
`updating` follows the existing update ledger's pending-tag recovery; and
`rolling-back` verifies the prior healthy tag before clearing the lease.

Successful health verification writes the healthy tag and clears the lease.
Any failed health check rolls back source and sandbox, records the failure,
and leaves an operator-visible failed lease until recovery succeeds or the
operator explicitly clears it.

## Configuration

`bootstrap.selfUpdate` owns two positive durations:

- `drainTimeoutMs` — grace period before cancellation requests;
- `cancellationTimeoutMs` — maximum wait for requested cancellation.

Defaults are conservative and the CLI may override neither value in this
packet.

## Update loop

`wake self-update --loop` preserves the legacy periodic-update capability.
Each iteration acquires and releases its own maintenance lease; a successful
or no-op iteration waits the configured interval before checking again. It
must not retain maintenance mode between iterations.

Any failed quiesce, update, health check, or rollback records that attempted
tag as bad and leaves the failed lease visible for the operator. The loop logs
the failure, waits its configured interval, and checks candidates again. It
MUST NOT retry that bad tag unless the operator uses `--force`, but it MUST
attempt a newer candidate tag once one is published. A successful update
clears the failed maintenance lease and the loop continues normally. It
respects process shutdown while waiting between iterations and while
quiescing.

## Tests

The implementation must add composed tests for:

- drain of a completing active Run without cancellation;
- durable cancellation of a Run exceeding the grace interval;
- refusal to update when cancellation cannot be confirmed;
- no new Run dispatch during quiescing;
- no duplicate agent invocation or provider effect across interruption and
  restart;
- failed-health rollback and restart recovery of every lease phase.

Tests use real target composition with fake runners, provider delivery, clock,
and source/Docker boundaries. They assert durable public Run views, maintenance
state, source/rollout calls, and external-effect counts.

## Exclusions

The design does not attempt to transfer in-flight Runs between Wake versions,
force-kill an unconfirmed external process, or hide ambiguous provider effects.
Those conditions block update and require explicit operator action.
