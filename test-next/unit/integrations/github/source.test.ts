import { expect, it } from 'vitest';
import { gitHubConfigSchema } from '../../../../src-next/integrations/github/contracts/config.js';
import { GitHubEventType } from '../../../../src-next/integrations/github/contracts/events.js';
import type { GitHubIssuePayload } from '../../../../src-next/integrations/github/contracts/payloads.js';
import { createGitHubSource } from '../../../../src-next/integrations/github/infrastructure/source.js';

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
    }),
  );

  const drafts = await source.poll(new AbortController().signal);
  const commentBodies = drafts
    .filter((draft) => draft.eventType === GitHubEventType.CommentObserved)
    .map((draft) => (draft.payload as { readonly body: string }).body);

  expect(commentBodies).toContain('issue comment');
  expect(commentBodies).toContain('pr comment');
});

function fakeClient(input: {
  readonly issues: readonly ReturnType<typeof issue>[];
  readonly issueComments: Readonly<Record<number, readonly ReturnType<typeof comment>[]>>;
}) {
  return {
    async listIssues() {
      return input.issues;
    },
    async listPullRequests() {
      return [];
    },
    async listIssueComments(_owner: string, _repo: string, issueNumber: number) {
      return input.issueComments[issueNumber] ?? [];
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

function comment(id: number, body: string) {
  return {
    id,
    body,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    user: { login: 'a', type: 'User' },
  };
}
