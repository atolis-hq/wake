# Tick, Intake, and Resident Hosts — Component Specification

## Type, purpose, and scope

Surface application. `TickHost` repeats a supplied `AdvanceOnce`-shaped
callback up to one bounded cycle's `HostBudget`. `IntakeHost` runs exactly
one poll-and-translate cycle per call. `ResidentHost` repeats either host's
cycles across the lifetime of an `AbortSignal`, sleeping between cycles.
Together these are the composed entry points CLI `tick` and `start` use to
repeat Advancement and intake; none of the hosts has any knowledge of what
its wrapped callback actually does internally.

## Ubiquitous language

- **Bounded cycle** — one `TickHost.run` call: a sequence of `advance`
  calls stopping at the first non-`progressed` result, a budget cap, or a
  wall-clock deadline, whichever comes first.
- **Intake cycle** — one `IntakeHost.run` call: exactly one poll-and-translate
  pass, reported as one advance if it processed anything, zero otherwise.
- **Resident run** — one `ResidentHost.run` call: repeated bounded (or
  intake) cycles until the given `AbortSignal` fires.

## Responsibilities and boundaries

`TickHost` owns looping its `advance` callback with `maxProgress: 1` per
call, counting advances/runs, enforcing the budget's wall-clock and count
caps, and mapping each stopping condition to a `HostStopReason`. It does not
decide what one `advance` call does — in production composition it is given
`RunnerPipeline.run`, so each loop iteration performs the internal half of a
tick (schedules, Advancement, react, deliver, react — no external poll).
`IntakeHost` owns running its cycle callback once per call and mapping
`processed`/not to `advances`/`stoppedBecause`; it does not loop within a
budget the way `TickHost` does, since one poll-and-translate pass is already
the natural unit of intake work. In production composition it is given
`IntakePipeline.run`, which performs the externally-rate-limited half of a
tick (poll, translate inbound). `ResidentHost` owns repeating either host's
cycles and accumulating their totals across a resident lifetime; it does not
itself decide the sleep duration between cycles — that is caller-supplied,
and production composition supplies a different sleep strategy per host (see
Decisions below).

## Core policies, invariants, and behaviours

- `TickHost.run` MUST call `advance({ maxProgress: 1 })` in a loop while
  `advances < maxAdvances` and `runs < maxRuns`, checking the wall-clock
  budget (`Date.now() - started >= maxDurationMs`) at the top of every
  iteration, including before the first call.
- Every `advance` result of kind `progressed` MUST increment `advances` by
  one and `runs` by the length of its `dispatched` batch (Advancement's own
  per-call dispatch loop may start more than one Run per `advance` call, up
  to `controlPlane.maxDispatches`), then continue the loop. `runs` can
  therefore exceed `advances`, and the loop's cap check runs only at the top
  of each iteration — a single `advance` call already in flight is never cut
  short mid-batch, so `runs` can overshoot `maxRuns` by up to one call's
  batch size before the loop next checks and stops.
- Any `advance` result that is not `progressed` MUST stop the cycle
  immediately and MUST be mapped to a `HostStopReason`: `no-work` → `Idle`,
  `waiting` → `Waiting`, `blocked` → `Blocked`; any other kind maps to
  `Budget` (in practice unreachable, since `TickHost` always requests
  `maxProgress: 1`, which never yields `exhausted`).
- Exiting the loop because a count cap was reached (rather than an early
  return inside the loop) MUST also report `Budget`.
- `IntakeHost.run` MUST call its cycle exactly once (ignoring `HostBudget`,
  which has no meaning for a single poll-and-translate pass) and MUST map
  `processed: true` to `{ advances: 1, runs: 0, stoppedBecause: Budget }`
  and `processed: false` to `{ advances: 0, runs: 0, stoppedBecause: Idle }`.
  It never reports a `dispatched` batch, since intake has no honest value for
  one — that is why it does not reuse `AdvanceResult`.
- `ResidentHost.run` MUST repeat `TickHost.run(budget)` (or `IntakeHost`'s
  equivalent) while the signal is not aborted, accumulating `advances` and
  `runs` as a running total across the whole resident lifetime (not per
  cycle), and MUST call the injected `sleep(signal, cadence)` between cycles
  only when the signal has not aborted since the last cycle completed.
- `cadence.consecutiveIdleTicks` MUST increment on any cycle that does not
  progress (`advances === 0`, whether it returned cleanly or threw) and MUST
  reset to 0 on any cycle that progresses. `cadence.consecutiveErrorTicks`
  MUST increment only on a cycle that throws and MUST reset to 0 on any
  cycle that completes without throwing, progress or not — it is a strict
  subset of `consecutiveIdleTicks`, letting a sleep strategy back off
  specifically on a run of failures (e.g. a rate-limited external call)
  without also slowing down ordinary "nothing to do locally" idling.
- The default `sleep` implementation MUST wait for the signal's own abort
  event (resolving immediately if already aborted) and never resolves on a
  timer — so a resident run with no caller-supplied `sleep` performs exactly
  one bounded cycle and then blocks until the signal is aborted externally.
- `ResidentHost.run` MUST catch any error thrown by the wrapped host's `run`,
  pass it to the injected `reportError` callback (default: a no-op), and
  continue the resident loop rather than letting the error propagate and end
  the resident run. A cycle that throws contributes nothing to the
  accumulated `advances`/`runs` totals.
- `ResidentHost.run`'s returned `stoppedBecause` MUST always be
  `HostStopReason.Shutdown`, regardless of the last cycle's own stop reason
  — the only way `run` returns is because the signal aborted, so every
  intermediate cycle's stop reason is discarded from the final result.

## Conceptual schema

**HostBudget** (per bounded cycle; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `maxAdvances` | integer | Cap on accepted outcomes in one cycle. Unused by `IntakeHost`. |
| `maxRuns` | integer | Cap on Runs started in one cycle; may be reached mid-iteration when one `advance` call's dispatch batch pushes `runs` past it, since the cap is only checked between calls. Unused by `IntakeHost`. |
| `maxDurationMs` | integer | Wall-clock cap for one cycle, checked once per loop iteration. Unused by `IntakeHost`. |

**HostResult** (per cycle or resident run; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `advances` / `runs` | integer | Counts reached (`runs` sums each `advance` call's dispatched-batch size, so it need not equal `advances`); for a resident run, cumulative across every cycle so far. `IntakeHost` always reports `runs: 0`. |
| `stoppedBecause` | closed vocabulary: `idle` / `waiting` / `blocked` / `budget` / `paused` / `shutdown` | Why this cycle (or the resident run as a whole) ended; a resident run's own field is always `shutdown`. |

## Dependencies and system role

- Advancement / RunnerPipeline (dependency) — the `advance` callback
  `TickHost` repeats; in production composition this is `RunnerPipeline.run`.
- IntakePipeline (dependency) — the cycle callback `IntakeHost` runs once
  per call; in production composition this is `IntakePipeline.run`.
- Bootstrap composition root (dependent) — constructs one `TickHost` (wrapping
  `root.runnerPipeline.run`) and one `IntakeHost` (wrapping
  `root.intakePipeline.run`), each wrapped in its own `ResidentHost`, exposed
  together as the CLI `start` command; the one-shot CLI `tick` command runs
  an intake cycle once and then drains the runner `TickHost` up to budget,
  mirroring the former combined `runTick` loop.

## Decisions, exclusions, and deferred capability

- `HostStopReason.Paused` is defined and part of `HostResult`'s type, but no
  path through either host produces it: Advancement does consult the global
  dispatch pause and can return `{ kind: 'paused' }`, but `TickHost` maps
  that (and any other non-`progressed`/`no-work`/`waiting`/`blocked` kind) to
  `HostStopReason.Budget`, not `Paused` (see `advance-once.spec.md`).
- The default `reportError` is a no-op; production composition
  (`bootstrap/surface-cli-applications.ts`) supplies one that writes the
  error to `stderr` per resident (`intake`/`runner`), so a thrown error is
  surfaced as a log line, not silently dropped, while the resident loop
  itself keeps running.
- The resident host's inter-cycle sleep is caller-supplied. Production
  composition (`bootstrap/surface-cli-applications.ts`) supplies two
  different strategies: the intake `ResidentHost` backs off exponentially on
  `consecutiveIdleTicks` (`controlPlane.resident.pollBackoffMs`/
  `maxPollBackoffMs`), because it unconditionally polls a rate-limited
  external API (GitHub) every cycle; the runner `ResidentHost` waits on the
  journal's `JournalChangeSignal` (falling back to a fixed, non-configurable
  safety-net interval if nothing signals — it's a correctness net for a
  missed notification, not an operator-tunable cadence) when
  idle-without-error and not at all when the prior cycle made progress,
  since dispatch and projections never poll that API on their own — a real
  journal append wakes it within milliseconds rather than on a fixed poll
  interval. This mirrors legacy `src/core/control-plane.ts`'s
  `runIntakeTick`/`runRunnerTick` split (`idleBackoff: true` vs `false`).
  But some runner stages (delivery, GitHub label maintenance) do call that
  same external API on their own schedule, not a poll, so the runner
  `ResidentHost` still backs off exponentially on `consecutiveErrorTicks`
  specifically — a repeated failure (e.g. that API rate-limiting) gets the
  same exponential relief as intake, without slowing down the case that
  motivated the split: noticing and starting already-pending local work.
