# Clear stale board outcome on retry

## Purpose

When an operator retries a work item after a terminal run outcome, its board card must show only the newly active run. A previous failed, blocked, cancelled, or other terminal outcome must not remain visible while the retry is running.

## Design

The operator-board projection clears `lastRunOutcome` when it folds `RunStarted` for a primary workflow run. The event already makes the card Active and records the new `activeRun`; clearing the outcome there makes the stored card represent the latest run state.

Child-run behaviour remains unchanged: child runs can contribute run statistics without driving the shared parent card's condition or clearing its state.

## Verification

Add a projection regression test that folds a failed primary run followed by a second primary `RunStarted` event. It asserts that the card is Active, exposes the new active run, and omits `lastRunOutcome`.
