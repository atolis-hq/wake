import { expect, it } from 'vitest';
import { createPullRequestService } from '../../../src-next/activities/index.js';
import {
  GitHubEventType,
  InboundTranslator,
  createGitHubSource,
  createGitHubWakeLabelReconciler,
  gitHubConfigSchema,
  isGitHubWakeEcho,
  reconcileGitHubWakeLabels,
} from '../../../src-next/integrations/github/index.js';
import { PollService } from '../../../src-next/integrations/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src-next/persistence/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  createResourceLookup,
  createResourceService,
} from '../../../src-next/resources/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

it('validates GitHub polling configuration and isolates a failed repository', async () => {
  const config = gitHubConfigSchema.parse({
    enabled: true,
    token: 'token',
    repositories: [
      { owner: 'bad', repo: 'repo' },
      { owner: 'good', repo: 'repo' },
    ],
  });
  const source = createGitHubSource(config, {
    async listIssues(owner) {
      if (owner === 'bad') throw new Error('unavailable');
      return [
        {
          number: 7,
          title: 'issue',
          body: null,
          state: 'open',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ];
    },
    async listPullRequests() {
      return [];
    },
    async listReviews() {
      return [];
    },
    async listCheckRunsForRef() {
      return [];
    },
    async getCombinedStatusForRef() {
      return [];
    },
  });

  await expect(source.poll(new AbortController().signal)).resolves.toHaveLength(1);
  expect(() => gitHubConfigSchema.parse({ enabled: true, token: 'x', repositories: [] })).toThrow();
});

it('replaces only Wake-owned label families while preserving user labels', () => {
  expect(
    reconcileGitHubWakeLabels(
      ['bug', 'team:platform', 'wake:status.working', 'wake:stage.implement'],
      ['wake:status.waiting', 'wake:workflow.default'],
    ),
  ).toEqual(['bug', 'team:platform', 'wake:status.waiting', 'wake:workflow.default']);
});

it('suppresses Wake-authored comments and Wake-owned labels as provider echoes', () => {
  expect(
    isGitHubWakeEcho({
      authorLogin: 'wake-bot',
      authenticatedLogin: 'wake-bot',
      body: 'Status update',
      labels: ['bug'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: '<!-- wake:agent -->\nDone',
      labels: ['bug'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: 'Human update',
      labels: ['wake:status.working'],
    }),
  ).toBe(true);
  expect(
    isGitHubWakeEcho({
      authorLogin: 'maintainer',
      authenticatedLogin: 'wake-bot',
      body: 'Human update',
      labels: ['bug'],
    }),
  ).toBe(false);
});

it('polls pull request reviews into comment-observed review signals', async () => {
  const config = gitHubConfigSchema.parse({
    enabled: true,
    token: 'token',
    repositories: [{ owner: 'org', repo: 'repo' }],
  });
  const source = createGitHubSource(config, {
    async listIssues() {
      return [];
    },
    async listPullRequests() {
      return [
        {
          number: 7,
          title: 'PR',
          body: null,
          state: 'open',
          updated_at: '2026-08-01T00:00:00.000Z',
          head: { sha: 'head-a' },
          base: { sha: 'base-a' },
          user: { login: 'author', type: 'User' },
        },
      ];
    },
    async listReviews() {
      return [
        {
          id: 101,
          state: 'APPROVED',
          body: null,
          commit_id: 'head-a',
          submitted_at: '2026-08-01T00:01:00.000Z',
          user: { login: 'reviewer', type: 'User' },
        },
      ];
    },
    async listCheckRunsForRef() {
      return [];
    },
    async getCombinedStatusForRef() {
      return [];
    },
  });
  const events = await source.poll(new AbortController().signal);
  expect(events.map((event) => event.eventType)).toContain('integration.github.comment-observed');
  expect(
    events.find((event) => event.eventType === 'integration.github.comment-observed'),
  ).toMatchObject({
    payload: {
      externalKey: 'org/repo#7',
      body: '/accepted',
      revision: 'head-a',
      reviewKind: 'formal',
    },
  });
});

it('flows a tracked PR review from GitHub source polling through Activities acceptance', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  const lookup = createResourceLookup({ journal, projections: new InMemoryProjectionStore() });
  const resources = createResourceService(journal, lookup);
  const work = createWorkService(journal);
  const pullRequests = createPullRequestService(journal, work, resources);
  const workItem = workId('github-source-review-work');
  const resource = resId('github-source-review-resource');
  const context = {
    commandId: 'setup',
    correlationId: 'setup' as never,
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'integration' as const, id: 'github' },
  };
  await work.create({ workItemId: workItem, objective: 'Review a tracked PR' }, context);
  await resources.discover(
    {
      resourceId: resource,
      kind: BuiltInResourceKind.PullRequest,
      externalKey: { adapter: 'github', key: 'org/repo#7' },
      capabilities: [
        BuiltInResourceCapability.Commentable,
        BuiltInResourceCapability.Reviewable,
        BuiltInResourceCapability.Revisioned,
      ],
      revision: 'head-a',
    },
    context,
  );
  await resources.correlate(resource, workItem, ResourceCorrelationRole.Primary, context);

  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'org', repo: 'repo' }],
    }),
    {
      async listIssues() {
        return [];
      },
      async listPullRequests() {
        return [
          {
            number: 7,
            title: 'PR',
            body: null,
            state: 'open',
            updated_at: clock.now().toISOString(),
            head: { sha: 'head-a' },
            base: { sha: 'base-a' },
            user: { login: 'author', type: 'User' },
          },
        ];
      },
      async listReviews() {
        return [
          {
            id: 101,
            state: 'APPROVED',
            body: null,
            commit_id: 'head-a',
            submitted_at: clock.now().toISOString(),
            user: { login: 'reviewer', type: 'User' },
          },
        ];
      },
      async listCheckRunsForRef() {
        return [];
      },
      async getCombinedStatusForRef() {
        return [];
      },
    },
  );
  await new PollService(journal, {
    adapter: 'github' as never,
    eventTypes: Object.values(GitHubEventType),
    source,
    delivery: {} as never,
    inbound: {} as never,
    verifyArtifact: async () => 'not-found' as const,
  }).pollOnce(new AbortController().signal);
  await new InboundTranslator(journal, checkpoints, work, resources, {
    pullRequests,
    lookup,
  }).runOnce();

  expect((await journal.readAll(0)).map((event) => event.eventType)).toContain(
    'pr.review-accepted',
  );
});

it('reconciles target workflow markers to correlated GitHub resources without rewriting user labels', async () => {
  const published: Array<{
    owner: string;
    repo: string;
    number: number;
    labels: readonly string[];
  }> = [];
  const reconciler = createGitHubWakeLabelReconciler({
    orchestration: {
      async listAll() {
        return [
          {
            workflowInstanceId: 'workflow-1',
            workItemId: workId('label-work'),
            workflowName: 'review',
            orchestrationGroupId: 'group-1',
            status: 'waiting',
            currentStage: 'await-review',
          },
        ] as never;
      },
    },
    resources: {
      async correlationsForWork() {
        return [{ resourceId: resId('label-resource') }] as never;
      },
      async get() {
        return { externalKey: { adapter: 'github', key: 'org/repo#42' } } as never;
      },
    },
    async getLabels() {
      return ['bug', 'wake:status.working', 'wake:stage.implement'];
    },
    async setLabels(owner, repo, number, labels) {
      published.push({ owner, repo, number, labels });
    },
  });

  await reconciler.runOnce();
  expect(published).toEqual([
    {
      owner: 'org',
      repo: 'repo',
      number: 42,
      labels: [
        'bug',
        'wake:status.awaiting-approval',
        'wake:stage.await-review',
        'wake:workflow.review',
      ],
    },
  ]);
});
