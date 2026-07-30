import type { WorkspaceProvider, WorkspaceRequest } from '../../contracts/workspace.js';

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly requests: WorkspaceRequest[] = [];
  constructor(private readonly path = '/fake/workspace') {}
  async acquire(request: WorkspaceRequest) {
    this.requests.push(request);
    return {
      workspaceId: `workspace-${this.requests.length}`,
      path: this.path,
      mode: request.mode,
      release: async () => {},
    };
  }
}
