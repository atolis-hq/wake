import { describe, expect, it, vi } from 'vitest';
import { BuiltInActivityName, MergeMethod } from '../../../src/activities/index.js';
import { gitHubProviderDefinition } from '../../../src/integrations/github/provider.js';
import { InMemoryEventJournal, InMemoryProjectionStore } from '../../../src/persistence/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  createResourceLookup,
  createResourceService,
} from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

const octokit = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getPullRequest: vi.fn(),
  graphql: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    readonly rest = {
      issues: { get: octokit.getIssue },
      pulls: { get: octokit.getPullRequest },
    };

    graphql = octokit.graphql;
    constructor(_options: unknown) {}
  },
}));

const mergeIntent = {
  intentEventId: 'intent' as never,
  globalPosition: 1,
  workflowInstanceId: 'workflow-1',
  activationId: 'activation-1',
  kind: BuiltInActivityName.PullRequestMerge,
  resourceId: resId('target-pr'),
  payload: {
    kind: BuiltInActivityName.PullRequestMerge,
    revision: 'abc',
    method: MergeMethod.Squash,
    autoMerge: true,
  },
  state: 'pending',
  attempts: 0,
  occurrenceOrdinal: 0,
} as const;

describe('GitHub provider auto-merge security precondition', () => {
  it.each([
    ['security on the target pull request', ['security'], [] as readonly string[], 'security-pr'],
    ['security on the correlated issue', [], ['security'] as readonly string[], 'security-issue'],
  ])(
    'fails closed for %s using uncached issues.get reads',
    async (_name, prLabels, issueLabels, reason) => {
      const provider = await composeProvider({ prLabels, issueLabels });

      await expect(
        provider.delivery.deliver(mergeIntent, new AbortController().signal),
      ).resolves.toMatchObject({
        kind: 'failed',
        message: reason,
      });
      expect(octokit.getIssue).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 17,
      });
      expect(octokit.getIssue).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 42,
      });
      expect(octokit.getPullRequest).not.toHaveBeenCalled();
    },
  );

  it('ignores a non-issue correlated resource and permits auto-merge when fresh labels are absent', async () => {
    const provider = await composeProvider({
      prLabels: [],
      issueLabels: [],
      includeRepository: true,
    });

    await expect(
      provider.delivery.deliver(mergeIntent, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'confirmed',
      externalId: 'node-17',
    });
    expect(octokit.getIssue).toHaveBeenCalledTimes(2);
    expect(octokit.getIssue).toHaveBeenNthCalledWith(1, {
      owner: 'org',
      repo: 'repo',
      issue_number: 17,
    });
    expect(octokit.getIssue).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      issue_number: 42,
    });
  });

  it('reads only the primary-correlated issue when a secondary issue carries security', async () => {
    const provider = await composeProvider({
      prLabels: [],
      issueLabels: [],
      secondaryIssueLabels: ['security'],
    });

    await expect(
      provider.delivery.deliver(mergeIntent, new AbortController().signal),
    ).resolves.toMatchObject({ kind: 'confirmed', externalId: 'node-17' });
    expect(octokit.getIssue).toHaveBeenCalledTimes(2);
    expect(octokit.getIssue).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      issue_number: 42,
    });
    expect(octokit.getIssue).not.toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      issue_number: 43,
    });
  });

  it('fails closed when the target pull request has no primary correlation', async () => {
    const provider = await composeProvider({
      prLabels: [],
      issueLabels: [],
      correlateTarget: false,
    });

    await expect(
      provider.delivery.deliver(mergeIntent, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'failed',
      message: 'correlation-incomplete',
    });
    expect(octokit.getIssue).not.toHaveBeenCalled();
  });

  it('fails closed when multiple primary-correlated issues exist', async () => {
    const provider = await composeProvider({
      prLabels: [],
      issueLabels: [],
      extraPrimaryIssue: true,
    });

    await expect(
      provider.delivery.deliver(mergeIntent, new AbortController().signal),
    ).resolves.toMatchObject({ kind: 'failed', message: 'correlation-incomplete' });
    expect(octokit.getIssue).not.toHaveBeenCalled();
  });

  it('fails closed when a fresh label lookup fails', async () => {
    const provider = await composeProvider({ prLabels: [], issueLabels: [] });
    octokit.getIssue.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      provider.delivery.deliver(mergeIntent, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'failed',
      message: 'lookup-unavailable',
    });
  });
});

async function composeProvider(input: {
  readonly prLabels: readonly string[];
  readonly issueLabels: readonly string[];
  readonly secondaryIssueLabels?: readonly string[];
  readonly extraPrimaryIssue?: boolean;
  readonly includeRepository?: boolean;
  readonly correlateTarget?: boolean;
}) {
  vi.clearAllMocks();
  octokit.getIssue.mockImplementation(
    async ({ issue_number }: { readonly issue_number: number }) => ({
      data: {
        labels:
          issue_number === 17
            ? input.prLabels.map((name) => ({ name }))
            : (issue_number === 42 ? input.issueLabels : (input.secondaryIssueLabels ?? [])).map(
                (name) => ({ name }),
              ),
      },
    }),
  );
  octokit.getPullRequest.mockResolvedValue({ data: { node_id: 'node-17' } });
  octokit.graphql.mockResolvedValue({
    enablePullRequestAutoMerge: { pullRequest: { id: 'node-17' } },
  });

  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const lookup = createResourceLookup({ journal, projections: new InMemoryProjectionStore() });
  const resources = createResourceService(journal, lookup);
  const work = createWorkService(journal);
  let command = 0;
  const context = () => ({
    commandId: `setup-${++command}`,
    correlationId: 'setup' as never,
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  });
  const item = workId('security-merge');
  await work.create({ workItemId: item, objective: 'Security merge test' }, context());
  await resources.discover(
    {
      resourceId: mergeIntent.resourceId,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'github', key: 'org/repo#17' },
      capabilities: [],
    },
    context(),
  );
  if (input.secondaryIssueLabels !== undefined)
    await resources.discover(
      {
        resourceId: resId('secondary-issue'),
        kind: BuiltInResourceKind.Issue,
        externalKey: { adapter: 'github', key: 'org/repo#43' },
        capabilities: [],
      },
      context(),
    );
  if (input.extraPrimaryIssue)
    await resources.discover(
      {
        resourceId: resId('extra-primary-issue'),
        kind: BuiltInResourceKind.Issue,
        externalKey: { adapter: 'github', key: 'org/repo#44' },
        capabilities: [],
      },
      context(),
    );
  await resources.discover(
    {
      resourceId: resId('primary-issue'),
      kind: BuiltInResourceKind.Issue,
      externalKey: { adapter: 'github', key: 'org/repo#42' },
      capabilities: [],
    },
    context(),
  );
  if (input.includeRepository)
    await resources.discover(
      {
        resourceId: resId('unrelated-repository'),
        kind: BuiltInResourceKind.Repository,
        externalKey: { adapter: 'github', key: 'org/repo' },
        capabilities: [],
      },
      context(),
    );
  if (input.correlateTarget !== false)
    await resources.correlate(
      mergeIntent.resourceId,
      item,
      ResourceCorrelationRole.Primary,
      context(),
    );
  await resources.correlate(
    resId('primary-issue'),
    item,
    ResourceCorrelationRole.Primary,
    context(),
  );
  if (input.secondaryIssueLabels !== undefined)
    await resources.correlate(
      resId('secondary-issue'),
      item,
      ResourceCorrelationRole.Secondary,
      context(),
    );
  if (input.extraPrimaryIssue)
    await resources.correlate(
      resId('extra-primary-issue'),
      item,
      ResourceCorrelationRole.Primary,
      context(),
    );
  if (input.includeRepository)
    await resources.correlate(
      resId('unrelated-repository'),
      item,
      ResourceCorrelationRole.Secondary,
      context(),
    );

  return gitHubProviderDefinition.create({
    adapter: 'github' as never,
    config: gitHubProviderDefinition.parseConfig({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'org', repo: 'repo' }],
    }),
    services: { resources, work, journal, clock } as never,
  });
}
