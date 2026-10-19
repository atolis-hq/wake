import type { EventData, EventEnvelope, StreamRef } from '../contracts/events.js';
import type { JournalChangeSignal } from '../subscriptions/journal-change-signal.js';

export class WrongExpectedSequenceError extends Error {}

export interface EventJournal {
  appendToStream(
    stream: StreamRef,
    expectedSequence: number,
    events: readonly EventData[],
  ): Promise<readonly EventEnvelope[]>;
  /** Every read observes all appends committed before the call, including by other processes. */
  readStream(stream: StreamRef): Promise<readonly EventEnvelope[]>;
  /** Optional bounded, cancellable snapshot reader for adapters with a streaming source. */
  scanAll?(signal?: AbortSignal): AsyncIterable<EventEnvelope>;
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
  readLatest?(beforeGlobalPosition?: number, limit?: number): Promise<readonly EventEnvelope[]>;
  // Cheap enough to call on every tick: implementations must answer this
  // without re-reading or re-copying the full event history, so callers can
  // gate an expensive full-collection re-derivation on "did this move" first.
  latestGlobalPosition(): Promise<number>;
  waitForEventsAfter(
    afterGlobalPosition: number,
    signal: AbortSignal,
    fallbackMs: number,
  ): Promise<void>;
  // Advisory only; a consumer always re-derives what's new from its own
  // durable checkpoint after waking, never from this signal.
  readonly changeSignal: JournalChangeSignal;
}
