import type { EventJournal } from '@atolis-hq/eventing';
import { ControlStreamKind } from '../contracts/streams.js';
import { triggerProjection, type TriggerView } from './trigger-projection.js';

/** A rebuildable operational cache; every critical section catches up to the journal. */
export class TriggerStateReader {
  private position = 0;
  private value = triggerProjection.initial('global');
  private readonly sequences = new Map<string, number>();

  constructor(private readonly journal: EventJournal) {}

  get current(): TriggerView {
    return this.value;
  }

  sequence(coordinationKey: string): number {
    return this.sequences.get(coordinationKey) ?? 0;
  }

  async get(): Promise<TriggerView> {
    const latest = await this.journal.latestGlobalPosition();
    while (this.position < latest) {
      const batch = await this.journal.readAll(this.position, 256);
      if (batch.length === 0) throw new Error('Trigger journal cursor did not advance');
      for (const envelope of batch) {
        if (triggerProjection.select(envelope) !== null)
          this.value = triggerProjection.project(this.value, envelope);
        if (envelope.stream.kind === ControlStreamKind.Trigger)
          this.sequences.set(envelope.stream.id, envelope.sequence);
        this.position = envelope.globalPosition;
      }
    }
    return this.value;
  }
}
