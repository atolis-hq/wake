import { describe, expect, it } from 'vitest';
import { runId } from '../../../src/execution/contracts/identifiers.js';
import { FakeWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/fake-workspace.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

const request = {
  runId: runId('run-fake-prepare'),
  signal: new AbortController().signal,
  mode: 'read-only' as const,
  workItemId: workId('fake-prepare'),
  repositoryResource: {
    resourceId: resId('workspace-resource'),
    kind: resourceKind('issue'),
    externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
    capabilities: [],
  },
};

describe('FakeWorkspaceProvider prepare hook', () => {
  it('records successful prepare invocations', async () => {
    const provider = new FakeWorkspaceProvider('/fake/prepare', undefined, {
      command: 'prepare.sh',
    });
    await provider.acquire(request);
    expect(provider.prepareInvocations).toEqual([{ command: 'prepare.sh', cwd: '/fake/prepare' }]);
  });

  it.each([
    [{ kind: 'exit', exitCode: 3 } as const, /code 3/],
    [{ kind: 'timed-out' } as const, /timed out/],
  ])('simulates a failing prepare outcome', async (outcome, expected) => {
    const provider = new FakeWorkspaceProvider(
      '/fake/prepare',
      undefined,
      { command: 'prepare.sh' },
      outcome,
    );
    await expect(provider.acquire(request)).rejects.toThrow(expected);
  });
});
