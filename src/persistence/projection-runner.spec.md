# Projection Runner — Component Specification

## Type, purpose, and scope

Policy/process. The Projection Runner deterministically advances registered
projections from the Event Journal to the Projection Store, tracking
progress in the Checkpoint Store, and can rebuild a single projection from
scratch. It is the only component that coordinates all three storage ports
together.

## Ubiquitous language

- **Run** — one bounded pass over a projection's unread events, up to a
  batch limit, ending either because the journal is caught up or because
  the limit was reached.
- **Registered projection** — a projection definition supplied when the
  runner is constructed; the runner treats its name, event selector, initial
  value, and fold function as opaque behaviour owned by a domain module.

## Responsibilities and boundaries

The Projection Runner owns: reading each projection's unread events from its
own checkpoint, applying the definition's selection and fold, writing the
resulting value, and advancing the checkpoint. It does not own what a
projection's fold means — that is the definition, supplied by a domain
module — and it does not decide when a run happens; callers (Bootstrap's
tick pipeline, operator diagnostics) schedule that.

## Core policies, invariants, and behaviours

- For each event read, in increasing global-position order, a run MUST call
  the definition's selector. When it returns nothing for that event, the
  event MUST NOT change the projection's stored value for any key.
- The checkpoint MUST advance past every event a run reads, whether or not
  the definition selected it, so a later run never rescans an event this
  run has already considered.
- A write MUST be skipped when the currently stored value's own
  `lastGlobalPosition` is already at or beyond the incoming event's global
  position. This makes re-applying an event the runner has already folded —
  for example after a crash between writing the value and advancing the
  checkpoint — a no-op rather than a double application.
- A projection definition's initial value MUST be used only the first time
  a given key is encountered for that projection; every later event folds
  onto the value already stored for that key.
- Running every registered definition MUST run each definition's own pass
  independently; one definition's failure MUST NOT be silently absorbed —
  it MUST surface as a failure of the overall call, and MUST NOT prevent
  the other definitions' passes, already started, from completing.
- Running every registered definition MUST remember the highest global
  position at which every definition's pass most recently read fewer events
  than the batch limit — that is, the point at which all of them were fully
  drained. While the journal's latest event has not advanced past that
  point, a further call MUST return 0 immediately, without reading any
  checkpoint or writing to the projection store. A backlog larger than one
  call's limit MUST keep being drained across repeated calls, and MUST NOT
  be treated as drained until every definition's pass reads fewer than the
  limit in the same call.
- Rebuilding a definition MUST clear that projection's entire stored
  namespace and reset its checkpoint before replaying, then MUST continue
  running bounded passes until a pass returns fewer events than its batch
  limit — that is, until the journal is caught up for that definition. A
  rebuild MUST NOT affect any other definition's stored values or
  checkpoint.
- Because global position is assigned once, is strictly increasing, and
  `readAll` returns events in that same order, replaying a definition's
  entire history from position 0 MUST reproduce a value identical to the
  one produced by folding events as they were originally appended.

- Resident callers retain the durable position sampled by a completed pass
  and call `waitForEventsAfter` before the next bounded pass. An append in
  the read-to-wait interval therefore starts another pass without a fixed
  polling delay; fallback is recovery only.

## Dependencies and system role

- Kernel — the projection-definition contract (name, selector, initial
  value, fold function) and the event envelope shape the runner reads.
- Event Journal (depends on) — the source of events for every run.
- Projection Store (depends on) — where folded values are written and
  cleared.
- Checkpoint Store (depends on) — where read progress is tracked and reset.
- Bootstrap (depends on Projection Runner) — schedules a full pass over
  every registered definition as part of the tick pipeline, and exposes
  per-definition rebuild through operator-facing diagnostics.

## Decisions, exclusions, and deferred capability

- No parallelism within one definition's own run; its events are applied
  strictly in order. Different definitions' runs do proceed concurrently
  with each other within one call.
- No partial or scoped rebuild — rebuilding a definition always replays its
  entire history; there is no way to rebuild only one key.
- The batch size bounding one run is a fixed code default, not exposed as
  operator configuration; a caller wanting full catch-up beyond one run's
  limit calls repeatedly, as rebuild does, or accepts convergence over
  multiple scheduled runs.
