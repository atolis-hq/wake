import type { EventJournal } from '../contracts/event-journal.js';
import type { EventEnvelope } from '../contracts/events.js';

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
  journal: Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>,
  derive: (events: readonly EventEnvelope[]) => Value | Promise<Value>,
): CachedJournalView<Value> {
  let cache: { readonly position: number; readonly value: Value } | undefined;
  return {
    async get(): Promise<Value> {
      const position = await journal.latestGlobalPosition();
      if (cache !== undefined && cache.position === position) return cache.value;
      const value = await derive(await journal.readAll(0));
      cache = { position, value };
      return value;
    },
  };
}
