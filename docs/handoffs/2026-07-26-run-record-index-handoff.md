# Handoff: implement the run-record summary index

- Date: 2026-07-26
- Spec: [2026-07-26-run-record-summary-index.md](../plans/2026-07-26-run-record-summary-index.md) — read it first; this doc is branch state, audit, and step-by-step, not a replacement.
- Branch: `fix/bound-run-record-listing-metadata` (PR [#409](https://github.com/atolis-hq/wake/pull/409), open against `main`, not yet merged)
- Incident this traces back to: 2026-07-26 — a closed-issue watcher kept re-dispatching runs (fixed separately in #408, merged), which inflated run-record history enough to first OOM-crash and then merely cripple (4+ minute request times) the resident loop and UI.

## What's already on this branch, and why it's still correct

Six commits already landed on `fix/bound-run-record-listing-metadata`, fixing the *byte-weight* half of this problem (each run record can carry 1-2.5MB of captured agent stdout in `metadata.stdout`/`stderr`/`raw` plus `runtimeEvents`; several read paths loaded that in full, unbounded, just to compute small aggregates). In order:

1. `c6a9c1f` — added `stripHeavyRunRecordFields`/`listRunRecordSummaries()`/`listRunRecordSummariesForDate()` in `state-store.ts`; switched `buildRuns` and the metrics bucket scan to use them.
2. `78032a9` — same switch for `buildItemDetail`/`buildItemTranscripts` (same bug, filtered to one item *after* parsing everything).
3. `0f6b767` — same switch for the resident tick loop's own per-tick reads (`markPendingActionableIssues`, `exceedsDispatchRateLimit`, `hasSchedulerCapacity` in `tick-runner.ts`) — these run every ~2 minutes regardless of UI activity, and explain the crash recurring on a fixed cadence even after the UI-facing paths were fixed.
4. `c11adf9` — same for `stale-run-reconciler.ts`'s per-tick staleness scan, **except** the two places it rewrites a record: those re-fetch the full record via `readRunRecord()` first, because this function spreads a listed record's `metadata` back into a `writeRunRecord()` call — summarizing the scan without this would silently drop captured stdout from disk on the next reconciliation.
5. `54ae58c` — the actual dominant cost at the time: `readRunRecord()`'s fallback (hit whenever a run's flat file is missing) used to do a full, unstripped scan of up to 500 records just to find one by id. Now scans summaries first, then does one targeted full read of just the matching file.
6. `3ad43fa` — `buildBoard` was calling that `readRunRecord()` fallback once per work item (54 items via `Promise.all`) — up to 54 separate scans per board load. Switched to one shared summarized scan (`Map` by `runId`) instead.

### Audit: is this all still valid, and does anything risk truncating data?

**Yes, still valid — nothing here is superseded by the index spec; the index spec builds directly on top of it.** `listRunRecordSummaries()`/`listRunRecordSummariesForDate()` are a stable public contract now (same signature, same sort order) that every call site above already uses. The index spec only changes what happens *inside* those two functions (index-first instead of scan-every-file) — every call site listed above needs zero further changes.

**No truncation risk, checked function by function:**
- Every write path (`writeRunRecord`) is completely unchanged across all six commits — always writes the full record. Nothing added here ever writes a stripped/summarized record to disk.
- The one place that reads a possibly-summarized record and then writes based on it (`stale-run-reconciler.ts`) explicitly re-fetches the full record via `readRunRecord(record.runId)` immediately before each `writeRunRecord()` call — verified by a test (`test/core/stale-run-reconciler.test.ts`: "preserves captured metadata on a reconciled record even though the staleness scan reads summaries") that writes a record with a large `metadata.stdout`, runs reconciliation, and asserts the field survives.
- `readRunRecord()`'s fallback degrades to returning a stripped summary only if the *targeted full read of the specific matching file* also fails after already being found via the summary scan — an edge case (the file being deleted in the moment between the two reads), not a normal-path behavior, and it never touches disk in that branch (nothing gets truncated on disk; only that one caller's in-memory return value for that one unlucky call lacks heavy fields).
- Bonus: this fallback's search scope actually got *wider*, not narrower — the old `listRecentRunRecords(wakeRoot, 500)` only searched the 500 most recent records, so a sufficiently old run's flat-file-missing case returned `null` before this branch; the new `listRunRecordSummaries(wakeRoot)` search has no cap. Not a regression to worry about; flagged here only so it isn't mistaken for one when reading the diff.

Net: safe to build on. If you find yourself needing to make a write path use a summarized record, or needing to skip the full-record re-fetch in `stale-run-reconciler.ts`, stop — that would reintroduce data loss and is not what this spec asks for.

## Verified-fixed numbers (for context on what "done" looks like)

Measured against the actual incident's `wake-home` (322 run records, ~8 day-buckets), rebuilding the sandbox image and testing against the real running container at each step — do the same, don't just trust local `tsx` numbers against the host filesystem (this session's biggest miscalibration: host-filesystem timing via `tsx` looked fine while the containerized, bind-mounted, sequential-file-read reality was still slow):

- Before any fix: OOM crash, or (once the byte-weight fixes landed) a single `/api/v1/status` request taking **4 minutes 8 seconds**.
- After all six commits on this branch: **7-24 seconds**, CPU/memory back to sane baseline (a few % CPU, <500MB), no crashes — but still visibly slow, and the user correctly identified this as a design smell rather than accepting "not crashing" as done.
- Target after the index spec lands: sub-second to low-single-digit-seconds, since reads become bounded by *day count* (~8-10) rather than *run count* (322 and growing).

## Step by step

1. Read the spec in full: [`docs/plans/2026-07-26-run-record-summary-index.md`](../plans/2026-07-26-run-record-summary-index.md).
2. Continue on `fix/bound-run-record-listing-metadata` (or branch off it if you'd rather keep this as a separate reviewable commit set — either is fine, this docs commit itself lands on the same branch).
3. Implement in `src/adapters/fs/state-store.ts`:
   - The per-date index read/write (Invariant 1-2 in the spec).
   - The locked upsert in `writeRunRecord()` (Invariant 3 — reuse `acquireFileLock` from `src/lib/lock.ts`, scoped as `locks/run-index-<date>.lock`).
   - The self-healing rebuild-on-miss in `listRunRecordSummariesForDate`.
4. Do **not** touch any call site outside `state-store.ts` (Invariant 4) — if the diff touches `ui-data.ts`, `tick-runner.ts`, or `stale-run-reconciler.ts`, something has gone off-spec.
5. Add the concurrency test described in the spec's Testing section first — this is the one most likely to get skipped under time pressure, and it's the one that actually validates Invariant 3.
6. Add `wake validate-state` drift detection (index entry count vs. actual file count per date) per the spec's Rebuild/integrity section.

## Testing instructions

Follow the spec's "Testing instructions" section exactly — it's written to be run standalone, not paraphrased here. In short:

1. `npm run verify` (lint + format:check + build + full test suite). At handoff time this branch is at 856 passing tests, 2 skipped, 80 files, all green on a clean/uncontended run — if your run shows failures, re-run once uncontended before assuming a regression (this session hit several false-positive timeouts from running heavy Docker builds and test suites in parallel on the same host).
2. New unit tests per the spec, including the concurrent-write test — don't skip it.
3. Real-data verification against the actual `wake-home` (or a copy): time `buildBoard`/`buildStatus` before/after with a throwaway script (delete it when done, don't commit it as a fixture), then rebuild the sandbox image and curl the real running container's `/api/v1/board` and `/api/v1/status`, confirming both the response time and that the deployed `dist/` actually contains your change (`docker exec wake-sandbox sh -c "grep -n <fn> /app/dist/src/adapters/fs/state-store.js"`) — don't trust "the source looks right," confirm the built artifact.
4. When you believe it's done, update PR #409's description (or open a new PR referencing it, whichever this branch's state calls for by then) with a before/after timing table, the same way the existing PR description documents each prior commit's measured impact.
