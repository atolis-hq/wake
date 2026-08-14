import { expect, it } from 'vitest';
import { gitHubConfigSchema } from '../../../../src/integrations/github/contracts/config.js';
import { GitHubEventType } from '../../../../src/integrations/github/contracts/events.js';
import type {
  GitHubIssueCommentPayload,
  GitHubIssuePayload,
  GitHubReviewPayload,
} from '../../../../src/integrations/github/contracts/payloads.js';
import { createGitHubSource } from '../../../../src/integrations/github/infrastructure/source.js';

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

function fakeClient(input: {
  readonly issues: readonly ReturnType<typeof issue>[];
  readonly issueComments: Readonly<Record<number, readonly ReturnType<typeof comment>[]>>;
  readonly reviewComments?: Readonly<Record<number, readonly ReturnType<typeof comment>[]>>;
  readonly reviews?: Readonly<Record<number, readonly GitHubReviewPayload[]>>;
}) {
  return {
    async listIssues() {
      return input.issues;
    },
    async listPullRequests() {
      return input.issues as never;
    },
    async listIssueComments(_owner: string, _repo: string, issueNumber: number) {
      return input.issueComments[issueNumber] ?? [];
    },
    async listReviews(_owner: string, _repo: string, pullNumber: number) {
      return input.reviews?.[pullNumber] ?? [];
    },
    async listReviewComments(_owner: string, _repo: string, pullNumber: number) {
      return input.reviewComments?.[pullNumber] ?? [];
    },
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
