import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import {
  ArtifactContextEventType,
  type ArtifactContextEventData,
  type ArtifactContextEventPayloads,
} from './context-events.js';

export type ArtifactContextEventInput = {
  [Type in keyof ArtifactContextEventPayloads]: EventDataInput<
    Type,
    ArtifactContextEventPayloads[Type]
  >;
}[keyof ArtifactContextEventPayloads];

export function createArtifactContextEventData(
  input: ArtifactContextEventInput,
): ArtifactContextEventData {
  switch (input.eventType) {
    case ArtifactContextEventType.Enrolled:
      return createEventData(input);
    case ArtifactContextEventType.Published:
      return createEventData(input);
    case ArtifactContextEventType.Delegated:
      return createEventData(input);
  }
}
