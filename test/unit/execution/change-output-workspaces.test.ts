import { expect, it, vi } from 'vitest';
import {
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import { acquireChangeOutputWorkspaces } from '../../../src/execution/application/change-output-workspaces.js';
import {
  runId,
  type ExecutionAttemptContext,
  type RunView,
  type WorkspaceProvider,
} from '../../../src/execution/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

const repository = {
  resourceId: resId('repo'),
  sourceRef: 'main',
  sourceRevision: 'a'.repeat(40),
  pullRequestBase: 'main',
};
const context: ExecutionAttemptContext = {
  workItemId: workId('child'),
  workflowInstanceId: activityWorkflowInstanceId('child'),
  orchestrationGroupId: activityOrchestrationGroupId('child'),
  repositoryAssignment: repository,
  resources: [
    {
      resourceId: repository.resourceId,
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'fake', key: 'org/repo' },
      capabilities: [],
    },
  ],
  changeOutputAssignments: ['web', 'api'].map((name) => ({ name, repository, isolated: true })),
};
const request = {
  runId: runId('multi'),
  context,
  mode: 'branch' as const,
  runs: [] as RunView[],
  signal: new AbortController().signal,
};

it('releases every acquired output when a later branch cannot be prepared', async () => {
  const release = vi.fn(async () => {});
  const acquire = vi.fn<WorkspaceProvider['acquire']>(async (entry) => {
    if (entry.outputName === 'web') throw new Error('lease busy');
    return {
      workspaceId: 'api',
      path: '/api',
      branch: 'api',
      mode: 'branch',
      readRevision: async () => repository.sourceRevision,
      release,
    };
  });
  await expect(acquireChangeOutputWorkspaces(request, { acquire })).rejects.toThrow('lease busy');
  expect(acquire.mock.calls.map(([entry]) => entry.outputName)).toEqual(['api', 'web']);
  expect(release).toHaveBeenCalledOnce();
});

it('captures each HEAD under its own lease and retains the real child owner', async () => {
  const heads = new Map([
    ['api', 'b'.repeat(40)],
    ['web', 'c'.repeat(40)],
  ]);
  const acquire = vi.fn<WorkspaceProvider['acquire']>(async (entry) => ({
    workspaceId: entry.outputName!,
    path: '/' + entry.outputName,
    branch: entry.outputName!,
    mode: entry.mode,
    readRevision: async () => heads.get(entry.outputName!)!,
    release: async () => {},
  }));
  const lease = await acquireChangeOutputWorkspaces(request, { acquire });
  heads.set('web', 'd'.repeat(40));
  expect((await lease.readChangeOutputs!()).map((entry) => [entry.name, entry.revision])).toEqual([
    ['api', 'b'.repeat(40)],
    ['web', 'd'.repeat(40)],
  ]);
  for (const [entry] of acquire.mock.calls) expect(entry.workItemId).toBe(context.workItemId);
  await lease.release();
});

it('refuses an ambiguous parent maintenance writer before acquiring any output', async () => {
  const acquire = vi.fn<WorkspaceProvider['acquire']>();
  const prior = {
    status: 'ambiguous',
    workspace: {
      maintenance: { targets: [{ childWorkItemId: context.workItemId, outputName: 'web' }] },
    },
  } as unknown as RunView;
  await expect(
    acquireChangeOutputWorkspaces({ ...request, runs: [prior] }, { acquire }),
  ).rejects.toThrow('unresolved earlier writer');
  expect(acquire).not.toHaveBeenCalled();
});
