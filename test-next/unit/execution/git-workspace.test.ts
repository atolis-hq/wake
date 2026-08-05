import { describe, expect, it } from 'vitest';
import { GitWorkspaceProvider } from '../../../src-next/execution/infrastructure/workspace/git-workspace.js';
import { resourceKind } from '../../../src-next/resources/index.js';
import { resId, workId } from '../../support/identities.js';

describe('GitWorkspaceProvider', () => {
  it('clones a repository into a work-item workspace', async () => {
    const commands: readonly string[][] = [];
    const provider = new GitWorkspaceProvider(
      '/workspaces',
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        (commands as string[][]).push([...args]);
      },
    );
    const lease = await provider.acquire({
      mode: 'read-only',
      workItemId: workId('one'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });
    expect((commands as string[][])[0]![0]).toBe('clone');
    expect((commands as string[][])[0]![1]).toBe('https://github.com/atolis-hq/wake-test.git');
    expect((commands as string[][])[0]![2]).toBe(lease.path);
  });
});
