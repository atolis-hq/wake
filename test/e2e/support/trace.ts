import type { EventEnvelope } from '../../../src/kernel/index.js';

export function formatTrace(events: readonly EventEnvelope[]): string {
  return events
    .map(
      (event) =>
        `${event.globalPosition} ${event.eventType} ` +
        `stream=${event.stream.kind}:${event.stream.id} ` +
        `cause=${event.causationId} payload=${JSON.stringify(event.payload)}`,
    )
    .join('\n');
}
