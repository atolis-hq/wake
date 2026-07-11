import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { parseIssueStateRecord } from '../../src/domain/schema.js';
import { createPolicyEngine } from '../../src/core/policy-engine.js';

function buildAwaitingApprovalIssue(options: {
  latestCommentBody?: string;
  pendingApprovalAction?: string;
}) {
  const pendingApprovalAction = options.pendingApprovalAction ?? 'implement';
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 50,
      title: 'Example',
      body: 'Body',
      labels: [],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/50',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    },
    comments: options.latestCommentBody !== undefined
      ? [
          {
            id: 'c-1',
            body: options.latestCommentBody,
            author: { login: 'owner' },
            createdAt: '2026-07-06T01:00:00.000Z',
            updatedAt: '2026-07-06T01:00:00.000Z',
          },
        ]
      : [],
    wake: {
      stage: pendingApprovalAction === 'refine' ? 'refine' : 'implement',
      syncedAt: '2026-07-06T00:00:00.000Z',
      stageHistory: [],
    },
    context: {
      lastRunSentinel: 'AWAITING_APPROVAL',
      ...(options.pendingApprovalAction !== undefined
        ? { pendingApprovalAction: options.pendingApprovalAction }
        : {}),
    },
  });
}

function buildIssue(overrides: {
  labels?: string[];
  assignees?: string[];
  isPullRequest?: boolean;
}) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 1,
      title: 'Example',
      body: 'Body',
      labels: overrides.labels ?? [],
      assignees: overrides.assignees ?? [],
      isPullRequest: overrides.isPullRequest ?? false,
      state: 'open',
      url: 'https://example.test/issues/1',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    },
    wake: {
      stage: 'queue',
      syncedAt: '2026-07-06T00:00:00.000Z',
      stageHistory: [],
    },
  });
}

function buildNeedsWakeActionIssue(overrides: {
  updatedAt?: string;
  latestCommentId?: string;
  lastHandledCommentId?: string;
  lastRunSentinel?: string;
  lastCompletedAction?: string;
}) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 61,
      title: 'Example',
      body: 'Body',
      labels: ['wake:implement'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/61',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-07-07T00:00:00.000Z',
    },
    comments: overrides.latestCommentId === undefined
      ? []
      : [
          {
            id: overrides.latestCommentId,
            body: 'Comment',
            author: { login: 'owner' },
            createdAt: '2026-07-06T01:00:00.000Z',
            updatedAt: '2026-07-06T01:00:00.000Z',
          },
        ],
    latestComment: overrides.latestCommentId === undefined
      ? undefined
      : {
          id: overrides.latestCommentId,
          body: 'Comment',
          author: { login: 'owner' },
          createdAt: '2026-07-06T01:00:00.000Z',
          updatedAt: '2026-07-06T01:00:00.000Z',
        },
    wake: {
      stage: 'implement',
      lastRunId: 'run-61-1',
      syncedAt: '2026-07-07T00:00:00.000Z',
      stageHistory: [],
    },
    context: {
      ...(overrides.lastHandledCommentId === undefined
        ? {}
        : { lastHandledCommentId: overrides.lastHandledCommentId }),
      ...(overrides.lastRunSentinel === undefined
        ? {}
        : { lastRunSentinel: overrides.lastRunSentinel }),
      ...(overrides.lastCompletedAction === undefined
        ? {}
        : { lastCompletedAction: overrides.lastCompletedAction }),
    },
  });
}

function buildBlockedOrFailedIssue(overrides: {
  stage: 'blocked' | 'refine' | 'implement' | 'queue';
  latestCommentId?: string;
  latestCommentIsBotAuthored?: boolean;
  lastHandledCommentId?: string;
  lastRunAction?: string;
}) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 62,
      title: 'Example',
      body: 'Body',
      labels: ['wake'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/62',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
    },
    comments: overrides.latestCommentId === undefined
      ? []
      : [
          {
            id: overrides.latestCommentId,
            body: 'Here is the missing context.',
            author: { login: overrides.latestCommentIsBotAuthored ? 'wake-bot' : 'owner' },
            createdAt: '2026-07-06T01:00:00.000Z',
            updatedAt: '2026-07-06T01:00:00.000Z',
            isBotAuthored: overrides.latestCommentIsBotAuthored ?? false,
          },
        ],
    wake: {
      stage: overrides.stage,
      lastRunId: 'run-62-1',
      syncedAt: '2026-07-07T00:00:00.000Z',
      stageHistory: [],
    },
    context: {
      ...(overrides.lastHandledCommentId === undefined
        ? {}
        : { lastHandledCommentId: overrides.lastHandledCommentId }),
      ...(overrides.lastRunAction === undefined
        ? {}
        : { lastRunAction: overrides.lastRunAction }),
    },
  });
}

describe('policy engine: requiredAssignees', () => {
  it('is ineligible when both requiredLabels and requiredAssignees are empty', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    const issue = buildIssue({ assignees: [] });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is eligible when issue is assigned to a listed login', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: ['octocat'] });

    expect(policy.isEligible(issue, config)).toBe(true);
  });

  it('is ineligible when issue has no assignees but requiredAssignees is set', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: [] });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is ineligible when the work item is a pull request', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredLabels = ['wake'];
    const issue = buildIssue({ labels: ['wake'], isPullRequest: true });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is ineligible when issue is assigned to a non-listed login only', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    const issue = buildIssue({ assignees: ['someone-else'] });

    expect(policy.isEligible(issue, config)).toBe(false);
  });

  it('is eligible when issue matches any one of multiple requiredAssignees (OR semantics)', () => {
    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredLabels = [];
    config.sources.github.policy.requiredAssignees = ['octocat', 'other-user'];
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 1,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: ['other-user'],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/1',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
      wake: {
        stage: 'queue',
        syncedAt: '2026-07-06T00:00:00.000Z',
        stageHistory: [],
      },
    });

    expect(policy.isEligible(issue, config)).toBe(true);
  });

  it('combines requiredAssignees and requiredLabels with AND semantics', () => {

    const policy = createPolicyEngine();
    const config = createDefaultWakeConfig('/tmp/wake-root');
    config.sources.github.policy.requiredAssignees = ['octocat'];
    config.sources.github.policy.requiredLabels = ['wake'];

    const matchesAssigneeOnly = buildIssue({ assignees: ['octocat'], labels: [] });
    const matchesLabelOnly = buildIssue({ assignees: [], labels: ['wake'] });
    const matchesBoth = buildIssue({ assignees: ['octocat'], labels: ['wake'] });

    expect(policy.isEligible(matchesAssigneeOnly, config)).toBe(false);
    expect(policy.isEligible(matchesLabelOnly, config)).toBe(false);
    expect(policy.isEligible(matchesBoth, config)).toBe(true);
  });
});

describe('policy engine: resolveApprovalTransition', () => {
  it('returns null when issue is not awaiting approval', () => {
    const policy = createPolicyEngine();
    const issue = buildIssue({ labels: ['wake'] });
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('returns approved=true when latest human comment contains /approved', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: '/approved',
      pendingApprovalAction: 'refine',
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(true);
    expect(resolution?.pendingAction).toBe('refine');
  });

  it('returns approved=true when /approved is on its own line within a longer comment', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'Looks good!\n/approved',
      pendingApprovalAction: 'implement',
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(true);
    expect(resolution?.pendingAction).toBe('implement');
  });

  it('does not approve when /approved appears mid-line as a substring, not a command (S2)', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'I have *not* /approved this yet.',
      pendingApprovalAction: 'implement',
    });
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('returns approved=false when latest comment is an explicit /changes command (S2)', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: '/changes Can you change the approach?',
      pendingApprovalAction: 'implement',
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(false);
    expect(resolution?.pendingAction).toBe('implement');
  });

  it('returns null (holds state) when the latest comment is conversation, not a command (S2)', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'Can you explain the approach?',
      pendingApprovalAction: 'implement',
    });
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('returns null when there are no human comments', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({});
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('returns null when the latest human comment was already handled', () => {
    const policy = createPolicyEngine();
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
      comments: [
        {
          id: 'c-1',
          body: 'Please start the implementation.',
          author: { login: 'owner' },
          createdAt: '2026-07-06T01:00:00.000Z',
          updatedAt: '2026-07-06T01:00:00.000Z',
        },
      ],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-07T00:00:00.000Z',
        stageHistory: [],
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
        lastHandledCommentId: 'c-1',
      },
    });
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('defaults pendingAction to implement when context is missing', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({ latestCommentBody: '/approved' });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.pendingAction).toBe('implement');
  });

  it('ignores a /approved comment that predates the last bot comment', () => {
    const policy = createPolicyEngine();
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
      comments: [
        {
          id: 'c-human-approved',
          body: '/approved',
          author: { login: 'owner' },
          createdAt: '2026-07-06T01:00:00.000Z',
          updatedAt: '2026-07-06T01:00:00.000Z',
          isBotAuthored: false,
        },
        {
          id: 'c-bot-approval-request',
          body: 'Implementation PR is open. Wake is awaiting your approval.',
          author: { login: 'wake-bot' },
          createdAt: '2026-07-06T02:00:00.000Z',
          updatedAt: '2026-07-06T02:00:00.000Z',
          isBotAuthored: true,
        },
      ],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-07T00:00:00.000Z',
        stageHistory: [],
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
    });
    expect(policy.resolveApprovalTransition(issue)).toBeNull();
  });

  it('accepts a /approved comment that follows the last bot comment', () => {
    const policy = createPolicyEngine();
    const issue = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Example',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
      comments: [
        {
          id: 'c-bot-approval-request',
          body: 'Implementation PR is open. Wake is awaiting your approval.',
          author: { login: 'wake-bot' },
          createdAt: '2026-07-06T02:00:00.000Z',
          updatedAt: '2026-07-06T02:00:00.000Z',
          isBotAuthored: true,
        },
        {
          id: 'c-human-approved',
          body: '/approved',
          author: { login: 'owner' },
          createdAt: '2026-07-06T03:00:00.000Z',
          updatedAt: '2026-07-06T03:00:00.000Z',
          isBotAuthored: false,
        },
      ],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-07T00:00:00.000Z',
        stageHistory: [],
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(true);
  });
});

describe('policy engine: needsWakeAction', () => {
  it('ignores updatedAt-only changes while waiting for a human reply after a failed run', () => {
    const policy = createPolicyEngine();
    const issue = buildNeedsWakeActionIssue({
      updatedAt: '2026-07-07T00:05:00.000Z',
      lastRunSentinel: 'FAILED',
    });

    expect(policy.needsWakeAction(issue)).toBe(false);
  });

  it('still wakes up when a new human comment arrives after a failed run', () => {
    const policy = createPolicyEngine();
    const issue = buildNeedsWakeActionIssue({
      updatedAt: '2026-07-07T00:05:00.000Z',
      latestCommentId: 'c-2',
      lastHandledCommentId: 'c-1',
      lastRunSentinel: 'FAILED',
    });

    expect(policy.needsWakeAction(issue)).toBe(true);
  });

  it('continues to implement after refine completed without relying on updatedAt churn', () => {
    const policy = createPolicyEngine();
    const issue = buildNeedsWakeActionIssue({
      lastRunSentinel: 'DONE',
      lastCompletedAction: 'refine',
    });

    expect(policy.needsWakeAction(issue)).toBe(true);
  });

  it('does not repeat implement when the refined stage action is already complete', () => {
    const policy = createPolicyEngine();
    const issue = buildNeedsWakeActionIssue({
      lastRunSentinel: 'DONE',
      lastCompletedAction: 'implement',
    });

    expect(policy.needsWakeAction(issue)).toBe(false);
  });

  it('does not wake an implement-stage item only because it is awaiting approval', () => {
    const policy = createPolicyEngine();
    const issue = buildNeedsWakeActionIssue({
      lastRunSentinel: 'AWAITING_APPROVAL',
    });

    expect(policy.needsWakeAction(issue)).toBe(false);
  });
});

describe('policy engine: chooseRetryActionAfterHumanReply', () => {
  it('retries the last run action for a blocked issue with an unhandled human reply', () => {
    const policy = createPolicyEngine();
    const issue = buildBlockedOrFailedIssue({
      stage: 'blocked',
      latestCommentId: 'c-2',
      lastHandledCommentId: 'c-1',
      lastRunAction: 'implement',
    });

    expect(policy.chooseRetryActionAfterHumanReply(issue)).toBe('implement');
  });

  it('retries the last run action for a failed issue with an unhandled human reply', () => {
    const policy = createPolicyEngine();
    const issue = buildBlockedOrFailedIssue({
      stage: 'refine',
      latestCommentId: 'c-2',
      lastHandledCommentId: 'c-1',
      lastRunAction: 'refine',
    });
    issue.context.lastRunSentinel = 'FAILED';

    expect(policy.chooseRetryActionAfterHumanReply(issue)).toBe('refine');
  });

  it('retries a quota-failed action after the control-plane pause expires without a human reply', () => {
    const policy = createPolicyEngine();
    const issue = buildBlockedOrFailedIssue({
      stage: 'refine',
      lastRunAction: 'refine',
    });
    issue.context.lastRunSentinel = 'FAILED';
    issue.context.lastFailureClass = 'quota';

    expect(policy.needsWakeAction(issue)).toBe(true);
    expect(policy.chooseRetryActionAfterHumanReply(issue)).toBe('refine');
  });

  it('does not retry when the latest human reply was already handled', () => {
    const policy = createPolicyEngine();
    const issue = buildBlockedOrFailedIssue({
      stage: 'blocked',
      latestCommentId: 'c-1',
      lastHandledCommentId: 'c-1',
      lastRunAction: 'implement',
    });

    expect(policy.chooseRetryActionAfterHumanReply(issue)).toBeNull();
  });

  it('does not retry for bot comments or runs that did not fail or block', () => {
    const policy = createPolicyEngine();
    const botReply = buildBlockedOrFailedIssue({
      stage: 'blocked',
      latestCommentId: 'c-2',
      latestCommentIsBotAuthored: true,
      lastRunAction: 'implement',
    });
    const queued = buildBlockedOrFailedIssue({
      stage: 'queue',
      latestCommentId: 'c-2',
      lastRunAction: 'refine',
    });

    expect(policy.chooseRetryActionAfterHumanReply(botReply)).toBeNull();
    expect(policy.chooseRetryActionAfterHumanReply(queued)).toBeNull();
  });
});
