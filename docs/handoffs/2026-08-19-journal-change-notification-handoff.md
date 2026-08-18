# Handoff: implement journal change notification, replace resident-loop polling

- Date: 2026-08-19
- Spec: [`docs/plans/2026-08-19-journal-change-notification.md`](../plans/2026-08-19-journal-change-notification.md) — read it first; this doc is branch state, step-by-step, and verification, not a replacement.
- Report: [`docs/reports/2026-08-19-resident-loop-full-history-rescan.md`](../reports/2026-08-19-resident-loop-full-history-rescan.md) — the investigation and evidence behind the spec.
- Branch: none yet. Start fresh from `main` (this session's diagnostic instrumentation was all temporary and fully reverted — nothing to build on, no branch exists).
- Prior related work: PR #713 (`fix/journal-projection-write-cache-invalidation`, merged) fixed a different bug in the same area (write-caused cache invalidation) — already shipped, don't re-touch `FileEventJournal`'s/`FileProjectionStore`'s existing cache-extension logic except to add the notifier hook described below.
- Also filed from the same investigation, separate and unrelated — don't conflate:
  - #715 — scope GitHub issue polling to intake-qualifying items (a different poll-volume problem, GitHub API side, not the journal).
  - #717 — intake retries a permanently-broken resource forever (a different infinite-retry bug, unrelated to this one; confirmed via evidence in this investigation that it is *not* contributing to the busy-loop — see the report's "Root cause" section, which explicitly rules it out).

## What's already true, verified this session (don't re-derive, build on it)

- `~/wake-home`'s real data volume: 8,714 events, ~19MB total. Not a factor — don't spend time on "reduce history size" approaches.
- The busy-loop is **not** `advance()`, **not** the `ResidentHost` outer loop (both directly measured, confirmed calm and correctly backing off), **not** the projection pump's own `setInterval` (confirmed via source, throttled to 1/sec), **not** HTTP API traffic (confirmed zero requests during the measurement window). It **is** `DeliveryOutcomeReactor.runOnce()`'s unconditional `journal.readAll(0)` on every call (`src/integrations/delivery/application/delivery-outcome-reactor.ts:29`), confirmed by direct call-stack sampling, not inference.
- A "detach every parsed string from its source buffer" fix was tried and measured **worse** than baseline — don't reattempt that angle; see the report's "Investigative dead ends" section for why.
- `eslint.config.js`'s `fullJournalRescanRule` exemption already documents `delivery-outcome-reactor.ts`'s second pass as known, deferred debt — this isn't a surprise finding, it's closing a gap the codebase already flagged.

## Step by step

1. Read both linked docs in full.
2. Implement `JournalChangeSignal` (spec's "Core principle" + "`JournalChangeSignal`" sections). Decide during implementation whether it lives beside `FileEventJournal` or in `kernel/infrastructure` — base the call on whether `InMemoryEventJournal` (the test fake) should implement the same interface for test parity. It probably should; check existing journal contract tests (`test/integration/persistence/file-event-journal.test.ts` and whatever exercises `InMemoryEventJournal`) for the pattern to extend.
3. Wire `FileEventJournal.append()` to call `notify()` after a successful write with `newEnvelopes.length > 0` — mirror the existing guard, don't notify on an idempotent no-op append.
4. **`DeliveryOutcomeReactor` first** (dominant measured cost, and the one piece with a real behavior change — get it right and reviewed before touching the others):
   - Preserve the existing incremental first pass unchanged.
   - Replace the unconditional full-history second pass with the bounded "pending confirmations awaiting a waiting workflow" set described in the spec.
   - The existing test "catches up a matching confirmation that was checkpointed before its delivery wait" in `delivery-outcome-reactor.test.ts` is the regression guard for this — it must still pass, unmodified in intent, against the new design.
5. Switch the runner pipeline's `catchUpProjections` and the standalone projection pump (`runProjectionPump` in `src/bootstrap/surface-cli-applications.ts`) to `waitForChange` instead of their current fixed-interval sleeps.
6. Switch `IntakeHost`'s `isPaused()` polling and `advance()`'s `cachedJournalView`-backed checks (`transitionWatchChildren`, `listWaiting`) to the same primitive, for consistency — lower priority than steps 4-5, fine to sequence last.
7. Raise `controlPlane.resident.idleBackoffMs`'s default (schema default in `src/control-plane/contracts/config.ts`, currently `1000`) to something in the 30,000-60,000 range, now that it's a fallback ceiling rather than the steady-state cadence. Don't add a new config key for this — it's the same knob, new meaning.
8. Update `~/wake-home`'s own `config.yaml` if it should reflect the same value explicitly (it currently doesn't set `controlPlane.resident` at all, so it's on whatever the schema default is — confirm whether that's still desired once the default changes, or whether an explicit override makes sense for that specific home).

## Testing instructions

Follow the spec's "Testing instructions" section exactly — six items, most importantly #1 (prove the guarantee holds even with `notify()` stubbed to a no-op) and #4 (the `DeliveryOutcomeReactor` race-preservation test). In short:

1. `npm run verify:ci` — this is cross-cutting (control-plane, persistence, integrations), not a single-module change.
2. New tests per the spec: guarantee-preservation with `notify()` stubbed out, coalescing, multiple independent subscribers, and the `DeliveryOutcomeReactor` race case.
3. Real-process verification against `~/wake-home` (or a copy) — rebuild the sandbox image via `wake-dev sandbox build` + `wake-dev sandbox update` from that home directory (the Dockerfile that matters is `~/wake-home/docker/Dockerfile`, **not** the source repo's `docker/Dockerfile` — the build context is the source repo, but the Dockerfile path is resolved from the target Wake home; this tripped up this session once, don't repeat it), then confirm via temporary call-counting instrumentation (same pattern used in this investigation — add, measure, remove before merge, don't leave diagnostic `console.error` calls in the shipped diff) that idle journal-read volume drops to near-zero and that appending a real event wakes affected consumers within milliseconds.
4. Before declaring done: confirm the two currently-orphaned/blocked items from this session's crash cycles (if still in that state — check current `~/wake-home` status, don't assume) are cleanly resolved via the normal operator-retry path, not left stuck.

## Raising the PR

Once verified: standard flow — new branch off `main` (don't reuse `chore/ignore-worktrees-dir`, it's stale and unrelated, same reasoning as #713's branch choice), commit, push, `gh pr create`. Reference this handoff, the spec, and the report in the PR description; include the before/after journal-read-rate numbers from your own real-process verification, the same way #713's PR documented its before/after profiling numbers.
