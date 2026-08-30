import { isDeepStrictEqual } from 'node:util';
import type {
  Clock,
  EntityRef,
  EventData,
  EventEnvelope,
  EventJournal,
  JournalChangeSignal,
} from '../../kernel/index.js';
import { InProcessJournalChangeSignal, WrongExpectedSequenceError } from '../../kernel/index.js';

interface IndexedEvent {
  readonly draft: EventData;
  readonly envelope: EventEnvelope;
}

export class InMemoryEventJournal implements EventJournal {
  private readonly streams = new Map<string, EventEnvelope[]>();
  private readonly events: EventEnvelope[] = [];
  private readonly eventIds = new Map<string, IndexedEvent>();
  private readonly changeSignalSource = new InProcessJournalChangeSignal();

  constructor(private readonly clock: Clock) {}

  get changeSignal(): JournalChangeSignal {
    return this.changeSignalSource;
  }

  async appendToStream(
    stream: EntityRef,
    expectedSequence: number,
    events: readonly EventData[],
  ): Promise<readonly EventEnvelope[]> {
    if (events.length === 0) throw new Error('appendToStream requires at least one event');
    validateBatch(stream, events);
    const existingEvents = events.map((draft) => this.eventIds.get(draft.eventId));
    this.rejectChangedEventIds(events, existingEvents);

    if (events.length > 0 && existingEvents.every((event) => event !== undefined)) {
      return existingEvents.map((event) => event.envelope);
    }

    const streamEvents = this.streams.get(streamKey(stream)) ?? [];
    if (streamEvents.length !== expectedSequence) {
      throw new WrongExpectedSequenceError(
        `Expected sequence ${expectedSequence} for ${streamKey(stream)}, actual ${streamEvents.length}`,
      );
    }

    const recordedAt = this.clock.now().toISOString();
    const appended: EventEnvelope[] = [];
    let newCount = 0;
    for (const [index, draft] of events.entries()) {
      const prior = existingEvents[index];
      if (prior !== undefined) {
        appended.push(prior.envelope);
        continue;
      }
      const envelope: EventEnvelope = {
        ...draft,
        recordedAt,
        sequence: streamEvents.length + 1,
        globalPosition: this.events.length + 1,
      };
      streamEvents.push(envelope);
      this.events.push(envelope);
      this.eventIds.set(draft.eventId, { draft, envelope });
      appended.push(envelope);
      newCount += 1;
    }
    this.streams.set(streamKey(stream), streamEvents);
    if (newCount > 0) this.changeSignalSource.notify();
    return appended;
  }

  async readStream(stream: EntityRef): Promise<readonly EventEnvelope[]> {
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

  private rejectChangedEventIds(
    drafts: readonly EventData[],
    existingEvents: readonly (IndexedEvent | undefined)[],
  ): void {
    for (const [index, draft] of drafts.entries()) {
      const existing = existingEvents[index];
      if (existing !== undefined && !isDeepStrictEqual(existing.draft, draft)) {
        throw new Error(`Event id ${draft.eventId} has already been used with different content`);
      }
    }
  }
}

function streamKey(stream: EntityRef): string {
  return `${stream.kind}:${stream.id}`;
}

function assertSameStream(expected: EntityRef, actual: EntityRef): void {
  if (streamKey(expected) !== streamKey(actual)) {
    throw new Error(
      `Event stream ${streamKey(actual)} does not match append stream ${streamKey(expected)}`,
    );
  }
}

function validateBatch(stream: EntityRef, drafts: readonly EventData[]): void {
  const eventIds = new Map<string, EventData>();
  for (const draft of drafts) {
    assertSameStream(stream, draft.stream);
    const prior = eventIds.get(draft.eventId);
    if (prior !== undefined) {
      if (!isDeepStrictEqual(prior, draft)) {
        throw new Error(
          `Event id ${draft.eventId} is repeated with different content in one append`,
        );
      }
      throw new Error(`Event id ${draft.eventId} is repeated in one append`);
    }
    eventIds.set(draft.eventId, draft);
  }
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
