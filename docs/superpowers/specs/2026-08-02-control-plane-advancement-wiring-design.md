# Control-plane Advancement wiring — design

Status: approved, ready for implementation planning.
Covers findings C1, C2, C5, C8 from
`docs/reports/2026-08-02-target-architecture-spec-findings.md`.

## Problem

Traced `advance-once.ts` and `tick-pipeline.ts` directly rather than
treating C1/C2/C5/C8 as four separate items. `advanceOnce` is a single-unit
"dispatch or accept one pending activation" primitive — naive
`pending[0]` selection, no fairness ordering, no pause check.
`TickPipeline.run` wraps it with the stages a continuously-running host
needs: `catchUpProjections → poll → translateInbound → react → advance →
catchUpProjections → deliver → catchUpProjections → react`. The CLI's
`tick` command runs the full pipeline via `TickHost`; the API's `advance`
command (the web UI's on-demand "sync now" action — confirmed the only
caller of `POST /control-plane/commands/advance`) calls bare `advanceOnce`
directly, skipping polling, delivery, and reaction entirely. Separately,
Dispatch Policy (fairness ordering, global pause) and Schedule Policy
(cron-slot → WorkItem generation) are both fully implemented but wired into
no composed path at all, and Schedule Service's actual create-WorkItem
sequence has a real crash-duplication bug once it is wired in.

## Decisions

- **The API's `advance` command becomes `tick`, and runs the full
  `TickPipeline`, not bare `advanceOnce`.** Confirmed the actual use case
  with the operator: a user makes a change on GitHub and doesn't want to
  wait for the resident loop's poll schedule — they want "poll, process,
  and deliver, right now," not "process only what's already pending."
  That's the CLI's `tick` operation, just triggered from the UI instead of
  a schedule. Bounded to one round (`{ maxProgress: 1 }`, matching today's
  call), same as CLI `tick`'s typical single-cycle use. Renaming
  `advance`→`tick` removes the "two operator-facing entry points share a
  name but do different things" problem by making them the same operation.
- **Dispatch Policy (fairness ordering, global pause) moves inside
  `createAdvanceOnce`'s returned function**, not into `TickPipeline`.
  Reasoning: `advanceOnce` is the one chokepoint every caller passes
  through — API `tick`, CLI `tick`, resident, schedule host (control-plane's
  own MODULE.md already claims this: "Tick, resident, and schedule hosts
  use the same bounded advancement capability"). `CONTROL-FAIRNESS`'s own
  requirement is "identically across all hosts" — if pause/fairness lived
  at the `TickPipeline` layer instead, a caller invoking `advanceOnce`
  directly (there may be others besides the now-renamed API command) would
  silently bypass a control meant to be global. Concretely: replace
  `const selected = pending[0]` with real Dispatch Policy selection; add a
  pause check at the top of the returned function that short-circuits to a
  `HostStopReason.Paused`-shaped result before any other work happens.
- **Schedule Policy/Service becomes a `TickPipeline` stage, alongside
  `poll`, not inside `advanceOnce`.** Its job — turning elapsed cron slots
  into new pending work — is conceptually a sibling to polling external
  providers for new activity: both are "generate new candidates for this
  tick," not "process an existing candidate." That's host-level behavior
  appropriate for the pipeline, not something a bare single-unit dispatch
  primitive should trigger as a side effect. Runs after `poll`, before
  `advance`, so Dispatch Policy's selection sees the full set of candidates
  the tick produced (external activity and elapsed schedules alike). A
  direct consequence, not an oversight: once the API's `tick` command runs
  the full pipeline (per the decision above), triggering it manually *will*
  also process any elapsed schedule slots — that's correct, it's what a
  tick now does, not special-cased away.
- **`ScheduleService`'s create-WorkItem sequence becomes idempotent by
  checking the deterministic `WorkflowInstanceId` before minting anything**,
  not by making `WorkItemId` itself derivable. Traced the actual bug: `workflow`
  (the `WorkflowInstanceId`) is already deterministic per slot
  (`workflow-${safe(slot.at)}`), but `item` (the `WorkItemId`) is minted
  fresh from the `IdGenerator` on every call to `run()`, with no check for
  whether one was already minted for this slot. A crash between
  `work.create()` and `checkpoint.save()` means the next run recomputes the
  same slot as still-elapsed, mints a **second**, now-orphaned WorkItem, and
  calls `orchestration.start()` again with the same deterministic
  `workflow` id — which (matching every other idempotent-command pattern in
  this codebase) returns the *existing* WorkflowInstance, still pointing at
  the *first* WorkItemId. The second WorkItem is silently leaked: `open`
  forever, referenced by nothing. Fix: look up the deterministic `workflow`
  id first; if a WorkflowInstance already exists there, reuse its
  `workItemId` and skip `work.create()` entirely; only mint a new
  `WorkItemId` when no WorkflowInstance exists yet for that slot. Chose
  this over deriving `WorkItemId` deterministically from the slot identity
  because that would fight Work's own "identity is minted, not borrowed"
  invariant; a lookup-before-mint check is the same idempotency shape
  already used everywhere else in this codebase (e.g. Resources' reverse-
  index lookup before minting a new Resource/WorkItem pair).

## Architecture

**Changed pieces:**

1. `control-plane/application/advance-once.ts` — `createAdvanceOnce` gains
   a pause-check at the top of its returned function (short-circuits to a
   `Paused`-shaped `AdvanceResult` when globally paused) and replaces naive
   `pending[0]` selection with `DispatchPolicy.select(pending, ...)`.
2. `control-plane/application/tick-pipeline.ts` — `TickPipelineStages`
   gains a `runSchedules: () => Promise<void>` stage, invoked after `poll`
   and `translateInbound`, before `advance`. No-op when no schedules are
   configured.
3. `control-plane/application/schedule-service.ts` — `run()`'s per-slot
   loop looks up the deterministic `workflow` id via a new
   `orchestration.get`-style dependency before deciding whether to mint a
   `WorkItemId`; `ScheduleServiceDependencies.orchestration` widens from
   `Pick<..., 'start'>` to include the lookup.
4. `bootstrap/surface-api-applications.ts` — the `advance` command handler
   (currently `await root.advanceOnce({ maxProgress: 1 })`) is renamed to
   `tick` and switched to run `root.pipeline.run({ maxProgress: 1 })` (the
   same `TickPipeline` the CLI composes), plus the corresponding route/
   client rename (`POST /control-plane/commands/advance` →
   `.../commands/tick`, `surfaces/web/src/api/client.ts`'s `advance` method
   → `tick`).
5. Bootstrap composes `DispatchPolicy` and `SchedulePolicy`/`ScheduleService`
   into `createAdvanceOnce`/`TickPipelineStages` respectively, where
   neither is currently composed at all.

## Error handling

- **Global pause set mid-tick** (between pipeline stages, not at the
  `advanceOnce` check itself) — out of scope for this design; the pause
  check happening at the top of `advanceOnce` is sufficient granularity,
  matching how bounded/cooperative checks already work elsewhere in this
  codebase (checked at a clear boundary, not preemptively mid-operation).
- **`ScheduleService` lookup finds a WorkflowInstance whose `workItemId`
  no longer resolves to a real WorkItem** (shouldn't happen under normal
  operation, since WorkItem creation and workflow start are both durable
  and sequenced before the checkpoint) — treated as a data-integrity error,
  surfaced rather than silently minting a replacement; not expected to be
  reachable in practice, so no dedicated recovery path beyond visibility.
- **API `tick` command invoked while a CLI `tick`/resident host is also
  running** — no new concurrency concern introduced by this design;
  whatever single-flight/locking behavior already governs concurrent
  `advanceOnce`-driven work continues to apply identically, since API
  `tick` now goes through the exact same `TickPipeline`/`advanceOnce` path.

## Testing

- Unit: `advanceOnce` — pause set → returns `Paused` immediately, no
  candidate work touched; Dispatch Policy ordering actually used instead of
  `pending[0]` (assert selection order changes when policy would pick
  differently than array order).
- Unit: `TickPipeline` — `runSchedules` invoked between `translateInbound`
  and `advance`; no-op with empty schedule config.
- Unit: `ScheduleService` — slot already has a WorkflowInstance → no second
  `work.create()` call, checkpoint still advances; slot has none → mints
  and creates as today. Simulated crash (checkpoint not saved after
  `work.create()`+`start()`) followed by a second `run()` call → no
  duplicate WorkItem.
- E2E (fake provider/fake runner, composed production services): API
  `tick` command against a wake-root fixture with pending GitHub activity —
  asserts polling, dispatch, and delivery all happened in one call, not
  just a single-unit advance. A second scenario drives a configured
  schedule through two `tick` calls with a simulated crash between them,
  asserting exactly one WorkItem exists for the slot afterward.

## Deferred / out of scope

- No change to how `HostBudget`/`maxProgress` bounds a *sequence* of
  `advanceOnce` calls within one pipeline run — only where pause/fairness
  checks live within a single call.
- Renaming the underlying route path is included (`advance` → `tick`); no
  backward-compatibility shim for the old path, since this is pre-cutover
  target-architecture work with no external consumers yet.
- CONTROL-QUOTA's `unpause` bug (finding C6) is a separate, already-
  mechanical fix and isn't part of this design.
