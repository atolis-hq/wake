import { beforeEach, describe, expect, it, vi } from 'vitest';

const paginateIterator = vi.fn();
const paginate = Object.assign(vi.fn(), { iterator: paginateIterator });

const setLabels = vi.fn();
const getPull = vi.fn();
const listPulls = vi.fn();
const listReviews = vi.fn();
const listReviewComments = vi.fn();
const createReplyForReviewComment = vi.fn();
const getAuthenticated = vi.fn();
const getBranch = vi.fn();
const listCheckRunsForRef = vi.fn();
const getCombinedStatusForRef = vi.fn();

function pagesOf(...pages: unknown[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const data of pages) {
        yield { data };
      }
    },
  };
}

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    paginate,
    rest: {
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
        setLabels,
      },
      pulls: {
        get: getPull,
        list: listPulls,
        listReviews,
        listReviewComments,
        createReplyForReviewComment,
      },
      repos: {
        getBranch,
        getCombinedStatusForRef,
      },
      checks: {
        listForRef: listCheckRunsForRef,
      },
      users: {
        getAuthenticated,
      },
    },
  })),
}));

describe('github client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through GitHub issues API results, including pull requests', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf([
        { number: 5, title: 'A real issue' },
        { number: 6, title: 'An open PR', pull_request: { url: 'https://example.test/pulls/6' } },
      ]),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues('atolis-hq', 'wake', 25, '2026-07-11T11:00:00.000Z');

    expect(issues).toHaveLength(2);
    expect(issues[0]?.number).toBe(5);
    expect(issues[1]?.number).toBe(6);
    expect(issues[1]).toHaveProperty('pull_request');
    expect(paginateIterator).toHaveBeenCalledWith(expect.anything(), {
      owner: 'atolis-hq',
      repo: 'wake',
      state: 'all',
      per_page: 25,
      since: '2026-07-11T11:00:00.000Z',
    });
  });

  it('stops paginating once maxResults is reached instead of walking every page (E4)', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf(
        [{ number: 1 }, { number: 2 }],
        [{ number: 3 }, { number: 4 }],
        [{ number: 5 }, { number: 6 }],
      ),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const issues = await client.listIssues('atolis-hq', 'wake', 3);

    expect(issues.map((issue) => (issue as { number: number }).number)).toEqual([1, 2, 3]);
    expect(paginateIterator).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        per_page: 3,
      }),
    );
  });

  it('replaces issue labels via the dedicated setLabels endpoint', async () => {
    setLabels.mockResolvedValueOnce({ data: [] });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    await client.setLabels('atolis-hq', 'wake', 74, [
      'bug',
      'wake:status.working',
      'wake:stage.active',
    ]);

    expect(setLabels).toHaveBeenCalledOnce();
    expect(setLabels).toHaveBeenCalledWith({
      owner: 'atolis-hq',
      repo: 'wake',
      issue_number: 74,
      labels: ['bug', 'wake:status.working', 'wake:stage.active'],
    });
  });

  it('fetches a single PR by number', async () => {
    getPull.mockResolvedValueOnce({
      data: {
        number: 91,
        html_url: 'https://github.com/org/repo/pull/91',
        head: { ref: 'wake/issue-82', sha: 'abc123' },
        user: { login: 'eddy-bot' },
        state: 'open',
      },
    });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const pr = await client.getPullRequest('org', 'repo', 91);

    expect(getPull).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
    });
    expect(pr.number).toBe(91);
    expect(pr.head.ref).toBe('wake/issue-82');
  });

  it('lists pull requests with pagination stopping at maxResults', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf(
        [
          { number: 1, title: 'PR 1' },
          { number: 2, title: 'PR 2' },
        ],
        [
          { number: 3, title: 'PR 3' },
          { number: 4, title: 'PR 4' },
        ],
      ),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const prs = await client.listPullRequests('org', 'repo', 3);

    expect(prs).toHaveLength(3);
    expect((prs[0] as { number: number }).number).toBe(1);
    expect((prs[2] as { number: number }).number).toBe(3);
    expect(paginateIterator).toHaveBeenCalledWith(expect.anything(), {
      owner: 'org',
      repo: 'repo',
      state: 'open',
      per_page: 3,
    });
  });

  it('lists reviews for a pull request', async () => {
    paginate.mockResolvedValueOnce([
      { id: 1, state: 'APPROVED' },
      { id: 2, state: 'REQUESTED_CHANGES' },
    ]);

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const reviews = await client.listReviews('org', 'repo', 91, 30);

    expect(paginate).toHaveBeenCalledWith(listReviews, {
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
      per_page: 30,
    });
    expect(reviews).toHaveLength(2);
  });

  it('lists review comments for a pull request', async () => {
    paginate.mockResolvedValueOnce([
      { id: 100, body: 'Comment 1' },
      { id: 101, body: 'Comment 2' },
    ]);

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const comments = await client.listReviewComments('org', 'repo', 91, 30);

    expect(paginate).toHaveBeenCalledWith(listReviewComments, {
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
      per_page: 30,
    });
    expect(comments).toHaveLength(2);
  });

  it('replies to a review comment', async () => {
    createReplyForReviewComment.mockResolvedValueOnce({
      data: { id: 102, body: 'Reply to comment' },
    });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const reply = await client.replyToReviewComment('org', 'repo', 91, 100, 'Reply to comment');

    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
      comment_id: 100,
      body: 'Reply to comment',
    });
    expect(reply.data.id).toBe(102);
  });

  it('resolves the authenticated login', async () => {
    getAuthenticated.mockResolvedValueOnce({ data: { login: 'atolis-hq-agent' } });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const login = await client.getAuthenticatedLogin();

    expect(login).toBe('atolis-hq-agent');
  });

  it('fetches required status check contexts from the base branch', async () => {
    getBranch.mockResolvedValueOnce({
      data: {
        protection: {
          required_status_checks: {
            contexts: ['lint'],
            checks: [{ context: 'test' }],
          },
        },
      },
    });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const required = await client.getRequiredStatusChecks('org', 'repo', 'main');

    expect(getBranch).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      branch: 'main',
    });
    expect(required).toEqual({ contexts: ['lint'], checks: ['test'] });
  });

  it('lists check runs for a ref', async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: { check_runs: [{ id: 1, name: 'test' }] },
    });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const runs = await client.listCheckRunsForRef('org', 'repo', 'abc123');

    expect(listCheckRunsForRef).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      per_page: 100,
    });
    expect(runs).toEqual([{ id: 1, name: 'test' }]);
  });

  it('fetches combined statuses for a ref', async () => {
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { statuses: [{ context: 'lint', state: 'failure' }] },
    });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const statuses = await client.getCombinedStatusForRef('org', 'repo', 'abc123');

    expect(getCombinedStatusForRef).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
    });
    expect(statuses).toEqual([{ context: 'lint', state: 'failure' }]);
  });

  it('sends If-None-Match on a repeat listCheckRunsForRef call and reuses cached data on 304', async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: { check_runs: [{ id: 1, name: 'test' }] },
      headers: { etag: '"runs-v1"' },
    });
    listCheckRunsForRef.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.listCheckRunsForRef('org', 'repo', 'abc123');
    const second = await client.listCheckRunsForRef('org', 'repo', 'abc123');

    expect(listCheckRunsForRef).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      per_page: 100,
      headers: { 'if-none-match': '"runs-v1"' },
    });
    expect(second).toEqual(first);
  });

  it('sends If-None-Match on a repeat getCombinedStatusForRef call and reuses cached data on 304', async () => {
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { statuses: [{ context: 'lint', state: 'failure' }] },
      headers: { etag: '"status-v1"' },
    });
    getCombinedStatusForRef.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.getCombinedStatusForRef('org', 'repo', 'abc123');
    const second = await client.getCombinedStatusForRef('org', 'repo', 'abc123');

    expect(getCombinedStatusForRef).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      headers: { 'if-none-match': '"status-v1"' },
    });
    expect(second).toEqual(first);
  });

  it('sends If-None-Match on a repeat getRequiredStatusChecks call and reuses cached data on 304', async () => {
    getBranch.mockResolvedValueOnce({
      data: {
        protection: { required_status_checks: { contexts: ['lint'], checks: [] } },
      },
      headers: { etag: '"branch-v1"' },
    });
    getBranch.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.getRequiredStatusChecks('org', 'repo', 'main');
    const second = await client.getRequiredStatusChecks('org', 'repo', 'main');

    expect(getBranch).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      branch: 'main',
      headers: { 'if-none-match': '"branch-v1"' },
    });
    expect(second).toEqual(first);
  });
});
