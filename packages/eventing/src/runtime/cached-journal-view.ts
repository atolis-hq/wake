import type { EventEnvelope } from '../contracts/events.js';
import type { EventJournal } from '../store/event-journal.js';

export const JOURNAL_CHANGE_FALLBACK_MS = 30_000;

export interface CachedJournalView<Value> {
  get(): Promise<Value>;
}

// Memoizes a full-journal derivation — a fold, decode, or index built from
// every event in history — so a resident loop calling it every tick only
// pays that cost when the journal has actually moved since the last call.
// Same durable position boundary used by projection subscriptions,
// generalized for callers that want a materialized view rather than an
// incremental batch. Depends only on the EventJournal port, not on any
// concrete persistence implementation, so it lives in Eventing rather than
// Persistence; domain and adapter modules may call it directly.
export function cachedJournalView<Value>(
  journal: Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>,
  derive: (events: readonly EventEnvelope[]) => Value | Promise<Value>,
  _now: () => number = Date.now,
): CachedJournalView<Value> {
  let cache: { readonly position: number; readonly value: Value } | undefined;
  return {
    async get(): Promise<Value> {
      const position = await journal.latestGlobalPosition();
      if (cache !== undefined && cache.position === position) return cache.value;
      const value = await derive(await journal.readAll(0));
      // Keep the position sampled before the read. An append racing the read
      // must force another derivation rather than being hidden by the cache.
      cache = { position, value };
      return value;
    },
  };
}
