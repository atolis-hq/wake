import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import { ArtifactEventType, type ArtifactEventData, type ArtifactEventPayloads } from './events.js';

export type ArtifactEventDataInput = {
  [Type in keyof ArtifactEventPayloads]: EventDataInput<Type, ArtifactEventPayloads[Type]>;
}[keyof ArtifactEventPayloads];

export function createArtifactEventData(input: ArtifactEventDataInput): ArtifactEventData {
  switch (input.eventType) {
    case ArtifactEventType.RevisionStaged:
      return createEventData(input);
    case ArtifactEventType.TombstoneStaged:
      return createEventData(input);
  }
}
