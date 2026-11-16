import { ActivityOutcomeKind, PullRequestDenialCode } from '../../activities/index.js';
import { RunStatus, WorkspaceMode, type RunView } from '../../execution/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';

export type DelegationReviewPolicy = (child: WorkflowInstanceView) => Promise<{
  readonly requireApproval: boolean;
  readonly allowTrustedReview?: boolean;
  readonly review?: WorkflowInstanceView | undefined;
}>;

/** A watch verdict is usable only with an accepted review Run's exact checkout attestation. */
export async function deliveryReadyRequirements(
  input: {
    readonly reviewPolicy?: DelegationReviewPolicy;
    readonly blocked?: (reason: string) => void;
    readonly runs: () => Promise<readonly RunView[]>;
  },
  child: WorkflowInstanceView,
  revision: string,
) {
  const policy = (await input.reviewPolicy?.(child)) ?? { requireApproval: true };
  if (!policy.requireApproval) {
    const reason = await reviewedHead(input.runs, child, policy.review, revision);
    if (reason !== undefined) {
      if (policy.allowTrustedReview) return { requireReview: true, requireChecks: true };
      input.blocked?.(reason);
      return null;
    }
  }
  return { requireReview: policy.requireApproval, requireChecks: true };
}

async function reviewedHead(
  runs: () => Promise<readonly RunView[]>,
  child: WorkflowInstanceView,
  review: WorkflowInstanceView | undefined,
  revision: string,
) {
  if (review === undefined || review.parentWorkflowInstanceId !== child.workflowInstanceId)
    return 'No accepted review verdict';
  const reviewed = (await runs())
    .filter(
      (run) =>
        run.workflowInstanceId === review.workflowInstanceId &&
        review.acceptedOutcomes.includes(run.activationId) &&
        run.workspace?.mode === WorkspaceMode.ReadOnly,
    )
    .at(-1);
  if (
    reviewed === undefined ||
    reviewed.status !== RunStatus.Succeeded ||
    reviewed.outcome?.kind !== ActivityOutcomeKind.Done
  )
    return 'No accepted successful read-only review verdict';
  return reviewed.workspaceRevision === revision
    ? undefined
    : 'No accepted review attesting exact head ' + revision;
}

export function outputAuthorityReason(reason: PullRequestDenialCode, requireApproval: boolean) {
  const trustedReview =
    requireApproval &&
    (reason === PullRequestDenialCode.StaleApproval ||
      reason === PullRequestDenialCode.UntrustedActor);
  return (
    (trustedReview ? 'Approval policy requires trusted review: ' : 'Output authority: ') + reason
  );
}
