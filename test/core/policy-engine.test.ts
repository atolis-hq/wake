import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { parseIssueStateRecord } from '../../src/domain/schema.js';
import { createPolicyEngine } from '../../src/core/policy-engine.js';

function buildAwaitingApprovalIssue(options: {
  latestCommentBody?: string;
  pendingApprovalAction?: string;
}) {
  return parseIssueStateRecord({
    schemaVersion: 1,
    issue: {
      repo: 'atolis-hq/wake',
      number: 50,
      title: 'Example',
      body: 'Body',
      labels: [],
      assignees: [],
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
            isWakeAuthored: false,
          },
        ]
      : [],
    wake: {
      stage: 'awaiting-approval',
      syncedAt: '2026-07-06T00:00:00.000Z',
      stageHistory: [],
    },
    context: options.pendingApprovalAction !== undefined
      ? { pendingApprovalAction: options.pendingApprovalAction }
      : {},
  });
}

function buildIssue(overrides: {
  labels?: string[];
  assignees?: string[];
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
    config.sources.github.policy.requiredAssignees = ['octocat', 'other-user'];
    const issue = buildIssue({ assignees: ['other-user'] });

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
  it('returns null when issue is not in awaiting-approval stage', () => {
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

  it('returns approved=true when /approved appears within a longer comment', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'Looks good! /approved',
      pendingApprovalAction: 'implement',
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(true);
    expect(resolution?.pendingAction).toBe('implement');
  });

  it('returns approved=false when latest comment does not contain /approved', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({
      latestCommentBody: 'Can you change the approach?',
      pendingApprovalAction: 'implement',
    });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(false);
    expect(resolution?.pendingAction).toBe('implement');
  });

  it('returns approved=false when there are no human comments', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({});
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.approved).toBe(false);
  });

  it('defaults pendingAction to implement when context is missing', () => {
    const policy = createPolicyEngine();
    const issue = buildAwaitingApprovalIssue({ latestCommentBody: '/approved' });
    const resolution = policy.resolveApprovalTransition(issue);
    expect(resolution?.pendingAction).toBe('implement');
  });
});
