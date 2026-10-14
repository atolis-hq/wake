import type { ProjectionDefinition } from '@atolis-hq/eventing';
import {
  ArtifactContextEventType,
  selectArtifactContextEvent,
} from '../contracts/context-events.js';
import type { OperatorInstructionsRevision } from '../contracts/context.js';

/** Latest operator revision metadata only; scope existence still comes from configuration. */
export const operatorInstructionsProjection: ProjectionDefinition<OperatorInstructionsRevision | null> =
  {
    name: 'operator-instructions',
    select(event) {
      const owned = selectArtifactContextEvent(event);
      return owned?.event.eventType === ArtifactContextEventType.InstructionsEdited
        ? { key: owned.event.payload.contextScope }
        : null;
    },
    initial: () => null,
    project(previous, event) {
      const owned = selectArtifactContextEvent(event);
      if (owned?.event.eventType !== ArtifactContextEventType.InstructionsEdited) return previous;
      const { expectedRevisionId: _expected, ...revision } = owned.event.payload;
      return revision;
    },
  };
