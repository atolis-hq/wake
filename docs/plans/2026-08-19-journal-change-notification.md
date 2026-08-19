# Journal change notification: spec

- Date: 2026-08-19
- Status: proposed
- Builds on: PR #713 (`fix/journal-projection-write-cache-invalidation`) — journal/projection reads are now individually cheap when nothing changed; this spec removes the need to *ask* in the first place.
- Context: [`docs/reports/2026-08-19-resident-loop-full-history-rescan.md`](../reports/2026-08-19-resident-loop-full-history-rescan.md) — read it first. It documents the measured evidence (sustained ~140 journal reads/sec on an idle system) and the confirmed root cause (`DeliveryOutcomeReactor.runOnce()`'s unconditional full-history rescan, called every ~3-5s). This doc is the target architecture, not a restatement of the investigation.

## Problem

Wake's resident loop consumes an append-only, event-sourced journal the way you'd poll an external, untrusted API: every consumer (the runner pipeline's `catchUpProjections`, `DeliveryOutcomeReactor`, `advance()`'s `cachedJournalView`-backed checks, `IntakeHost`'s `isPaused()` check) periodically asks "has anything changed?" by reading and re-deriving state, on a fixed schedule, forever — including when the system is completely idle. #713 made each individual "nothing changed" check cheap. It did not change the fact that the check happens at all, on a schedule, regardless of whether it's needed.

This is the wrong shape for an in-process, single-writer event store. The writer (`FileEventJournal.append()`) always knows the exact instant new data exists — it's the one writing it. There's no reason for readers to keep re-asking on a timer instead of being told.

## Why not adopt an existing library

Researched three candidates the way this problem is usually solved in the JS ecosystem, specifically checking whether any of them provide guaranteed-delivery notification as a solved problem (findings, not assumptions — verified against each project's own documentation):

- **`fmodel-ts`** (`@fraktalio/fmodel-ts`) — not applicable. It's a domain-modeling library (Decider/View/Saga patterns for structuring command-to-event logic), a different layer of concern entirely. It has no opinion on consumption/notification.
- **`node-eventstore`** (`thenativeweb/node-eventstore`) — its own documentation confirms notification is an **optional, best-effort publisher callback** (`useEventPublisher`), not a delivery guarantee. Real reliability comes from consumer-tracked `getUndispatchedEvents()`/`setEventToDispatched()` — the consumer still owns replay-on-miss. Adopting it would also mean replacing Wake's own `EventEnvelope`/`EventJournal`/kernel contracts with this library's event/storage model across every domain module that depends on them — a large, invasive rewrite for machinery Wake can build directly.
- **`@ricofritzsche/eventstore`** — same finding: "auto-notification" is documented as a wake-up hint; actual catch-up is via consumer-side `minSequenceNumber` querying. Its primary target storage is PostgreSQL (file/in-memory modes exist but are secondary, testing-oriented) — an external infrastructure dependency this project has explicitly ruled out.

**Conclusion: build a small in-process primitive, don't adopt a library.** All three either confirm the correct pattern (notification is advisory; the durable position-based catch-up is what guarantees delivery — which Wake's `FileCheckpointStore` + `ProjectionRunner`/reactor checkpoint logic already does correctly today) or require infrastructure/rewrites this project doesn't want. The actual missing piece — a wake-up signal — is on the order of 30-50 lines against Node's built-in `EventEmitter`.

## Design

### Core principle: notification is 100% advisory; durability is unchanged

The existing checkpoint-based catch-up (`FileCheckpointStore` positions; `ProjectionRunner.applyFrom`; each reactor's own `consumer` checkpoint) remains the **sole source of correctness**, completely unchanged. A consumer that wakes up — whether from a notification or from the fallback timeout — always re-derives what's new by comparing against its own durable position, exactly as it does today. The notification's only job is to shorten how long a consumer sits idle before checking. It carries **no payload** — just "something changed" — which is the property that makes it safe: a channel that can never claim to tell you *what* changed can't become a second, driftable source of truth. A missed, duplicated, or coalesced notification cannot cause a missed event, because the notification is never what delivers the event.

### `JournalChangeSignal`: the notifier

A small addition alongside `FileEventJournal` (same package, `src/persistence/filesystem/` or `src/kernel/infrastructure/` — pick based on whether other journal implementations, e.g. the in-memory test fake, should share it; the in-memory fake likely should, for test parity):

```ts
export interface JournalChangeSignal {
  // Resolves as soon as a change has been signalled since this call started,
  // or after fallbackMs elapses, or if the signal aborts — whichever first.
  // Never rejects. Coalesces: any number of notify() calls between waitForChange()
  // calls produce exactly one wake-up, not one per call.
  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void>;
}
```

Implementation sketch (illustrative, not final — get this right in review, it's the one piece every consumer depends on):

```ts
class InProcessJournalChangeSignal implements JournalChangeSignal {
  private waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  waitForChange(signal: AbortSignal, fallbackMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.push(done);
      const timer = setTimeout(done, fallbackMs);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
```

`FileEventJournal.append()` calls `this.changeSignal.notify()` once, after a successful write that actually appended new envelopes (mirrors the existing `if (newEnvelopes.length > 0)` guard — a no-op idempotent append shouldn't wake anyone, since nothing changed).

### Consumers switch from "sleep, then poll" to "process pending, then wait"

The shape everywhere becomes:

```ts
while (!signal.aborted) {
  await doWork(); // whatever the consumer's actual per-cycle work is, unchanged
  await journal.changeSignal.waitForChange(signal, fallbackMs);
}
```

Concretely, in order of expected impact:

1. **`DeliveryOutcomeReactor`** — the dominant, measured cost. Its *first* pass (incremental, checkpoint-based) is already correctly shaped and needs no change. Its *second* pass (the full `readAll(0)` rescan) exists to catch a specific race: a delivery confirmation checkpointed before the corresponding workflow reached its "waiting for delivery" state. **Do not just delete the second pass or gate it behind the change signal as-is** — that would still be an unbounded rescan, just less frequent, and doesn't address the actual race. Instead: maintain a small, bounded, persisted set of "confirmations seen but not yet matched to a waiting workflow" (populated by the first pass when `isAwaitingThisDelivery` returns false), and re-check *only that set* — not the full journal — whenever a workflow transitions into a delivery-wait state. This is the one piece of this spec that's a real behavior change, not just a trigger change, and deserves its own focused test (see Testing).
2. **Runner pipeline's `catchUpProjections`** (`ProjectionRunner.runRegisteredOnceUnlocked`) and the standalone projection pump (`runProjectionPump`, currently a hardcoded 1000ms `setInterval`-equivalent) — switch to wait-for-change with a generous fallback. Already cheap per-call after #713; this removes the remaining call-volume overhead and the artificial 1s floor for genuinely idle periods.
3. **`IntakeHost`'s `isPaused()` check** — lower priority (it's one `readStream()` per intake cycle, and intake already backs off correctly via `nextIdleBackoffMs`), but worth folding into the same primitive for consistency rather than leaving it as the one remaining poller.
4. **`advance()`'s `cachedJournalView`-backed calls** (`transitionWatchChildren`, `listWaiting`) — these already have the right *shape* (memoize by position, only re-derive on change) but still pay a `scan()` call just to check the position. Once `latestGlobalPosition()` is cheap in the true O(1) sense (already true post-#713 for the common case) this matters less, but should still move to the same wait primitive for consistency once the journal exposes it.

### Fallback duration

Reuse the existing `controlPlane.resident.idleBackoffMs`/`maxIdleBackoffMs` config surface — this is already "how long to wait when idle" for the intake resident and for the runner resident's genuine-idle path; this change just makes it the *ceiling* rather than the *steady-state cadence* for everything else too. Current defaults: `idleBackoffMs: 1000`, `maxIdleBackoffMs` unset (runtime fallback `baseMs * 16` = 16,000ms). Since the fallback is now purely a safety net (missed in-process notification, or a cross-process writer the in-process `EventEmitter` can't see) rather than the primary trigger, **raise the default floor** — 30-60 seconds is reasonable; there's no correctness reason to check sooner than that when nothing has signalled a change. Don't introduce a new config key for this; extend the meaning of the existing one and update its default.

### Cross-process consideration

The in-process `EventEmitter` can't fire for a write from a different OS process (e.g. a manual `wake tick` CLI invocation running alongside the resident `wake start` loop, both against the same `.wake` directory). That's fine: a cross-process writer's consumers still catch up via the fallback timeout, same as any other missed notification — bounded by whatever the fallback is set to, not "never." If lower latency there is wanted later, `fs.watch()` on `.wake/events/` could feed the same internal notifier — flagged as a future enhancement, not required for this spec, since the measured hot path (this investigation's entire cost) is single-process.

## Testing instructions

1. **Guarantee-preservation test (most important):** with the new wait-based consumers, verify no event is ever lost even if `notify()` is never called at all — i.e., run the existing correctness test suite with the change-signal's `notify()` stubbed to a no-op, relying solely on the fallback timeout, and confirm all existing journal/projection/reactor tests still pass (just slower). This is the test that proves the "notification is advisory, checkpoints are authoritative" property actually holds in the implementation, not just in this doc.
2. **Coalescing test:** multiple rapid `append()` calls between one consumer's `waitForChange()` calls produce exactly one wake-up, and the consumer's next catch-up pass picks up all of them (not just the first or last).
3. **Multiple independent subscribers:** two consumers with different checkpoint positions both wake on the same `notify()` call and each correctly catches up to their own position, independently.
4. **`DeliveryOutcomeReactor`'s race-preservation test:** the existing `delivery-outcome-reactor.test.ts` case this second pass was built for ("catches up a matching confirmation that was checkpointed before its delivery wait") must still pass against the new bounded-set design — this is the one behavior that must not regress.
5. **Real-process verification:** deploy to `~/wake-home` (or a copy) the same way #713 was verified — rebuild the sandbox image, confirm via the diagnostic pattern used in this investigation (temporary call-counting instrumentation, removed before merge) that idle journal-read volume drops to near-zero and a real `append()` wakes the affected consumers within milliseconds, not up to the fallback duration.
6. `npm run verify` (or `npm run verify:ci` given this touches control-plane, persistence, and integrations — cross-cutting per `AGENTS.md`'s guidance).
