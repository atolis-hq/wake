# Resident loop full-history rescan: investigation report

- Date: 2026-08-19
- Follows on from: PR #713 (`fix/journal-projection-write-cache-invalidation`) — `FileEventJournal` and `FileProjectionStore` no longer discard their in-memory cache on every self-caused write. That fix is real, measured (~4.7x faster / ~52% less heap growth on the journal; ~11x faster / ~62% less heap growth on the projection store, profiled against a 7,930-entry fixture), and correctly deployed.
- This report: why `~/wake-home`'s resident loop still OOM-crashed hours after #713 shipped, and what's actually driving the cost.

## Summary

`#713` fixed a real bug (each write nulled the whole cache, forcing the next read to redo a full parse), but it did not touch a separate, larger cost: a resident-loop reactor doing an **unconditional full-history journal scan on every tick**, several times a minute, regardless of whether anything changed. This is a pre-existing, already-acknowledged gap (see "Root cause" below) that #713's caching made *individually cheap* per call — but the call volume is high enough that the aggregate cost still matters, and more importantly, it's the wrong *shape* of fix. The real problem is architectural: every consumer in the resident loop re-verifies "did anything change?" by reading and re-deriving from the journal, on a fixed schedule, rather than being told. See the companion design doc, [`2026-08-19-journal-change-notification.md`](../plans/2026-08-19-journal-change-notification.md), for the proposed fix.

## What's confirmed, with evidence

**Data volume is not the problem.** `~/wake-home`'s actual data: 8,714 events across 7 day-files, 9.8MB on disk; 1,194 projection files, 9.1MB on disk. ~19MB total. Any explanation resting on "there's a lot of history to hold in memory" doesn't fit — this is a *per-tick repeated-work* cost, not a storage-size cost.

**The journal is read at a sustained, measured rate of ~130-145 calls/second, continuously**, confirmed via direct instrumentation of `FileEventJournal.scan()` (temporary, added and removed within this investigation — nothing landed from it). Five independent 15-second measurement windows: 2,062 / 2,003 / 2,080 / 2,011 / 2,169 calls. This held steady across container restarts and was not a transient burst tied to any specific active run.

**Root cause, confirmed by direct call-stack sampling** (not inferred — `new Error().stack` captured live inside `scan()`):

`src/integrations/delivery/application/delivery-outcome-reactor.ts`, `DeliveryOutcomeReactor.runOnce()`:

```ts
async runOnce(): Promise<number> {
  const consumer = 'reactor:delivery-outcomes';
  const events = await this.journal.readAll(await this.checkpoints.load(consumer));
  const resolvedDeliveryEventIds = new Set<string>();
  for (const event of events) {
    await this.reconcile(event, resolvedDeliveryEventIds);
    await this.checkpoints.save(consumer, event.globalPosition);
  }
  for (const event of await this.journal.readAll(0))          // <-- here
    await this.reconcile(event, resolvedDeliveryEventIds);
  return events.length;
}
```

The first loop is the normal, cheap, checkpoint-incremental pass. The **second loop unconditionally re-reads the entire journal from position 0, every single call**, and for every delivery-related event it finds, `reconcile()` → `isAwaitingThisDelivery()` → `OrchestrationRepository.load()` fans out into an additional `journal.readStream()` call per event. `runOnce()` is wired to `stages.react` in `src/bootstrap/integration-runtime.ts`, and `react()` is itself called **twice** per pipeline execution — `src/control-plane/application/runner-pipeline.ts`'s `runOnce()` calls `await stages.react()` once mid-flow (after `advance()`) and once more near the end (after `deliver()`) — and that pipeline run happens roughly every 3-5 seconds (the runner resident's own outer-loop cadence, confirmed calm and correctly backing off — see "Investigative dead ends" below). The full-history rescan plus its per-event fan-out is what actually produces the measured ~140/sec aggregate.

**This is not a hidden bug — it was already known and explicitly deferred.** `eslint.config.js`'s `fullJournalRescanRule` exemption list already carries this exact file with this comment:

> "Its second pass deliberately re-evaluates every past delivery event against current orchestration state on every tick — see 'catches up a matching confirmation that was checkpointed before its delivery wait' in delivery-outcome-reactor.test.ts. Skipping it when the journal hasn't moved is provably safe in production... but the fix wasn't made in this pass; tracked as follow-up rather than risked here."

**The second pass exists for a real correctness reason — don't just delete it.** It exists to catch a race: a delivery confirmation event can get checkpointed by the reactor's incremental pass *before* the corresponding workflow has actually reached the point of waiting on it. Once checkpointed, the incremental pass never re-examines that position, so without the second pass, that confirmation would be silently missed forever. Any fix must preserve this guarantee — see the design doc for the proposed approach (react to the workflow transitioning into "waiting for delivery," not to a blind full rescan).

**Secondary, smaller contributors, also confirmed by stack trace, same underlying pattern (poll and re-verify rather than being told):**
- `IntakeHost`'s per-cycle `isPaused()` check reads the journal (`intake-pipeline.js` → `control-plane-service.js:isPaused` → `readStream()`).
- `advance()`'s `OrchestrationService.transitionWatchChildren()` and `runDispatchLoop`'s `listWaiting()` both go through `cachedJournalView`, which calls `journal.latestGlobalPosition()` — itself a full `scan()` — just to check whether its memoized value is still valid.

None of these run in a busy-loop on their own; they're each individually infrequent. They matter because they're all instances of the same shape: "ask the journal whether anything changed" instead of "be told when something changed."

## Investigative dead ends (explored, ruled out, nothing landed)

Documenting these so a future session doesn't re-tread them:

1. **V8 sliced-string retention.** A real heap snapshot (`--heapsnapshot-near-heap-limit`, captured live from the crashed process) showed the single largest retained string (4.5MB) was a genuine V8 "sliced string" whose retainer chain traced to a suspended `FileEventJournal.scan()` call. Plausible-looking, but two independent synthetic reproductions (one matching a per-line-await shape, one matching `scan()`'s actual single-await-then-synchronous shape) both failed to reproduce any retention. A fix attempt (force-copying every parsed string to detach it from its source buffer, in both `FileEventJournal` and `FileProjectionStore`) was implemented, tested against the real classes with a realistic 160,000-event dataset, and **measured worse** than baseline (195.5MB vs. 130.1MB heap growth on an identical workload) — reverted in full. Conclusion: real phenomenon, but not the explanation for the sustained growth, and not worth pursuing further given the definitive finding above.
2. **`ResidentHost`'s zero-delay-on-progress branch.** The runner resident's sleep strategy uses `Promise.resolve()` (no delay) immediately after a tick that "made progress," which looked like a plausible busy-loop trigger. Directly instrumented and measured: the outer resident-loop iterates only 3-6 times per ~16-17 seconds, for both the runner and intake residents, with `consecutiveIdleTicks` climbing correctly (1→2→3...→10) and the zero-delay branch firing only transiently right after genuine dispatch events. This mechanism is working as designed and is not the busy-loop source.

## Why this matters beyond the immediate crash

Wake's architecture is fundamentally event-sourced (append-only journal, projections folded from it), but the resident loop consumes it as if polling an external, untrusted source — repeatedly asking "has anything changed?" on a fixed schedule, forever, even when idle. A real event-streaming system (Kafka, an in-process `EventEmitter`, anything with genuine push/subscribe semantics) doesn't have this shape: a consumer either blocks until told, or gets pushed new records directly. The fix proposed in the companion design doc keeps Wake's existing durable, checkpoint-based catch-up mechanism as the sole source of correctness (unchanged, still guarantees no message is ever lost) and adds a thin, in-process "wake up early" notification layer on top of it — eliminating the poll-and-reverify pattern without introducing any new class of correctness risk, and without adopting external infrastructure or a third-party event-sourcing framework (research into `node-eventstore`, `@ricofritzsche/eventstore`, and `fmodel-ts` is in the design doc; none solve this problem better than a purpose-built in-process primitive would, and adopting any of them would mean either an external dependency or replacing Wake's own `EventEnvelope`/`EventJournal` contracts).

## Numbers to compare against for "done"

- Journal read rate: ~140/sec sustained today (idle system) → target near-zero when idle, bursting only in response to actual writes.
- `DeliveryOutcomeReactor.runOnce()`'s second pass: currently O(total history) on every call (~8,714 events today, growing forever) → target O(pending confirmations awaiting workflow catch-up), which should be a small, bounded set at any given time.
- No change expected to correctness: same events processed, same checkpoints advanced, same delivery confirmations resolved — only the trigger and the per-call cost shape change.
