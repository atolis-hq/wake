import {
  PullRequestDenialCode,
  PullRequestState,
  readMergePolicyDenial,
  type MergePolicyDetails,
  type PullRequestView,
} from '../../../activities/index.js';
import { WorkflowStatus, type WorkflowInstanceView } from '../../../orchestration/index.js';
import type { MergePolicyBlockResponse } from '../contracts/orchestration.js';

export function presentMergePolicyBlock(input: {
  readonly workflow: WorkflowInstanceView;
  readonly pullRequest: PullRequestView;
  readonly href?: string | undefined;
  readonly policy?: MergePolicyDetails | undefined;
}): MergePolicyBlockResponse | undefined {
  const denial = readMergePolicyDenial(input.workflow.lastOutcome);
  if (denial === null || input.workflow.status !== WorkflowStatus.Waiting) return undefined;
  const policy = denial.policy ?? input.policy;
  const merged = input.pullRequest.state === PullRequestState.Merged;
  const explanation =
    denial.reason === PullRequestDenialCode.BlockedPathChanged
      ? 'Automatic merge stopped because this PR changes a protected path.'
      : denial.reason === PullRequestDenialCode.TooManyFilesChanged
        ? 'Automatic merge stopped because this PR exceeds the configured file-count limit.'
        : 'Automatic merge stopped because changed-file evidence required by policy is unavailable.';
  return {
    status: merged ? 'recovering' : 'awaiting-human-merge',
    explanation,
    nextAction: merged
      ? 'The PR has merged. Normal control-plane advancement will check the durable evidence and continue the configured completion flow.'
      : 'Review and merge the correlated PR manually. Wake will observe the merge and continue. Approval or a comment only retries automation and does not override this policy.',
    ...(input.href === undefined ? {} : { href: input.href }),
    ...(policy === undefined ? {} : { policy }),
  };
}
