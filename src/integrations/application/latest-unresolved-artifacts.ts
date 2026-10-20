import type { EventEnvelope } from '@atolis-hq/eventing';
import {
  ArtifactEventType,
  decodeArtifactEvent,
  type ArtifactEvent,
} from '../contracts/artifact-events.js';

// Folds only the new events; the previous map is returned untouched when none
// of them record an unresolved verification.
export function extendLatestUnresolved(
  previous: ReadonlyMap<string, ArtifactEvent>,
  events: readonly EventEnvelope[],
): ReadonlyMap<string, ArtifactEvent> {
  if (!events.some((event) => event.event.eventType === ArtifactEventType.VerificationUnresolved))
    return previous;
  const latest = new Map(previous);
  for (const event of events) {
    if (event.event.eventType !== ArtifactEventType.VerificationUnresolved) continue;
    const decoded = decodeArtifactEvent(event);
    const key = `${decoded.event.causationId}:${decoded.event.payload.artifact.externalKey.adapter}:${decoded.event.payload.artifact.externalKey.key}`;
    latest.set(key, decoded);
  }
  return latest;
}
