import type { EventEnvelope } from '../contracts/events.js';
import type { EventJournal } from '../store/event-journal.js';
import { JOURNAL_VIEW_PAGE_SIZE, sharedJournalFeed } from './shared-journal-feed.js';
import { restoreView, ViewSnapshotWriter, type ViewAnchor } from './view-persistence.js';
import type { ViewPersistence } from './view-snapshot.js';

export { JOURNAL_VIEW_PAGE_SIZE, warmJournalViews } from './shared-journal-feed.js';

export const JOURNAL_CHANGE_FALLBACK_MS = 30_000;

export interface JournalView<Value> {
  get(): Promise<Value>;
}

type ViewJournal = Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>;

export interface JournalFold<Value> {
  /** Stable identity: names the snapshot file and attributes catch-up cost per view. */
  readonly name: string;
  readonly initial: Value;
  /** Returns the value after `events`, which follow everything already folded. Must not mutate `value`: earlier callers may still hold it across awaits. */
  extend(value: Value, events: readonly EventEnvelope[]): Value;
  /** Opt in to a rebuildable on-disk snapshot so a restart skips folded history. */
  readonly persist?: ViewPersistence<Value>;
}

// The in-process read model for derivations that join across streams or must
// answer without a durable key (use a ProjectionStore projection for per-key
// state that must survive restarts). The first call folds history once; every
// later journal move folds only the events after the position already held, so
// cost per resident tick is proportional to what changed, never to history.
// There is deliberately no "re-derive everything when the journal moves" form.
// Folds are serialised, so every event is applied once and in order however
// many callers ask at the same time; the value is keyed by the last position
// actually read, never one sampled beforehand. Views over one journal share
// the paged catch-up reads (see SharedJournalFeed). A head behind the held
// position means the journal was restored, so the view starts over.
export function foldedJournalView<Value>(
  journal: ViewJournal,
  fold: JournalFold<Value>,
): JournalView<Value> {
  const feed = sharedJournalFeed(journal);
  const writer =
    fold.persist === undefined
      ? undefined
      : new ViewSnapshotWriter(journal, fold.name, fold.persist);
  let state: { readonly position: number; readonly value: Value } = {
    position: 0,
    value: fold.initial,
  };
  let anchor: ViewAnchor | null = null;
  let restoreTried = false;
  let running: Promise<unknown> | undefined;

  async function restore(head: number): Promise<void> {
    restoreTried = true;
    if (fold.persist === undefined) return;
    const restored = await restoreView(journal, fold.name, fold.persist, head);
    if (restored === null) return;
    state = { position: restored.position, value: restored.value };
    anchor = { position: restored.position, eventId: restored.eventId };
    writer?.restored(restored.position, restored.valuePosition, restored.value);
  }

  // Catch up in pages: one unbounded read would hold every decoded envelope of
  // a long journal at once on first use.
  async function catchUp(head: number): Promise<void> {
    if (!restoreTried) await restore(head);
    for (;;) {
      const events = await feed.page(state.position);
      const last = events.at(-1);
      if (last !== undefined) {
        state = { position: last.globalPosition, value: fold.extend(state.value, events) };
        if (writer !== undefined)
          anchor = { position: last.globalPosition, eventId: last.event.eventId };
      }
      if (events.length < JOURNAL_VIEW_PAGE_SIZE) break;
    }
    writer?.maybeSave(anchor, state.value);
  }

  const view: JournalView<Value> = {
    async get(): Promise<Value> {
      for (;;) {
        const sampled = await feed.head();
        if (sampled < state.position && running === undefined) {
          state = { position: 0, value: fold.initial };
          anchor = null;
          restoreTried = false;
          writer?.reset();
        }
        if (state.position >= sampled) return state.value;
        if (running !== undefined) {
          await running.catch(() => undefined);
          continue;
        }
        const before = state.position;
        const run = feed
          .catchUp(() => catchUp(sampled))
          .finally(() => {
            if (running === run) running = undefined;
          });
        running = run;
        await run;
        // A page shared with an earlier reader may predate `sampled`; ask again.
        if (state.position >= sampled || state.position === before) return state.value;
      }
    },
  };
  feed.register(view);
  return view;
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
