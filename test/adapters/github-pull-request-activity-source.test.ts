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
    // Embeds updated_at so a PR that fails mint qualification is re-offered
    // for qualification once it actually changes, instead of being
    // permanently quarantined under its first-seen eventId.
    expect(seenEvents[0]?.eventId).toContain('2026-07-18T00:00:00Z');
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

  it('emits PR feedback when a required check run fails', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn().mockResolvedValue({
        number: 91,
        html_url: 'https://github.com/org/repo/pull/91',
        head: { ref: 'wake/issue-240', sha: 'abc123' },
        base: { ref: 'main' },
        user: { login: 'trusted-human' },
        updated_at: '2026-07-18T00:00:00Z',
      }),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      getRequiredStatusChecks: vi.fn().mockResolvedValue({
        contexts: [],
        checks: ['test'],
      }),
      listCheckRunsForRef: vi.fn().mockResolvedValue([
        {
          id: 8001,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/org/repo/actions/runs/8001',
          completed_at: '2026-07-18T00:02:00Z',
        },
        {
          id: 8002,
          name: 'optional-smoke',
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-07-18T00:03:00Z',
        },
      ]),
      getCombinedStatusForRef: vi.fn().mockResolvedValue([]),
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
    const checkEvents = events.filter((e) => e.sourceEventType === 'pr.checks.failed');

    expect(client.getRequiredStatusChecks).toHaveBeenCalledWith('org', 'repo', 'main');
    expect(client.listCheckRunsForRef).toHaveBeenCalledWith('org', 'repo', 'abc123');
    expect(checkEvents).toHaveLength(1);
    expect(checkEvents[0]?.sourceRefs.resourceUri).toBe('github:pr:org/repo#91');
    expect(checkEvents[0]?.payload.comment).toMatchObject({
      id: 'pr-check-failed-abc123-8001-failure',
      body: 'Required check failed: test (failure).',
      author: { login: 'github-checks' },
      resourceUri: 'github:pr:org/repo#91',
    });
  });

  it('emits PR feedback when a required legacy status fails', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn().mockResolvedValue({
        number: 91,
        html_url: 'https://github.com/org/repo/pull/91',
        head: { ref: 'wake/issue-240', sha: 'abc123' },
        base: { ref: 'main' },
        user: { login: 'trusted-human' },
        updated_at: '2026-07-18T00:00:00Z',
      }),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      getRequiredStatusChecks: vi.fn().mockResolvedValue({
        contexts: ['ci/lint'],
        checks: [],
      }),
      listCheckRunsForRef: vi.fn().mockResolvedValue([]),
      getCombinedStatusForRef: vi.fn().mockResolvedValue([
        {
          context: 'ci/lint',
          state: 'error',
          description: 'Command exited 1',
          target_url: 'https://ci.example.test/build/1',
          created_at: '2026-07-18T00:01:00Z',
          updated_at: '2026-07-18T00:02:00Z',
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
    const checkEvents = events.filter((e) => e.sourceEventType === 'pr.checks.failed');

    expect(checkEvents).toHaveLength(1);
    expect(checkEvents[0]?.payload.comment).toMatchObject({
      id: 'pr-status-failed-abc123-ci/lint-error',
      body: 'Required status failed: ci/lint (error): Command exited 1',
      author: { login: 'github-status' },
      resourceUri: 'github:pr:org/repo#91',
    });
  });

  it('does not poll required checks when pullRequests.checks.enabled is false', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn().mockResolvedValue({
        head: { ref: 'wake/issue-240', sha: 'abc123' },
        base: { ref: 'main' },
      }),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      getRequiredStatusChecks: vi.fn().mockResolvedValue({ contexts: ['test'], checks: [] }),
      listCheckRunsForRef: vi.fn().mockResolvedValue([]),
      getCombinedStatusForRef: vi.fn().mockResolvedValue([]),
      replyToReviewComment: vi.fn(),
      createComment: vi.fn(),
    };
    const config = buildConfig();
    config.sources.github.pullRequests.checks.enabled = false;
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });

    expect(client.getRequiredStatusChecks).not.toHaveBeenCalled();
    expect(client.listCheckRunsForRef).not.toHaveBeenCalled();
    expect(client.getCombinedStatusForRef).not.toHaveBeenCalled();
    expect(events.filter((e) => e.sourceEventType === 'pr.checks.failed')).toHaveLength(0);
  });

  it('marks an unmarked review-comment reply from Wake\'s own login as bot-authored (#258 follow-up)', async () => {
    // A revise run replies directly via `gh api .../replies`, bypassing
    // formatWakeComment entirely — no wake:agent marker, account type
    // 'User'. Without a selfLogin check this looks like a fresh human
    // reply and re-triggers another Wake run against itself.
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([
        {
          id: 501,
          in_reply_to_id: 500,
          path: 'docs/example.md',
          line: 3,
          body: 'Done in abc123. No marker, posted via gh api directly.',
          user: { login: 'atolis-hq-agent', type: 'User' },
          created_at: '2026-07-18T00:05:00Z',
          updated_at: '2026-07-18T00:05:00Z',
          html_url: 'https://github.com/org/repo/pull/91#discussion_r501',
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
      selfLogin: 'atolis-hq-agent',
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    const reviewCommentEvent = events.find((e) => e.sourceEventType === 'pr.review-comment.created');
    expect(reviewCommentEvent?.derivedHints?.botAuthoredComment).toBe(true);
  });

  it('does not mark an unmarked review-comment reply from a different login as bot-authored', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([
        {
          id: 502,
          in_reply_to_id: 500,
          path: 'docs/example.md',
          line: 3,
          body: 'Actually, please also rename the other occurrence.',
          user: { login: 'a-real-reviewer', type: 'User' },
          created_at: '2026-07-18T00:06:00Z',
          updated_at: '2026-07-18T00:06:00Z',
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
      selfLogin: 'atolis-hq-agent',
    });

    const events = await source.pollEvents({ watch: [{ resourceUri: 'github:pr:org/repo#91' }] });
    const reviewCommentEvent = events.find((e) => e.sourceEventType === 'pr.review-comment.created');
    expect(reviewCommentEvent?.derivedHints?.botAuthoredComment).toBe(false);
  });

  it('does not poll watchlisted PR activity when pullRequests.enabled is false', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
      getRequiredStatusChecks: vi.fn().mockResolvedValue({ contexts: ['test'], checks: [] }),
      listCheckRunsForRef: vi.fn().mockResolvedValue([]),
      getCombinedStatusForRef: vi.fn().mockResolvedValue([]),
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
    expect(client.getRequiredStatusChecks).not.toHaveBeenCalled();
    expect(client.listCheckRunsForRef).not.toHaveBeenCalled();
    expect(client.getCombinedStatusForRef).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('still emits a review event when the review body is empty, so a bare approve/request-changes is not lost', async () => {
    const client = {
      listPullRequests: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(),
      listComments: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([
        {
          id: 701,
          body: '',
          state: 'CHANGES_REQUESTED',
          user: { login: 'reviewer' },
          submitted_at: '2026-07-18T00:00:00Z',
          html_url: 'https://github.com/org/repo/pull/91#pullrequestreview-701',
        },
      ]),
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
    const reviewEvents = events.filter((e) => e.sourceEventType === 'pr.review.created');
    expect(reviewEvents).toHaveLength(1);
    expect((reviewEvents[0]?.payload.comment as { body: string }).body).toBe('[CHANGES_REQUESTED]');
  });

  it('tags review-thread comment events with sourceRefs.parentResourceUri pointing at the owning PR', async () => {
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
    expect(threadEvents).toHaveLength(1);
    expect(threadEvents[0]?.sourceRefs.parentResourceUri).toBe('github:pr:org/repo#91');
  });

  it('formats PR comment replies with formatWakeComment, including the approval-instructions footer, not a bare marker+body', async () => {
    const client = {
      listPullRequests: vi.fn(),
      getPullRequest: vi.fn(),
      listComments: vi.fn(),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
      replyToReviewComment: vi.fn().mockResolvedValue({ html_url: 'https://github.com/org/repo/pull/91#discussion_r501' }),
      createComment: vi.fn().mockResolvedValue({ html_url: 'https://github.com/org/repo/pull/91#issuecomment-1' }),
    };
    const source = createGitHubPullRequestActivitySource({
      client,
      stateStore: createStateStore({ wakeRoot: root }),
      config: buildConfig(),
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-18T00:00:00Z'),
    });

    await source.deliverIntent({
      event: {
        schemaVersion: 1,
        eventId: 'intent-1',
        workItemKey: 'work-01JZ0000000000000000000000',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { resourceUri: 'github:pr:org/repo#91' },
        occurredAt: '2026-07-18T00:00:00Z',
        ingestedAt: '2026-07-18T00:00:00Z',
        trigger: 'context-only',
        payload: { kind: 'approval-request', body: 'Please review.' },
      },
    });

    expect(client.createComment).toHaveBeenCalledWith(
      'org',
      'repo',
      91,
      expect.stringContaining('/approved'),
    );
    expect(client.createComment).toHaveBeenCalledWith(
      'org',
      'repo',
      91,
      expect.stringContaining('<!-- wake:agent -->'),
    );
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
