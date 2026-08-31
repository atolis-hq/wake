import type { EventData, EventEnvelope, StreamRef } from '../contracts/events.js';
import type { EventingClock } from '../runtime/clock.js';
import { WrongExpectedSequenceError, type EventJournal } from '../store/event-journal.js';
import { InProcessJournalChangeSignal } from '../subscriptions/in-process-journal-change-signal.js';
import type { JournalChangeSignal } from '../subscriptions/journal-change-signal.js';

export class InMemoryEventJournal implements EventJournal {
  private readonly streams = new Map<string, EventEnvelope[]>();
  private readonly events: EventEnvelope[] = [];
  private readonly changeSignalSource = new InProcessJournalChangeSignal();

  constructor(private readonly clock: EventingClock) {}

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  async appendToStream(
    stream: StreamRef,
    expectedSequence: number,
    events: readonly EventData[],
  ): Promise<readonly EventEnvelope[]> {
    if (events.length === 0) throw new Error('appendToStream requires at least one event');
    const streamEvents = this.streams.get(streamKey(stream)) ?? [];
    if (streamEvents.length !== expectedSequence) {
      throw new WrongExpectedSequenceError(
        `Expected sequence ${expectedSequence} for ${streamKey(stream)}, actual ${streamEvents.length}`,
      );
    }

    const recordedAt = this.clock.now().toISOString();
    const appended: EventEnvelope[] = [];
    for (const draft of events) {
      const envelope: EventEnvelope = {
        event: draft,
        stream,
        recordedAt,
        sequence: streamEvents.length + 1,
        globalPosition: this.events.length + 1,
      };
      streamEvents.push(envelope);
      this.events.push(envelope);
      appended.push(envelope);
    }
    this.streams.set(streamKey(stream), streamEvents);
    this.changeSignalSource.notify();
    return appended;
  }

  async readStream(stream: StreamRef): Promise<readonly EventEnvelope[]> {
    return [...(this.streams.get(streamKey(stream)) ?? [])];
  }

  async readAll(
    afterGlobalPosition: number,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<readonly EventEnvelope[]> {
    return this.events
      .filter((event) => event.globalPosition > afterGlobalPosition)
      .slice(0, limit);
  }

  async readLatest(
    beforeGlobalPosition = this.events.length + 1,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<readonly EventEnvelope[]> {
    return this.events
      .slice(0, beforeGlobalPosition - 1)
      .slice(-limit)
      .reverse();
  }

  async latestGlobalPosition(): Promise<number> {
    return this.events.length;
  }

  async waitForEventsAfter(
    afterGlobalPosition: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void> {
    await waitForEventsAfter(
      () => this.latestGlobalPosition(),
      this.changeSignalSource,
      afterGlobalPosition,
      signal,
      fallbackMs,
    );
  }
}

function streamKey(stream: StreamRef): string {
  return `${stream.kind}:${stream.id}`;
}

async function waitForEventsAfter(
  latestGlobalPosition: () => Promise<number>,
  changeSignal: JournalChangeSignal,
  afterGlobalPosition: number,
  signal: AbortSignal,
  fallbackMs: number,
): Promise<void> {
  if (signal.aborted) return;
  const observedGeneration = changeSignal.revision();
  const waiting = new AbortController();
  const abort = () => waiting.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const wake = changeSignal.waitForChangeAfter(observedGeneration, waiting.signal, fallbackMs);
    if ((await latestGlobalPosition()) > afterGlobalPosition) return;
    await wake;
  } finally {
    waiting.abort();
    signal.removeEventListener('abort', abort);
  }
}
