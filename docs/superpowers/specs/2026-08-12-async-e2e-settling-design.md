# Async E2E Settling Design

## Purpose

Keep asynchronous execution observable as discrete scheduler ticks while
giving ordinary end-to-end scenarios a deterministic way to wait for work
that is expected to settle.

## Design

`TestWorld.advance()` remains a one-tick wrapper around `advanceOnce`. It
continues to expose a durable started run immediately, which is essential for
cancellation and recovery scenarios.

`TestWorld.advanceUntilSettled()` will be added as a test-only helper. It will
invoke `advance()` repeatedly, yielding the JavaScript microtask queue between
ticks, until the requested work item has no pending activation and no started
run, or a small fixed iteration limit is reached. On exhaustion it will throw
an error containing the workflow and run state so a genuinely stuck scenario
is diagnosable rather than silently timing out.

Scenarios whose assertions require an eventual workflow state (`waiting`,
`blocked`, or `completed`) will use the settling helper. Scenarios which
inspect an in-flight run will retain the one-tick method.

## Local test workflow

The default `npm test` command remains the full non-live suite because CI's
`npm run verify` invokes it. A `test:fast` script will run the unit suite for
quick local feedback. Development documentation will distinguish focused and
unit checks from the authoritative full CI verification.

Unit and integration configurations will state their file-level parallelism
explicitly. Their tests have no shared on-disk test root. E2E remains serial:
some scenarios start processes or make filesystem changes, so parallelizing it
without further isolation would trade speed for flaky results.

## Scope and safety

No production scheduler, runner, filesystem, or CI behavior changes. The
helper is bounded, has no timers, and operates only on the in-memory E2E
world. Filesystem-backed recovery tests remain explicitly serial.

## Verification

Tests will first demonstrate that a zero-delay asynchronous activity settles
through the helper but remains started after exactly one `advance()` call. The
affected lifecycle scenario will then use the helper. The focused E2E test,
unit suite, and focused integration/bootstrap test will be run before the
full suite is attempted.
