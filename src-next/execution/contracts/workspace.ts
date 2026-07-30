import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
export interface WorkspaceRequest {
  readonly mode: 'read-only' | 'branch';
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
