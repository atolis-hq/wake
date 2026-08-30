import type { EventEnvelope } from '../../../src/kernel/index.js';

export function formatTrace(events: readonly EventEnvelope[]): string {
  return events
    .map(
      (event) =>
        `${event.globalPosition} ${event.event.eventType} ` +
        `stream=${event.stream.kind}:${event.stream.id} ` +
        `cause=${event.event.causationId} payload=${JSON.stringify(event.event.payload)}`,
    )
    .join('\n');
}
