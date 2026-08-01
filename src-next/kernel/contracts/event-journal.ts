import type { EventDraft, EventEnvelope } from './events.js';
import type { EntityRef } from './identifiers.js';

export class WrongExpectedSequenceError extends Error {}

export interface EventJournal {
  append(
    stream: EntityRef,
    expectedSequence: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]>;
  readStream(stream: EntityRef): Promise<readonly EventEnvelope[]>;
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
}
