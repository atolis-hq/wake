# Wake runner controls design

## Goal

Close Task 25B step 13 with durable, operator-accessible runner pause controls
and truthful runner availability, while preserving global and WorkItem pause
scopes.

## Decision

Runner control uses two explicit idempotent commands:

- `POST /api/v1/runners/:runnerId/commands/pause`
- `POST /api/v1/runners/:runnerId/commands/unpause`

Both accept only the existing idempotency key. A pause appends
`control-plane.runner-paused` with `cause: manual` and
`reason: "paused by operator"`; it has no expiry. An unpause appends
`control-plane.runner-resumed`, which clears either manual or quota pause early.
Unknown or unconfigured runners are rejected.

## Runtime behavior

The control-plane projection remains the durable source of runner health. A
quota pause is active until its persisted `resumeAt`; a manual pause is active
until `RunnerResumed`. The composed advancement path derives the active runner
set from this view and passes it to Execution, which selects the next candidate
only within the activation's configured tier.

The runner list derives `available`, `status`, and pause detail from the same
projection and the clock. It must not report a paused runner as available.

## Web behavior

The health runner view uses the runner list state to show one action per runner:
Pause for an available runner and Unpause for a paused runner. Each action sends
the explicit API command with a fresh idempotency key and refreshes runner data.

## Proof

Tests cover strict events, command idempotency and unknown runners, manual
pause/unpause, quota expiry, early quota resume, restart/replay, composed
same-tier fallback, truthful API runner state, and the web action state. The
existing required lint, architecture, unused-code, target, and legacy gates
remain required before completion.
