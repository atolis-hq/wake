import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createGitHubPullRequestActivitySource } from '../../src/adapters/github/github-pull-request-activity-source.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('createGitHubPullRequestActivitySource', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-github-pr-activity-source-'));
  });

  function buildConfig() {
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['org/repo'];
    config.sources.github.pullRequests.enabled = true;
    return config;
  }

  it('discovers open PRs not yet correlated and emits a pr.seen event per PR', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([
        {
          number: 91,
          html_url: 'https://github.com/org/repo/pull/91',
          user: { login: 'trusted-human' },
          head: { ref: 'feature-x' },
          updated_at: '2026-07-18T00:00:00Z',
        },
      ]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const resourceIndex = createFakeResourceIndex();
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config: buildConfig(),
      resourceIndex,
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [] });
    const seenEvents = events.filter((e) => e.sourceEventType === 'pr.seen');
    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]?.sourceRefs.resourceUri).toBe('github:pr:org/repo#91');
    expect(seenEvents[0]?.payload.pr).toEqual({ number: 91, author: 'trusted-human', headRef: 'feature-x' });
  });

  it('does not re-emit pr.seen once the PR is already correlated', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([
        {
          number: 91,
          html_url: 'https://github.com/org/repo/pull/91',
          user: { login: 'trusted-human' },
          head: { ref: 'feature-x' },
          updated_at: '2026-07-18T00:00:00Z',
        },
      ]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const resourceIndex = createFakeResourceIndex();
    await resourceIndex.register('github:pr:org/repo#91', 'work-01JZ0000000000000000000000');
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config: buildConfig(),
      resourceIndex,
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    expect(events.filter((e) => e.sourceEventType === 'pr.seen')).toHaveLength(0);
  });

  it('polls conversation comments, reviews, and review comments only for watchlisted PRs', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: 'LGTM modulo one thing',
          user: { login: 'reviewer' },
          created_at: '2026-07-18T00:00:00Z',
          updated_at: '2026-07-18T00:00:00Z',
          html_url: 'https://github.com/org/repo/pull/91#issuecomment-1',
        },
      ]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config: buildConfig(),
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    expect(client.listComments).toHaveBeenCalledWith('org', 'repo', 91, expect.any(Number));
    const commentEvents = events.filter((e) => e.sourceEventType === 'pr.comment.created');
    expect(commentEvents).toHaveLength(1);
    expect(commentEvents[0]?.sourceRefs.resourceUri).toBe('github:pr:org/repo#91');
  });

  it('does not poll watchlisted PR activity when pullRequests.enabled is false', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const config = buildConfig();
    config.sources.github.pullRequests.enabled = false;
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    expect(client.listComments).not.toHaveBeenCalled();
    expect(client.listReviews).not.toHaveBeenCalled();
    expect(client.listReviewComments).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('derives a stable review-thread resourceUri from review comment thread roots', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([
        {
          id: 501,
          in_reply_to_id: undefined,
          path: 'src/foo.ts',
          line: 42,
          body: 'root comment',
          user: { login: 'reviewer' },
          created_at: '2026-07-18T00:00:00Z',
          updated_at: '2026-07-18T00:00:00Z',
          html_url: 'https://github.com/org/repo/pull/91#discussion_r501',
        },
        {
          id: 502,
          in_reply_to_id: 501,
          path: 'src/foo.ts',
          line: 42,
          body: 'reply',
          user: { login: 'author' },
          created_at: '2026-07-18T00:01:00Z',
          updated_at: '2026-07-18T00:01:00Z',
          html_url: 'https://github.com/org/repo/pull/91#discussion_r502',
        },
      ]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config: buildConfig(),
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    const threadEvents = events.filter((e) => e.sourceEventType === 'pr.review-comment.created');
    expect(threadEvents).toHaveLength(2);
    expect(threadEvents[0]?.sourceRefs.resourceUri).toBe('github:pr-review-thread:org/repo#91/rt_501');
    expect(threadEvents[1]?.sourceRefs.resourceUri).toBe('github:pr-review-thread:org/repo#91/rt_501');
    expect((threadEvents[0]?.payload.comment as { reviewThread: { path: string; line: number } }).reviewThread).toEqual({
      path: 'src/foo.ts',
      line: 42,
    });
  });
});
