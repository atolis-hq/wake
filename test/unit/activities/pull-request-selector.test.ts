import { describe, expect, it } from 'vitest';
import { BuiltInResourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import {
  selectPrimaryPullRequest,
  type PullRequestAuthorityInput,
} from '../../../src/activities/index.js';

const workItem = workId('1');
const resource = resId('1');

function inputWithOnePrimary(): PullRequestAuthorityInput {
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
          capabilities: [BuiltInResourceCapability.Mergeable],
          revision: 'head-a',
        },
        correlations: [
          {
            resourceId: resource,
            workItemId: workItem,
            role: 'primary',
            provenance: 'provider-observed' as const,
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
      },
    ],
    acceptedSignals: [],
  };
}

function inputWithTwoPrimaries(): PullRequestAuthorityInput {
  const secondResource = resId('2');
  const input = inputWithOnePrimary();
  return {
    ...input,
    resources: [
      ...input.resources,
      {
        resource: {
          ...input.resources[0]!.resource,
          resourceId: secondResource,
        },
        correlations: [
          {
            resourceId: secondResource,
            workItemId: workItem,
            role: 'primary',
            provenance: 'provider-observed' as const,
            establishedByEventId: 'correlation-2',
          },
        ],
      },
    ],
  };
}

describe('selectPrimaryPullRequest', () => {
  it('returns null when the work item has two primary pull-request resources', () => {
    expect(selectPrimaryPullRequest(inputWithTwoPrimaries(), workItem)).toBeNull();
  });

  it('returns the single non-conflicted primary pull request', () => {
    const selected = selectPrimaryPullRequest(inputWithOnePrimary(), workItem);
    expect(selected?.pullRequest.resourceId).toBe(resource);
  });
});
