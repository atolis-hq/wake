import { readFile } from 'node:fs/promises';

import { resourceKind, resourceCapability } from '../../src-next/resources/index.js';
import { describe, expect, it } from 'vitest';
import { workId, resId } from '../support/identities.js';

import {
  decidePullRequestAuthority,
  type PullRequestAuthorityInput,
} from '../../src-next/activities/index.js';
import {} from '../../src-next/resources/index.js';
import {} from '../../src-next/work/index.js';

const workItem = workId('1');
const resource = resId('1');

function authorityInput(
  overrides: Partial<PullRequestAuthorityInput> = {},
): PullRequestAuthorityInput {
  return {
    work: {
      workItemId: workItem,
      objective: 'Ship it',
      state: 'open',
      tags: [],
      autoApprovalGranted: false,
      relatedWorkItems: [],
    },
    resources: [
      {
        resource: {
          resourceId: resource,
          kind: resourceKind('pull-request'),
          externalKey: { adapter: 'github', key: 'owner/repo#1' },
          capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
          revision: 'head-a',
        },
        correlations: [
          {
            resourceId: resource,
            workItemId: workItem,
            role: 'primary',
            establishedByEventId: 'correlation-1',
          },
        ],
      },
    ],
    pullRequests: [
      {
        resourceId: resource,
        workItemId: workItem,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
        acceptedReview: { revision: 'head-a', actorId: 'reviewer', acceptedEventId: 'review-1' },
      },
    ],
    acceptedSignals: [
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-1',
        trusted: true,
      },
    ],
    ...overrides,
  };
}

describe('decidePullRequestAuthority', () => {
  it('uses the Pull Request denial vocabulary for closed authority', async () => {
    const source = await readFile(
      new URL('../../src-next/activities/pr/policy.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('return denied(PullRequestDenialCode.Closed)');
    expect(source).not.toContain('return denied(PullRequestState.Closed)');
  });

  it.each([
    ['missing-resource', { resources: [] }],
    [
      'ambiguous-resource',
      {
        resources: [
          ...authorityInput().resources,
          {
            resource: {
              ...authorityInput().resources[0]!.resource,
              resourceId: resId('2'),
            },
            correlations: [
              {
                resourceId: resId('2'),
                workItemId: workItem,
                role: 'primary' as const,
                establishedByEventId: 'correlation-2',
              },
            ],
          },
        ],
      },
    ],
    [
      'correlation-conflict',
      {
        resources: [
          {
            ...authorityInput().resources[0]!,
            correlations: [
              ...authorityInput().resources[0]!.correlations,
              {
                resourceId: resource,
                workItemId: workId('2'),
                role: 'primary' as const,
                establishedByEventId: 'correlation-2',
              },
            ],
          },
        ],
      },
    ],
  ])('rejects %s primary-resource selection', (reason, overrides) => {
    expect(decidePullRequestAuthority(authorityInput(overrides))).toEqual({
      allowed: false,
      reason,
    });
  });

  it('binds accepted review to the observed head revision', () => {
    expect(decidePullRequestAuthority(authorityInput())).toEqual({
      allowed: true,
      resourceId: resource,
      revision: 'head-a',
    });
    expect(
      decidePullRequestAuthority(
        authorityInput({
          pullRequests: [withoutAcceptedReview(authorityInput().pullRequests[0]!, 'head-b')],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'stale-approval' });
  });

  it.each([
    [
      'closed',
      { pullRequests: [{ ...authorityInput().pullRequests[0]!, state: 'closed' as const }] },
    ],
    [
      'checks-pending',
      { pullRequests: [{ ...authorityInput().pullRequests[0]!, checks: 'unknown' as const }] },
    ],
    [
      'checks-pending',
      { pullRequests: [{ ...authorityInput().pullRequests[0]!, checks: 'pending' as const }] },
    ],
    [
      'checks-failing',
      { pullRequests: [{ ...authorityInput().pullRequests[0]!, checks: 'failing' as const }] },
    ],
    [
      'untrusted-actor',
      { acceptedSignals: [{ ...authorityInput().acceptedSignals[0]!, trusted: false }] },
    ],
  ])('rejects %s authority state', (reason, overrides) => {
    expect(decidePullRequestAuthority(authorityInput(overrides))).toEqual({
      allowed: false,
      reason,
    });
  });
});

function withoutAcceptedReview(
  pullRequest: PullRequestAuthorityInput['pullRequests'][number],
  headRevision: string,
): PullRequestAuthorityInput['pullRequests'][number] {
  return {
    resourceId: pullRequest.resourceId,
    workItemId: pullRequest.workItemId,
    state: pullRequest.state,
    headRevision,
    baseRevision: pullRequest.baseRevision,
    checks: pullRequest.checks,
  };
}
