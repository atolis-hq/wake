import type { WorkItemId } from '../../work/index.js';
import type { ArtifactWorkItemId } from './identifiers.js';

export interface ArtifactRevisionView {
  readonly revisionId: string;
  readonly producer: string;
  readonly path: string;
  readonly runId: string;
  readonly activationId: string;
  readonly occurredAt: string;
  readonly deleted: boolean;
  readonly location?: string;
  readonly digest?: string;
  readonly byteLength?: number;
  readonly mediaType?: string;
}

export interface ArtifactWorkItemView {
  readonly artifactWorkItemId: ArtifactWorkItemId;
  readonly workItemId: WorkItemId;
  readonly revisions: readonly ArtifactRevisionView[];
}
