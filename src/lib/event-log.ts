import type { EventEnvelope } from '../domain/types.js';

export function createEventEnvelope(input: Omit<EventEnvelope, 'schemaVersion'>): EventEnvelope {
  return {
    schemaVersion: 1,
    ...input,
  };
}
