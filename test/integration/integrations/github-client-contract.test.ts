import { beforeEach, describe, expect, it, vi } from 'vitest';

const octokit = vi.hoisted(() => ({
  constructor: vi.fn(),
  paginateIterator: vi.fn(),
  listIssues: vi.fn(),
  getAuthenticated: vi.fn(),
  createComment: vi.fn(),
  merge: vi.fn(),
  getPullRequest: vi.fn(),
  graphql: vi.fn(),
  getIssue: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function (options: unknown) {
    octokit.constructor(options);
    return {
      paginate: Object.assign(vi.fn(), { iterator: octokit.paginateIterator }),
      rest: {
        users: { getAuthenticated: octokit.getAuthenticated },
        issues: {
          listForRepo: octokit.listIssues,
          createComment: octokit.createComment,
          get: octokit.getIssue,
        },
        pulls: { get: octokit.getPullRequest, merge: octokit.merge },
      },
      graphql: octokit.graphql,
    };
  }),
}));

import { MergeMethod } from '../../../src/activities/index.js';
import * as GitHubClient from '../../../src/integrations/github/infrastructure/bounded-fetch.js';
import { createGitHubClient } from '../../../src/integrations/github/infrastructure/client.js';

describe('GitHub client transport contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads auto-merge labels directly without the ETag cache', async () => {
    octokit.getIssue.mockResolvedValue({ data: { labels: [{ name: 'security' }] } });
    const client = createGitHubClient('token');
    await expect(client.getIssueLabelsFresh('owner', 'repo', 7)).resolves.toEqual(['security']);
    expect(octokit.getIssue).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 7,
    });
    expect(octokit.paginateIterator).not.toHaveBeenCalled();
  });

  it('configures the supplied token and propagates authentication failure', async () => {
    octokit.getAuthenticated.mockRejectedValueOnce(
      Object.assign(new Error('bad credentials'), { status: 401 }),
    );
    const client = createGitHubClient('ghp_configured_token');

    await expect(client.authenticatedLogin()).rejects.toMatchObject({
      message: 'bad credentials',
      status: 401,
    });
    expect(octokit.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'ghp_configured_token' }),
    );
  });

  it('installs a bounded fetch before Octokit decodes provider responses', () => {
    createGitHubClient('token');

    expect(octokit.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ fetch: expect.any(Function) }),
      }),
    );
  });

  it('rejects an unknown-length response that exceeds the configured byte cap before decoding', async () => {
    const factory = (
      GitHubClient as unknown as {
        readonly createBoundedGitHubFetch?: unknown;
      }
    ).createBoundedGitHubFetch;

    expect(factory).toBeTypeOf('function');
    if (typeof factory !== 'function') return;
    const boundedFetch = factory as (
      fetch: typeof globalThis.fetch,
      maximumResponseBytes: number,
    ) => typeof globalThis.fetch;
    const fetch = boundedFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('abcdefgh'));
              controller.enqueue(new TextEncoder().encode('i'));
              controller.close();
            },
          }),
        ),
      8,
    );

    const response = await fetch('https://api.github.test/repos/owner/repo/issues');
    await expect(response.text()).rejects.toMatchObject({ name: 'GitHubResponseTooLargeError' });
  });

  it('paginates a bounded issue read and conditionally reuses its ETag cache', async () => {
    const requests: unknown[] = [];
    octokit.paginateIterator.mockImplementation((_endpoint, request) => {
      requests.push(request);
      if (requests.length === 1)
        return pagesOf({ data: [issue(1), issue(2)], headers: { etag: '"issues-v1"' } });
      return notModifiedPages();
    });
    const client = createGitHubClient('token');

    await expect(client.listIssues('owner', 'repo', 1)).resolves.toEqual([issue(1)]);
    await expect(client.listIssues('owner', 'repo', 1)).resolves.toEqual([issue(1)]);

    expect(requests).toEqual([
      {
        owner: 'owner',
        repo: 'repo',
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 1,
      },
      {
        owner: 'owner',
        repo: 'repo',
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 1,
        headers: { 'if-none-match': '"issues-v1"' },
      },
    ]);
  });

  it('passes a durable watermark query to GitHub without reusing the bootstrap cache', async () => {
    const requests: unknown[] = [];
    octokit.paginateIterator.mockImplementation((_endpoint, request) => {
      requests.push(request);
      return pagesOf({ data: [issue(1)], headers: { etag: '"issues-v1"' } });
    });
    const client = createGitHubClient('token');

    await client.listIssues('owner', 'repo', 1);
    await client.listIssues('owner', 'repo', 1, '2026-08-16T19:22:00.000Z');

    expect(requests[1]).toMatchObject({ since: '2026-08-16T19:22:00.000Z' });
    expect(requests[1]).not.toHaveProperty('headers');
  });

  it('sends exact merge and comment requests with the durable delivery key marker', async () => {
    octokit.merge.mockResolvedValueOnce({ data: { sha: 'merged-sha' } });
    octokit.createComment.mockResolvedValueOnce({ data: { id: 42 } });
    const client = createGitHubClient('token');

    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        pull_number: 7,
        action: MergeMethod.Merge,
        merge_method: MergeMethod.Squash,
        idempotencyKey: 'delivery-merge-7',
      }),
    ).resolves.toBe('merged-sha');
    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        issue_number: 8,
        action: 'reply',
        body: 'Finished.',
        idempotencyKey: 'delivery-comment-8',
      }),
    ).resolves.toBe('42');

    expect(octokit.merge).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
      merge_method: MergeMethod.Squash,
    });
    expect(octokit.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 8,
      body: 'Finished.\n<!-- wake:delivery:delivery-comment-8 -->',
    });
  });

  it('propagates an outbound GitHub failure unchanged', async () => {
    octokit.createComment.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const client = createGitHubClient('token');

    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        issue_number: 8,
        action: 'reply',
        idempotencyKey: 'delivery-comment-8',
      }),
    ).rejects.toMatchObject({ message: 'rate limited', status: 429 });
  });

  it('enables native auto-merge using the pull request node id and selected method', async () => {
    octokit.getPullRequest.mockResolvedValueOnce({ data: { node_id: 'PR_node_7' } });
    octokit.graphql.mockResolvedValueOnce({
      enablePullRequestAutoMerge: { pullRequest: { id: 'PR_node_7' } },
    });
    const client = createGitHubClient('token');

    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        pull_number: 7,
        action: 'enable-auto-merge',
        merge_method: MergeMethod.Squash,
        idempotencyKey: 'delivery-auto-merge-7',
      }),
    ).resolves.toBe('PR_node_7');

    expect(octokit.getPullRequest).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
    });
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('enablePullRequestAutoMerge'),
      { pullRequestId: 'PR_node_7', mergeMethod: 'SQUASH' },
    );
    expect(octokit.merge).not.toHaveBeenCalled();
  });

  it('falls back to direct merge only when GitHub reports an already-clean pull request', async () => {
    octokit.getPullRequest.mockResolvedValueOnce({ data: { node_id: 'PR_node_7' } });
    octokit.graphql.mockRejectedValueOnce(new Error('Pull request is in clean status'));
    octokit.merge.mockResolvedValueOnce({ data: { sha: 'merged-sha' } });
    const client = createGitHubClient('token');

    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        pull_number: 7,
        action: 'enable-auto-merge',
        merge_method: MergeMethod.Squash,
        idempotencyKey: 'delivery-auto-merge-7',
      }),
    ).resolves.toBe('merged-sha');

    expect(octokit.merge).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
      merge_method: MergeMethod.Squash,
    });
  });

  it('does not fall back to direct merge for other auto-merge failures', async () => {
    octokit.getPullRequest.mockResolvedValueOnce({ data: { node_id: 'PR_node_7' } });
    octokit.graphql.mockRejectedValueOnce(new Error('Auto-merge is disabled for this repository'));
    const client = createGitHubClient('token');

    await expect(
      client.deliver({
        owner: 'owner',
        repo: 'repo',
        pull_number: 7,
        action: 'enable-auto-merge',
        merge_method: MergeMethod.Squash,
        idempotencyKey: 'delivery-auto-merge-7',
      }),
    ).rejects.toThrow('Auto-merge is disabled for this repository');
    expect(octokit.merge).not.toHaveBeenCalled();
  });
});

function issue(number: number) {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    updated_at: '2026-08-11T00:00:00.000Z',
  };
}

function pagesOf(
  ...pages: readonly {
    readonly data: readonly ReturnType<typeof issue>[];
    readonly headers?: Record<string, string>;
  }[]
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) yield page;
    },
  };
}

function notModifiedPages() {
  return {
    // eslint-disable-next-line require-yield -- a conditional GitHub read can reject before yielding a page
    async *[Symbol.asyncIterator]() {
      throw Object.assign(new Error('not modified'), { status: 304 });
    },
  };
}
