import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { selectArtifactEvent } from '../contracts/events.js';
import { ArtifactStreamKind } from '../contracts/streams.js';
import type { ArtifactWorkItemView } from '../contracts/views.js';
import { applyArtifactEvent } from '../domain/artifact-work-item.js';

export const artifactProjection: ProjectionDefinition<ArtifactWorkItemView | null> = {
  name: ArtifactStreamKind.WorkItem,
  select(event) {
    const owned = selectArtifactEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectArtifactEvent(event);
    return owned === null ? previous : applyArtifactEvent(previous, owned);
  },
};
