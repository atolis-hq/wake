import { expect, it } from 'vitest';
import { acquireMaintenanceWorkspaces } from '../../../src/execution/application/maintenance-workspaces.js';
import {
  runId,
  RunStatus,
  type RunView,
  type WorkspaceProvider,
} from '../../../src/execution/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

const ids = [workId('a'), workId('b')];
const request = {
  runId: runId('maintenance'),
  runs: [] as readonly RunView[],
  signal: new AbortController().signal,
  maintenance: {
    targets: [...ids].reverse().map((id) => ({
      childWorkItemId: id,
      outputName: 'change',
      resourceId: resId(id.endsWith('a') ? 'a' : 'b'),
      branch: id,
      revision: 'a'.repeat(40),
      pullRequestBase: 'main',
      repository: {
        resourceId: resId('repo'),
        sourceRef: 'main',
        sourceRevision: 'b'.repeat(40),
        pullRequestBase: 'main',
      },
    })),
  },
  resources: [
    {
      resourceId: resId('repo'),
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'fake', key: 'org/repo' },
      capabilities: [],
    },
  ],
};

it('leases child branches in deterministic order and cleans up partial preparation', async () => {
  const acquired: string[] = [],
    released: string[] = [];
  const provider: WorkspaceProvider = {
    acquire: async (entry) => {
      acquired.push(entry.workItemId);
      if (entry.workItemId === ids[1]) throw new Error('lease busy');
      return {
        path: '/fake',
        workspaceId: 'fake',
        mode: entry.mode,
        release: async () => {
          released.push(entry.workItemId);
        },
      };
    },
  };
  await expect(acquireMaintenanceWorkspaces(request, provider)).rejects.toThrow('lease busy');
  expect(acquired).toEqual(ids);
  expect(released).toEqual([ids[0]]);
});

it('reconciles ambiguous prior writers before acquiring any branch', async () => {
  let acquired = false;
  const prior = {
    runId: runId('prior'),
    status: RunStatus.Ambiguous,
    workspace: { maintenance: { targets: [{ childWorkItemId: ids[0], outputName: 'change' }] } },
  } as unknown as RunView;
  await expect(
    acquireMaintenanceWorkspaces(
      { ...request, runs: [prior] },
      {
        acquire: async () => {
          acquired = true;
          throw new Error('must not acquire');
        },
      },
    ),
  ).rejects.toThrow('unresolved earlier writer');
  expect(acquired).toBe(false);
});

it('leases two outputs owned by one child independently and releases both', async () => {
  const acquired: string[] = [],
    released: string[] = [];
  const targets = ['web', 'api'].map((outputName) => ({
    ...request.maintenance.targets[0]!,
    childWorkItemId: ids[0]!,
    outputName,
    resourceId: resId(outputName),
    branch: ids[0] + '-output-' + outputName,
  }));
  const lease = await acquireMaintenanceWorkspaces(
    { ...request, maintenance: { targets } },
    {
      acquire: async (entry) => {
        acquired.push(entry.outputName!);
        return {
          path: '/' + entry.outputName,
          workspaceId: entry.outputName!,
          mode: entry.mode,
          branch: targets.find((target) => target.outputName === entry.outputName)!.branch,
          release: async () => {
            released.push(entry.outputName!);
          },
        };
      },
    },
  );
  expect(acquired).toEqual(['api', 'web']);
  expect(lease.maintenance?.targets.map((target) => target.path)).toEqual(['/api', '/web']);
  await lease.release();
  expect(released).toEqual(['web', 'api']);
});
