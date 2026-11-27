import { foldedJournalView, type EventJournal, type JournalView } from '@atolis-hq/eventing';
import { ControlStreamKind } from '../contracts/streams.js';
import { triggerProjection, type TriggerView } from './trigger-projection.js';

interface TriggerState {
  readonly value: TriggerView;
  readonly sequences: ReadonlyMap<string, number>;
}

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
      initial: this.state,
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
