import { expect, it } from 'vitest';
import { acquireCandidateWorkspaces } from '../../../src/execution/application/candidate-workspaces.js';
import {
  runId,
  type WorkspaceProvider,
  type WorkspaceRequest,
} from '../../../src/execution/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

class CandidateWorkspaces implements WorkspaceProvider {
  readonly requested: string[] = [];
  readonly released: string[] = [];
  constructor(
    private readonly fail?: string,
    private readonly wrongRevision = false,
  ) {}

  async acquire(request: WorkspaceRequest) {
    const id = request.repositoryResource.resourceId;
    this.requested.push(id);
    if (id === this.fail) throw new Error('Environment preparation unavailable');
    return {
      workspaceId: id,
      path: '/fake/' + id,
      mode: request.mode,
      readRevision: async () => (this.wrongRevision ? '0'.repeat(40) : request.checkoutRevision!),
      release: async () => {
        this.released.push(id);
      },
    };
  }
}

const ids = [resId('a'), resId('b')];
const request = {
  runId: runId('candidate'),
  workItemId: workId('candidate'),
  signal: new AbortController().signal,
  candidate: {
    candidateId: 'candidate',
    selectionRevision: 1,
    criteria: ['Works'],
    inputs: [],
    repositories: [...ids].reverse().map((id) => ({
      resourceId: id,
      sourceRef: 'retained',
      sourceRevision: 'a'.repeat(40),
      pullRequestBase: 'main',
      requiredSourceRef: 'retained',
    })),
  },
  resources: ids.map((id) => ({
    resourceId: id,
    kind: BuiltInResourceKind.Repository,
    externalKey: { adapter: 'fake', key: id },
    capabilities: [],
  })),
};

it('acquires all exact checkouts in deterministic order and releases them in reverse order', async () => {
  const provider = new CandidateWorkspaces();
  const lease = await acquireCandidateWorkspaces(request, provider);
  expect(provider.requested).toEqual(ids);
  expect(lease.candidate?.repositories.map((entry) => entry.revision)).toEqual([
    'a'.repeat(40),
    'a'.repeat(40),
  ]);
  await lease.release();
  expect(provider.released).toEqual([...ids].reverse());
});

it('cleans up partial acquisition when a later environment is unavailable', async () => {
  const provider = new CandidateWorkspaces(ids[1]);
  await expect(acquireCandidateWorkspaces(request, provider)).rejects.toThrow(
    'Environment preparation unavailable',
  );
  expect(provider.released).toEqual([ids[0]]);
});

it('rejects a checkout that differs from the manifest and releases its lease', async () => {
  const provider = new CandidateWorkspaces(undefined, true);
  await expect(acquireCandidateWorkspaces(request, provider)).rejects.toThrow('differs');
  expect(provider.released).toEqual([ids[0]]);
});
