# Run-record summary index: spec

- Date: 2026-07-26
- Status: proposed
- Builds on: PR #409 (`fix/bound-run-record-listing-metadata`), which fixed the byte-weight half of this problem but not the file-count half
- Context: 2026-07-26 production incident — closed-issue watcher re-dispatch (#408) inflated run history enough to first OOM-crash, then merely cripple, the resident loop and UI

## Problem

Every board/status/runs/metrics request, and every tick, needs to look at run-record history in bulk (all runs, or all of today's runs). `state-store.ts`'s `listRunRecordsImpl`/`listRunRecordsForDateImpl` answer this by `readdir`-ing the runs directory and reading **every file individually, sequentially, in a `for...of` loop with `await` per file** — no parallelism, no cache, no index. This repeats from scratch on every single call, in every process (`wake ui`, `wake start`, one-shot `wake tick`/`wake self-update` invocations) that asks.

PR #409 fixed the *byte* cost — each file no longer carries multi-MB `stdout`/`stderr`/`raw`/`runtimeEvents` in the summarized read path — but did not fix the *file-count* cost. Measured against the incident's actual `wake-home` (322 run files across ~8 day-buckets):

- Raw `cat` of all 322 files inside the container: ~1.6s (filesystem itself is not pathologically slow).
- A single `/api/v1/board` or `/api/v1/status` request after PR #409's fixes: 7-24s, because each request still does one or more full sequential walks of the summarized files, and `buildStatus` triggers two independent full walks in the same request (its own `listRunRecordSummariesForDate(today)` plus `buildBoard`'s `listRunRecordSummaries()`).
- This scales with **total run-record count**, not bytes, and will keep getting slower as history grows, regardless of any further byte-level trimming.

The fix: stop re-deriving the summary list from every individual run file on every read. Maintain it as a **small, incrementally-updated, self-healing index**, sharded by day to match the existing `runs/by-date/<date>/` layout.

## Design

### One index file per day: `runs/by-date/<date>/index.json`

```json
{
  "schemaVersion": 1,
  "date": "2026-07-26",
  "entries": [ /* RunRecord, already summarized (no metadata.stdout/stderr/raw, no runtimeEvents) */ ]
}
```

Sorted by `startedAt`, same as today's in-memory sort order, so no caller-visible ordering change.

### Write path: `writeRunRecord()` gains a third write

Today `writeRunRecord()` writes the full record to both `paths.runFile(runId)` (flat, legacy) and `paths.runDateFile(date, runId)` (by-date, full). Add:

1. Acquire a per-date lock (`locks/run-index-<date>.lock`, via the existing `acquireFileLock` in `src/lib/lock.ts` — same primitive already used for `tick.lock`/`runner.lock`, just scoped per date instead of globally).
2. Read `runs/by-date/<date>/index.json` (treat missing/corrupt as empty).
3. Upsert this run's **summarized** record by `runId` (replace if present, else append).
4. Write atomically via the existing `writeJsonFile` (already does tmp-file + rename).
5. Release the lock.

This makes each `writeRunRecord()` call do one extra small read-modify-write, bounded by **that day's** run count (currently tens, not hundreds) — not total history. This is the concurrency-sensitive part: see Invariant 3.

### Read path: index-first, self-healing fallback

`listRunRecordSummariesForDate(date)`:
1. Try reading `runs/by-date/<date>/index.json` directly — one file read, done.
2. If missing, corrupt, or fails schema validation: fall back to the current behavior (scan every file in that date's directory, strip, sort) — and as a side effect of the successful rebuild, **write the freshly-rebuilt index** so the next read is fast. This is what makes the index a cache, not a second source of truth: if it's ever wrong or missing, the authoritative per-run files fully reconstruct it, the same way `state/` reconstructs from `events/`.

`listRunRecordSummaries()` (all history): enumerate date directories (already cheap, just a `readdir`), call the per-date function above for each, merge. For ~8-10 days of history that's ~8-10 file reads total, not 322+.

`readRunRecord()`'s fallback (PR #409 already made this scan summaries instead of full records) can now use the index-backed `listRunRecordSummaries()` transparently — no further change needed there once the above lands, since it already calls that function.

### Rebuild / integrity

- **Startup**: no eager rebuild needed — the self-healing fallback means a missing/stale index for a given date is repaired lazily on first read of that date, and every write keeps it current going forward. Do not add an eager "rebuild all indexes on boot" step; that reintroduces the exact O(total history) cost this spec exists to remove.
- **`wake validate-state`** (existing command, see `src/cli/*.ts`): add a check that each date's `index.json` entry count matches that date's actual run-file count, flagging (not auto-fixing) a mismatch as a `StateHealthIssue`. Auto-repair happens naturally on next read via the self-healing fallback; `validate-state` should surface drift, not silently paper over it.

## Non-negotiable invariants

1. **The index is a cache, never a source of truth.** It must always be derivable by rescanning the day's run files; nothing may read the index and treat a missing/stale entry as "this run doesn't exist" without falling back to a real scan first. Deleting every `index.json` and replaying reads must reproduce identical summaries.
2. **Full-fidelity readers are unaffected.** `readRunRecord(runId)`'s primary path (flat file) and its date-bucket-targeted-full-read fallback (added in PR #409) are untouched — they read the *full* record file directly, never the index. The index only ever holds summaries.
3. **Concurrent writes to the same day must not lose entries.** Two ticks writing different runs on the same day, at the same time, must both end up represented in that day's index — a locked read-modify-write (Invariant above) is required; a bare "read then write" race will silently drop whichever write loses the race. This must have a test that actually exercises concurrent writers (see Testing below), not just a single-writer happy path.
4. **No change to the public read contract.** `listRunRecordSummaries()` / `listRunRecordSummariesForDate()` keep their existing signatures and sort order. Every call site fixed in PR #409 (`buildRuns`, `buildBoard`, `buildStatus`, `buildItemDetail`, `buildItemTranscripts`, the metrics bucket scan, `tick-runner.ts`'s three per-tick reads, `stale-run-reconciler.ts`'s scan) needs **zero changes** — they already call these functions; only the implementation underneath gets faster. If any call site needs touching to make this land, something about this spec has been violated.
5. **Legacy flat-only run files (no `by-date` entry) still work.** `listRunRecordsForDateImpl` already has a legacy fallback (scan flat `runs/*.json`, filter by `startedAt` date) for wake-homes written before the by-date layout existed. The index only covers the by-date path; the legacy fallback path is untouched and still does a full scan (acceptable — it's a one-time-per-old-wake-home cost, not the hot path).

## Testing instructions

Run these against the actual incident's `wake-home` data, not just synthetic fixtures — the whole reason this spec exists is that synthetic small fixtures never would have surfaced the file-count problem.

1. **Unit tests** (`test/adapters/state-store.test.ts`):
   - Writing a run creates/updates that date's `index.json` with a summarized (no `stdout`/`stderr`/`raw`/`runtimeEvents`) entry.
   - Deleting a date's `index.json` and calling `listRunRecordSummariesForDate` still returns correct data (self-healing fallback) and re-creates the index file as a side effect.
   - Corrupting a date's `index.json` (invalid JSON) behaves the same as missing — falls back, rebuilds, does not throw.
   - **Concurrency**: write two different runs for the same date via `Promise.all` (simulating two ticks racing) and assert the resulting index contains both — this is the test most likely to be skipped under time pressure; do not skip it.
   - `readRunRecord()` for a run whose flat file is missing still returns the full record (unaffected by this change).
2. **Full suite**: `npm run verify`. Expect ~856+ tests passing (see "Current branch state" in the handoff doc for the exact baseline count at handoff time).
3. **Real-data verification** (do this before considering the fix complete — matches the methodology used to find and confirm every fix in PR #409):
   - Point a local script at the actual `wake-home` used in the incident (or a copy of it) and time `buildBoard`/`buildStatus` before and after, the same way `scratch-verify-board2.ts` did in this session (delete the scratch file when done — it's throwaway, not a fixture).
   - Rebuild the sandbox image (`wake sandbox build && wake sandbox update` from the wake-home) and `curl -w '%{time_total}' http://127.0.0.1:4317/api/v1/board` and `/api/v1/status` against the real running container — confirm sub-second-to-low-single-digit-second responses, not just "doesn't crash." The prior fix in this branch already got board/status from crashing/4+ minutes down to ~8-24s; this spec's target is turning "N file reads" into "~days of history file reads," which should land board/status well under 1s once indexes are warm.
   - Confirm via `docker exec wake-sandbox sh -c "grep -n <new function name> /app/dist/src/adapters/fs/state-store.js"` that the deployed image actually contains the change — this session found multiple cases where a fix was correct in source but the running container was still on stale code; don't skip this check.

## Explicitly out of scope for this spec

- Caching in process memory (rejected — see handoff doc's audit notes: `wake ui`, `wake start`, and one-shot `wake tick`/`wake self-update` invocations are separate processes that don't share memory, and Wake's existing philosophy is durable state over in-process caching for anything that needs to survive a restart).
- Changing the `runs/<id>.json` flat-file or `runs/by-date/<date>/<id>.json` full-record layout — this spec only adds a derived index alongside them.
- Fixing `buildItemDetail`/`buildItemTranscripts`'s per-work-item filtering (`(await listRunRecordSummaries()).filter(run => run.workItemKey === ...)`) to avoid loading *other* work items' summaries — worth doing later (an index keyed additionally by `workItemKey` would help), but out of scope here; this spec is scoped to the day-level index only.
