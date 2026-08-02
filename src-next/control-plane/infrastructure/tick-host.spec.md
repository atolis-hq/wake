# Tick and Resident Hosts — Component Specification

## Type, purpose, and scope

Surface application. `TickHost` repeats a supplied `AdvanceOnce`-shaped
callback up to one bounded cycle's `HostBudget`. `ResidentHost` repeats
`TickHost` cycles across the lifetime of an `AbortSignal`, sleeping between
cycles. Together these are the composed entry points CLI `tick` and `start`
use to repeat Advancement; neither host has any knowledge of what its
`advance` callback actually does internally.

## Ubiquitous language

- **Bounded cycle** — one `TickHost.run` call: a sequence of `advance`
  calls stopping at the first non-`progressed` result, a budget cap, or a
  wall-clock deadline, whichever comes first.
- **Resident run** — one `ResidentHost.run` call: repeated bounded cycles
  until the given `AbortSignal` fires.

## Responsibilities and boundaries

`TickHost` owns looping its `advance` callback with `maxProgress: 1` per
call, counting advances/runs, enforcing the budget's wall-clock and count
caps, and mapping each stopping condition to a `HostStopReason`. It does not
decide what one `advance` call does — in production composition it is given
`TickPipeline.run`, so each loop iteration performs a full tick (poll,
translate, react, Advancement, deliver, react), not a bare Advancement call.
`ResidentHost` owns repeating `TickHost` cycles and accumulating their
totals across a resident lifetime; it does not itself decide the sleep
duration between cycles — that is caller-supplied.

## Core policies, invariants, and behaviours

- `TickHost.run` MUST call `advance({ maxProgress: 1 })` in a loop while
  `advances < maxAdvances` and `runs < maxRuns`, checking the wall-clock
  budget (`Date.now() - started >= maxDurationMs`) at the top of every
  iteration, including before the first call.
- Every `advance` result of kind `progressed` MUST increment both `advances`
  and `runs` together by one and continue the loop; these two counters are
  never incremented independently, so `maxAdvances` and `maxRuns` only
  diverge in effect when a caller sets them to different values, and
  whichever is smaller governs when both counters are equal at every step.
- Any `advance` result that is not `progressed` MUST stop the cycle
  immediately and MUST be mapped to a `HostStopReason`: `no-work` → `Idle`,
  `waiting` → `Waiting`, `blocked` → `Blocked`; any other kind maps to
  `Budget` (in practice unreachable, since `TickHost` always requests
  `maxProgress: 1`, which never yields `exhausted`).
- Exiting the loop because a count cap was reached (rather than an early
  return inside the loop) MUST also report `Budget`.
- `ResidentHost.run` MUST repeat `TickHost.run(budget)` while the signal is
  not aborted, accumulating `advances` and `runs` as a running total across
  the whole resident lifetime (not per cycle), and MUST call the injected
  `sleep(signal)` between cycles only when the signal has not aborted since
  the last cycle completed.
- The default `sleep` implementation MUST wait for the signal's own abort
  event (resolving immediately if already aborted) and never resolves on a
  timer — so a resident run with no caller-supplied `sleep` performs exactly
  one bounded cycle and then blocks until the signal is aborted externally.
- `ResidentHost.run`'s returned `stoppedBecause` MUST always be
  `HostStopReason.Shutdown`, regardless of the last cycle's own stop reason
  — the only way `run` returns is because the signal aborted, so every
  intermediate cycle's stop reason is discarded from the final result.

## Conceptual schema

**HostBudget** (per bounded cycle; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `maxAdvances` | integer | Cap on accepted outcomes in one cycle. |
| `maxRuns` | integer | Cap on Runs started in one cycle; always equal to `advances` in the current implementation. |
| `maxDurationMs` | integer | Wall-clock cap for one cycle, checked once per loop iteration. |

**HostResult** (per cycle or resident run; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `advances` / `runs` | integer | Counts reached; for a resident run, cumulative across every cycle so far. |
| `stoppedBecause` | closed vocabulary: `idle` / `waiting` / `blocked` / `budget` / `paused` / `shutdown` | Why this cycle (or the resident run as a whole) ended; a resident run's own field is always `shutdown`. |

## Dependencies and system role

- Advancement / Tick pipeline (dependency) — the `advance` callback
  `TickHost` repeats; in production composition this is `TickPipeline.run`,
  not the bare Advancement function.
- Bootstrap composition root (dependent) — constructs `TickHost` with
  `root.pipeline.run` and wraps it in a `ResidentHost`, exposed as the CLI
  `tick` and `start` commands.

## Decisions, exclusions, and deferred capability

- `HostStopReason.Paused` is defined and part of `HostResult`'s type, but no
  path through either host produces it, since global dispatch pausing is
  not consulted by Advancement.
- The resident host's inter-cycle sleep is caller-supplied; the composed
  production system does not currently supply one, so a composed resident
  run performs one bounded cycle and then blocks until externally aborted.
  `controlPlane.resident.idleBackoffMs` is validated configuration with no
  consumer today.
