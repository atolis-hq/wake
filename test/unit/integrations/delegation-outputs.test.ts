import { describe, expect, it, vi } from 'vitest';
import { createDelegationOutputs } from '../../../src/integrations/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
} from '../../../src/resources/index.js';

import { resId } from '../../support/identities.js';

const repository = {
  resourceId: resId('delegation-outputs-repo'),
  externalKey: { adapter: 'fake', key: 'org/repo' },
};
const pullRequest = {
  resourceId: resId('delegation-outputs-pr'),
  kind: BuiltInResourceKind.PullRequest,
  externalKey: { adapter: 'fake', key: 'org/repo#1' },
};
const assignment = {
  resourceId: repository.resourceId,
  sourceRef: 'main',
  pullRequestBase: 'integration',
};
const child = { workflowInstanceId: 'wf', workItemId: 'child', acceptedOutcomes: ['a1', 'a2'] };
const output = { name: 'delivery', kind: 'change', requireReview: false, requireChecks: false };

const run = (activationId: string, revision: string, reported: boolean) => ({
  runId: 'run-' + activationId,
  activationId,
  workflowInstanceId: 'wf',
  status: 'succeeded',
  repositoryAssignment: assignment,
  workspaceRevision: revision,
  workspace: { mode: 'branch', branch: 'child' },
  outcome: {
    kind: 'done',
    data: {
      reportedArtifacts: reported
        ? [{ name: 'delivery', kind: 'pull-request', externalKey: pullRequest.externalKey }]
        : [],
    },
  },
});

function outputs(runs: unknown[], providerHead: string) {
  const verifyArtifact = vi.fn(async (_kind, externalKey, source) =>
    source.workspaceRevision === providerHead
      ? {
          kind: BuiltInResourceKind.PullRequest,
          externalKey,
          capabilities: [],
          revision: providerHead,
        }
      : 'not-found',
  );
  const service = createDelegationOutputs({
    artifacts: { qualifyingOutputs: async () => [] },
    resources: {
      get: async () => repository,
      findByExternalKey: async () => pullRequest,
      primaryCorrelation: async () => ({
        workItemId: 'child',
        role: ResourceCorrelationRole.Primary,
        provenance: ResourceCorrelationProvenance.AgentReported,
      }),
    },
    pullRequests: {
      decideAuthority: async () => ({ allowed: true, revision: providerHead }),
    },
    runs: async () => runs,
    providers: async () => [{ adapter: 'fake', verifyArtifact }],
  } as never);
  return {
    verifyArtifact,
    qualify: () => service.qualifyingOutputs(child as never, [output] as never),
  };
}

describe('createDelegationOutputs', () => {
  it('keeps a reported PR qualifying when a later revision run pushes without re-reporting it', async () => {
    const { qualify, verifyArtifact } = outputs(
      [run('a1', 'head-1', true), run('a2', 'head-2', false)],
      'head-2',
    );
    expect(await qualify()).toMatchObject([
      { name: 'delivery', reference: { revision: 'head-2', pullRequestBase: 'integration' } },
    ]);
    expect(verifyArtifact).toHaveBeenCalledWith(
      BuiltInResourceKind.PullRequest,
      pullRequest.externalKey,
      expect.objectContaining({ workspaceBranch: 'child', workspaceRevision: 'head-2' }),
    );
  });

  it('does not qualify when the provider PR still points at an older head than the implementation', async () => {
    const { qualify } = outputs([run('a1', 'head-1', true), run('a2', 'head-2', false)], 'head-1');
    expect(await qualify()).toBeNull();
  });
});
