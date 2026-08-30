import { createEventData, type EventDataInput } from '../../kernel/index.js';
import {
  ArtifactEventType,
  type ArtifactEventData,
  type ArtifactEventPayloads,
} from './artifact-events.js';

export type ArtifactEventDataInput = {
  [Type in keyof ArtifactEventPayloads]: EventDataInput<Type, ArtifactEventPayloads[Type]>;
}[keyof ArtifactEventPayloads];

export function createArtifactEventData(input: ArtifactEventDataInput): ArtifactEventData {
  switch (input.eventType) {
    case ArtifactEventType.VerificationUnresolved:
      return createEventData(input);
  }
}
