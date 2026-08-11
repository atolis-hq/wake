import type { WorkspaceProvider, WorkspaceRequest } from '../../contracts/workspace.js';

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly requests: WorkspaceRequest[] = [];
  constructor(
    private readonly path = '/fake/workspace',
    private readonly branch: string | undefined = 'wake/fake-work',
  ) {}

  async acquire(request: WorkspaceRequest) {
    this.requests.push(request);
    return {
      workspaceId: `workspace-${this.requests.length}`,
      path: this.path,
      ...(this.branch === undefined ? {} : { branch: this.branch }),
      mode: request.mode,
      release: async () => {},
    };
  }
}
