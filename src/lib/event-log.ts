import type { EventRecord } from '../domain/types.js';

export function createEventRecord(input: Omit<EventRecord, 'schemaVersion'>): EventRecord {
  return {
    schemaVersion: 1,
    ...input,
  };
}
