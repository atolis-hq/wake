import type { EventEnvelope } from '../contracts/events.js';
import type { EventJournal } from '../store/event-journal.js';

export const JOURNAL_CHANGE_FALLBACK_MS = 30_000;

export interface JournalView<Value> {
  get(): Promise<Value>;
}

type ViewJournal = Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>;

export interface JournalFold<Value> {
  readonly initial: Value;
  /** Returns the value after `events`, which follow everything already folded. Must not mutate `value`: earlier callers may still hold it across awaits. */
  extend(value: Value, events: readonly EventEnvelope[]): Value;
}

// The in-process read model for derivations that join across streams or must
// answer without a durable key (use a ProjectionStore projection for per-key
// state that must survive restarts). The first call folds history once; every
// later journal move folds only the events after the position already held, so
// cost per resident tick is proportional to what changed, never to history.
// There is deliberately no "re-derive everything when the journal moves" form.
// Folds are serialised, so every event is applied once and in order however
// many callers ask at the same time; the value is keyed by the last position
// actually read, never one sampled beforehand.
export function foldedJournalView<Value>(
  journal: ViewJournal,
  fold: JournalFold<Value>,
): JournalView<Value> {
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

/**
 * Decodes each envelope object once. Journals hand out the same immutable
 * envelope instances while their cache is valid, so repeated stream loads reuse
 * the earlier decode instead of re-running schema validation on every call. A
 * decoder that throws is not memoized and keeps throwing.
 */
export function decodeOnce<Decoded extends object | null>(
  decode: (event: EventEnvelope) => Decoded,
): (event: EventEnvelope) => Decoded {
  const decoded = new WeakMap<EventEnvelope, Decoded>();
  return (event) => {
    if (decoded.has(event)) return decoded.get(event) as Decoded;
    const value = decode(event);
    decoded.set(event, value);
    return value;
  };
}
