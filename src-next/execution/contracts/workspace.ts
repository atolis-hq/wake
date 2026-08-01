import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import { WorkspaceMode } from './vocabulary.js';
export interface WorkspaceRequest {
  readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
  readonly workItemId: WorkItemId;
  readonly repositoryResource: ResourceView;
}
export interface WorkspaceLease {
  readonly workspaceId: string;
  readonly path: string;
  readonly mode: WorkspaceRequest['mode'];
  release(): Promise<void>;
}
export interface WorkspaceProvider {
  acquire(request: WorkspaceRequest): Promise<WorkspaceLease>;
}
