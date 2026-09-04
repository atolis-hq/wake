import type {
  EventData,
  EventEnvelope,
  EventJournal,
  JournalChangeSignal,
} from '@atolis-hq/eventing';
import type { EntityRef } from '../../src/kernel/index.js';

export class InterleavingEventJournal implements EventJournal {
  private waiting = 0;
  private release: (() => void) | undefined;

  constructor(
    private readonly inner: EventJournal,
    private readonly shouldInterleave: (events: readonly EventData[]) => boolean,
  ) {}

  get changeSignal(): JournalChangeSignal {
    return this.inner.changeSignal;
  }

  async appendToStream(
    stream: EntityRef,
    expectedSequence: number,
    events: readonly EventData[],
  ): Promise<readonly EventEnvelope[]> {
    if (this.shouldInterleave(events)) {
      this.waiting += 1;
      if (this.waiting === 1) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      } else if (this.waiting === 2) {
        this.release?.();
      }
    }
    return this.inner.appendToStream(stream, expectedSequence, events);
  }

  readStream(stream: EntityRef): Promise<readonly EventEnvelope[]> {
    return this.inner.readStream(stream);
  }

  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]> {
    return this.inner.readAll(afterGlobalPosition, limit);
  }

  readLatest(beforeGlobalPosition?: number, limit?: number): Promise<readonly EventEnvelope[]> {
    if (this.inner.readLatest === undefined) return Promise.resolve([]);
    return this.inner.readLatest(beforeGlobalPosition, limit);
  }

  latestGlobalPosition(): Promise<number> {
    return this.inner.latestGlobalPosition();
  }

  waitForEventsAfter(
    afterGlobalPosition: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void> {
    return this.inner.waitForEventsAfter(afterGlobalPosition, signal, fallbackMs);
  }
}
