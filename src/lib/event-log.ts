import type { EventEnvelope, EventRecord } from '../domain/types.js';

export function createEventRecord(input: Omit<EventRecord, 'schemaVersion'>): EventRecord {
  return {
    schemaVersion: 1,
    ...input,
  };
}

export function createEventEnvelope(input: Omit<EventEnvelope, 'schemaVersion'>): EventEnvelope {
  return {
    schemaVersion: 1,
    ...input,
  };
}
