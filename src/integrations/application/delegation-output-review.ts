import { ActivityOutcomeKind } from '../../activities/index.js';
import { RunStatus, WorkspaceMode, type RunView } from '../../execution/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';

export type DelegationReviewPolicy = (child: WorkflowInstanceView) => Promise<{
  readonly requireApproval: boolean;
  readonly review?: WorkflowInstanceView | undefined;
}>;

/** A watch verdict is usable only with an accepted review Run's exact checkout attestation. */
export async function deliveryReadyRequirements(
  input: {
    readonly reviewPolicy?: DelegationReviewPolicy;
    readonly runs: () => Promise<readonly RunView[]>;
  },
  child: WorkflowInstanceView,
  revision: string,
) {
  const policy = (await input.reviewPolicy?.(child)) ?? { requireApproval: true };
  if (!policy.requireApproval && !(await reviewedHead(input.runs, child, policy.review, revision)))
    return null;
  return { requireReview: policy.requireApproval, requireChecks: true };
}

async function reviewedHead(
  runs: () => Promise<readonly RunView[]>,
  child: WorkflowInstanceView,
  review: WorkflowInstanceView | undefined,
  revision: string,
) {
  if (review === undefined || review.parentWorkflowInstanceId !== child.workflowInstanceId)
    return false;
  const reviewed = (await runs())
    .filter(
      (run) =>
        run.workflowInstanceId === review.workflowInstanceId &&
        review.acceptedOutcomes.includes(run.activationId) &&
        run.workspace?.mode === WorkspaceMode.ReadOnly,
    )
    .at(-1);
  return (
    reviewed !== undefined &&
    reviewed.status === RunStatus.Succeeded &&
    reviewed.outcome?.kind === ActivityOutcomeKind.Done &&
    reviewed.workspaceRevision === revision
  );
}
