import type { EventEnvelope } from '../domain/types.js';

export function createEventEnvelope(input: Omit<EventEnvelope, 'schemaVersion'>): EventEnvelope {
  return {
    schemaVersion: 1,
    ...input,
  };
}

/**
 * Builds a source event with no workItemKey. Sources do not self-key; the
 * resolver in tick-runner stamps the canonical key between poll and append
 * (spec D1).
 *
 * The return type is spelled structurally rather than importing
 * core/contracts' `UnkeyedEventEnvelope` — it is the identical type, and lib/
 * must not depend on core/.
 */
export function createUnkeyedEventEnvelope(
  input: Omit<EventEnvelope, 'schemaVersion' | 'workItemKey'>,
): Omit<EventEnvelope, 'workItemKey'> {
  return {
    schemaVersion: 1,
    ...input,
  };
}
