import type { EventJournal } from '../contracts/event-journal.js';
import type { EventEnvelope } from '../contracts/events.js';

export const JOURNAL_CHANGE_FALLBACK_MS = 30_000;

export interface CachedJournalView<Value> {
  get(): Promise<Value>;
}

// Memoizes a full-journal derivation — a fold, decode, or index built from
// every event in history — so a resident loop calling it every tick only
// pays that cost when the journal has actually moved since the last call.
// Same gate ProjectionRunner keeps for itself (a last-seen global position),
// generalized for callers that want a materialized view rather than an
// incremental batch. Depends only on the EventJournal port, not on any
// concrete persistence implementation, so it lives in kernel rather than
// persistence — domain and adapter modules may call it directly.
export function cachedJournalView<Value>(
  journal: Pick<EventJournal, 'readAll' | 'changeSignal'>,
  derive: (events: readonly EventEnvelope[]) => Value | Promise<Value>,
  now: () => number = Date.now,
): CachedJournalView<Value> {
  let cache:
    | { readonly observedRevision: number; readonly checkedAt: number; readonly value: Value }
    | undefined;
  return {
    async get(): Promise<Value> {
      const observedRevision = journal.changeSignal.revision();
      const checkedAt = now();
      if (
        cache !== undefined &&
        cache.observedRevision === observedRevision &&
        checkedAt - cache.checkedAt < JOURNAL_CHANGE_FALLBACK_MS
      )
        return cache.value;
      const value = await derive(await journal.readAll(0));
      // Retain the revision observed before the read. An append that races
      // this derivation must force one more pass instead of being hidden.
      cache = { observedRevision, checkedAt: now(), value };
      return value;
    },
  };
}
