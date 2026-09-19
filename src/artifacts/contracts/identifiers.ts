import type { Brand } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';

export type ArtifactWorkItemId = Brand<string, 'ArtifactWorkItemId'>;

export function artifactWorkItemId(value: string): ArtifactWorkItemId {
  if (!/^artifact-work-[0-9a-hjkmnp-tv-z]{26}$/.test(value))
    throw new Error('Invalid ArtifactWorkItemId');
  return value as ArtifactWorkItemId;
}

export function artifactWorkItemIdForWorkItem(workItemId: WorkItemId): ArtifactWorkItemId {
  return artifactWorkItemId(`artifact-work-${String(workItemId).slice('work-'.length)}`);
}
