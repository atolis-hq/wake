import type { EventEnvelope, ViewSnapshotCodec } from '@atolis-hq/eventing';
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

export const latestUnresolvedCodec: ViewSnapshotCodec<ReadonlyMap<string, ArtifactEvent>> = {
  encode: (latest) => [...latest],
  decode(raw) {
    if (!Array.isArray(raw)) throw new Error('Artifact snapshot must be a list of entries');
    return new Map(
      (raw as [string, EventEnvelope][]).map(([key, event]) => [key, decodeArtifactEvent(event)]),
    );
  },
};
