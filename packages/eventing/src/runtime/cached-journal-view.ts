import type { EventEnvelope } from '../contracts/events.js';
import type { EventJournal } from '../store/event-journal.js';

export const JOURNAL_CHANGE_FALLBACK_MS = 30_000;

export interface CachedJournalView<Value> {
  get(): Promise<Value>;
}

type ViewJournal = Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>;

// Memoizes a full-journal derivation — a fold, decode, or index built from
// every event in history — so a resident loop calling it every tick only
// pays that cost when the journal has actually moved since the last call.
// Same durable position boundary used by projection subscriptions,
// generalized for callers that want a materialized view rather than an
// incremental batch. Depends only on the EventJournal port, not on any
// concrete persistence implementation, so it lives in Eventing rather than
// Persistence; domain and adapter modules may call it directly.
//
// The cached value is keyed by the last position actually read, never by the
// position sampled beforehand, so a value can never be held under a position
// newer than the events it was derived from. Callers that find the journal
// unchanged since a derivation already running share it.
export function cachedJournalView<Value>(
  journal: ViewJournal,
  derive: (events: readonly EventEnvelope[]) => Value | Promise<Value>,
  _now: () => number = Date.now,
): CachedJournalView<Value> {
  let cache: { readonly position: number; readonly value: Value } | undefined;
  let inFlight: { readonly sampled: number; readonly run: Promise<Value> } | undefined;
  return {
    async get(): Promise<Value> {
      const sampled = await journal.latestGlobalPosition();
      if (cache !== undefined && cache.position >= sampled) return cache.value;
      if (inFlight?.sampled === sampled) return inFlight.run;
      const run = (async () => {
        const events = await journal.readAll(0);
        const value = await derive(events);
        cache = { position: events.at(-1)?.globalPosition ?? 0, value };
        return value;
      })().finally(() => {
        if (inFlight?.run === run) inFlight = undefined;
      });
      inFlight = { sampled, run };
      return run;
    },
  };
}

export interface JournalFold<Value> {
  readonly initial: Value;
  /** Returns the value after `events`, which follow everything already folded. Must not mutate `value`. */
  extend(value: Value, events: readonly EventEnvelope[]): Value;
}

// An incremental counterpart of cachedJournalView for views that can be
// extended event by event: each journal move folds only the new events instead
// of re-deriving history. Folds are serialised, so every event is applied once
// and in order however many callers ask at the same time.
export function foldedJournalView<Value>(
  journal: ViewJournal,
  fold: JournalFold<Value>,
): CachedJournalView<Value> {
  let state: { readonly position: number; readonly value: Value } = {
    position: 0,
    value: fold.initial,
  };
  let running: Promise<unknown> | undefined;
  return {
    async get(): Promise<Value> {
      for (;;) {
        const sampled = await journal.latestGlobalPosition();
        if (state.position >= sampled) return state.value;
        if (running !== undefined) {
          await running.catch(() => undefined);
          continue;
        }
        const run = (async () => {
          const events = await journal.readAll(state.position);
          if (events.length > 0)
            state = {
              position: events.at(-1)!.globalPosition,
              value: fold.extend(state.value, events),
            };
          return state.value;
        })().finally(() => {
          if (running === run) running = undefined;
        });
        running = run;
        return run;
      }
    },
  };
}
