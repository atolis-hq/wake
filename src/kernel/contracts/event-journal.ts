import type { EventDraft, EventEnvelope } from './events.js';
import type { EntityRef } from './identifiers.js';
import type { JournalChangeSignal } from './journal-change-signal.js';

export class WrongExpectedSequenceError extends Error {}

export interface EventJournal {
  append(
    stream: EntityRef,
    expectedSequence: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]>;
  readStream(stream: EntityRef): Promise<readonly EventEnvelope[]>;
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
  readLatest?(beforeGlobalPosition?: number, limit?: number): Promise<readonly EventEnvelope[]>;
  // Cheap enough to call on every tick: implementations must answer this
  // without re-reading or re-copying the full event history, so callers can
  // gate an expensive full-collection re-derivation on "did this move" first.
  latestGlobalPosition(): Promise<number>;
  // Advisory only; a consumer always re-derives what's new from its own
  // durable checkpoint after waking, never from this signal.
  readonly changeSignal: JournalChangeSignal;
}
