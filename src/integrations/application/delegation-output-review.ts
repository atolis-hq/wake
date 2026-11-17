import { ActivityOutcomeKind, PullRequestDenialCode } from '../../activities/index.js';
import { RunStatus, WorkspaceMode, type RunView } from '../../execution/index.js';
import type { DelegationResult, WorkflowInstanceView } from '../../orchestration/index.js';

export type DelegationReviewPolicy = (child: WorkflowInstanceView) => Promise<{
  readonly refreshedSubject?: DelegationResult['outputs'][number] | undefined;
  readonly requireApproval: boolean;
  readonly allowTrustedReview?: boolean;
  readonly review?: WorkflowInstanceView | undefined;
  /** Why a requested fresh review cannot attest the head, when it ended without a verdict. */
  readonly reviewUnavailable?: string | undefined;
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
    const reason =
      policy.reviewUnavailable ?? (await reviewedHead(input.runs, child, policy.review, revision));
    if (reason !== undefined) {
      if (policy.allowTrustedReview)
        return { requireReview: true, requireChecks: true, reviewFallbackReason: reason };
      input.blocked?.(reason);
      return null;
    }
  }
  return { requireReview: policy.requireApproval, requireChecks: true };
}

export async function refreshedReviewSubject(
  input: {
    readonly reviewPolicy?: DelegationReviewPolicy;
    readonly runs: () => Promise<readonly RunView[]>;
  },
  child: WorkflowInstanceView,
) {
  const policy = await input.reviewPolicy?.(child);
  const subject = policy?.refreshedSubject;
  if (subject === undefined || !('revision' in subject.reference)) return {};
  return (await reviewedHead(input.runs, child, policy?.review, subject.reference.revision)) ===
    undefined
    ? { subject }
    : policy?.reviewUnavailable === undefined
      ? {}
      : { unavailable: policy.reviewUnavailable };
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

export function outputAuthorityReason(
  reason: PullRequestDenialCode,
  requireApproval: boolean,
  reviewFallbackReason?: string,
) {
  if (reviewFallbackReason !== undefined)
    return reviewFallbackReason + '; Trusted PR review fallback: ' + reason;
  const trustedReview =
    requireApproval &&
    (reason === PullRequestDenialCode.StaleApproval ||
      reason === PullRequestDenialCode.UntrustedActor);
  return (
    (trustedReview ? 'Approval policy requires trusted review: ' : 'Output authority: ') + reason
  );
}
