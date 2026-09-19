import type { EntityRef } from '../../kernel/index.js';
import type { ArtifactWorkItemId } from './identifiers.js';

export const ArtifactStreamKind = { WorkItem: 'artifact-work-item' } as const;

export type ArtifactWorkItemStreamRef = EntityRef<
  typeof ArtifactStreamKind.WorkItem,
  ArtifactWorkItemId
>;

export function artifactWorkItemStream(id: ArtifactWorkItemId): ArtifactWorkItemStreamRef {
  return { kind: ArtifactStreamKind.WorkItem, id };
}
