# Cleanup handoff: decompose `tick-runner.ts`

Source: architectural review of `main` at `bbbf616` (2026-07-20), scope "loose coupling, separation of responsibilities, simplicity." This doc is the actionable follow-up, not a replacement for reading the code — every extraction below has non-obvious invariants documented in the existing comments; read them before moving the code, don't just cut-paste.

## Why

`src/core/tick-runner.ts` is ~1700 lines. `policy-engine.ts` (301 lines, decision-only) and `sink-router.ts` (small, single-purpose) show the shape the rest of `core/` already uses: a focused `createX(deps)` factory with a narrow interface. `tick-runner.ts` never got split that way — it grew by accretion, one incident/issue at a time (#82, #135, #258, #267 are all cited inline), with each fix added as a new closure in the same function scope instead of a new module. Net effect: six-plus independent concerns share one 1700-line function, most are only reachable/testable by driving a full `runTick()`, and one piece of logic (candidate eligibility) has silently forked into two copies.

## Fix first: duplicated eligibility logic (do this before any extraction)

`shouldMarkPending` (tick-runner.ts:319-342) and the inline predicate inside `runRunnerTick`'s `projections.find(...)` (tick-runner.ts:1182-1200) implement the same question — "is this issue eligible, on a known workflow stage, and does it have a next action" — as two independent call chains through `isEligible` → `workflowForProjection`/`isKnownWorkflowStage` → the `isAwaitingApproval` branch → `resolveCustomCommandRequest`/`chooseAction`/`chooseRetryActionAfterHumanReply` → `needsWakeAction`.

- Unify into one function, e.g. `policy.resolveNextEligibleAction(issue, config): { action: AgentAction; workflow: WorkflowDefinition } | null`, added to `policy-engine.ts` (it's a pure decision, that's where it belongs).
- Both call sites become: get the resolution, `null` → not eligible / idle; non-null → proceed.
- This is the fix the #258 incident comment (tick-runner.ts:1302-1311) is implicitly asking for: that incident happened because a rule change didn't propagate everywhere it needed to. Two copies of the eligibility predicate is the same risk, still live.
- Do this first and independently of the extraction work below — it's a small, self-contained, high-value change, and doing it before splitting the file means you only have to get it right in one place.

## Extraction plan

Each of these is a cohesive concern currently living as closures inside `createTickRunner`. Pull each into its own `src/core/*.ts` module with a `createX(deps)` factory (mirror `sink-router.ts`'s shape), taking only the slice of `deps` it actually needs — not the full `tick-runner` deps bag. Update `createTickRunner` to compose them. Do NOT change behavior while extracting; this is a pure move + narrow-the-interface pass. Behavior changes (if any turn out to be warranted) are a separate follow-up.

1. **`core/event-resolver.ts`** — `resolveInboundEvent`, `buildOriginCorrelationEvents`, `ingestInboundEvents`, `laterTimestamp`. This is "how an unkeyed event becomes a work item" — the correlation-resolution subsystem described in `docs/adrs/0001-correlating-external-resources-to-work-items.md`. Needs `stateStore`, `resourceIndex`, `policy.qualifiesForMint`, `clock`. The comments on `resolveInboundEvent` and `buildOriginCorrelationEvents` describe crash/replay invariants (the "heal a partially minted work item" branch, the ordering-must-hold-by-construction reasoning) — preserve them verbatim next to the moved code, they're load-bearing documentation, not incidental.
2. **`core/outbox.ts`** — `attemptDelivery`, `recordDeliveryFailure`, `deliverOutboundEvent`, `retryUnconfirmedDeliveries`, the `outboundIntentEventTypes`/`outboundConfirmationEventTypes` sets, `outboxMaxAttempts`. Self-contained outbox pattern; needs `stateStore`, `outboundSink`, `clock`, and a `rebuildFromEvents` callback (or take the `projectionUpdater` instance directly). This is the best first extraction to attempt — it already has the cleanest boundary (no dependency on the candidate-selection logic) and is the easiest to unit-test in isolation once moved (currently only reachable through a full tick).
3. **`core/stale-run-reconciler.ts`** — `isStaleRunningRecord`, `reconcileStaleRunningRecords`. Needs `stateStore`, `runnerTimeoutMs()` (pass as a function or precomputed value), and a way to emit the label-update side effect (either take `deliverOutboundEvent` from the outbox module as a dependency, or return a description of what to deliver and let the caller call it — prefer the latter if it keeps this module from depending on the outbox module).
4. **`core/workspace-cleanup.ts`** — `cleanupClosedIssueWorkspaces`, `isPerIssueWorkspacePath`. Needs `workspaceManager`, `stateStore`, `config.paths.wakeRoot`, `config.transcripts.retainAfterWorkspaceCleanup`, `clock`.
5. **`lib/format.ts`** (or extend an existing `lib/` file if one already covers formatting) — `formatCostUsd`, `formatDuration`, `formatTokenCount`, `extractTokenCount`. Pure functions, zero dependency on tick state. These belong in `lib/` per this repo's own module-boundary convention ("small focused utilities"), and moving them is what makes them directly unit-testable instead of only reachable through a full run.
6. **Event/label envelope builders** — `createLabelsEvent`, `createPublishIntentEvent`. These are payload-shaping, not orchestration. Candidate home: a `core/event-builders.ts`, or fold into whichever of the above modules is their primary caller (`createLabelsEvent` is called from several places — intake, approval, stale-reconciliation, main run path — so it probably wants its own small module rather than living in one of the others).

After all six extractions, `tick-runner.ts` should read close to: acquire lock → resolve candidate (via the unified `policy.resolveNextEligibleAction`) → resolve routing → prepare workspace → invoke runner → record outcome → hand off to the outbox/label modules for delivery. That's the actual tick decision logic; right now it's buried under the supporting machinery above.

## Non-negotiable invariants (apply to every extraction, not just the ones that look event-related)

These are existing repo invariants (see `CLAUDE.md` and the ADR) — moving code must not weaken any of them:

1. **Event stamping stays per-event, not per-tick.** `eventStampNow()` reads the clock at the moment of stamping. Do not let any extracted module cache "now" once and reuse it across multiple events — that's the exact bug class `CLAUDE.md` calls out (events sorting before the projection-creating event they fold against, silently dropped on replay).
2. **`rebuildFromEvents` ordering is stable-sort-on-`ingestedAt`, no `eventId` tie-break.** Any extracted module that appends multiple events must preserve append order for same-timestamp events, exactly as the current code does (see `buildOriginCorrelationEvents`'s comment on why the source event is appended first).
3. **Crash/replay safety.** Every extracted function needs to remain safe to re-run from scratch after a crash mid-sequence (append succeeded, fold didn't; or vice versa). Don't introduce any in-process caching of "what happened last tick" while relocating this code — `CLAUDE.md`: "the tick is a pure function of durable state."
4. **`core/` never imports a concrete adapter directly.** New modules still take interfaces from `contracts.ts`, wired in by `main.ts`'s `buildRuntime` (or composed inside `tick-runner.ts` itself, since these are `core/`-internal collaborators, not adapters — either is fine, just don't reach into `adapters/`).

## Smaller opportunistic fixes (do only if touching the relevant file anyway — don't scope-creep the extraction PR)

- `workspaceModeForCustomCommand` (tick-runner.ts:96-101) is a one-line pass-through to `customCommandWorkspace` from `domain/custom-commands.ts`. Either inline the call at its one call site or drop the wrapper.
- `policy-engine.ts` repeats `issue.context as Record<string, unknown>` plus manual `typeof` guards for the same handful of fields (`lastHandledCommentId`, `lastCompletedAction`, `lastRunSentinel`, `lastFailureClass`, `lastRunAction`, `pendingApprovalAction`) across `needsWakeAction`, `chooseRetryActionAfterHumanReply`, `resolveApprovalTransition`, and the free function `latestUnhandledHumanComment`. If `domain/types.ts` can give `IssueStateRecord.context` a real (even partial) shape instead of `unknown`, a single typed accessor removes all of these casts. Worth doing if you're already in `policy-engine.ts` for the eligibility-unification fix above; not worth a separate PR on its own.

## Testing approach

`test/core/tick-runner.test.ts` is currently one large `describe('tick runner', ...)` block (~5300 lines) that exercises everything through `runTick`/`runIntakeTick`/`runRunnerTick` end-to-end via the fake adapters (`createFakeRunner`, `createFileBackedFakeTicketingSystem`, `createFakeWorkspaceManager` — per this repo's testing convention, keep using these, don't mock `contracts.ts` ad hoc).

- Do the extraction so the existing end-to-end tests keep passing unmodified — they're your regression safety net for the crash/replay invariants above, and it proves the move was behavior-preserving.
- Add focused unit tests for each newly-extracted module (especially `lib/format.ts` and `core/outbox.ts`, which are the two with the cleanest boundaries and the least excuse not to be tested directly).
- `npm run verify` (build + test) must pass before calling this done.

## Acceptance

1. `policy.resolveNextEligibleAction` (or equivalent) exists; `shouldMarkPending` and the `runRunnerTick` candidate predicate both call it — no independent copy of the eligibility chain remains anywhere in `tick-runner.ts`.
2. `tick-runner.ts` is meaningfully shorter (target: under ~500 lines) and reads as tick orchestration only — event-resolution, outbox, stale-run reconciliation, workspace cleanup, and formatting all live in their own modules.
3. Every invariant-explaining comment moved with its code, not left behind or summarized away.
4. `npm run verify` passes with no behavior changes to existing tests.
5. New unit tests exist for at least `lib/format.ts` and `core/outbox.ts` in isolation (not only reachable through a full tick).
