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
      get: async () => ({ headRevision: providerHead, baseRevision: 'base-1', state: 'open' }),
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

it('distinguishes pushed, delivery-ready and actual merged change prerequisites', async () => {
  let state = 'open';
  let reviewed = false;
  let head = 'head-1';
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
      get: async () => ({ state, headRevision: head, baseRevision: 'base-1' }),
      decideAuthority: async (_work: string, options: { requireAcceptedReview: boolean }) => ({
        allowed: state === 'open' && (!options.requireAcceptedReview || reviewed),
        revision: head,
      }),
    },
    runs: async () => [run('a1', 'head-1', true)],
    providers: async () => [
      {
        adapter: 'fake',
        verifyArtifact: async () => ({ externalKey: pullRequest.externalKey, revision: head }),
      },
    ],
  } as never);
  const select = (condition: 'pushed-change' | 'delivery-ready' | 'merged-change') =>
    service.prerequisiteOutput!(
      child as never,
      { ...output, requireReview: true } as never,
      condition,
    );
  expect(await select('pushed-change')).toMatchObject({
    reference: { revision: 'head-1', baseRevision: 'base-1' },
  });
  expect(await select('delivery-ready')).toBeNull();
  expect(await select('merged-change')).toBeNull();
  reviewed = true;
  expect(await select('delivery-ready')).not.toBeNull();
  state = 'closed';
  expect(await select('merged-change')).toBeNull();
  state = 'merged';
  expect(await select('merged-change')).not.toBeNull();
  head = 'different-head';
  expect(await select('merged-change')).toBeNull();
});

describe('independent named change outputs (DC-17, DC-29)', () => {
  function fixture() {
    const names = ['api', 'web'];
    const heads = new Map(names.map((name) => [name, name + '-head']));
    const sources = names.map((name) => ({
      name,
      branch: name + '-branch',
      path: '/' + name,
      repository: { ...assignment, sourceRef: name + '-source', pullRequestBase: name + '-base' },
      revision: name + '-head',
    }));
    const reports = names.map((name) => ({
      name,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'fake', key: name },
    }));
    const runs = [
      {
        ...run('a1', 'shared-head', false),
        workspace: { mode: 'branch', branch: 'api-branch', changeOutputs: sources },
        changeOutputs: sources,
        outcome: { kind: 'done', data: { reportedArtifacts: reports } },
      },
    ];
    const verifyArtifact = vi.fn(async (_kind, key, source) => {
      const expected = sources.find((entry) => entry.name === key.key);
      return expected !== undefined &&
        source.workspaceBranch === expected.branch &&
        source.workspaceRevision === heads.get(key.key) &&
        source.pullRequestBase === expected.repository.pullRequestBase
        ? { externalKey: key, revision: heads.get(key.key) }
        : 'not-found';
    });
    const decideAuthority = vi.fn(async (_owner, options) => ({
      allowed: true,
      revision: heads.get(options.target.resourceId),
    }));
    const service = createDelegationOutputs({
      artifacts: { qualifyingOutputs: async () => [] },
      resources: {
        get: async () => repository,
        findByExternalKey: async (key: { key: string }) => ({
          ...pullRequest,
          resourceId: key.key,
          externalKey: key,
        }),
        primaryCorrelation: async () => ({
          workItemId: 'child',
          role: ResourceCorrelationRole.Primary,
          provenance: ResourceCorrelationProvenance.AgentReported,
        }),
      },
      pullRequests: {
        get: async (id: string) => ({
          headRevision: heads.get(id),
          baseRevision: id + '-base-head',
          state: 'open',
        }),
        decideAuthority,
      },
      runs: async () => runs,
      providers: async () => [{ adapter: 'fake', verifyArtifact }],
    } as never);
    const outputs = names.map((name) => ({ ...output, name }));
    return { heads, service, runs, sources, outputs, verifyArtifact, decideAuthority };
  }

  it('verifies each output against its own branch, source, base, head and explicit review resource', async () => {
    const f = fixture();
    expect(await f.service.qualifyingOutputs(child as never, f.outputs as never)).toMatchObject([
      {
        name: 'api',
        reference: {
          resourceId: 'api',
          branch: 'api-branch',
          revision: 'api-head',
          pullRequestBase: 'api-base',
        },
      },
      {
        name: 'web',
        reference: {
          resourceId: 'web',
          branch: 'web-branch',
          revision: 'web-head',
          pullRequestBase: 'web-base',
        },
      },
    ]);
    expect(f.decideAuthority.mock.calls.map((call) => call[1].target.resourceId)).toEqual([
      'api',
      'web',
    ]);
    f.heads.set('web', 'stale');
    expect(await f.service.qualifyingOutputs(child as never, f.outputs as never)).toBeNull();
    expect(
      await f.service.prerequisiteOutput!(child as never, f.outputs[0] as never, 'pushed-change'),
    ).toMatchObject({ name: 'api' });
    expect(
      await f.service.prerequisiteOutput!(child as never, f.outputs[1] as never, 'pushed-change'),
    ).toBeNull();
  });

  it('does not borrow another output snapshot or a failed outcome to fill a missing output', async () => {
    const f = fixture();
    f.runs[0]!.changeOutputs = [f.sources[0]!];
    expect(await f.service.qualifyingOutputs(child as never, f.outputs as never)).toBeNull();
    f.runs[0]!.changeOutputs = f.sources;
    for (const outcome of ['failed', 'blocked', 'rejected']) {
      f.runs[0]!.outcome.kind = outcome;
      expect(await f.service.qualifyingOutputs(child as never, f.outputs as never)).toBeNull();
    }
    f.runs[0]!.outcome.kind = 'found';
    expect(await f.service.qualifyingOutputs(child as never, f.outputs as never)).not.toBeNull();
  });

  it('fails closed on duplicate names rather than choosing a reported PR', async () => {
    const f = fixture();
    f.runs[0]!.outcome.data.reportedArtifacts.push({
      ...f.runs[0]!.outcome.data.reportedArtifacts[0]!,
      externalKey: { adapter: 'fake', key: 'other' },
    });
    await expect(f.service.qualifyingOutputs(child as never, f.outputs as never)).rejects.toThrow(
      'Duplicate named change report',
    );
  });
});

it('does not let a missing optional change waive a required change', async () => {
  const f = outputs([run('a1', 'head-1', true)], 'head-1');
  expect(await f.qualify()).not.toBeNull();
  const service = createDelegationOutputs({
    artifacts: { qualifyingOutputs: async () => null },
    runs: async () => [],
    providers: async () => [],
  } as never);
  expect(
    await service.qualifyingOutputs(child as never, [
      { name: 'optional', kind: 'change', required: false },
      { name: 'required', kind: 'change' },
    ]),
  ).toBeNull();
  expect(
    await service.qualifyingOutputs(child as never, [
      { name: 'optional', kind: 'change', required: false },
      { name: 'notes', path: 'notes.md', required: false },
    ]),
  ).toEqual([]);
});
