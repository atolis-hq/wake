import {
  foldedJournalView,
  type EventJournal,
  type JournalView,
  type ViewSnapshotCodec,
} from '@atolis-hq/eventing';
import { ControlStreamKind } from '../contracts/streams.js';
import { triggerProjection, type TriggerView } from './trigger-projection.js';

interface TriggerState {
  readonly value: TriggerView;
  readonly sequences: ReadonlyMap<string, number>;
}

// TriggerView is plain JSON (it is also stored as a projection). Bump
// `schemaVersion` when it or the fold changes.
const triggerStateCodec: ViewSnapshotCodec<TriggerState> = {
  encode: (state) => ({ value: state.value, sequences: [...state.sequences] }),
  decode(raw) {
    const { value, sequences } = raw as { value: TriggerView; sequences: [string, number][] };
    if (typeof value !== 'object' || value === null || !Array.isArray(sequences))
      throw new Error('Trigger snapshot is malformed');
    return { value, sequences: new Map(sequences) };
  },
};

/** A rebuildable operational cache; every critical section catches up to the journal. */
export class TriggerStateReader {
  private state: TriggerState = {
    value: triggerProjection.initial('global'),
    sequences: new Map(),
  };

  private readonly view: JournalView<TriggerState>;

  constructor(journal: EventJournal) {
    // Shares the paged journal catch-up with every other view over this journal.
    this.view = foldedJournalView<TriggerState>(journal, {
      name: 'trigger-state',
      initial: this.state,
      persist: { schemaVersion: 1, codec: triggerStateCodec },
      extend: (known, events) => {
        let value = known.value;
        const sequences = new Map(known.sequences);
        for (const envelope of events) {
          if (triggerProjection.select(envelope) !== null)
            value = triggerProjection.project(value, envelope);
          if (envelope.stream.kind === ControlStreamKind.Trigger)
            sequences.set(envelope.stream.id, envelope.sequence);
        }
        return { value, sequences };
      },
    });
  }

  get current(): TriggerView {
    return this.state.value;
  }

  sequence(coordinationKey: string): number {
    return this.state.sequences.get(coordinationKey) ?? 0;
  }

  async get(): Promise<TriggerView> {
    this.state = await this.view.get();
    return this.state.value;
  }
}
