import { expect, it } from 'vitest';
import {
  PullRequestDenialCode,
  PullRequestState,
  type PullRequestView,
} from '../../../src/activities/index.js';
import { WorkflowStatus, type WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { presentMergePolicyBlock } from '../../../src/surfaces/index.js';
import { resId, workId } from '../../support/identities.js';

const pr: PullRequestView = {
  resourceId: resId('policy'),
  workItemId: workId('policy'),
  state: PullRequestState.Open,
  headRevision: 'head',
  baseRevision: 'base',
  checks: 'passing',
};

function workflow(reason: string): WorkflowInstanceView {
  return {
    status: WorkflowStatus.Waiting,
    lastOutcome: { kind: 'blocked', data: { reason } },
  } as WorkflowInstanceView;
}

it('presents only the applicable count restriction and manual-merge guidance', () => {
  const result = presentMergePolicyBlock({
    workflow: workflow(PullRequestDenialCode.TooManyFilesChanged),
    pullRequest: pr,
    href: 'https://github.com/owner/repo/pull/1',
    policy: { maxFilesChanged: 20, filesChanged: 21 },
  });
  expect(result).toMatchObject({
    status: 'awaiting-human-merge',
    policy: { maxFilesChanged: 20, filesChanged: 21 },
    href: 'https://github.com/owner/repo/pull/1',
  });
  expect(result?.nextAction).toContain('merge the correlated PR manually');
  expect(result?.nextAction).toContain('does not override');
});
it('shows recovery guidance for durable merged state and no blocker after workflow completion', () => {
  const view = workflow(PullRequestDenialCode.BlockedPathChanged);
  const merged = { ...pr, state: PullRequestState.Merged };
  const result = presentMergePolicyBlock({ workflow: view, pullRequest: merged });
  expect(result?.status).toBe('recovering');
  expect(result?.nextAction).toContain('The PR has merged');
  expect(result?.nextAction).not.toContain('merge the correlated PR manually');
  expect(
    presentMergePolicyBlock({
      workflow: { ...view, status: WorkflowStatus.Completed },
      pullRequest: merged,
    }),
  ).toBeUndefined();
});
it('does not present unrelated denial reasons as a policy merge wait', () => {
  expect(
    presentMergePolicyBlock({
      workflow: workflow(PullRequestDenialCode.UntrustedActor),
      pullRequest: pr,
    }),
  ).toBeUndefined();
});
