import type { WorkspaceProvider, WorkspaceRequest } from '../../contracts/workspace.js';

export type FakeWorkspacePrepareOutcome =
  | { readonly kind: 'success' }
  | {
      readonly kind: 'exit';
      readonly exitCode: number;
      readonly stdout?: string;
      readonly stderr?: string;
    }
  | { readonly kind: 'timed-out'; readonly stdout?: string; readonly stderr?: string };

export interface FakeWorkspacePrepareHook {
  readonly command: string;
  readonly timeoutMs?: number;
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly requests: WorkspaceRequest[] = [];
  readonly prepareInvocations: { readonly command: string; readonly cwd: string }[] = [];
  constructor(
    private readonly path = '/fake/workspace',
    private readonly branch: string | undefined = 'wake/fake-work',
    private readonly prepareHook?: FakeWorkspacePrepareHook,
    private readonly prepareOutcome: FakeWorkspacePrepareOutcome = { kind: 'success' },
  ) {}

  async acquire(request: WorkspaceRequest) {
    request.signal.throwIfAborted();
    this.requests.push(request);
    if (this.prepareHook !== undefined) {
      this.prepareInvocations.push({ command: this.prepareHook.command, cwd: this.path });
      if (this.prepareOutcome.kind === 'timed-out')
        throw new Error(`Fake workspace prepare hook (${this.prepareHook.command}) timed out`);
      if (this.prepareOutcome.kind === 'exit' && this.prepareOutcome.exitCode !== 0)
        throw new Error(
          `Fake workspace prepare hook (${this.prepareHook.command}) exited with code ${this.prepareOutcome.exitCode}`,
        );
    }
    request.signal.throwIfAborted();
    return {
      workspaceId: `workspace-${this.requests.length}`,
      path: this.path,
      ...(this.branch === undefined ? {} : { branch: this.branch }),
      mode: request.mode,
      release: async () => {},
    };
  }
}
