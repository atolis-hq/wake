import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ProviderPermission,
  ReviewerAuthorizationSource,
} from '../../../../src/activities/index.js';
import { gitHubConfigSchema } from '../../../../src/integrations/github/contracts/config.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import type {
  GitHubIssueCommentPayload,
  GitHubIssuePayload,
  GitHubReviewPayload,
} from '../../../../src/integrations/github/contracts/payloads.js';
import { watermarkCheckpoint } from '../../../../src/integrations/github/infrastructure/poll-watermark.js';
import { createGitHubSource } from '../../../../src/integrations/github/infrastructure/source.js';
import { FileCheckpointStore } from '../../../../src/persistence/index.js';

it('defaults the provider-wide request concurrency limit to four', () => {
  const config = gitHubConfigSchema.parse({
    enabled: true,
    token: 'token',
    repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
  });

  expect(config.polling.maxConcurrent).toBe(4);
});

it('bounds every nested GitHub read to the repository poll limit while retaining latest evidence', async () => {
  const nestedLimits: Array<number | undefined> = [];
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
      polling: { maxPerRepo: 2, commentPageSize: 2 },
    }),
    {
      ...fakeClient({
        issues: [{ ...issue(6, 'A PR'), pull_request: {} }],
        issueComments: { 6: [comment(10, 'latest issue feedback')] },
        reviews: { 6: [review(11, 'APPROVED', 'latest review feedback')] },
        reviewComments: { 6: [comment(12, 'latest inline feedback')] },
      }),
      async listIssueComments(_owner, _repo, issueNumber, _pageSize, _since, maxResults) {
        nestedLimits.push(maxResults);
        return [comment(issueNumber * 100, 'latest issue feedback')];
      },
      async listReviews(_owner, _repo, pullNumber, _pageSize, maxResults) {
        nestedLimits.push(maxResults);
        return [review(pullNumber * 100, 'APPROVED', 'latest review feedback')];
      },
      async listReviewComments(_owner, _repo, pullNumber, _pageSize, maxResults) {
        nestedLimits.push(maxResults);
        return [comment(pullNumber * 100, 'latest inline feedback')];
      },
      async listCheckRunsForRef(_owner, _repo, _ref, maxResults) {
        nestedLimits.push(maxResults);
        return [];
      },
      async getCombinedStatusForRef(_owner, _repo, _ref, maxResults) {
        nestedLimits.push(maxResults);
        return [];
      },
      async listPullRequestFiles(_owner, _repo, _pullNumber, maxResults) {
        nestedLimits.push(maxResults);
        return [];
      },
    },
  );

  const drafts = await source.poll(new AbortController().signal);

  expect(nestedLimits).toEqual([2, 2, 2, 2, 2, 2]);
  expect(drafts).toContainEqual(
    expect.objectContaining({
      eventType: GitHubEventType.CommentObserved,
      payload: expect.objectContaining({ body: 'latest review feedback' }),
    }),
  );
});

it('sends source polling and enrichment calls through the provider request coordinator', async () => {
  let requests = 0;
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [{ ...issue(6, 'A PR'), pull_request: {} }],
      issueComments: {},
    }),
    undefined,
    {
      run: async (operation) => {
        requests += 1;
        return operation();
      },
    },
  );

  await source.poll(new AbortController().signal);

  expect(requests).toBeGreaterThanOrEqual(7);
});

it('polls comments for pull requests, not only pure issues', async () => {
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [issue(5, 'A plain issue'), { ...issue(6, 'A PR'), pull_request: {} }],
      issueComments: {
        5: [comment(1, 'issue comment')],
        6: [comment(2, 'pr comment')],
      },
      reviewComments: {
        6: [
          {
            ...comment(3, 'inline review comment'),
            path: 'src/example.ts',
            line: 42,
            side: 'RIGHT',
          },
        ],
      },
    }),
  );

  const drafts = await source.poll(new AbortController().signal);
  const commentBodies = drafts
    .filter((draft) => draft.eventType === GitHubEventType.CommentObserved)
    .map((draft) => (draft.payload as { readonly body: string }).body);

  expect(commentBodies).toContain('issue comment');
  expect(commentBodies).toContain('pr comment');
  expect(commentBodies).toContain('inline review comment');
  const inlineReview = drafts.find(
    (draft) =>
      draft.eventType === GitHubEventType.CommentObserved &&
      (draft.payload as { readonly body: string }).body === 'inline review comment',
  ) as { readonly payload: unknown } | undefined;
  expect(inlineReview?.payload).toMatchObject({
    location: { path: 'src/example.ts', line: 42, side: 'RIGHT' },
  });
  expect(
    drafts.find(
      (draft) =>
        draft.eventType === GitHubEventType.CommentObserved &&
        (draft.payload as { readonly body: string }).body === 'issue comment',
    )?.payload,
  ).not.toHaveProperty('location');
});

it('emits a submitted COMMENTED review body as formal feedback', async () => {
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [{ ...issue(6, 'A PR'), pull_request: {} }],
      issueComments: {},
      reviews: {
        6: [review(4, 'COMMENTED', 'general review feedback')],
      },
    }),
  );

  const drafts = await source.poll(new AbortController().signal);

  expect(drafts).toContainEqual(
    expect.objectContaining({
      eventType: GitHubEventType.CommentObserved,
      payload: expect.objectContaining({
        reviewKind: 'formal',
        body: 'general review feedback',
      }),
    }),
  );
});

it('keeps an approved review body separate from its acceptance command', async () => {
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [{ ...issue(6, 'A PR'), pull_request: {} }],
      issueComments: {},
      reviews: {
        6: [review(4, 'APPROVED', 'general approval feedback')],
      },
    }),
  );

  const bodies = (await source.poll(new AbortController().signal))
    .filter((draft) => draft.eventType === GitHubEventType.CommentObserved)
    .map((draft) => (draft.payload as { readonly body: string }).body);

  expect(bodies).toEqual(['general approval feedback', '/accepted']);
});

it('attaches collaborator permission evidence to a /retry comment', async () => {
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [issue(5, 'A plain issue')],
      issueComments: { 5: [comment(1, '/retry')] },
      collaboratorPermission: ProviderPermission.Write,
    }),
  );

  const drafts = await source.poll(new AbortController().signal);

  expect(drafts).toContainEqual(
    expect.objectContaining({
      eventType: GitHubEventType.CommentObserved,
      payload: expect.objectContaining({
        body: '/retry',
        authorization: {
          source: ReviewerAuthorizationSource.ProviderPermission,
          permission: ProviderPermission.Write,
        },
      }),
    }),
  );
});

it('keeps issue observations when pull-request review enrichment fails', async () => {
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({
      issues: [issue(5, 'A plain issue'), { ...issue(6, 'A PR'), pull_request: {} }],
      issueComments: {},
      reviewError: new Error('review endpoint unavailable'),
    }),
  );

  const drafts = await source.poll(new AbortController().signal);

  expect(drafts).toContainEqual(
    expect.objectContaining({
      eventType: GitHubEventType.WorkObserved,
      payload: expect.objectContaining({ externalKey: 'atolis-hq/wake-test#5' }),
    }),
  );
});

it('keeps issue comment intake available when the pull-request query fails and preserves its watermark', async () => {
  const saved: Array<readonly [string, number]> = [];
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
      polling: { lookbackMs: 30_000 },
    }),
    fakeClient({
      issues: [issue(630, 'operator resolution')],
      issueComments: { 630: [comment(5309237436, 'CLI + API only')] },
      pullRequestError: new Error('GitHub 500'),
    }),
    undefined,
    undefined,
    {
      checkpoints: {
        async load() {
          return Date.parse('2026-08-16T19:22:00.000Z');
        },
        async save(consumer, position) {
          saved.push([consumer, position]);
        },
        async reset() {},
      },
      now: () => Date.parse('2026-08-16T19:23:00.000Z'),
    },
  );

  const drafts = await source.poll(new AbortController().signal);
  await source.markPollPersisted?.();

  expect(drafts).toContainEqual(
    expect.objectContaining({
      eventType: GitHubEventType.CommentObserved,
      payload: expect.objectContaining({ body: 'CLI + API only' }),
    }),
  );
  expect(saved).toEqual([]);
});

it('uses an overlapping durable watermark only after a complete poll has persisted', async () => {
  const saved: Array<readonly [string, number]> = [];
  const queriedSince: Array<string | undefined> = [];
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
      polling: { lookbackMs: 30_000 },
    }),
    fakeClient({
      issues: [issue(5, 'A plain issue')],
      issueComments: {},
      onListIssues: (since) => queriedSince.push(since),
    }),
    undefined,
    undefined,
    {
      checkpoints: {
        async load() {
          return 0;
        },
        async save(consumer, position) {
          saved.push([consumer, position]);
        },
        async reset() {},
      },
      now: () => Date.parse('2026-08-16T19:23:00.000Z'),
    },
  );

  await source.poll(new AbortController().signal);
  expect(queriedSince).toEqual([undefined]);
  expect(saved).toEqual([]);
  await source.markPollPersisted?.();

  expect(saved).toEqual([
    ['source:github:github:atolis-hq%2Fwake-test', Date.parse('2026-08-16T19:23:00.000Z')],
  ]);
});

it('persists repository watermarks through the filesystem checkpoint store', async () => {
  const checkpoints = new FileCheckpointStore(await mkdtemp(join(tmpdir(), 'wake-checkpoints-')));
  const source = createGitHubSource(
    gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
    }),
    fakeClient({ issues: [issue(5, 'A plain issue')], issueComments: {} }),
    undefined,
    undefined,
    { checkpoints, now: () => Date.parse('2026-08-16T19:23:00.000Z') },
  );

  await source.poll(new AbortController().signal);
  await source.markPollPersisted?.();

  const checkpoint = watermarkCheckpoint(undefined, 'atolis-hq/wake-test');
  expect(checkpoint).not.toContain('/');
  expect(await checkpoints.load(checkpoint)).toBe(Date.parse('2026-08-16T19:23:00.000Z'));
});

function fakeClient(input: {
  readonly issues: readonly ReturnType<typeof issue>[];
  readonly issueComments: Readonly<Record<number, readonly ReturnType<typeof comment>[]>>;
  readonly reviewComments?: Readonly<Record<number, readonly ReturnType<typeof comment>[]>>;
  readonly reviews?: Readonly<Record<number, readonly GitHubReviewPayload[]>>;
  readonly reviewError?: Error;
  readonly pullRequestError?: Error;
  readonly onListIssues?: (since: string | undefined) => void;
  readonly collaboratorPermission?: typeof ProviderPermission.Write;
}) {
  const collaboratorPermission = input.collaboratorPermission;
  return {
    async listIssues(_owner: string, _repo: string, _maxResults: number, since?: string) {
      input.onListIssues?.(since);
      return input.issues;
    },
    async listPullRequests() {
      if (input.pullRequestError !== undefined) throw input.pullRequestError;
      return input.issues as never;
    },
    async listIssueComments(_owner: string, _repo: string, issueNumber: number) {
      return input.issueComments[issueNumber] ?? [];
    },
    async listReviews(_owner: string, _repo: string, pullNumber: number) {
      if (input.reviewError !== undefined) throw input.reviewError;
      return input.reviews?.[pullNumber] ?? [];
    },
    async listReviewComments(_owner: string, _repo: string, pullNumber: number) {
      return input.reviewComments?.[pullNumber] ?? [];
    },
    ...(collaboratorPermission === undefined
      ? {}
      : {
          async collaboratorPermission() {
            return collaboratorPermission;
          },
        }),
    async listCheckRunsForRef() {
      return [];
    },
    async getCombinedStatusForRef() {
      return [];
    },
    async listPullRequestFiles() {
      return [];
    },
  };
}

function issue(number: number, title: string): GitHubIssuePayload {
  return {
    number,
    title,
    body: '',
    state: 'open' as const,
    updated_at: '2026-08-08T00:00:00Z',
    user: { login: 'a', type: 'User' },
  };
}

function comment(id: number, body: string): GitHubIssueCommentPayload {
  return {
    id,
    body,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    user: { login: 'a', type: 'User' },
  };
}

function review(id: number, state: string, body: string): GitHubReviewPayload {
  return {
    id,
    state,
    body,
    commit_id: 'head-a',
    submitted_at: '2026-08-08T00:00:00Z',
    user: { login: 'a', type: 'User' },
  };
}
